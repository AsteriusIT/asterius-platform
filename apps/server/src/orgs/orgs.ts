import { z } from 'zod';
import type { ConfigSource, ConfigSyncStatus, Member, Organization, OrgMembership, OrgRef, Role } from '@asterius/shared';
import { all, json, newId, now, one, run } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { SECRET_REF, slug } from '../schemas.js';
import dns from 'node:dns/promises';
import { DEFAULT_ORG, withOrg } from './context.js';
import { domainToken } from '../secrets.js';
import { config } from '../config.js';

/**
 * Organizations (tenants): every catalog, workflow, integration, secret and audit entry belongs to one. Users are
 * global identities that join organizations through memberships, with a role per organization.
 */

export interface OrgRow {
  id: string;
  slug: string;
  name: string;
  domains: string;
  settings: string;
  managed: number;
  created_at: string;
  updated_at: string;
}

export interface OrgSettings {
  /** Domains whose DNS TXT record was checked (or set by platform operators). */
  verifiedDomains?: string[];
  configSource?: ConfigSource;
  configStatus?: ConfigSyncStatus;
  keycloakOrgId?: string | null;
}

/** Paths under which organization slugs would be confusing or clash with routes. */
const RESERVED = new Set(['api', 'admin', 'new', 'orgs', 'login', 'logout', 'auth', 'mcp', 'platform', 'settings', 'system']);

const DOMAIN = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export const orgInput = z.object({
  slug: slug.refine((s) => !RESERVED.has(s), 'this identifier is reserved'),
  name: z.string().trim().min(1).max(100),
  domains: z.array(z.string().trim().toLowerCase().regex(DOMAIN, 'an email domain such as example.com')).max(20).default([]),
});

