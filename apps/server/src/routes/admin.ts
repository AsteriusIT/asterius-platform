import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit, listAudit } from '../audit.js';
import {
  actorOf,
  createApiToken,
  createServiceAccount,
  deleteApiToken,
  isAdmin,
  listApiTokens,
  listUsers,
  publicUser,
  requireAdmin,
  requireUser,
  updateUser,
} from '../auth/users.js';
import { deleteTeam, listTeams, upsertTeam } from '../auth/teams.js';
import { deleteSecret, listSecrets, setSecret, shortSecretWarning } from '../secrets.js';
import { deleteWebhook, getWebhook, listDeliveries, listWebhooks, redeliver, upsertWebhook } from '../webhooks/webhooks.js';
import { exportConfig, managedCounts } from '../config-loader.js';
import { config } from '../config.js';
import { idParam, page } from './util.js';
import { badRequest } from '../lib/errors.js';

export async function adminRoutes(app: FastifyInstance, opts: { reloadConfig: () => Promise<void> }) {
  // ---- for every signed-in user ----
  await app.register(async (user) => {
    user.addHook('preHandler', requireUser);
    user.get('/teams', async () => listTeams());
    user.get('/users/lookup', async () => (await listUsers()).filter((u) => u.active).map(({ id, name, email }) => ({ id, name, email })));

    // Personal API tokens (admins: every token with ?all=true)
    user.get('/tokens', async (req) => {
      const all = (req.query as { all?: string }).all === 'true' && isAdmin(req.principal);
      return listApiTokens(all ? undefined : req.principal.id);
    });
    user.post('/tokens', async (req, reply) => {
      const body = z.object({ name: z.string().min(1).max(100), expiresInDays: z.number().int().min(1).max(730).nullish() }).parse(req.body);
      const t = await createApiToken({ name: body.name, userId: req.principal.id, createdBy: req.principal.id, expiresInDays: body.expiresInDays ?? 90 });
      await audit(actorOf(req.principal), 'token.created', body.name, { tokenId: t.id });
      return reply.code(201).send(t);
    });
    user.delete('/tokens/:id', async (req) => {
      const { id } = idParam.parse(req.params);
      await deleteApiToken(id, isAdmin(req.principal) ? undefined : req.principal.id);
      await audit(actorOf(req.principal), 'token.revoked', id);
      return { ok: true };
    });
  });

  // ---- admins ----
  await app.register(async (admin) => {
    admin.addHook('preHandler', requireAdmin);

    admin.get('/users', async () => listUsers());
    admin.patch('/users/:id', async (req) => {
      const { id } = idParam.parse(req.params);
      const body = z
        .object({ role: z.enum(['admin', 'member']).optional(), active: z.boolean().optional(), teams: z.array(z.string()).optional() })
        .parse(req.body);
      if (id === req.principal.id && (body.role === 'member' || body.active === false)) throw badRequest('You cannot demote or disable yourself');
      const u = await updateUser(id, body);
      await audit(actorOf(req.principal), 'user.updated', u.email, body);
      return u;
    });
    /** Service accounts: non-human identities for CI pipelines and scripts (API tokens only). */
    admin.post('/service-accounts', async (req, reply) => {
      const body = z
        .object({
          name: z.string().min(1).max(100),
          role: z.enum(['admin', 'member']).default('member'),
          teams: z.array(z.string()).default([]),
          expiresInDays: z.number().int().min(1).max(730).nullish(),
        })
        .parse(req.body);
      const sa = await createServiceAccount(body.name, body.role);
      if (body.teams.length) await updateUser(sa.id, { teams: body.teams });
      const t = await createApiToken({ name: `${body.name} token`, userId: sa.id, createdBy: req.principal.id, expiresInDays: body.expiresInDays ?? null });
      await audit(actorOf(req.principal), 'service_account.created', body.name, { role: body.role });
      return reply.code(201).send({ user: await publicUser(sa), token: t.token });
    });

    admin.put('/teams/:id', async (req) => {
      const { id } = idParam.parse(req.params);
      const { created } = await upsertTeam({ ...(req.body as object), identifier: id });
      await audit(actorOf(req.principal), created ? 'team.created' : 'team.updated', id);
      return (await listTeams()).find((t) => t.identifier === id);
    });
    admin.delete('/teams/:id', async (req) => {
      const { id } = idParam.parse(req.params);
      await deleteTeam(id);
      await audit(actorOf(req.principal), 'team.deleted', id);
      return { ok: true };
    });

    admin.get('/secrets', async () => listSecrets());
    admin.put('/secrets/:id', async (req) => {
      const { id } = idParam.parse(req.params);
      const body = z.object({ value: z.string().min(1).max(64_000), description: z.string().max(500).default('') }).parse(req.body);
      await setSecret(id, body.value, body.description, req.principal.id);
      await audit(actorOf(req.principal), 'secret.set', id);
      return { ok: true, warning: shortSecretWarning(body.value) };
    });
    admin.delete('/secrets/:id', async (req) => {
      const { id } = idParam.parse(req.params);
      await deleteSecret(id);
      await audit(actorOf(req.principal), 'secret.deleted', id);
      return { ok: true };
    });

    admin.get('/webhooks', async () => listWebhooks());
    admin.get('/webhooks/:id', async (req) => {
      const { secret, secondarySecret, ...w } = await getWebhook(idParam.parse(req.params).id);
      return { ...w, secret: secret ?? null, secondarySecret: secondarySecret ?? null }; // references (${secret:NAME}), never values
    });
    admin.put('/webhooks/:id', async (req) => {
      const { id } = idParam.parse(req.params);
      const { webhook, created } = await upsertWebhook({ ...(req.body as object), identifier: id });
      await audit(actorOf(req.principal), created ? 'webhook.created' : 'webhook.updated', id);
      return webhook;
    });
    admin.delete('/webhooks/:id', async (req) => {
      const { id } = idParam.parse(req.params);
      await deleteWebhook(id);
      await audit(actorOf(req.principal), 'webhook.deleted', id);
      return { ok: true };
    });
    admin.get('/webhooks/:id/deliveries', async (req) => listDeliveries(idParam.parse(req.params).id));
    admin.post('/deliveries/:id/redeliver', async (req) => {
      await redeliver(idParam.parse(req.params).id);
      return { ok: true };
    });

    admin.get('/audit', async (req) => listAudit(page.extend({ search: z.string().max(200).optional() }).parse(req.query)));

    admin.get('/config', async () => ({ dir: config.CONFIG_DIR, managed: await managedCounts() }));
    admin.get('/config/export', async (_req, reply) => reply.type('text/yaml; charset=utf-8').send(await exportConfig()));
    admin.post('/config/reload', async (req) => {
      await opts.reloadConfig();
      await audit(actorOf(req.principal), 'config.reload_requested', config.CONFIG_DIR);
      return { ok: true };
    });
  });
}
