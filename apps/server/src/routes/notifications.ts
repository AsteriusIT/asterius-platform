import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireUser } from '../auth/users.js';
import { getPrefs, listNotifications, markRead, setPrefs } from '../notifications.js';
import { page } from './util.js';

export async function notificationRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireUser);

  app.get('/notifications', async (req) => {
    const q = page.extend({ unread: z.enum(['true', 'false']).optional() }).parse(req.query);
    return listNotifications(req.principal.id, { unread: q.unread === 'true', limit: q.limit, offset: q.offset });
  });

  app.post('/notifications/read', async (req) => {
    const body = z.object({ ids: z.array(z.string()).max(200).optional(), all: z.boolean().optional() }).parse(req.body ?? {});
    const changed = await markRead(req.principal.id, body.all ? 'all' : (body.ids ?? []));
    return { changed };
  });

  app.get('/notifications/preferences', async (req) => getPrefs(req.principal.id));
  app.put('/notifications/preferences', async (req) => {
    const body = z.object({ email: z.boolean(), slack: z.boolean() }).parse(req.body);
    return setPrefs(req.principal.id, body);
  });
}
