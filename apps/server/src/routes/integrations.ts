import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit.js';
import { actorOf, requireAdmin } from '../auth/users.js';
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
import { ingest, renderConfig, testIntegration, verifyWebhook } from '../integrations/sync.js';
import { getSource } from '../integrations/sources/index.js';
import { mapItem } from '../integrations/mapping.js';
import { mappingDef } from '../schemas.js';
import { idParam } from './util.js';

declare module 'fastify' {
  interface FastifyRequest {
    rawBody?: string;
  }
}

export async function integrationRoutes(app: FastifyInstance) {
  /**
   * Inbound webhook ingestion (third parties → catalog). Authenticated by the integration's secret:
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
    hooks.post('/ingest/:id', { config: { rateLimit: { max: 600, timeWindow: '1 minute' } } }, async (req, reply) => {
      const { id } = idParam.parse(req.params);
      const r = await getIntegrationRow(id).catch(() => undefined);
      if (!r || !getSource(r.type).push) return reply.code(404).send({ error: 'not found' });
      if (!bool(r.enabled)) return reply.code(409).send({ error: 'integration disabled' });
      let cfg: Record<string, unknown>;
      try {
        cfg = await renderConfig(r);
      } catch (err) {
        req.log.warn({ err, integration: id }, 'webhook integration misconfigured');
        return reply.code(503).send({ error: `Integration "${id}" is misconfigured: ${(err as Error).message}` });
      }
      const contentType = String(req.headers['content-type'] ?? 'application/json');
      const raw = req.rawBody ?? (typeof req.body === 'string' ? req.body : JSON.stringify(req.body ?? null));
      if (!verifyWebhook(cfg, req.headers, raw)) return reply.code(401).send({ error: 'invalid signature or token' });
      const headers = Object.fromEntries(
        Object.entries(req.headers).filter(([k]) => !['authorization', 'cookie', 'x-asterius-token', 'x-gitlab-token'].includes(k)),
      );
      let body: unknown;
      try {
        body = decodeBody(contentType, raw);
      } catch {
        return reply.code(400).send({ error: 'payload cannot be decoded for its content type' });
      }
      // Slack's endpoint verification handshake.
      if (cfg.preset === 'slack' && (body as { type?: string } | null)?.type === 'url_verification')
        return { challenge: (body as { challenge?: string }).challenge };
      if (Array.isArray(body) && body.length > MAX_ITEMS_PER_EVENT) return reply.code(413).send({ error: `at most ${MAX_ITEMS_PER_EVENT} items per request` });
      if (cfg.sync === true) return ingest(r, body, headers);
      const eventId = await enqueueInbound(id, headers, contentType, raw);
      return reply.code(202).send({ queued: true, id: eventId });
    });
  });

  await app.register(async (admin) => {
    admin.addHook('preHandler', requireAdmin);

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
    admin.post('/integrations/:id/test', async (req) => {
      const { id } = idParam.parse(req.params);
      return testIntegration(id);
    });

    /** Try a mapping on a sample item without writing anything (mapping editor). */
    admin.post('/mappings/preview', async (req) => {
      const body = z.object({ mapping: mappingDef, item: z.unknown(), headers: z.record(z.string(), z.unknown()).default({}) }).parse(req.body);
      return mapItem(body.mapping, body.item, { headers: body.headers, integration: { identifier: 'preview', config: {} } });
    });
  });
}