export const configSourceInput = z.discriminatedUnion('type', [
  z.object({ type: z.literal('none') }),
  z.object({ type: z.literal('directory') }),
  z.object({
    type: z.literal('git'),
    url: z
      .string()
      .url()
      .regex(/^https:\/\//, 'Git repositories are pulled over https'),
    branch: z
      .string()
      .regex(/^[A-Za-z0-9._/-]{1,200}$/)
      .default('main'),
    path: z
      .string()
      .regex(/^[A-Za-z0-9._/-]{0,300}$/)
      .refine((p) => !p.split('/').includes('..'), 'no .. in the path')
      .default(''),
    token: z.string().regex(SECRET_REF, 'the token must be a reference: ${secret:NAME}').nullish().default(null),
  }),
]);

export const settingsOf = (r: OrgRow) => json<OrgSettings>(r.settings, {});

/** DNS name of the verification record of a domain. */
export const verificationRecord = (domain: string) => `_asterius-verification.${domain}`;

/**
 * Verified domains of an organization. Domains declared in the platform configuration are trusted; domains added by
 * an organization's admins count once their TXT record was checked: anyone can type someone else's domain.
 */
export function verifiedDomains(r: OrgRow): string[] {
  const domains = json<string[]>(r.domains, []);
  if (r.managed === 1) return domains;
  const ok = new Set(settingsOf(r).verifiedDomains ?? []);
  return domains.filter((d) => ok.has(d));
}

/** A domain belongs to one organization at most (Keycloak enforces it too). */
async function assertDomainsFree(domains: string[], exceptOrg?: string) {
  if (!domains.length) return;
  for (const o of await listOrgRows()) {
    if (o.id === exceptOrg) continue;
    const taken = json<string[]>(o.domains, []).find((d) => domains.includes(d));
    if (taken) throw conflict(`The domain ${taken} is already claimed by another organization; contact the platform team if it is yours`);
  }
}

export const orgRef = (r: OrgRow): OrgRef => ({ id: r.id, slug: r.slug, name: r.name });

export async function toOrganization(r: OrgRow): Promise<Organization> {
  const s = settingsOf(r);
  const n = await one<{ n: number }>('SELECT count(*) AS n FROM memberships WHERE org_id = ?', r.id);
  return {
    ...orgRef(r),
    domains: json<string[]>(r.domains, []),
    managed: r.managed === 1,
    createdAt: r.created_at,
    memberCount: Number(n?.n ?? 0),
    domainStatus: json<string[]>(r.domains, []).map((d) => ({
      domain: d,
      verified: verifiedDomains(r).includes(d),
      record: verificationRecord(d),
      value: `asterius-verification=${domainToken(r.id, d)}`,
    })),
    configSource: s.configSource ?? { type: r.id === DEFAULT_ORG ? 'directory' : 'none' },
    configStatus: s.configStatus ?? null,
    sso: { enabled: !!s.keycloakOrgId, keycloakOrgId: s.keycloakOrgId ?? null },
  };
}

const slugCache = new Map<string, string>();
/** Slug of an organization id (URLs such as inbound webhooks); slugs never change. */
export async function orgSlug(id: string): Promise<string> {
  const c = slugCache.get(id);
  if (c) return c;
  const r = await one<{ slug: string }>('SELECT slug FROM organizations WHERE id = ?', id);
  if (!r) throw notFound(`Organization ${id}`);
  slugCache.set(id, r.slug);
  return r.slug;
}

/** The platform's Kubernetes credentials serve the organizations listed in KUBERNETES_ORGS only. */
/** The platform's own cloud identity (workload identity, metadata servers, external secret managers): PLATFORM_IDENTITY_ORGS. */
export async function assertPlatformIdentityAllowed(orgIdValue: string, what: string) {
  const slugValue = await orgSlug(orgIdValue);
  if (!config.PLATFORM_IDENTITY_ORGS.includes(slugValue))
    throw new Error(`${what}: the platform's own identity is not available to organization "${slugValue}" (PLATFORM_IDENTITY_ORGS); configure credentials`);
}

export async function assertKubernetesAllowed(orgIdValue: string) {
  const slugValue = await orgSlug(orgIdValue);
  if (!config.KUBERNETES_ORGS.includes(slugValue))
    throw new Error(`The platform's Kubernetes access is not available to organization "${slugValue}" (KUBERNETES_ORGS)`);
}

/** By id or slug. */
export const findOrg = (key: string) => one<OrgRow>('SELECT * FROM organizations WHERE id = ? OR slug = ?', key, key);

export async function getOrg(key: string): Promise<OrgRow> {
  const r = await findOrg(key);
  if (!r) throw notFound(`Organization ${key}`);
  return r;
}

export const listOrgRows = () => all<OrgRow>('SELECT * FROM organizations ORDER BY name');

/**
 * Background work over every organization (scheduled passes): runs `fn` in each organization's context in turn. A
 * failing organization is logged and does not stop the others.
 */
export async function forEachOrg(fn: (org: string) => Promise<unknown>, label = 'background job') {
  for (const { id } of await all<{ id: string }>('SELECT id FROM organizations ORDER BY id')) {
    try {
      await withOrg(id, () => fn(id));
    } catch (err) {
      console.error(`[${label}] organization ${id}: ${(err as Error).message}`);
    }
  }
}

export async function listMyOrgs(userId: string): Promise<OrgMembership[]> {
  const rows = await all<OrgRow & { role: Role }>(
    'SELECT o.*, m.role FROM memberships m JOIN organizations o ON o.id = m.org_id WHERE m.user_id = ? ORDER BY o.name',
    userId,
  );
  return rows.map((r) => ({ ...orgRef(r), role: r.role }));
}

export const membership = (orgId: string, userId: string) =>
  one<{ role: Role; role_override: number; via: string; extra_roles: string | null }>(
    'SELECT role, role_override, via, extra_roles FROM memberships WHERE org_id = ? AND user_id = ?',
    orgId,
    userId,
  );

export async function createOrg(input: unknown, opts: { creatorId?: string; managed?: boolean } = {}): Promise<OrgRow> {
  const def = orgInput.parse(input);
  if (await findOrg(def.slug)) throw conflict(`The identifier "${def.slug}" is already taken`);
  await assertDomainsFree(def.domains);
  const id = newId();
  const t = now();
  await run(
    'INSERT INTO organizations (id, slug, name, domains, settings, managed, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    id,
    def.slug,
    def.name,
    JSON.stringify(def.domains),
    '{}',
    opts.managed ? 1 : 0,
    t,
    t,
  );
  if (opts.creatorId) await addMember(id, opts.creatorId, 'admin', 'manual');
  return (await findOrg(id))!;
}

export async function updateOrg(id: string, patch: { name?: string; domains?: string[] }, opts: { managed?: boolean } = {}) {
  const r = await getOrg(id);
  if (r.managed === 1 && !opts.managed) throw forbidden('This organization is declared in the platform configuration: change it there');
  const def = orgInput.pick({ name: true, domains: true }).partial().parse(patch);
  if (def.domains) await assertDomainsFree(def.domains, r.id);
  await run(
    'UPDATE organizations SET name = ?, domains = ?, managed = ?, updated_at = ? WHERE id = ?',
    def.name ?? r.name,
    JSON.stringify(def.domains ?? json<string[]>(r.domains, [])),
    opts.managed ? 1 : r.managed,
    now(),
    r.id,
  );
  return (await findOrg(r.id))!;
}

/** Merge into the organization's settings (config source, sync status, Keycloak link). */
export async function patchSettings(id: string, patch: Partial<OrgSettings>) {
  const r = await getOrg(id);
  await run('UPDATE organizations SET settings = ?, updated_at = ? WHERE id = ?', JSON.stringify({ ...settingsOf(r), ...patch }), now(), r.id);
}

/** Deletes every resource of the organization (cascade). The default organization stays. */
export async function deleteOrg(id: string) {
  const r = await getOrg(id);
  if (r.id === DEFAULT_ORG) throw badRequest('The default organization cannot be deleted');
  // Runs and API tokens reference the organization without a foreign key (they predate it): remove them first.
  await run('DELETE FROM api_tokens WHERE org_id = ?', r.id);
  await run('DELETE FROM runs WHERE org_id = ?', r.id);
  // Children before parents; tables without a cascading foreign key to the organization.
  for (const t of [
    'entity_relations',
    'entity_versions',
    'entity_tombstones',
    'scorecard_history',
    'scorecard_results',
    'entities',
    'blueprint_stats',
    'blueprint_validation',
    'team_members',
    'inbound_events',
    'sync_runs',
    'deliveries',
    'ingest_deliveries',
    'action_versions',
    'ai_budgets',
    'ai_reviews',
    'llm_usage',
    'notifications',
    'notification_settings',
    'config_status',
  ])
    await run(`DELETE FROM ${t} WHERE org_id = ?`, r.id);
  await run('DELETE FROM ai_leases WHERE name = ?', `review:${r.id}`);
  await run('DELETE FROM organizations WHERE id = ?', r.id);
  // Service accounts only exist for their organization.
  await run("DELETE FROM users WHERE provider = 'service' AND id NOT IN (SELECT user_id FROM memberships)");
}

// ---------- memberships ----------

export async function addMember(orgId: string, userId: string, role: Role, via: 'manual' | 'sso' | 'config') {
  const m = await membership(orgId, userId);
  if (m) return false;
  await run('INSERT INTO memberships (org_id, user_id, role, via, created_at) VALUES (?, ?, ?, ?, ?)', orgId, userId, role, via, now());
  return true;
}

export async function setMemberRole(orgIdValue: string, userId: string, role: Role) {
  const m = await membership(orgIdValue, userId);
  if (!m) throw notFound('Member');
  if (m.role === 'admin' && role !== 'admin') await assertAnotherAdmin(orgIdValue, userId);
  await run('UPDATE memberships SET role = ?, role_override = 1 WHERE org_id = ? AND user_id = ?', role, orgIdValue, userId);
}

export async function removeMember(orgIdValue: string, userId: string) {
  const m = await membership(orgIdValue, userId);
  if (!m) throw notFound('Member');
  if (m.role === 'admin') await assertAnotherAdmin(orgIdValue, userId);
  await run('DELETE FROM memberships WHERE org_id = ? AND user_id = ?', orgIdValue, userId);
  await run('DELETE FROM team_members WHERE org_id = ? AND user_id = ?', orgIdValue, userId);
  await run('DELETE FROM api_tokens WHERE org_id = ? AND user_id = ?', orgIdValue, userId);
}

/** An organization keeps a human admin: checked before demoting or removing `userId` (a super-admin can still recover it). */
async function assertAnotherAdmin(orgIdValue: string, userId: string) {
  if (orgIdValue === DEFAULT_ORG) return;
  const n = await one<{ n: number }>(
    "SELECT count(*) AS n FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.org_id = ? AND m.user_id != ? AND m.role = 'admin' AND u.provider != 'service' AND u.active = 1",
    orgIdValue,
    userId,
  );
  if (Number(n?.n) === 0) throw conflict('An organization needs at least one admin: make someone else admin first');
}

export async function listMembers(orgId: string): Promise<Member[]> {
  const rows = await all<{
    id: string;
    email: string;
    name: string;
    provider: Member['provider'];
    role: Role;
    via: Member['via'];
    active: number;
    last_login_at: string | null;
    created_at: string;
  }>(
    `SELECT u.id, u.email, u.name, u.provider, m.role, m.via, u.active, u.last_login_at, m.created_at
     FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.org_id = ? ORDER BY u.provider, u.name`,
    orgId,
  );
  return rows.map((r) => ({
    id: r.id,
    email: r.email,
    name: r.name,
    provider: r.provider,
    role: r.role,
    via: r.via,
    active: r.active === 1,
    lastLoginAt: r.last_login_at,
    joinedAt: r.created_at,
  }));
}

/** Organizations whose verified email domains match: joined automatically by SSO-verified accounts. */
export async function orgsForDomain(email: string): Promise<OrgRow[]> {
  const domain = email.split('@')[1]?.toLowerCase();
  if (!domain) return [];
  return (await listOrgRows()).filter((o) => verifiedDomains(o).includes(domain));
}

/**
 * Check the DNS TXT record of a domain (`_asterius-verification.<domain>` = `asterius-verification=<token>`).
 * `trusted`: platform super-admins vouch for it without DNS.
 */
export async function verifyDomain(orgIdValue: string, domain: string, opts: { trusted?: boolean } = {}): Promise<boolean> {
  const r = await getOrg(orgIdValue);
  if (!json<string[]>(r.domains, []).includes(domain)) throw notFound(`Domain ${domain} of this organization`);
  if (!opts.trusted) {
    const want = `asterius-verification=${domainToken(r.id, domain)}`;
    const records = await dns.resolveTxt(verificationRecord(domain)).catch(() => [] as string[][]);
    if (!records.some((chunks) => chunks.join('') === want)) return false;
  }
  const s = settingsOf(r);
  await patchSettings(r.id, { verifiedDomains: [...new Set([...(s.verifiedDomains ?? []), domain])] });
  return true;
}
