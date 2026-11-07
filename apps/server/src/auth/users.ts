import { createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { config, isLocalUrl } from '../config.js';
import { all, json, later, newId, now, one, run, tx } from '../db.js';
import type { ApiToken, OrgRef, PublicUser, Role, Subjects, TeamRef, UserProvider } from '@asterius/shared';
import { emit } from '../events.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { purgeLoginFailures } from './lockout.js';
import { audit } from '../audit.js';
import { blueprintOfPath, grants, ipAllowed, requiredScope, type Scope } from './scopes.js';
import { DEFAULT_ORG, enterOrg, maybeOrgId, orgId, withOrg } from '../orgs/context.js';
import { addMember, findOrg, listMyOrgs, membership, orgRef } from '../orgs/orgs.js';

// ---------- passwords & tokens ----------
export function hashPassword(password: string) {
  const salt = randomBytes(16);
  return `scrypt:${salt.toString('hex')}:${scryptSync(password, salt, 64).toString('hex')}`;
}

export function verifyPassword(password: string, stored: string | null) {
  if (!stored) return false;
  const [, saltHex, hashHex] = stored.split(':');
  if (!saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  return timingSafeEqual(expected, scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length));
}

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url');

/** API tokens are recognisable (secret scanners) and only their hash is stored. */
export const API_TOKEN_PREFIX = 'ast_';

// ---------- users ----------
export interface UserRow {
  id: string;
  provider: UserProvider;
  external_id: string | null;
  email: string;
  name: string;
  password_hash: string | null;
  /** Legacy global role (before organizations); the role that counts is the membership's. */
  role: Role;
  active: number;
  groups: string;
  superadmin: number;
  last_org_id: string | null;
  /** 1: an admin (or the bootstrap rule) set the role by hand; Entra claims no longer change it. */
  role_override: number;
  last_login_at: string | null;
  tour_completed_at: string | null;
  /** Legacy (before organizations): delegated roles now live on the membership. */
  extra_roles: string | null;
  created_at: string;
}

/** The authenticated caller of a request, within the organization of the request. */
export interface Principal {
  id: string;
  email: string;
  name: string;
  /** Role in the current organization (super-admins act as admins everywhere). */
  role: Role;
  /** Delegated / custom roles on top of `role`, in the current organization. */
  roles: string[];
  provider: UserProvider;
  /** Teams of the current organization. */
  teams: string[];
  superadmin: boolean;
  org: OrgRef | null;
  /** Set when the request authenticated with an API token that carries restrictions. */
  token?: { id: string; scopes: string[] | null; blueprints: string[] | null };
}

/** Teams of the user in the current organization. */
export async function teamsOf(userId: string): Promise<TeamRef[]> {
  const org = maybeOrgId();
  if (!org) return [];
  return all<TeamRef>(
    'SELECT t.identifier, t.title FROM team_members m JOIN teams t ON t.org_id = m.org_id AND t.identifier = m.team WHERE m.org_id = ? AND m.user_id = ? ORDER BY t.title',
    org,
    userId,
  );
}

/** Principal of a user in an organization (null: no organization). */
export async function principalOf(u: UserRow, org: OrgRef | null = null): Promise<Principal> {
  const m = org ? await membership(org.id, u.id) : undefined;
  const superadmin = u.superadmin === 1;
  const role: Role = superadmin ? 'admin' : (m?.role ?? 'member');
  const teams = org ? await teamsOf(u.id) : [];
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    role,
    roles: json<string[]>(m?.extra_roles, []),
    provider: u.provider,
    teams: teams.map((t) => t.identifier),
    superadmin,
    org,
  };
}

export async function publicUser(u: UserRow, org: OrgRef | null = null): Promise<PublicUser> {
  const p = await principalOf(u, org);
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    provider: u.provider,
    role: p.role,
    roles: p.roles,
    active: u.active === 1,
    teams: org ? await teamsOf(u.id) : [],
    lastLoginAt: u.last_login_at,
    tourCompletedAt: u.tour_completed_at,
    superadmin: p.superadmin,
    organization: org,
    organizations: await listMyOrgs(u.id),
  };
}

export const getUser = (id: string) => one<UserRow>('SELECT * FROM users WHERE id = ?', id);

/**
 * Super-admin bootstrap, in order: ADMIN_EMAILS; the one-time BOOTSTRAP_TOKEN (only while no super-admin exists); and, as a
 * development fallback only (local PUBLIC_URL, no ADMIN_EMAILS, no BOOTSTRAP_TOKEN), the very first human account.
 * The bootstrap super-admin is also admin of the default organization.
 */
