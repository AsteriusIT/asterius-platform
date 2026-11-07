import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit.js';
import { actorOf } from '../auth/users.js';
import { requireRole } from '../auth/access.js';
import { bool } from '../db.js';
import {
  deleteIntegration,
  getIntegration,
  getIntegrationRow,
  listIntegrations,
  requestSync,
  syncHistory,
  upsertIntegration,
} from '../integrations/integrations.js';
import { decodeBody, enqueueInbound, MAX_ITEMS_PER_EVENT } from '../integrations/inbound.js';
import { deliveryIdOf, ingest, recordDelivery, renderConfig, testIntegration, verifyWebhook } from '../integrations/sync.js';
import { getSource } from '../integrations/sources/index.js';
import { mapItem } from '../integrations/mapping.js';
import { mappingDef } from '../schemas.js';
import { render } from '../lib/expr.js';
import { resolveRef } from '../secrets.js';
import { idParam } from './util.js';
import { DEFAULT_ORG, withOrg } from '../orgs/context.js';
import { findOrg } from '../orgs/orgs.js';

declare module 'fastify' {
  interface FastifyRequest {
    rawBody?: string;
  }
}

const ingestLimit = { config: { rateLimit: { max: 600, timeWindow: '1 minute' } } };

/**
 * Inbound webhook of an organization's integration: /ingest/<organization>/<integration>, and the older
 * /ingest/<integration> for the default organization. Callers are anonymous: unknown organizations are a plain 404.
 */
async function ingestRoute(req: FastifyRequest, reply: FastifyReply, orgKey: string, id: string) {
  const found = await findOrg(orgKey);
  if (!found) return reply.code(404).send({ error: 'not found' });
  return withOrg(found.id, async () => {
    const r = await getIntegrationRow(id).catch(() => undefined);
    const source = r ? getSource(r.type) : undefined;
    if (!r || !source || (!source.push && !source.pushScope)) return reply.code(404).send({ error: 'not found' });
    if (!bool(r.enabled)) return reply.code(409).send({ error: 'integration disabled' });
    let cfg: Record<string, unknown>;
    try {
      cfg = await renderConfig(r);
    } catch (err) {
      req.log.warn({ err, org: found.slug, integration: id }, 'webhook integration misconfigured');
      return reply.code(503).send({ error: 'Service unavailable' }); // details stay in the logs: callers are anonymous
    }
    const contentType = String(req.headers['content-type'] ?? 'application/json');
    const raw = req.rawBody ?? (typeof req.body === 'string' ? req.body : JSON.stringify(req.body ?? null));
    // Pull sources refreshed by a provider webhook authenticate with `pushSecret` / `pushPreset`.
    const auth = source.push ? cfg : { secret: cfg.pushSecret, preset: cfg.pushPreset, signatureHeader: cfg.pushSignatureHeader };
    if (!source.push && !cfg.pushSecret) return reply.code(404).send({ error: 'not found' });
    if (!verifyWebhook(auth, req.headers, raw)) return reply.code(401).send({ error: 'invalid signature or token' });
    // Replay protection: a delivery id (GitHub, GitLab) is processed once within the dedupe window.
    const deliveryId = deliveryIdOf(req.headers);
    if (deliveryId && !(await recordDelivery(id, deliveryId)))
      return { duplicate: true, queued: false, upserted: 0, deleted: 0, skipped: 0, failed: 0, errors: [] };
    const headers = Object.fromEntries(
      Object.entries(req.headers).filter(([k]) => !['authorization', 'cookie', 'x-asterius-token', 'x-gitlab-token'].includes(k)),
    );
    let body: unknown;
    try {
      body = decodeBody(contentType, raw);
    } catch {
      return reply.code(400).send({ error: 'payload cannot be decoded for its content type' });
    }
    if (!source.push) {
      const scope = source.pushScope!(body, req.headers);
      if (!scope) return reply.code(202).send({ queued: false, ignored: true });
      await requestSync(id, undefined, scope);
      return reply.code(202).send({ queued: true, scope });
    }
    // Slack's endpoint verification handshake.
    if (cfg.preset === 'slack' && (body as { type?: string } | null)?.type === 'url_verification')
      return { challenge: (body as { challenge?: string }).challenge };
    if (Array.isArray(body) && body.length > MAX_ITEMS_PER_EVENT) return reply.code(413).send({ error: `at most ${MAX_ITEMS_PER_EVENT} items per request` });
    if (cfg.sync === true) return ingest(r, body, headers);
    const eventId = await enqueueInbound(id, headers, contentType, raw);
    return reply.code(202).send({ queued: true, id: eventId });
  });
}

