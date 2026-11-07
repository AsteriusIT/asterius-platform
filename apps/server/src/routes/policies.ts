import type { FastifyInstance } from 'fastify';
import { audit } from '../audit.js';
import { actorOf, requireAdmin } from '../auth/users.js';
import { deletePolicy, getPolicy, listPolicies, upsertPolicy } from '../policies/policies.js';
import { idParam } from './util.js';

/** Policy gate definitions (admins only: they describe the guard rails). */
export async function policyRoutes(app: FastifyInstance) {
  app.get('/policies', { preHandler: requireAdmin }, async () => listPolicies());
  app.get('/policies/:id', { preHandler: requireAdmin }, async (req) => getPolicy(idParam.parse(req.params).id));
  app.put('/policies/:id', { preHandler: requireAdmin }, async (req) => {
    const { id } = idParam.parse(req.params);
    const { policy, created } = await upsertPolicy({ ...(req.body as object), identifier: id });
    await audit(actorOf(req.principal), created ? 'policy.created' : 'policy.updated', id);
    return policy;
  });
  app.delete('/policies/:id', { preHandler: requireAdmin }, async (req) => {
    const { id } = idParam.parse(req.params);
    await deletePolicy(id);
    await audit(actorOf(req.principal), 'policy.deleted', id);
    return { ok: true };
  });
}