export async function initialRole(email: string, bootstrapToken?: string): Promise<Role> {
  if (config.ADMIN_EMAILS.includes(email.toLowerCase())) return 'admin';
  const admin = await one('SELECT id FROM users WHERE superadmin = 1 LIMIT 1');
  if (admin) return 'member';
  if (config.BOOTSTRAP_TOKEN && bootstrapToken && sameSecret(bootstrapToken, config.BOOTSTRAP_TOKEN)) return 'admin';
  if (!config.BOOTSTRAP_TOKEN && !config.ADMIN_EMAILS.length && isLocalUrl(config.PUBLIC_URL)) {
    console.warn(`[auth] no admin exists: ${email} becomes the first admin (development fallback). Set ADMIN_EMAILS or BOOTSTRAP_TOKEN for real installs.`);
    return 'admin';
  }
  console.warn(`[auth] no admin exists and ${email} is not allowed to bootstrap one: set ADMIN_EMAILS, ENTRA_ADMIN_GROUPS or BOOTSTRAP_TOKEN`);
  return 'member';
}

const sameSecret = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export async function createLocalUser(email: string, name: string, password: string, bootstrapToken?: string) {
  email = email.toLowerCase();
  if (await one("SELECT id FROM users WHERE provider = 'local' AND email = ?", email)) throw conflict('An account already exists for this email');
  const id = newId();
  const role = await initialRole(email, bootstrapToken);
  await run(
    "INSERT INTO users (id, provider, email, name, password_hash, role, superadmin, created_at) VALUES (?, 'local', ?, ?, ?, ?, ?, ?)",
    id,
    email,
    name,
    hashPassword(password),
    role,
    role === 'admin' ? 1 : 0,
    now(),
  );
  await joinInitialOrgs(id, role);
  const created = (await getUser(id))!;
  await emit({ type: 'user.created', blueprint: null, data: { user: { id, email: created.email, name: created.name, role: created.role } } });
  return created;
}

/**
 * A new account belongs to no organization: the person creates one, is invited, or comes in through an organization's
 * SSO (see upsertKeycloakUser). AUTO_JOIN_DEFAULT_ORG keeps the single-tenant behaviour: everyone joins the default
 * organization, the bootstrap super-admin as its admin.
 */
export async function joinInitialOrgs(userId: string, role: Role) {
  if (config.AUTO_JOIN_DEFAULT_ORG) await addMember(DEFAULT_ORG, userId, role, 'manual');
}

/**
 * Role of an externally authenticated user, recomputed from the claims on every sign-in and re-sync: admin when a group
 * in the provider's admin groups (or a verified ADMIN_EMAILS address) matches, member otherwise, so removing someone from
 * the group demotes them. Only a role set by hand (role_override) is kept.
 */
export function externalRole(
  user: { role: Role; role_override: number } | undefined,
  p: { email: string; groups: string[]; adminGroups?: string[]; emailVerified?: boolean },
): Role {
  const groupAdmin = p.groups.some((g) => p.adminGroups?.includes(g));
  const emailAdmin = p.emailVerified !== false && config.ADMIN_EMAILS.includes(p.email.toLowerCase());
  if (groupAdmin || emailAdmin) return 'admin';
  if (user && Number(user.role_override) === 1) return user.role;
  return 'member';
}

export const entraRole = (user: { role: Role; role_override: number } | undefined, email: string, groups: string[]): Role =>
  externalRole(user, { email, groups, adminGroups: config.ENTRA_ADMIN_GROUPS });

export type ExternalProvider = 'entra' | 'oidc' | 'github' | 'saml';

export interface ExternalIdentity {
  /** Stable subject, namespaced by the issuer (never the email). */
  externalId: string;
  email: string;
  /** Only verified emails may bootstrap the admin role through ADMIN_EMAILS. */
  emailVerified?: boolean;
  name: string;
  groups: string[];
  /** Groups whose members are admins. */
  adminGroups?: string[];
}

/** Link a SCIM-provisioned account to the identity of the first SSO sign-in (same verified email). */
export async function adoptScimUser(provider: string, externalId: string, email: string, emailVerified: boolean | undefined) {
  if (emailVerified === false) return false;
  const { changes } = await run(
    "UPDATE users SET provider = ?, external_id = ? WHERE provider = 'scim' AND email = ? AND NOT EXISTS (SELECT 1 FROM users o WHERE o.provider = ? AND o.email = ?)",
    provider,
    externalId,
    email.toLowerCase(),
    provider,
    email.toLowerCase(),
  );
  return changes > 0;
}

