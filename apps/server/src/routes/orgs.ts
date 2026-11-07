import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit.js';
import { config } from '../config.js';
import { one } from '../db.js';
import { badRequest, forbidden, notFound } from '../lib/errors.js';
import { actorOf, requireAccount, requireAdmin, requireSuperadmin, requireUser, type UserRow } from '../auth/users.js';
import {
  kcAddMember,
  kcAddProvider,
  kcCreateOrganization,
  kcDeleteOrganization,
  kcInvite,
  kcListProviders,
  kcRemoveMember,
  kcRemoveProvider,
  kcUpdateOrganization,
  keycloakEnabled,
  clearSsoRoutes,
} from '../auth/keycloak.js';
import {
  addMember,
  configSourceInput,
  createOrg,
  deleteOrg,
  getOrg,
  listMembers,
  listMyOrgs,
  listOrgRows,
  orgInput,
  patchSettings,
  removeMember,
  setMemberRole,
  settingsOf,
  toOrganization,
  updateOrg,
  verifiedDomains,
  verifyDomain,
} from '../orgs/orgs.js';
import { orgId } from '../orgs/context.js';
import { forgetGitSource } from '../orgs/git-source.js';

/**
 * Organizations: listing and creation (any signed-in account, per ORG_CREATION), the current organization's settings,
 * members, configuration-as-code source and SSO (admins of the organization), and every organization (super-admins).
 */
