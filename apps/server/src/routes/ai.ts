import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit.js';
import { actorOf, requireAdmin, requireUser } from '../auth/users.js';
import { aiConfigured } from '../ai/model.js';
import { config } from '../config.js';
import { deleteBudget, deletePrice, listBudgets, listPrices, setPrice, upsertBudget, usageReport } from '../ai/usage.js';
import { idParam } from './util.js';

/** AI endpoints: status for everyone, governance (usage, prices, budgets) for admins. */
export async function aiRoutes(app: FastifyInstance) {
  await app.register(async (user) => {
    user.addHook('preHandler', requireUser);
    user.get('/ai/status', async () => ({ enabled: aiConfigured(), provider: config.AI_PROVIDER, assistantModel: config.AI_ASSISTANT_MODEL }));
  });

  await app.register(async (admin) => {
    admin.addHook('preHandler', requireAdmin);

    admin.get('/ai/usage', async (req) => {
      const q = z.object({ since: z.string().datetime().optional() }).parse(req.query);
      return usageReport(q.since);
    });

    admin.get('/ai/prices', async () => listPrices());
    admin.put('/ai/prices/:model', async (req) => {
      const { model } = z.object({ model: z.string().min(1).max(100) }).parse(req.params);
      await setPrice(model, req.body);
      await audit(actorOf(req.principal), 'ai.price_set', model);
      return listPrices();
    });
    admin.delete('/ai/prices/:model', async (req) => {
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
