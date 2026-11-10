import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireUser } from '../auth/users.js';
import { createView, deleteView, getPreferences, getView, listViews, setPreferences, updateView } from '../preferences.js';
import { idParam } from './util.js';

/** Per-user preferences and saved catalog views (see preferences.ts). */
export async function preferenceRoutes(app: FastifyInstance) {
  await app.register(async (scoped) => {
    scoped.addHook('preHandler', requireUser);

    scoped.get('/me/preferences', async (req) => getPreferences(req.principal.id));
    /** Partial update: each given key is replaced, `null` removes it. */
    scoped.put('/me/preferences', async (req) => setPreferences(req.principal.id, req.body ?? {}));

    /** My views and the views shared with my teams (`all=true`: admins list every view of the organization). */
    scoped.get('/views', async (req) => {
      const q = z.object({ blueprint: z.string().max(64).optional(), all: z.enum(['true', 'false']).optional() }).parse(req.query);
      return listViews(req.principal, { blueprint: q.blueprint, all: q.all === 'true' });
    });
    scoped.get('/views/:id', async (req) => getView(req.principal, idParam.parse(req.params).id));
    scoped.post('/views', async (req, reply) => reply.code(201).send(await createView(req.principal, req.body)));
    scoped.put('/views/:id', async (req) => updateView(req.principal, idParam.parse(req.params).id, req.body));
    scoped.delete('/views/:id', async (req) => {
      await deleteView(req.principal, idParam.parse(req.params).id);
      return { ok: true };
    });
  });
}