/**
 * Sign-in through an identity provider configured for the whole platform (Entra ID, generic OIDC, GitHub, SAML): these
 * serve the default organization; per-organization SSO goes through Keycloak. Upserts the user, then synchronises the
 * default organization's role and teams from the groups.
 */
export async function upsertExternalUser(provider: ExternalProvider, p: ExternalIdentity) {
  // Accounts provisioned in advance by SCIM are claimed by the first SSO sign-in with the same verified email.
  if (provider !== 'github') await adoptScimUser(provider, p.externalId, p.email, p.emailVerified);
  let user = await one<UserRow>('SELECT * FROM users WHERE provider = ? AND external_id = ?', provider, p.externalId);
  let bootstrap = false;
  if (user) {
    await run('UPDATE users SET email = ?, name = ?, groups = ?, last_login_at = ? WHERE id = ?', p.email, p.name, JSON.stringify(p.groups), now(), user.id);
  } else {
    const id = newId();
    const fromClaims = externalRole(undefined, p) === 'admin';
    // Bootstrap (no super-admin yet): the first account runs the platform.
    bootstrap = !fromClaims && p.emailVerified !== false && (await initialRole(p.email)) === 'admin';
    const emailAdmin = p.emailVerified !== false && config.ADMIN_EMAILS.includes(p.email.toLowerCase());
    await run(
      'INSERT INTO users (id, provider, external_id, email, name, groups, role, superadmin, last_login_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      id,
      provider,
      p.externalId,
      p.email,
      p.name,
      JSON.stringify(p.groups),
      fromClaims || bootstrap ? 'admin' : 'member',
      bootstrap || emailAdmin ? 1 : 0,
      now(),
      now(),
    );
    user = await getUser(id);
  }
  await syncExternalMembership(user!.id, p, bootstrap);
  await syncEntraTeams(user!.id, p.groups, provider);
  return (await getUser(user!.id))!;
}

/** Membership of an SSO user in the default organization; the role follows the admin groups unless set by hand. */
export async function syncExternalMembership(userId: string, p: ExternalIdentity, bootstrap = false) {
  const m = await membership(DEFAULT_ORG, userId);
  const role = bootstrap ? 'admin' : externalRole(m, p);
  if (!m) {
    await addMember(DEFAULT_ORG, userId, role, 'sso');
    if (bootstrap) await run('UPDATE memberships SET role_override = 1 WHERE org_id = ? AND user_id = ?', DEFAULT_ORG, userId);
  } else if (m.role !== role) await run('UPDATE memberships SET role = ? WHERE org_id = ? AND user_id = ?', role, DEFAULT_ORG, userId);
  if (p.emailVerified !== false && config.ADMIN_EMAILS.includes(p.email.toLowerCase())) await run('UPDATE users SET superadmin = 1 WHERE id = ?', userId);
}

export const upsertEntraUser = (p: { externalId: string; email: string; name: string; groups: string[] }) =>
  upsertExternalUser('entra', { ...p, adminGroups: config.ENTRA_ADMIN_GROUPS });

/**
 * Teams bound to an IdP group (`entraGroupId`, the group id/name whatever the provider) follow the user's groups. These
 * providers serve the default organization: its teams.
 */
export async function syncEntraTeams(userId: string, groups: string[], via: ExternalProvider = 'entra', org = DEFAULT_ORG) {
  const teams = await all<{ identifier: string; entra_group_id: string }>(
    'SELECT identifier, entra_group_id FROM teams WHERE org_id = ? AND entra_group_id IS NOT NULL',
    org,
  );
  const wanted = new Set(teams.filter((t) => groups.includes(t.entra_group_id)).map((t) => t.identifier));
  await tx(async (d) => {
    await d.query('DELETE FROM team_members WHERE org_id = ? AND user_id = ? AND via = ?', [org, userId, via]);
    for (const team of wanted) {
      const existing = await d.query('SELECT team FROM team_members WHERE org_id = ? AND team = ? AND user_id = ?', [org, team, userId]);
      if (!existing.rows.length) await d.query('INSERT INTO team_members (org_id, team, user_id, via) VALUES (?, ?, ?, ?)', [org, team, userId, via]);
    }
  });
}

