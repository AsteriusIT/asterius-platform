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
import { ingest, renderConfig, verifyWebhook } from '../integrations/sync.js';
import { getSource } from '../integrations/sources/index.js';
import { mapItem } from '../integrations/mapping.js';
import { mappingDef } from '../schemas.js';
import { render } from '../lib/expr.js';
import { resolveRef } from '../secrets.js';
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
  app.post('/ingest/:id', { config: { rateLimit: { max: 600, timeWindow: '1 minute' } } }, async (req, reply) => {
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
    if (!verifyWebhook(cfg, req.headers, req.rawBody ?? JSON.stringify(req.body ?? null))) return reply.code(401).send({ error: 'invalid signature or token' });
    const headers = Object.fromEntries(Object.entries(req.headers).filter(([k]) => !['authorization', 'cookie', 'x-asterius-token'].includes(k)));
    return ingest(r, req.body, headers);
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
      await requestSync(id);
      await audit(actorOf(req.principal), 'integration.sync_requested', id);
      return reply.code(202).send({ queued: true });
    });

    /**
     * Test connection (integration editor): validate the configuration, fetch the first page of `kind` and return up to
     * three raw items, so mappings can be previewed against real data. Nothing is written.
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
          for await (const page of source.list!(body.kind, { config, log: (l) => log.push(l) })) return page.slice(0, 3);
          return [];
        })();
        return { ok: true, sample: await Promise.race([first, timeout]), log };
      } catch (err) {
        return { ok: false, sample: [], error: (err as Error).message };
      }
    });

    /** Try a mapping on a sample item without writing anything (mapping editor). */
    admin.post('/mappings/preview', async (req) => {
      const body = z.object({ mapping: mappingDef, item: z.unknown(), headers: z.record(z.string(), z.unknown()).default({}) }).parse(req.body);
      return mapItem(body.mapping, body.item, { headers: body.headers, integration: { identifier: 'preview', config: {} } });
    });
  });
}
