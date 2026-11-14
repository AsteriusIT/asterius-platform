import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit.js';
import { actorOf, requireAdmin } from '../auth/users.js';
import { badRequest } from '../lib/errors.js';
import { deletePolicy, getPolicy, listPolicies, planPolicies, upsertPolicy } from '../policies/policies.js';
import { deletePriceCatalog, getPriceCatalog, listPriceCatalogs, upsertPriceCatalog, catalogChain } from '../plan/price-catalogs.js';
import { buildOutput, runChecks } from '../plan/checks.js';
import { parsePlan } from '../plan/plan.js';
import { estimate } from '../plan/pricing.js';
import { idParam } from './util.js';

const estimateBody = z.object({ plan: z.unknown(), action: z.string().max(64).optional() });

/** Policy gate definitions and the price catalogs of plan checks (admins only: they describe the guard rails). */
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

  app.get('/price-catalogs', { preHandler: requireAdmin }, async () => listPriceCatalogs());
  app.get('/price-catalogs/:id', { preHandler: requireAdmin }, async (req) => getPriceCatalog(idParam.parse(req.params).id));
  app.put('/price-catalogs/:id', { preHandler: requireAdmin, bodyLimit: 4 * 1024 * 1024 }, async (req) => {
    const { id } = idParam.parse(req.params);
    const { catalog, created } = await upsertPriceCatalog({ ...(req.body as object), identifier: id });
    await audit(actorOf(req.principal), created ? 'price_catalog.created' : 'price_catalog.updated', id);
    return catalog;
  });
  app.delete('/price-catalogs/:id', { preHandler: requireAdmin }, async (req) => {
    const { id } = idParam.parse(req.params);
    await deletePriceCatalog(id);
    await audit(actorOf(req.principal), 'price_catalog.deleted', id);
    return { ok: true };
  });
  // Try a catalog (and the organization's plan policies) on a plan, without a run: what a plan-check step would report.
  app.post('/price-catalogs/:id/estimate', { preHandler: requireAdmin, bodyLimit: 26 * 1024 * 1024 }, async (req) => {
    const { id } = idParam.parse(req.params);
    const body = estimateBody.parse(req.body);
    let plan;
    try {
      plan = parsePlan(body.plan);
    } catch (err) {
      throw badRequest((err as Error).message);
    }
    const est = estimate(plan, await catalogChain(id).catch((err: Error) => Promise.reject(badRequest(err.message))));
    const violations = await runChecks(plan, est, {
      rules: [],
      policies: await planPolicies(body.action ?? ''),
      context: {
        inputs: {},
        action: body.action ? { identifier: body.action } : null,
        principal: { id: req.principal.id, email: req.principal.email },
        entity: null,
      },
    });
    return buildOutput(plan, est, violations, { onWarning: 'override', maxResources: 500 });
  });
}