/** Service accounts belong to the current organization (API tokens for CI and automation). */
export async function createServiceAccount(name: string, role: Role) {
  const id = newId();
  const email = `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${id.slice(0, 6)}@service.local`;
  await run("INSERT INTO users (id, provider, email, name, role, created_at) VALUES (?, 'service', ?, ?, ?, ?)", id, email, name, role, now());
  await addMember(orgId(), id, role, 'manual');
  return (await getUser(id))!;
}

const AUTOMATION_EMAIL = 'workflow-automation@service.local';

/**
 * The service account owning runs started by schedules, events, webhooks and parent workflows. One platform account,
 * acting as a member of the organization of the work (no membership row: it never signs in).
 */
export async function automationPrincipal(): Promise<Principal> {
  const find = () => one<UserRow>("SELECT * FROM users WHERE provider = 'service' AND email = ?", AUTOMATION_EMAIL);
  let u = await find();
  if (!u) {
    try {
      await run(
        "INSERT INTO users (id, provider, email, name, role, created_at) VALUES (?, 'service', ?, 'Workflow automation', 'member', ?)",
        newId(),
        AUTOMATION_EMAIL,
        now(),
      );
    } catch {
      // created concurrently by another replica (unique index on provider+email)
    }
    u = await find();
  }
  const org = maybeOrgId();
  const ref = org ? await findOrg(org) : undefined;
  return principalOf(u!, ref ? orgRef(ref) : null);
}

const currentOrgRef = async () => orgRef((await findOrg(orgId()))!);

/** Members of the current organization. */
export async function listUsers(): Promise<PublicUser[]> {
  const users = await all<UserRow>('SELECT u.* FROM users u JOIN memberships m ON m.user_id = u.id WHERE m.org_id = ? ORDER BY u.provider, u.name', orgId());
  const org = await currentOrgRef();
  return Promise.all(users.map((u) => publicUser(u, org)));
}

/**
 * Change a member of the current organization: role, delegated roles and teams are per organization. Deactivating an
 * account (all organizations, all sessions) is reserved to super-admins, except for the organization's service accounts.
 */
export async function updateUser(id: string, patch: { role?: Role; roles?: string[]; active?: boolean; teams?: string[] }, by?: Principal) {
  const u = await getUser(id);
  const org = orgId();
  if (!u || !(await membership(org, id))) throw notFound('User');
  if (patch.role) await run('UPDATE memberships SET role = ?, role_override = 1 WHERE org_id = ? AND user_id = ?', patch.role, org, id);
  if (patch.roles) await run('UPDATE memberships SET extra_roles = ? WHERE org_id = ? AND user_id = ?', JSON.stringify([...new Set(patch.roles)]), org, id);
  if (patch.active !== undefined) {
    if (u.provider !== 'service' && by && !by.superadmin) throw forbidden('Only platform super-admins can deactivate an account; remove the member instead');
    await run('UPDATE users SET active = ? WHERE id = ?', patch.active ? 1 : 0, id);
    if (!patch.active) {
      await run('DELETE FROM sessions WHERE user_id = ?', id);
      await run('DELETE FROM api_tokens WHERE user_id = ?', id);
    }
  }
  if (patch.teams) {
    const teams = patch.teams;
    await tx(async (d) => {
      await d.query("DELETE FROM team_members WHERE org_id = ? AND user_id = ? AND via = 'manual'", [org, id]);
      for (const t of teams) {
        const exists = await d.query('SELECT team FROM team_members WHERE org_id = ? AND team = ? AND user_id = ?', [org, t, id]);
        if (!exists.rows.length) await d.query("INSERT INTO team_members (org_id, team, user_id, via) VALUES (?, ?, ?, 'manual')", [org, t, id]);
      }
    });
  }
  const updated = await publicUser((await getUser(id))!, await currentOrgRef());
  await emit({
    type: 'user.updated',
    blueprint: null,
    data: { user: { id, email: updated.email, role: updated.role, active: updated.active }, changes: Object.keys(patch) },
  });
  return updated;
}

// ---------- sessions ----------
/** `idToken`: the identity provider's ID token, kept to end its session at sign-out (id_token_hint). */
export async function createSession(userId: string, ctx: { ip?: string; userAgent?: string; idToken?: string } = {}) {
  const token = randomToken();
  const t = now();
  await run(
    'INSERT INTO sessions (token_hash, user_id, expires_at, created_at, last_seen_at, ip, user_agent, id_token) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    sha256(token),
    userId,
    later(config.SESSION_DAYS * 86400_000),
    t,
    t,
    ctx.ip ?? null,
    (ctx.userAgent ?? '').slice(0, 200) || null,
    ctx.idToken ?? null,
  );
  await run('UPDATE users SET last_login_at = ? WHERE id = ?', now(), userId);
  return token;
}

