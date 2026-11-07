import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit.js';
import { actorOf, requireAdmin, requireSuperadmin, requireUser } from '../auth/users.js';
import { aiConfigured } from '../ai/model.js';
import { askCatalog, draftBlueprint, draftWorkflow, explainRun, suggestMapping } from '../ai/assist.js';
import { badRequest, notFound } from '../lib/errors.js';
import { getReview, listReviews, reviewIdParam, runReview } from '../ai/review.js';
import { config } from '../config.js';
import { deleteBudget, deletePrice, listBudgets, listPrices, setPrice, upsertBudget, usageReport } from '../ai/usage.js';
import { idParam } from './util.js';

/** AI endpoints: status for everyone, governance (usage, budgets) for organization admins, model prices for super-admins. */
export async function aiRoutes(app: FastifyInstance) {
  await app.register(async (user) => {
    user.addHook('preHandler', requireUser);
    user.get('/ai/status', async () => ({ enabled: aiConfigured(), provider: config.AI_PROVIDER, assistantModel: config.AI_ASSISTANT_MODEL }));

    // Assistants cost money: tight rate limits on top of the budgets.
    const limit = { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } };
    user.post('/ai/ask', limit, async (req) => {
      const { question } = z.object({ question: z.string().trim().min(3).max(2000) }).parse(req.body);
      return askCatalog(req.principal, question);
    });
    user.post('/ai/runs/:id/explain', limit, async (req) => {
      const { id } = idParam.parse(req.params);
      const { mode } = z.object({ mode: z.enum(['explain', 'summarise']).default('explain') }).parse(req.body ?? {});
      return explainRun(req.principal, id, mode);
    });
  });

  // Authoring helpers produce drafts of admin-only resources: nothing is saved, the form shows the draft for review.
  await app.register(async (author) => {
    author.addHook('preHandler', requireAdmin);
    const limit = { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } };
    author.post('/ai/suggest-mapping', limit, async (req) => {
      const b = z.object({ sample: z.unknown(), blueprint: z.string().min(1).max(64), hint: z.string().max(2000).optional() }).parse(req.body);
      if (b.sample === undefined) throw badRequest('sample is required');
      return suggestMapping(req.principal, { sample: b.sample, blueprint: b.blueprint, hint: b.hint });
    });
    author.post('/ai/draft-blueprint', limit, async (req) => {
      const b = z.object({ sample: z.unknown().optional(), description: z.string().max(4000).optional() }).parse(req.body);
      return draftBlueprint(req.principal, b);
    });
    author.post('/ai/draft-workflow', limit, async (req) => {
      const b = z.object({ description: z.string().trim().min(5).max(4000) }).parse(req.body);
      return draftWorkflow(req.principal, b);
    });
  });

  await app.register(async (admin) => {
    admin.addHook('preHandler', requireAdmin);

    admin.get('/ai/usage', async (req) => {
      const q = z.object({ since: z.string().datetime().optional() }).parse(req.query);
      return usageReport(q.since);
    });

    admin.get('/ai/reviews', async () => listReviews());
    admin.get('/ai/reviews/:id', async (req) => {
      const r = await getReview(reviewIdParam.parse(req.params).id);
      if (!r) throw notFound('Review');
      return r;
    });
    admin.post('/ai/reviews/run', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (req) => runReview('manual', actorOf(req.principal)));

    admin.get('/ai/prices', async () => listPrices());
    // Prices are the platform's (every organization's costs): super-admins edit them.
    admin.put('/ai/prices/:model', { preHandler: requireSuperadmin }, async (req) => {
      const { model } = z.object({ model: z.string().min(1).max(100) }).parse(req.params);
      await setPrice(model, req.body);
      await audit(actorOf(req.principal), 'ai.price_set', model);
      return listPrices();
    });
    admin.delete('/ai/prices/:model', { preHandler: requireSuperadmin }, async (req) => {
      const { model } = z.object({ model: z.string().min(1).max(100) }).parse(req.params);
      await deletePrice(model);
      await audit(actorOf(req.principal), 'ai.price_deleted', model);
      return listPrices();
    });

    admin.get('/ai/budgets', async () => listBudgets());
    admin.put('/ai/budgets', async (req) => {
      const b = await upsertBudget(req.body);
      await audit(actorOf(req.principal), 'ai.budget_set', `${b.scope}:${b.key}`, { softUsd: b.softUsd, hardUsd: b.hardUsd });
      return b;
    });
    admin.delete('/ai/budgets/:id', async (req) => {
      const { id } = idParam.parse(req.params);
      await deleteBudget(id);
      await audit(actorOf(req.principal), 'ai.budget_deleted', id);
      return { ok: true };
    });
  });
}
