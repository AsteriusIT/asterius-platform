import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit.js';
import { actorOf, requireAdmin, requireUser } from '../auth/users.js';
import { mailConfigured, postSlack, postTeams, sendMail } from '../notifications/channels.js';
import { getNotificationPrefs, getNotificationSettings, setNotificationPrefs, setNotificationSettings } from '../notifications/settings.js';

export async function notificationRoutes(app: FastifyInstance) {
  await app.register(async (scoped) => {
    scoped.addHook('preHandler', requireUser);

    /** What can be delivered at all: lets the profile page hide channels that are not set up. */
    scoped.get('/notifications/channels', async () => {
      const s = await getNotificationSettings();
      return { email: await mailConfigured(), slack: !!s.slack.botToken };
    });
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