export interface SessionInfo {
  id: string;
  createdAt: string | null;
  lastSeenAt: string | null;
  expiresAt: string;
  ip: string | null;
  userAgent: string | null;
  current: boolean;
}

/** Session ids are a prefix of the stored token hash: enough to address a session, useless as a credential. */
export async function listSessions(userId: string, currentToken?: string): Promise<SessionInfo[]> {
  const current = currentToken ? sha256(currentToken) : '';
  const rows = await all<{
    token_hash: string;
    created_at: string | null;
    last_seen_at: string | null;
    expires_at: string;
    ip: string | null;
    user_agent: string | null;
  }>(
    'SELECT token_hash, created_at, last_seen_at, expires_at, ip, user_agent FROM sessions WHERE user_id = ? AND expires_at > ? ORDER BY created_at DESC',
    userId,
    now(),
  );
  return rows.map((r) => ({
    id: r.token_hash.slice(0, 16),
    createdAt: r.created_at,
    lastSeenAt: r.last_seen_at,
    expiresAt: r.expires_at,
    ip: r.ip,
    userAgent: r.user_agent,
    current: r.token_hash === current,
  }));
}

export async function revokeSession(userId: string, id: string) {
  const rows = await all<{ token_hash: string }>('SELECT token_hash FROM sessions WHERE user_id = ?', userId);
  const hit = rows.find((r) => r.token_hash.slice(0, 16) === id);
  if (!hit) throw notFound('Session');
  await run('DELETE FROM sessions WHERE token_hash = ?', hit.token_hash);
}

/** Sign out everywhere, optionally keeping the session making the request. */
export async function revokeAllSessions(userId: string, keepToken?: string) {
  if (keepToken) return (await run('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?', userId, sha256(keepToken))).changes;
  return (await run('DELETE FROM sessions WHERE user_id = ?', userId)).changes;
}

/** Ends a session; returns the identity provider's ID token when there was one (single sign-out). */
export async function deleteSession(token: string): Promise<string | null> {
  const s = await one<{ id_token: string | null }>('SELECT id_token FROM sessions WHERE token_hash = ?', sha256(token));
  await run('DELETE FROM sessions WHERE token_hash = ?', sha256(token));
  return s?.id_token ?? null;
}

export async function purgeExpiredAuth() {
  const t = now();
  await run('DELETE FROM sessions WHERE expires_at < ?', t);
  await run('DELETE FROM oauth_states WHERE expires_at < ?', t);
  await purgeLoginFailures();
}

// ---------- API tokens ----------
export interface TokenRestrictions {
  /** Null: all rights of the user (tokens created before scopes existed). */
  scopes?: string[] | null;
  /** Null: every blueprint. Only combinable with catalog scopes. */
  blueprints?: string[] | null;
  ipAllow?: string[] | null;
}

/** Org policy: API_TOKEN_MAX_DAYS caps the lifetime and makes an expiry mandatory. */
export function tokenLifetime(requested: number | null | undefined, fallback: number | null): number | null {
  const max = config.API_TOKEN_MAX_DAYS;
  const days = requested === undefined ? fallback : requested;
  if (!max) return days;
  if (days === null || days > max) throw badRequest(`API tokens expire after at most ${max} days`);
  return days;
}

/** API tokens act in the organization they were created in (CI jobs, MCP clients). */
export async function createApiToken(p: { name: string; userId: string; createdBy: string; expiresInDays?: number | null } & TokenRestrictions) {
  if (p.blueprints?.length && p.scopes?.some((s) => s.startsWith('runs:') || s === 'admin'))
    throw badRequest('Tokens restricted to blueprints can only carry catalog scopes');
  if (p.blueprints?.length && !p.scopes?.length) throw badRequest('Blueprint-restricted tokens need explicit catalog scopes');
  const token = `${API_TOKEN_PREFIX}${randomToken()}`;
  const id = newId();
  await run(
    'INSERT INTO api_tokens (id, org_id, name, token_hash, prefix, user_id, created_by, created_at, expires_at, scopes, blueprints, ip_allow) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    id,
    orgId(),
    p.name,
    sha256(token),
    token.slice(0, 10),
    p.userId,
    p.createdBy,
    now(),
    p.expiresInDays ? later(p.expiresInDays * 86400_000) : null,
    p.scopes?.length ? JSON.stringify([...new Set(p.scopes)]) : null,
    p.blueprints?.length ? JSON.stringify(p.blueprints) : null,
    p.ipAllow?.length ? JSON.stringify(p.ipAllow) : null,
  );
  return { id, token };
}

