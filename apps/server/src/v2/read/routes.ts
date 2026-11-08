import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { isAdmin, requireUser } from '../../auth/users.js';
import { getRun } from '../../actions/runs.js';
import { canRead } from '../../catalog/entities.js';
import { idParam } from '../../routes/util.js';
import { buildTimeline, dropCachedTimeline } from './timeline.js';

/**
 * V2 read side (docs/V2-READ-SIDE.md):
 *   GET /api/v1/runs/:id/timeline   ordered events of a run (portal steps, catalog transitions, Loki logs, Tempo traces);
 *                                   `?refresh=true` (admins) drops the cached copy and rebuilds it.
 */
export async function v2ReadRoutes(app: FastifyInstance) {
  await app.register(async (scoped) => {
    scoped.addHook('preHandler', requireUser);
    scoped.get('/runs/:id/timeline', async (req) => {
      const { id } = idParam.parse(req.params);
      const q = z.object({ refresh: z.enum(['true', 'false']).optional() }).parse(req.query);
      const r = await getRun(id, req.principal, { logs: false }); // 404 unless the caller may see the run
      if (q.refresh === 'true' && isAdmin(req.principal)) await dropCachedTimeline(id);
      return buildTimeline(r, { canSeeEntity: (e) => canRead(req.principal, e) });
    });
  });
}
