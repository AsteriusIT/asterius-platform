import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit.js';
import { actorOf, requireAdmin, requireUser } from '../auth/users.js';
import {
  deleteInitiative,
  grantExemption,
  initiativeDetail,
  initiativeEntities,
  initiativeViews,
  listExemptions,
  myInitiativeItems,
  revokeExemption,
  upsertInitiative,
  visibleInitiative,
} from '../catalog/initiatives.js';
import { idParam } from './util.js';

/**
 * Scorecard initiatives. Everyone reads those on blueprints they can read; admins define them; admins and the owner
 * of an initiative grant exemptions. `GET /me/initiatives` lists the failing entities of the caller's teams (To do).
 */
export async function initiativeRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireUser);
  app.get('/initiatives', async (req) => initiativeViews(req.principal));
  app.get('/initiatives/:id', async (req) => initiativeDetail(req.principal, idParam.parse(req.params).id));
  app.get('/initiatives/:id/entities', async (req) => {
    const { id } = idParam.parse(req.params);
    const q = z.object({ status: z.enum(['failing', 'passing', 'exempt', 'all']).default('all'), team: z.string().max(64).optional() }).parse(req.query);
    return initiativeEntities(req.principal, id, q.status, q.team);
  });
  app.put('/initiatives/:id', { preHandler: requireAdmin }, async (req) => {
    const { id } = idParam.parse(req.params);
    const { initiative, created } = await upsertInitiative({ ...(req.body as object), identifier: id });
    await audit(actorOf(req.principal), created ? 'initiative.created' : 'initiative.updated', id);
    return initiative;
  });
  app.delete('/initiatives/:id', { preHandler: requireAdmin }, async (req) => {
    const { id } = idParam.parse(req.params);
    await deleteInitiative(id);
    await audit(actorOf(req.principal), 'initiative.deleted', id);
    return { ok: true };
  });
  app.get('/initiatives/:id/exemptions', async (req) => {
    const { id } = idParam.parse(req.params);
    await visibleInitiative(req.principal, id);
    return listExemptions(id);
  });
  app.post('/initiatives/:id/exemptions', async (req) => grantExemption(req.principal, idParam.parse(req.params).id, req.body));
  app.delete('/initiatives/:id/exemptions/:exemption', async (req) => {
    const { id, exemption } = idParam.extend({ exemption: z.string().min(1).max(100) }).parse(req.params);
    await revokeExemption(req.principal, id, exemption);
    return { ok: true };
  });
  app.get('/me/initiatives', async (req) => myInitiativeItems(req.principal));
}