export async function listApiTokens(userId?: string): Promise<ApiToken[]> {
  const rows = await all<{
    id: string;
    name: string;
    prefix: string;
    user_id: string;
    user_name: string;
    created_at: string;
    expires_at: string | null;
    last_used_at: string | null;
    scopes: string | null;
    blueprints: string | null;
    ip_allow: string | null;
  }>(
    `SELECT t.id, t.name, t.prefix, t.user_id, u.name AS user_name, t.created_at, t.expires_at, t.last_used_at, t.scopes, t.blueprints, t.ip_allow
     FROM api_tokens t JOIN users u ON u.id = t.user_id WHERE t.org_id = ? ${userId ? 'AND t.user_id = ?' : ''} ORDER BY t.created_at DESC`,
    orgId(),
    ...(userId ? [userId] : []),
  );
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    prefix: r.prefix,
    userId: r.user_id,
    userName: r.user_name,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    lastUsedAt: r.last_used_at,
    scopes: json<string[] | null>(r.scopes, null),
    blueprints: json<string[] | null>(r.blueprints, null),
    ipAllow: json<string[] | null>(r.ip_allow, null),
  }));
}

export async function deleteApiToken(id: string, userId?: string) {
  const { changes } = userId
    ? await run('DELETE FROM api_tokens WHERE id = ? AND org_id = ? AND user_id = ?', id, orgId(), userId)
    : await run('DELETE FROM api_tokens WHERE id = ? AND org_id = ?', id, orgId());
  if (!changes) throw notFound('Token');
}

const lastUsedWrites = new Map<string, number>();

interface Resolved {
  user: UserRow;
  /** API tokens fix the organization of the request. */
  token?: NonNullable<Principal['token']> & { ipAllow: string[] | null; org: string };
}

async function userFromBearer(token: string, ip: string): Promise<Resolved | undefined> {
  const hash = sha256(token);
  if (token.startsWith(API_TOKEN_PREFIX)) {
    const row = await one<
      UserRow & {
        token_id: string;
        token_expires: string | null;
        t_scopes: string | null;
        t_blueprints: string | null;
        t_ip: string | null;
        t_org: string;
      }
    >(
      `SELECT u.*, t.id AS token_id, t.expires_at AS token_expires, t.scopes AS t_scopes, t.blueprints AS t_blueprints, t.ip_allow AS t_ip,
         t.org_id AS t_org
       FROM api_tokens t JOIN users u ON u.id = t.user_id WHERE t.token_hash = ?`,
      hash,
    );
    if (!row || (row.token_expires && row.token_expires < now())) return undefined;
    const ipAllow = json<string[] | null>(row.t_ip, null);
    if (ipAllow?.length && !ipAllowed(ip, ipAllow)) return undefined; // same answer as an unknown token
    // Record usage at most once a minute per token; admin tokens leave an audit trail (in the token's organization).
    if ((lastUsedWrites.get(row.token_id) ?? 0) < Date.now() - 60_000) {
      lastUsedWrites.set(row.token_id, Date.now());
      void run('UPDATE api_tokens SET last_used_at = ? WHERE id = ?', now(), row.token_id).catch(() => undefined);
      const admin = row.superadmin === 1 || (await membership(row.t_org, row.id))?.role === 'admin';
      if (admin) void withOrgAudit(row.t_org, { id: row.id, email: row.email }, row.token_id, ip);
    }
    return {
      user: row,
      token: {
        id: row.token_id,
        scopes: json<string[] | null>(row.t_scopes, null),
        blueprints: json<string[] | null>(row.t_blueprints, null),
        ipAllow,
        org: row.t_org,
      },
    };
  }
  const s = await one<UserRow & { last_seen_at: string | null }>(
    'SELECT u.*, s.last_seen_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?',
    hash,
    now(),
  );
  if (!s) return undefined;
  if (config.SESSION_IDLE_MINUTES && s.last_seen_at && Date.parse(s.last_seen_at) < Date.now() - config.SESSION_IDLE_MINUTES * 60_000) {
    await run('DELETE FROM sessions WHERE token_hash = ?', hash);
    return undefined;
  }
  // Refresh the idle clock at most once a minute per session.
  if ((lastUsedWrites.get(hash) ?? 0) < Date.now() - 60_000) {
    lastUsedWrites.set(hash, Date.now());
    void run('UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?', now(), hash).catch(() => undefined);
  }
  return { user: s };
}

