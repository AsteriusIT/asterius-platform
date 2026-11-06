import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { Readable } from 'node:stream';
import { audit, auditFacets, CSV_HEADER, csvRow, exportAudit, listAudit, verifyAuditChain } from '../audit.js';
import { nextPageHeaders } from '../lib/cursor.js';
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
  tokenLifetime,
  updateUser,
} from '../auth/users.js';
import { deleteTeam, listTeams, upsertTeam } from '../auth/teams.js';
import { providerInfos } from '../secret-providers/index.js';
import { deleteSecret, listSecrets, reencryptSecrets, setSecret, shortSecretWarning } from '../secrets.js';
import {
  deleteWebhook,
  getWebhook,
  listDeliveries,
  listWebhooks,
  redeliver,
  redeliverFailed,
  redeliverMany,
  upsertWebhook,
  queueTestDelivery,
} from '../webhooks/webhooks.js';
import { configDiff, configStatus, exportConfig, importConfig, managedCounts, planConfig } from '../config-loader.js';
import { config } from '../config.js';
import { idParam, page } from './util.js';
import { badRequest, errorMessage, forbidden } from '../lib/errors.js';
import { grants, ipAllowSchema, scopeSchema, SCOPES } from '../auth/scopes.js';
import { roleName } from '../schemas.js';
import { exportArchive, importArchive } from '../archive.js';

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
      const body = z
        .object({
          name: z.string().min(1).max(100),
          expiresInDays: z.number().int().min(1).max(730).nullish(),
          scopes: z
            .array(scopeSchema.exclude(['scim']))
            .max(SCOPES.length)
            .optional(),
          blueprints: z.array(z.string().max(64)).max(100).optional(),
          ipAllow: ipAllowSchema.optional(),
        })
        .parse(req.body);
      // A restricted token cannot mint tokens (it would escape its own restrictions): only unrestricted callers or `admin` scope.
      if (req.principal.token && (req.principal.token.blueprints || !req.principal.token.scopes?.includes('admin')))
        throw forbidden('This API token cannot create tokens');
      if (req.principal.token?.scopes && body.scopes?.some((s) => !grants(req.principal.token!.scopes!, s)))
        throw forbidden('A token cannot grant scopes it lacks');
      if (!isAdmin(req.principal) && body.scopes?.includes('admin')) throw forbidden('Only admins can create tokens with the admin scope');
      const t = await createApiToken({
        name: body.name,
        userId: req.principal.id,
        createdBy: req.principal.id,
        expiresInDays: tokenLifetime(body.expiresInDays, 90),
        scopes: body.scopes,
        blueprints: body.blueprints,
        ipAllow: body.ipAllow,
      });
      await audit(actorOf(req.principal), 'token.created', body.name, {
        tokenId: t.id,
        scopes: body.scopes ?? null,
        blueprints: body.blueprints ?? null,
        ipAllow: body.ipAllow ?? null,
      });
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
        .object({
          role: z.enum(['admin', 'member']).optional(),
          roles: z.array(roleName).max(50).optional(),
          active: z.boolean().optional(),
          teams: z.array(z.string()).optional(),
        })
        .parse(req.body);
      if (id === req.principal.id && (body.role === 'member' || body.active === false)) throw badRequest('You cannot demote or disable yourself');
      const u = await updateUser(id, body);
      await audit(actorOf(req.principal), 'user.updated', u.email, body);
      return u;
    });
    /** Service accounts: non-human identities for CI pipelines and scripts (API tokens only). */
    /** SCIM provisioning token: a dedicated service account whose token carries only the `scim` scope. */
    admin.post('/scim/token', async (req, reply) => {
      const body = z.object({ expiresInDays: z.number().int().min(1).max(730).default(365) }).parse(req.body ?? {});
      const sa = await createServiceAccount('SCIM provisioning', 'member');
      const t = await createApiToken({
        name: 'SCIM provisioning',
        userId: sa.id,
        createdBy: req.principal.id,
        expiresInDays: tokenLifetime(body.expiresInDays, 365),
        scopes: ['scim'],
      });
      await audit(actorOf(req.principal), 'scim.token_created', sa.email, { tokenId: t.id });
      return reply.code(201).send({ token: t.token, baseUrl: `${config.PUBLIC_URL}/scim/v2` });
    });
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
      const t = await createApiToken({
        name: `${body.name} token`,
        userId: sa.id,
        createdBy: req.principal.id,
        expiresInDays: tokenLifetime(body.expiresInDays, null),
      });
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
    /** External secret managers available on this deployment (with a reference example each). */
    admin.get('/secret-providers', async () => providerInfos());
    admin.post('/secrets/reencrypt', async (req) => {
      const r = await reencryptSecrets();
      await audit(actorOf(req.principal), 'secrets.reencrypted', null, { reencrypted: r.reencrypted, failed: r.failed.length });
      return r;
    });
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
    /** Queue a `webhook.test` delivery for this webhook, whatever its event subscriptions. */
    admin.post('/webhooks/:id/test', async (req) => {
      const { id } = idParam.parse(req.params);
      await getWebhook(id); // 404 when unknown
      await queueTestDelivery(id);
      return { queued: true };
    });
    admin.get('/webhooks/:id/deliveries', async (req, reply) => {
      const q = z
        .object({
          status: z.enum(['pending', 'success', 'failed']).optional(),
          limit: z.coerce.number().int().min(1).max(500).default(50),
          cursor: z.string().max(500).optional(),
          offset: z.coerce.number().int().min(0).default(0),
        })
        .parse(req.query);
      const { deliveries, nextCursor } = await listDeliveries({ ...q, webhook: idParam.parse(req.params).id });
      nextPageHeaders(req, reply, nextCursor);
      return deliveries;
    });
    admin.get('/deliveries', async (req) => {
      const q = z
        .object({
          status: z.enum(['pending', 'success', 'failed']).optional(),
          webhook: z.string().optional(),
          limit: z.coerce.number().int().min(1).max(500).default(100),
          offset: z.coerce.number().int().min(0).default(0),
        })
        .parse(req.query);
      return (await listDeliveries(q)).deliveries;
    });
    admin.post('/deliveries/redeliver', async (req) => {
      const body = z.object({ ids: z.array(z.string()).min(1).max(500) }).parse(req.body);
      const queued = await redeliverMany(body.ids);
      await audit(actorOf(req.principal), 'delivery.redelivered_bulk', 'selection', { count: queued });
      return { queued };
    });
    admin.post('/deliveries/redeliver-failed', async (req) => {
      const body = z.object({ webhook: z.string().optional() }).parse(req.body ?? {});
      const n = await redeliverFailed(body.webhook);
      await audit(actorOf(req.principal), 'delivery.redelivered_bulk', body.webhook ?? '*', { count: n });
      return { requeued: n };
    });
    admin.post('/deliveries/:id/redeliver', async (req) => {
      const { id } = idParam.parse(req.params);
      await redeliver(id);
      await audit(actorOf(req.principal), 'delivery.redelivered', id);
      return { ok: true };
    });

    // A date (2026-01-31) or a timestamp with an offset.
    const date = z
      .string()
      .max(40)
      .refine((v) => !Number.isNaN(Date.parse(v)), 'invalid date')
      .optional();
    const auditQuery = z.object({
      search: z.string().max(200).optional(),
      action: z.string().max(100).optional(),
      actor: z.string().max(200).optional(),
      target: z.string().max(200).optional(),
      from: date,
      to: date,
    });
    admin.get('/audit', async (req, reply) => {
      const { entries, nextCursor } = await listAudit(
        page
          .merge(auditQuery)
          .extend({ cursor: z.string().max(500).optional() })
          .parse(req.query),
      );
      nextPageHeaders(req, reply, nextCursor);
      return entries;
    });
    admin.get('/audit/facets', async (req) => auditFacets(auditQuery.parse(req.query)));
    /** Export with the same filters: CSV (spreadsheet-safe) or NDJSON. Exporting is itself audited. */
    admin.get('/audit/export', async (req, reply) => {
      const q = auditQuery.extend({ format: z.enum(['csv', 'json']).default('csv') }).parse(req.query);
      const { format, ...filters } = q;
      await audit(actorOf(req.principal), 'audit.exported', null, { format, ...filters });
      const rows = exportAudit(filters);
      const stream =
        format === 'csv'
          ? Readable.from(
              (async function* () {
                yield CSV_HEADER;
                for await (const e of rows) yield csvRow(e);
              })(),
            )
          : Readable.from(
              (async function* () {
                for await (const e of rows) yield `${JSON.stringify(e)}\n`;
              })(),
            );
      return reply
        .type(format === 'csv' ? 'text/csv; charset=utf-8' : 'application/x-ndjson; charset=utf-8')
        .header('content-disposition', `attachment; filename="audit.${format === 'csv' ? 'csv' : 'ndjson'}"`)
        .send(stream);
    });
    /** Recompute the hash chain (AUDIT_HASH_CHAIN): detects modified, removed or reordered entries. */
    admin.get('/audit/verify', async () => verifyAuditChain());

    admin.get('/config', async () => {
      const st = await configStatus();
      return {
        dir: config.CONFIG_DIR,
        managed: await managedCounts(),
        // Summary for the admin page header (details: /config/status and /config/plan).
        status: {
          lastCheckedAt: new Date().toISOString(),
          lastAppliedAt: st.appliedAt,
          hash: st.appliedHash ? st.appliedHash.slice(0, 12) : null,
          files: st.files.length,
          error: st.readError ?? st.errors[0] ?? null,
        },
      };
    });
    admin.get('/config/status', async () => configStatus());
    admin.get('/config/plan', async () => planConfig());
    admin.get('/config/diff', async () => configDiff());
    admin.post('/config/import', async (req) => {
      const body = z.object({ yaml: z.string().max(2_000_000), dryRun: z.boolean().default(false) }).parse(req.body);
      try {
        const counts = await importConfig(body.yaml, body.dryRun);
        if (!body.dryRun) await audit(actorOf(req.principal), 'config.imported', null, counts);
        return { ok: true, counts };
      } catch (err) {
        throw badRequest(errorMessage(err));
      }
    });
    admin.get('/config/export', async (req, reply) => {
      await audit(actorOf(req.principal), 'config.exported', null);
      return reply.type('text/yaml; charset=utf-8').send(await exportConfig());
    });
    // Portable archive (definitions + entities + secret names, never secret values) for backup / migration between environments.
    admin.get('/archive', async (req, reply) => {
      const archive = await exportArchive();
      await audit(actorOf(req.principal), 'archive.exported', null, { entities: archive.entities.length });
      return reply
        .header('content-disposition', `attachment; filename="asterius-archive-${archive.exportedAt.slice(0, 10)}.json"`)
        .type('application/json')
        .send(archive);
    });
    admin.post('/archive/import', { bodyLimit: 512 * 1024 * 1024 }, async (req) => {
      const q = z.object({ mode: z.enum(['skip', 'overwrite']).default('skip'), dryRun: z.enum(['true', 'false']).default('false') }).parse(req.query);
      let report;
      try {
        report = await importArchive(req.body, { mode: q.mode, dryRun: q.dryRun === 'true' });
      } catch (err) {
        throw badRequest(errorMessage(err));
      }
      await audit(actorOf(req.principal), 'archive.imported', null, {
        mode: q.mode,
        dryRun: report.dryRun,
        created: report.created,
        updated: report.updated,
        failed: report.failed,
      });
      return report;
    });
    admin.post('/config/reload', async (req) => {
      await opts.reloadConfig();
      await audit(actorOf(req.principal), 'config.reload_requested', config.CONFIG_DIR);
      return { ok: true };
    });
  });
}