export async function integrationRoutes(app: FastifyInstance) {
  /**
   * Inbound webhook ingestion (third parties → catalog), per organization (see ingestRoute). Authenticated by the integration's secret:
   * `X-Asterius-Token` / `Authorization: Bearer`, or an HMAC signature header (e.g. GitHub's X-Hub-Signature-256).
   */
  await app.register(async (hooks) => {
    // Any content type: keep the exact bytes (signatures are computed over them) and decode later.
    // JSON keeps the parser of app.ts; this one covers forms, XML, text and the rest — for this route only.
    hooks.addContentTypeParser('*', { parseAs: 'string' }, (req, body, done) => {
      req.rawBody = body as string;
      done(null, body);
    });
    hooks.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (req, body, done) => {
      req.rawBody = body as string;
      done(null, body);
    });
    hooks.post('/ingest/:org/:id', ingestLimit, async (req, reply) => {
      const { org, id } = z.object({ org: z.string().min(1).max(64), id: z.string().min(1).max(200) }).parse(req.params);
      return ingestRoute(req, reply, org, id);
    });
    hooks.post('/ingest/:id', ingestLimit, async (req, reply) => ingestRoute(req, reply, DEFAULT_ORG, idParam.parse(req.params).id));
  });

  await app.register(async (admin) => {
    admin.addHook('preHandler', requireRole('integration-admin'));

    admin.get('/integrations', async () => listIntegrations());
    admin.get('/integrations/:id', async (req) => getIntegration(idParam.parse(req.params).id));
    admin.get('/integrations/:id/syncs', async (req) => syncHistory(idParam.parse(req.params).id));
    admin.put('/integrations/:id', async (req) => {
      const { id } = idParam.parse(req.params);
      const { integration, created } = await upsertIntegration({ ...(req.body as object), identifier: id });
      await audit(actorOf(req.principal), created ? 'integration.created' : 'integration.updated', id);
      return integration;
    });
    admin.delete('/integrations/:id', async (req) => {
      const { id } = idParam.parse(req.params);
      const q = z.object({ deleteEntities: z.enum(['true', 'false']).default('false') }).parse(req.query);
      await deleteIntegration(id, { deleteEntities: q.deleteEntities === 'true' });
      await audit(actorOf(req.principal), 'integration.deleted', id, { deleteEntities: q.deleteEntities === 'true' });
      return { ok: true };
    });
    admin.post('/integrations/:id/sync', async (req, reply) => {
      const { id } = idParam.parse(req.params);
      const { kind } = z.object({ kind: z.string().min(1).max(100).optional() }).parse(req.query);
      await requestSync(id, kind);
      await audit(actorOf(req.principal), 'integration.sync_requested', id, kind ? { kind } : undefined);
      return reply.code(202).send({ queued: true });
    });

    /** Test the connection: fetch one page per kind (nothing is written). */
    /**
     * Test connection (integration editor): validate an unsaved configuration, fetch the first page of `kind` and return up
     * to three raw items, so mappings can be previewed against real data. Nothing is written.
     */
    admin.post('/integrations/test', async (req) => {
      const body = z.object({ type: z.string(), config: z.record(z.string(), z.unknown()).default({}), kind: z.string().default('item') }).parse(req.body);
      try {
        const source = getSource(body.type);
        const config = (await render(body.config, { integration: { identifier: 'test' } }, resolveRef)).value as Record<string, unknown>;
        source.validate(config);
        if (!source.list) return { ok: true, sample: [], note: 'This source receives pushed events: nothing to fetch.' };
        const log: string[] = [];
        const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Timed out after 20 s')), 20_000).unref());
        const first = (async () => {
          for await (const page of source.list!(body.kind, {
            config,
            log: (l) => log.push(l),
            setState: () => undefined,
            incomplete: () => undefined,
            startedAt: new Date().toISOString(),
          }))
            return page.slice(0, 3);
          return [];
        })();
        return { ok: true, sample: await Promise.race([first, timeout]), log };
      } catch (err) {
        return { ok: false, sample: [], error: (err as Error).message };
      }
    });

    admin.post('/integrations/:id/test', async (req) => {
      const { id } = idParam.parse(req.params);
      return testIntegration(id);
    });

    /** Try a mapping on a sample item without writing anything (mapping editor). */
    admin.post('/mappings/preview', async (req) => {
      const body = z.object({ mapping: mappingDef, item: z.unknown(), headers: z.record(z.string(), z.unknown()).default({}) }).parse(req.body);
      await audit(actorOf(req.principal), 'integration.mapping_previewed', null);
      return mapItem(body.mapping, body.item, { headers: body.headers, integration: { identifier: 'preview', config: {} } });
    });
  });
}