const withOrgAudit = (org: string, actor: { id: string; email: string }, tokenId: string, ip: string) =>
  withOrg(org, () => audit(actor, 'token.used', tokenId, { ip })).catch(() => undefined);

/** Header naming the organization a browser session works in (slug or id). API tokens ignore it. */
export const ORG_HEADER = 'x-asterius-org';

/**
 * Organization of a request: the API token's, else the X-Asterius-Org header, else the user's last organization,
 * else their first one. Members only (super-admins may enter any organization). Null: the user has none yet.
 */
async function resolveOrg(req: FastifyRequest, user: UserRow, tokenOrg?: string): Promise<OrgRef | null> {
  const header = req.headers[ORG_HEADER];
  const asked = tokenOrg ?? (typeof header === 'string' && header ? header : undefined);
  const superadmin = user.superadmin === 1;
  if (asked) {
    const org = await findOrg(asked);
    if (!org || (!superadmin && !(await membership(org.id, user.id)))) {
      throw forbidden(tokenOrg ? 'This token no longer has access to its organization' : 'You are not a member of this organization');
    }
    if (!tokenOrg && user.last_org_id !== org.id) void run('UPDATE users SET last_org_id = ? WHERE id = ?', org.id, user.id).catch(() => undefined);
    return orgRef(org);
  }
  if (user.last_org_id) {
    const org = await findOrg(user.last_org_id);
    if (org && (superadmin || (await membership(org.id, user.id)))) return orgRef(org);
  }
  const mine = await listMyOrgs(user.id);
  return mine[0] ? { id: mine[0].id, slug: mine[0].slug, name: mine[0].name } : null;
}

/** Enter the organization of the request and build its principal. */
async function principalFor(req: FastifyRequest, found: Resolved): Promise<Principal> {
  const org = await resolveOrg(req, found.user, found.token?.org);
  if (org) enterOrg(org.id);
  return principalOf(found.user, org);
}

declare module 'fastify' {
  interface FastifyRequest {
    principal: Principal;
  }
}

export const bearer = (req: FastifyRequest) => {
  const h = req.headers.authorization;
  return h?.startsWith('Bearer ') ? h.slice(7).trim() : undefined;
};

// ---------- cookie sessions (SESSION_COOKIE) ----------
export const SESSION_COOKIE = '__Host-asterius_session';
const cookieName = () => (config.PUBLIC_URL.startsWith('https://') ? SESSION_COOKIE : 'asterius_session');

function cookieOf(req: FastifyRequest, name: string) {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return undefined;
}

/** CSRF token bound to the session: only someone who holds the (httpOnly) session token can compute it. */
export const csrfFor = (sessionToken: string) => createHmac('sha256', sessionToken).update('asterius-csrf-v1').digest('base64url');

export function sessionCookie(token: string | null) {
  const https = config.PUBLIC_URL.startsWith('https://');
  const age = token ? config.SESSION_DAYS * 86400 : 0;
  // __Host- prefix on https: no Domain, Path=/, Secure. SameSite=Lax lets the IdP redirect back while blocking cross-site POSTs.
  return `${cookieName()}=${token ?? ''}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${age}${https ? '; Secure' : ''}`;
}

/** The session token of a request, from the Authorization header or the session cookie. */
export const sessionToken = (req: FastifyRequest) => bearer(req) ?? (config.SESSION_COOKIE ? cookieOf(req, cookieName()) : undefined);

/** Cookie-authenticated unsafe requests must prove they come from the app: same origin and the session-bound CSRF token. */
function assertCsrf(req: FastifyRequest, token: string) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return;
  const origin = req.headers.origin;
  if (origin && origin !== new URL(config.PUBLIC_URL).origin) throw forbidden('Cross-origin request refused');
  const sent = req.headers['x-csrf-token'];
  const want = csrfFor(token);
  if (typeof sent !== 'string' || sent.length !== want.length || !timingSafeEqual(Buffer.from(sent), Buffer.from(want)))
    throw forbidden('Missing or invalid CSRF token');
}

/**
 * Resolve the caller from a session or API token (Authorization: Bearer …, or the session cookie) and enter the
 * organization of the request: every org-scoped query of the request then runs in it.
 */
