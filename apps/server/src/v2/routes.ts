import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ObjectSchema } from '@asterius/shared';
import { getAction } from '../actions/actions.js';
import { requireAdmin, requireUser } from '../auth/users.js';
import { badRequest } from '../lib/errors.js';
import { xrdFormSource } from '../schemas.js';
import { previewAction } from './preview.js';
import { clearXrdCache, resolveXrdInputs } from './xrd.js';

/** V2 write-side endpoints (under /api/v1). See docs/V2-WRITE-SIDE.md. */
export async function v2Routes(app: FastifyInstance) {
  await app.register(async (scoped) => {
    scoped.addHook('preHandler', requireUser);

    /** Preview of a run of an action with a `service-precheck` step: the spec, the policy result, the resources. */
    scoped.post('/actions/:id/preview', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req) => {
      const { id } = z.object({ id: z.string().min(1).max(200) }).parse(req.params);
      const body = z.object({ entity: z.string().nullish(), inputs: z.record(z.string(), z.unknown()).default({}) }).parse(req.body ?? {});
      return previewAction(req.principal, id, body);
    });

    /**
     * The form generated from the XRD (admin): for an action (`?action=`), or for an ad-hoc source (POST body), with
     * the source status. `refresh=true` drops the cache first.
     */
    scoped.get('/v2/xrd-form', { preHandler: requireAdmin }, async (req) => {
      const q = z.object({ action: z.string().min(1).max(200), refresh: z.enum(['true', 'false']).optional() }).parse(req.query);
      if (q.refresh === 'true') clearXrdCache();
      const a = await getAction(q.action);
      const t = a.trigger;
      if (t?.type !== 'form' && t?.type !== 'api') throw badRequest('This action has no form');
      return { action: a.identifier, inputs: t.inputs, xrd: (t.inputs as { xrd?: unknown }).xrd ?? null };
    });
    scoped.post('/v2/xrd-form', { preHandler: requireAdmin, config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req) => {
      const b = z
        .object({ fromXrd: xrdFormSource, properties: z.record(z.string(), z.unknown()).default({}), refresh: z.boolean().default(false) })
        .parse(req.body ?? {});
      if (b.refresh) clearXrdCache();
      return resolveXrdInputs({ properties: b.properties as ObjectSchema['properties'], fromXrd: b.fromXrd });
    });
  });
}