export async function orgRoutes(app: FastifyInstance, opts: { reloadConfig: (org?: string) => Promise<void> }) {
  const current = async () => getOrg(orgId());

  // ---- account level (no organization needed) ----
  await app.register(async (acct) => {
    acct.addHook('preHandler', requireAccount);

    acct.get('/api/orgs', async (req) => {
      if ((req.query as { all?: string }).all === 'true') {
        if (!req.principal.superadmin) throw forbidden('Platform super-admin role required');
        return Promise.all((await listOrgRows()).map(toOrganization));
      }
      return listMyOrgs(req.principal.id);
    });

    acct.post('/api/orgs', async (req, reply) => {
      if (config.ORG_CREATION === 'superadmin' && !req.principal.superadmin) throw forbidden('Only platform super-admins create organizations here');
      if (req.principal.provider === 'service') throw forbidden('Service accounts cannot create organizations');
      const body = orgInput.parse(req.body);
      const org = await createOrg(body, { creatorId: req.principal.id });
      if (keycloakEnabled()) {
        // Same organization in Keycloak: SSO, invitations and domain routing are configured there.
        try {
          const kcId = await kcCreateOrganization({ slug: org.slug, name: org.name, domains: verifiedDomains(org) });
          await patchSettings(org.id, { keycloakOrgId: kcId });
          const me = await one<UserRow>('SELECT * FROM users WHERE id = ?', req.principal.id);
          if (me?.provider === 'keycloak' && me.external_id) await kcAddMember(kcId, me.external_id);
        } catch (err) {
          req.log.warn({ err, org: org.slug }, 'could not create the Keycloak organization (SSO can be enabled later)');
        }
      }
      await audit(actorOf(req.principal), 'org.created', org.slug, { name: org.name }, org.id);
      return reply.code(201).send(await toOrganization(org));
    });
  });

  // ---- the current organization ----
  await app.register(async (member) => {
    member.addHook('preHandler', requireUser);
    member.get('/api/v1/org', async () => toOrganization(await current()));
  });

  await app.register(async (admin) => {
    admin.addHook('preHandler', requireAdmin);

    admin.patch('/api/v1/org', async (req) => {
      const body = orgInput.pick({ name: true, domains: true }).partial().parse(req.body);
      const org = await updateOrg(orgId(), body);
      const kcId = settingsOf(org).keycloakOrgId;
      if (kcId) await kcUpdateOrganization(kcId, { slug: org.slug, name: org.name, domains: verifiedDomains(org) });
      await audit(actorOf(req.principal), 'org.updated', org.slug, body);
      return toOrganization(org);
    });

    /** Deletes everything the organization holds. The slug must be repeated as a confirmation. */
    admin.delete('/api/v1/org', async (req) => {
      const { confirm } = z.object({ confirm: z.string() }).parse(req.body ?? {});
      const org = await current();
      if (confirm !== org.slug) throw badRequest(`Type the organization identifier ("${org.slug}") to confirm`);
      if (org.managed === 1 && !req.principal.superadmin) throw forbidden('This organization is declared in the platform configuration');
      const kcId = settingsOf(org).keycloakOrgId;
      await deleteOrg(org.id);
      forgetGitSource(org.id);
      if (kcId) await kcDeleteOrganization(kcId).catch((err) => req.log.warn({ err }, 'could not delete the Keycloak organization'));
      await audit(actorOf(req.principal), 'org.deleted', org.slug, {}, null);
      return { ok: true };
    });

    /** Check a domain's DNS TXT record (super-admins may vouch for it with `trusted`). */
    admin.post('/api/v1/org/domains/verify', async (req) => {
      const body = z.object({ domain: z.string().toLowerCase(), trusted: z.boolean().default(false) }).parse(req.body);
      if (body.trusted && !req.principal.superadmin) throw forbidden('Only platform super-admins can vouch for a domain');
      const ok = await verifyDomain(orgId(), body.domain, { trusted: body.trusted });
      if (!ok) throw badRequest(`The TXT record for ${body.domain} was not found yet (DNS changes can take a few minutes)`);
      clearSsoRoutes();
      const org = await current();
      const kcId = settingsOf(org).keycloakOrgId;
      if (kcId) await kcUpdateOrganization(kcId, { slug: org.slug, name: org.name, domains: verifiedDomains(org) });
      await audit(actorOf(req.principal), 'org.domain_verified', body.domain, { trusted: body.trusted });
      return toOrganization(org);
    });

    // members
    admin.get('/api/v1/org/members', async () => listMembers(orgId()));
    /**
     * Add someone by email: an existing account joins right away; otherwise, with Keycloak, an invitation email lets
     * them register and join. Without Keycloak, they need to create an account first.
     */
    admin.post('/api/v1/org/members', async (req, reply) => {
      const body = z.object({ email: z.string().email().toLowerCase(), role: z.enum(['admin', 'member']).default('member') }).parse(req.body);
      const org = await current();
      const kcId = settingsOf(org).keycloakOrgId;
      const user = await one<UserRow>("SELECT * FROM users WHERE email = ? AND provider != 'service' ORDER BY last_login_at DESC LIMIT 1", body.email);
      if (user) {
        await addMember(org.id, user.id, body.role, 'manual');
        if (kcId && user.provider === 'keycloak' && user.external_id) await kcAddMember(kcId, user.external_id);
        await audit(actorOf(req.principal), 'org.member_added', body.email, { role: body.role });
        return reply.code(201).send({ status: 'added' });
      }
      if (!kcId) throw notFound(`No account for ${body.email}: ask them to sign up first, then add them`);
      await kcInvite(kcId, body.email);
      await audit(actorOf(req.principal), 'org.member_invited', body.email);
      return reply.code(202).send({ status: 'invited' });
    });
    admin.patch('/api/v1/org/members/:id', async (req) => {
      const { id } = z.object({ id: z.string() }).parse(req.params);
      const { role } = z.object({ role: z.enum(['admin', 'member']) }).parse(req.body);
      if (id === req.principal.id && role !== 'admin' && !req.principal.superadmin) throw badRequest('You cannot demote yourself');
      await setMemberRole(orgId(), id, role);
      await audit(actorOf(req.principal), 'org.member_role', id, { role });
      return { ok: true };
    });
    admin.delete('/api/v1/org/members/:id', async (req) => {
      const { id } = z.object({ id: z.string() }).parse(req.params);
      const org = await current();
      await removeMember(org.id, id);
      const u = await one<UserRow>('SELECT * FROM users WHERE id = ?', id);
      const kcId = settingsOf(org).keycloakOrgId;
      if (kcId && u?.provider === 'keycloak' && u.external_id) await kcRemoveMember(kcId, u.external_id);
      await audit(actorOf(req.principal), 'org.member_removed', u?.email ?? id);
      return { ok: true };
    });

    // configuration as code
    admin.put('/api/v1/org/config-source', async (req) => {
      const src = configSourceInput.parse(req.body);
      const org = await current();
      if (src.type === 'directory' && org.id !== 'default' && !org.managed) {
        // Directories are mounted by the platform operator (CONFIG_DIR/orgs/<slug>): only they can switch to it.
        if (!req.principal.superadmin) throw forbidden('Directory sources are set up by the platform operators');
      }
      await patchSettings(org.id, { configSource: src, configStatus: undefined });
      forgetGitSource(org.id);
      await audit(actorOf(req.principal), 'org.config_source', org.slug, {
        type: src.type,
        ...(src.type === 'git' ? { url: src.url, branch: src.branch } : {}),
      });
      void opts.reloadConfig(org.id).catch((err) => req.log.warn({ err }, 'config reload failed'));
      return toOrganization(await current());
    });
    admin.post('/api/v1/org/config/sync', async (req) => {
      await opts.reloadConfig(orgId());
      await audit(actorOf(req.principal), 'config.reload_requested', (await current()).slug);
      return toOrganization(await current());
    });

    // SSO (Keycloak)
    admin.get('/api/v1/org/sso', async () => {
      const org = await current();
      return { available: keycloakEnabled(), enabled: !!settingsOf(org).keycloakOrgId, providers: keycloakEnabled() ? await kcListProviders(org) : [] };
    });
    /** Link the organization to Keycloak (organizations created before Keycloak was set up). */
    admin.post('/api/v1/org/sso/enable', async (req) => {
      const org = await current();
      if (settingsOf(org).keycloakOrgId) return toOrganization(org);
      const kcId = await kcCreateOrganization({ slug: org.slug, name: org.name, domains: verifiedDomains(org) });
      await patchSettings(org.id, { keycloakOrgId: kcId });
      for (const m of await listMembers(org.id)) {
        const u = await one<UserRow>('SELECT * FROM users WHERE id = ?', m.id);
        if (u?.provider === 'keycloak' && u.external_id) await kcAddMember(kcId, u.external_id).catch(() => undefined);
      }
      await audit(actorOf(req.principal), 'org.sso_enabled', org.slug);
      return toOrganization(await current());
    });
    admin.post('/api/v1/org/sso/providers', async (req, reply) => {
      const body = z
        .object({
          alias: z.string().min(1).max(40),
          displayName: z.string().max(100).default(''),
          type: z.enum(['oidc', 'saml']),
          url: z.string().url(),
          clientId: z.string().max(300).optional(),
          clientSecret: z.string().max(2000).optional(),
          domain: z.string().toLowerCase().nullish(),
        })
        .parse(req.body);
      const p = await kcAddProvider(await current(), body);
      await audit(actorOf(req.principal), 'org.sso_provider_added', p.alias, { type: p.type, domain: p.domain });
      return reply.code(201).send(p);
    });
    admin.delete('/api/v1/org/sso/providers/:alias', async (req) => {
      const { alias } = z.object({ alias: z.string().min(1).max(40) }).parse(req.params);
      await kcRemoveProvider(await current(), alias);
      await audit(actorOf(req.principal), 'org.sso_provider_removed', alias);
      return { ok: true };
    });
  });

  // ---- platform super-admins ----
  await app.register(async (sa) => {
    sa.addHook('preHandler', requireSuperadmin);
    /** Delete any organization (platform operators). */
    sa.delete('/api/orgs/:id', async (req) => {
      const { id } = z.object({ id: z.string() }).parse(req.params);
      const org = await getOrg(id);
      const kcId = settingsOf(org).keycloakOrgId;
      await deleteOrg(org.id);
      forgetGitSource(org.id);
      if (kcId) await kcDeleteOrganization(kcId).catch((err) => req.log.warn({ err }, 'could not delete the Keycloak organization'));
      await audit(actorOf(req.principal), 'org.deleted', org.slug, {}, null);
      return { ok: true };
    });
  });
}