export async function authenticate(req: FastifyRequest): Promise<Principal | undefined> {
  if (req.principal) return req.principal;
  const header = bearer(req);
  const cookie = !header && config.SESSION_COOKIE ? cookieOf(req, cookieName()) : undefined;
  if (cookie && !cookie.startsWith(API_TOKEN_PREFIX)) {
    const found = await userFromBearer(cookie, req.ip);
    if (!found || found.user.active !== 1) return undefined;
    assertCsrf(req, cookie);
    req.principal = await principalFor(req, found);
    return req.principal;
  }
  const token = header;
  const found = token ? await userFromBearer(token, req.ip) : undefined;
  if (!found || found.user.active !== 1) return undefined;
  const principal = await principalFor(req, found);
  if (found.token && (found.token.scopes || found.token.blueprints)) {
    principal.token = { id: found.token.id, scopes: found.token.scopes, blueprints: found.token.blueprints };
    enforceTokenRestrictions(principal, req);
  }
  req.principal = principal;
  return req.principal;
}

/** Scope and blueprint restrictions of API tokens (403 with the missing scope named). */
function enforceTokenRestrictions(p: Principal, req: FastifyRequest) {
  const t = p.token!;
  if (t.scopes) {
    const needed: Scope = requiredScope(req.method, req.url);
    if (!grants(t.scopes, needed)) throw forbidden(`This API token lacks the "${needed}" scope`);
  }
  if (t.blueprints) {
    const bp = blueprintOfPath(req.url);
    const queried = new URL(req.url, 'http://x').searchParams.get('blueprint');
    const target = bp ?? queried;
    // Cross-blueprint endpoints (home, global search) would reveal other blueprints: require an explicit one.
    if (!target || !t.blueprints.includes(target)) throw forbidden('This API token is restricted to other blueprints');
  }
}

/** preHandler: signed-in users and API tokens, working in an organization. */
export async function requireUser(req: FastifyRequest, reply: FastifyReply) {
  if (!(await authenticate(req))) return reply.code(401).send({ error: 'unauthorized' });
  if (!req.principal.org) return reply.code(403).send({ error: 'Join or create an organization first', code: 'NO_ORGANIZATION' });
}

/** preHandler: signed-in, with or without an organization (profile, organization list and creation). */
export async function requireAccount(req: FastifyRequest, reply: FastifyReply) {
  if (!(await authenticate(req))) return reply.code(401).send({ error: 'unauthorized' });
}

/** preHandler: platform super-admins (every organization). */
export async function requireSuperadmin(req: FastifyRequest, reply: FastifyReply) {
  if (!(await authenticate(req))) return reply.code(401).send({ error: 'unauthorized' });
  if (!req.principal.superadmin) return reply.code(403).send({ error: 'Platform super-admin role required' });
}

export async function requireAdmin(req: FastifyRequest, reply: FastifyReply) {
  await requireUser(req, reply);
  if (reply.sent) return;
  if (req.principal.role !== 'admin') return reply.code(403).send({ error: 'Admin role required' });
}

// ---------- authorization ----------
export const isAdmin = (p: Principal) => p.role === 'admin';

/**
 * Does the principal match a subject list? Empty/undefined subjects match everyone.
 * `ownerTeam` matches members of the team owning the target entity.
 */
export function matchesSubjects(p: Principal, s: Subjects | undefined, ownerTeam: string | null): boolean {
  if (!s) return true;
  const hasRules = !!(s.roles?.length || s.teams?.length || s.users?.length || s.ownerTeam);
  if (!hasRules) return true;
  if (s.roles?.some((r) => r === p.role || p.roles.includes(r))) return true;
  if (s.teams?.some((t) => p.teams.includes(t))) return true;
  if (s.users?.some((u) => u.toLowerCase() === p.email.toLowerCase())) return true;
  if (s.ownerTeam && ownerTeam && p.teams.includes(ownerTeam)) return true;
  return false;
}

/** Humans edit catalog entities of their teams; admins edit everything. */
export function canEditEntity(p: Principal, team: string | null) {
  return isAdmin(p) || (!!team && p.teams.includes(team));
}

export function assertPassword(password: string) {
  if (password.length < 10) throw badRequest('Passwords need at least 10 characters');
}

export const actorOf = (p: Pick<Principal, 'id' | 'email'>) => ({ id: p.id, email: p.email });

export const parseGroups = (u: UserRow) => json<string[]>(u.groups, []);

/** Onboarding tour: shown until completed or skipped; null restarts it. */
export async function setTourCompleted(userId: string, completed: boolean) {
  await run('UPDATE users SET tour_completed_at = ? WHERE id = ?', completed ? now() : null, userId);
}
