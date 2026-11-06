import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit.js';
import { actorOf, requireAdmin, requireUser } from '../auth/users.js';
import { mailConfigured, postSlack, postTeams, sendMail } from '../notifications/channels.js';
import { getPrefs, listNotifications, markRead, setPrefs } from '../inbox.js';
import { page } from './util.js';
import { getNotificationPrefs, getNotificationSettings, setNotificationPrefs, setNotificationSettings } from '../notifications/settings.js';

export async function notificationRoutes(app: FastifyInstance) {
  await app.register(async (scoped) => {
    scoped.addHook('preHandler', requireUser);

    /** What can be delivered at all: lets the profile page hide channels that are not set up. */
    scoped.get('/notifications/channels', async () => {
      const s = await getNotificationSettings();
      return { email: await mailConfigured(), slack: !!s.slack.botToken };
    });
    // In-app inbox (bell icon): one row per (user, event), see inbox.ts.
    scoped.get('/notifications', async (req) => {
      const q = page.extend({ unread: z.enum(['true', 'false']).optional() }).parse(req.query);
      return listNotifications(req.principal.id, { unread: q.unread === 'true', limit: q.limit, offset: q.offset });
    });
    scoped.post('/notifications/read', async (req) => {
      const body = z.object({ ids: z.array(z.string()).max(200).optional(), all: z.boolean().optional() }).parse(req.body ?? {});
      return { changed: await markRead(req.principal.id, body.all ? 'all' : (body.ids ?? [])) };
    });
    scoped.get('/notifications/preferences', async (req) => getPrefs(req.principal.id));
    scoped.put('/notifications/preferences', async (req) => setPrefs(req.principal.id, z.object({ email: z.boolean(), slack: z.boolean() }).parse(req.body)));
    scoped.get('/me/notifications', async (req) => getNotificationPrefs(req.principal.id));
    scoped.put('/me/notifications', async (req) => setNotificationPrefs(req.principal.id, req.body));

    scoped.get('/notification-settings', { preHandler: requireAdmin }, async () => getNotificationSettings());
    scoped.put('/notification-settings', { preHandler: requireAdmin }, async (req) => {
      const s = await setNotificationSettings(req.body);
      await audit(actorOf(req.principal), 'notification_settings.updated', null);
      return s;
    });
    /** Send a test message through one channel, to check the settings. */
    scoped.post('/notification-settings/test', { preHandler: requireAdmin, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => {
      const body = z.object({ channel: z.enum(['slack', 'teams', 'email']), to: z.string().max(200).optional() }).parse(req.body ?? {});
      const text = `Test notification from Asterius Platform, requested by ${req.principal.name}.`;
      if (body.channel === 'slack') await postSlack({}, { text });
      else if (body.channel === 'teams') await postTeams(undefined, { title: 'Asterius Platform', text });
      else await sendMail({ to: [body.to ?? req.principal.email], subject: 'Asterius Platform test', text });
      return { ok: true };
    });
  });
}
