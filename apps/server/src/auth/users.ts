import { createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { config, isLocalUrl } from '../config.js';
import { all, json, later, newId, now, one, run, tx } from '../db.js';
import type { ApiToken, PublicUser, Role, Subjects, TeamRef, UserProvider } from '@asterius/shared';
import { emit } from '../events.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { purgeLoginFailures } from './lockout.js';
import { audit } from '../audit.js';
import { blueprintOfPath, grants, ipAllowed, requiredScope, type Scope } from './scopes.js';

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
  role: Role;
  active: number;
  groups: string;
  /** 1: an admin (or the bootstrap rule) set the role by hand; Entra claims no longer change it. */
  role_override: number;
  last_login_at: string | null;
  tour_completed_at: string | null;
  extra_roles: string | null;
  created_at: string;
}

/** The authenticated caller of a request. */
export interface Principal {
  id: string;
  email: string;
  name: string;
  role: Role;
  /** Delegated / custom roles on top of `role`. */
  roles: string[];
  provider: UserProvider;
  teams: string[];
  /** Set when the request authenticated with an API token that carries restrictions. */
  token?: { id: string; scopes: string[] | null; blueprints: string[] | null };
}

export async function teamsOf(userId: string): Promise<TeamRef[]> {
  return all<TeamRef>('SELECT t.identifier, t.title FROM team_members m JOIN teams t ON t.identifier = m.team WHERE m.user_id = ? ORDER BY t.title', userId);
}

export async function principalOf(u: UserRow): Promise<Principal> {
  const teams = await teamsOf(u.id);
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    role: u.role,
    roles: json<string[]>(u.extra_roles, []),
    provider: u.provider,
    teams: teams.map((t) => t.identifier),
  };
}

export async function publicUser(u: UserRow): Promise<PublicUser> {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    provider: u.provider,
    role: u.role,
    roles: json<string[]>(u.extra_roles, []),
    active: u.active === 1,
    teams: await teamsOf(u.id),
    lastLoginAt: u.last_login_at,
    tourCompletedAt: u.tour_completed_at,
  };
}

export const getUser = (id: string) => one<UserRow>('SELECT * FROM users WHERE id = ?', id);

/**
 * Admin bootstrap, in order: ADMIN_EMAILS; the one-time BOOTSTRAP_TOKEN (only while no admin exists); and, as a
 * development fallback only (local PUBLIC_URL, no ADMIN_EMAILS, no BOOTSTRAP_TOKEN), the very first human account.
 */
async function initialRole(email: string, bootstrapToken?: string): Promise<Role> {
  if (config.ADMIN_EMAILS.includes(email.toLowerCase())) return 'admin';
  const admin = await one("SELECT id FROM users WHERE role = 'admin' AND provider != 'service' LIMIT 1");
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
  await run(
    "INSERT INTO users (id, provider, email, name, password_hash, role, created_at) VALUES (?, 'local', ?, ?, ?, ?, ?)",
    id,
    email,
    name,
    hashPassword(password),
    await initialRole(email, bootstrapToken),
    now(),
  );
  const created = (await getUser(id))!;
  await emit({ type: 'user.created', blueprint: null, data: { user: { id, email: created.email, name: created.name, role: created.role } } });
  return created;
}

/**
 * Role of an externally authenticated user, recomputed from the claims on every sign-in and re-sync: admin when a group
 * in the provider's admin groups (or a verified ADMIN_EMAILS address) matches, member otherwise, so removing someone from
 * the group demotes them. Only a role set by hand (role_override) is kept.
 */
export function externalRole(
  user: Pick<UserRow, 'role' | 'role_override'> | undefined,
  p: { email: string; groups: string[]; adminGroups?: string[]; emailVerified?: boolean },
): Role {
  const groupAdmin = p.groups.some((g) => p.adminGroups?.includes(g));
  const emailAdmin = p.emailVerified !== false && config.ADMIN_EMAILS.includes(p.email.toLowerCase());
  if (groupAdmin || emailAdmin) return 'admin';
  if (user && Number(user.role_override) === 1) return user.role;
  return 'member';
}

export const entraRole = (user: Pick<UserRow, 'role' | 'role_override'> | undefined, email: string, groups: string[]): Role =>
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

/** Sign-in through an identity provider: upsert the user, then synchronise team memberships and the admin role from groups. */
export async function upsertExternalUser(provider: ExternalProvider, p: ExternalIdentity) {
  // Accounts provisioned in advance by SCIM are claimed by the first SSO sign-in with the same verified email.
  if (provider !== 'github') await adoptScimUser(provider, p.externalId, p.email, p.emailVerified);
  let user = await one<UserRow>('SELECT * FROM users WHERE provider = ? AND external_id = ?', provider, p.externalId);
  if (user) {
    await run(
      'UPDATE users SET email = ?, name = ?, groups = ?, role = ?, last_login_at = ? WHERE id = ?',
      p.email,
      p.name,
      JSON.stringify(p.groups),
      externalRole(user, p),
      now(),
      user.id,
    );
  } else {
    const id = newId();
    const fromClaims = externalRole(undefined, p) === 'admin';
    // Bootstrap (no admin yet): the first account becomes admin and keeps it until an admin changes it.
    const role: Role = fromClaims ? 'admin' : p.emailVerified === false ? 'member' : await initialRole(p.email);
    const override = !fromClaims && role === 'admin' ? 1 : 0;
    await run(
      'INSERT INTO users (id, provider, external_id, email, name, groups, role, role_override, last_login_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      id,
      provider,
      p.externalId,
      p.email,
      p.name,
      JSON.stringify(p.groups),
      role,
      override,
      now(),
      now(),
    );
    user = await getUser(id);
  }
  await syncEntraTeams(user!.id, p.groups, provider);
  return (await getUser(user!.id))!;
}

export const upsertEntraUser = (p: { externalId: string; email: string; name: string; groups: string[] }) =>
  upsertExternalUser('entra', { ...p, adminGroups: config.ENTRA_ADMIN_GROUPS });

/** Teams bound to an IdP group (`entraGroupId`, the group id/name whatever the provider) follow the user's groups. */
export async function syncEntraTeams(userId: string, groups: string[], via: ExternalProvider = 'entra') {
  const teams = await all<{ identifier: string; entra_group_id: string }>('SELECT identifier, entra_group_id FROM teams WHERE entra_group_id IS NOT NULL');
  const wanted = new Set(teams.filter((t) => groups.includes(t.entra_group_id)).map((t) => t.identifier));
  await tx(async (d) => {
    await d.query('DELETE FROM team_members WHERE user_id = ? AND via = ?', [userId, via]);
    for (const team of wanted) {
      const existing = await d.query('SELECT team FROM team_members WHERE team = ? AND user_id = ?', [team, userId]);
      if (!existing.rows.length) await d.query('INSERT INTO team_members (team, user_id, via) VALUES (?, ?, ?)', [team, userId, via]);
    }
  });
}

export async function createServiceAccount(name: string, role: Role) {
  const id = newId();
  const email = `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${id.slice(0, 6)}@service.local`;
  await run("INSERT INTO users (id, provider, email, name, role, created_at) VALUES (?, 'service', ?, ?, ?, ?)", id, email, name, role, now());
  return (await getUser(id))!;
}

const AUTOMATION_EMAIL = 'workflow-automation@service.local';

/** The service account owning runs started by schedules, events, webhooks and parent workflows. */
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
  return principalOf(u!);
}

export async function listUsers(): Promise<PublicUser[]> {
  const users = await all<UserRow>('SELECT * FROM users ORDER BY provider, name');
  return Promise.all(users.map(publicUser));
}

export async function updateUser(id: string, patch: { role?: Role; roles?: string[]; active?: boolean; teams?: string[] }) {
  const u = await getUser(id);
  if (!u) throw notFound('User');
  if (patch.role) await run('UPDATE users SET role = ?, role_override = 1 WHERE id = ?', patch.role, id);
  if (patch.roles) await run('UPDATE users SET extra_roles = ? WHERE id = ?', JSON.stringify([...new Set(patch.roles)]), id);
  if (patch.active !== undefined) {
    await run('UPDATE users SET active = ? WHERE id = ?', patch.active ? 1 : 0, id);
    if (!patch.active) {
      await run('DELETE FROM sessions WHERE user_id = ?', id);
      await run('DELETE FROM api_tokens WHERE user_id = ?', id);
    }
  }
  if (patch.teams) {
    const teams = patch.teams;
    await tx(async (d) => {
      await d.query("DELETE FROM team_members WHERE user_id = ? AND via = 'manual'", [id]);
      for (const t of teams) {
        const exists = await d.query('SELECT team FROM team_members WHERE team = ? AND user_id = ?', [t, id]);
        if (!exists.rows.length) await d.query("INSERT INTO team_members (team, user_id, via) VALUES (?, ?, 'manual')", [t, id]);
      }
    });
  }
  const updated = await publicUser((await getUser(id))!);
  await emit({
    type: 'user.updated',
    blueprint: null,
    data: { user: { id, email: updated.email, role: updated.role, active: updated.active }, changes: Object.keys(patch) },
  });
  return updated;
}

// ---------- sessions ----------
export async function createSession(userId: string, ctx: { ip?: string; userAgent?: string } = {}) {
  const token = randomToken();
  const t = now();
  await run(
    'INSERT INTO sessions (token_hash, user_id, expires_at, created_at, last_seen_at, ip, user_agent) VALUES (?, ?, ?, ?, ?, ?, ?)',
    sha256(token),
    userId,
    later(config.SESSION_DAYS * 86400_000),
    t,
    t,
    ctx.ip ?? null,
    (ctx.userAgent ?? '').slice(0, 200) || null,
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

export async function deleteSession(token: string) {
  await run('DELETE FROM sessions WHERE token_hash = ?', sha256(token));
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

export async function createApiToken(p: { name: string; userId: string; createdBy: string; expiresInDays?: number | null } & TokenRestrictions) {
  if (p.blueprints?.length && p.scopes?.some((s) => s.startsWith('runs:') || s === 'admin'))
    throw badRequest('Tokens restricted to blueprints can only carry catalog scopes');
  if (p.blueprints?.length && !p.scopes?.length) throw badRequest('Blueprint-restricted tokens need explicit catalog scopes');
  const token = `${API_TOKEN_PREFIX}${randomToken()}`;
  const id = newId();
  await run(
    'INSERT INTO api_tokens (id, name, token_hash, prefix, user_id, created_by, created_at, expires_at, scopes, blueprints, ip_allow) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    id,
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
     FROM api_tokens t JOIN users u ON u.id = t.user_id ${userId ? 'WHERE t.user_id = ?' : ''} ORDER BY t.created_at DESC`,
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
    ? await run('DELETE FROM api_tokens WHERE id = ? AND user_id = ?', id, userId)
    : await run('DELETE FROM api_tokens WHERE id = ?', id);
  if (!changes) throw notFound('Token');
}

const lastUsedWrites = new Map<string, number>();

interface Resolved {
  user: UserRow;
  token?: NonNullable<Principal['token']> & { ipAllow: string[] | null };
}

async function userFromBearer(token: string, ip: string): Promise<Resolved | undefined> {
  const hash = sha256(token);
  if (token.startsWith(API_TOKEN_PREFIX)) {
    const row = await one<
      UserRow & { token_id: string; token_expires: string | null; t_scopes: string | null; t_blueprints: string | null; t_ip: string | null }
    >(
      `SELECT u.*, t.id AS token_id, t.expires_at AS token_expires, t.scopes AS t_scopes, t.blueprints AS t_blueprints, t.ip_allow AS t_ip
       FROM api_tokens t JOIN users u ON u.id = t.user_id WHERE t.token_hash = ?`,
      hash,
    );
    if (!row || (row.token_expires && row.token_expires < now())) return undefined;
    const ipAllow = json<string[] | null>(row.t_ip, null);
    if (ipAllow?.length && !ipAllowed(ip, ipAllow)) return undefined; // same answer as an unknown token
    // Record usage at most once a minute per token; admin tokens leave an audit trail.
    if ((lastUsedWrites.get(row.token_id) ?? 0) < Date.now() - 60_000) {
      lastUsedWrites.set(row.token_id, Date.now());
      void run('UPDATE api_tokens SET last_used_at = ? WHERE id = ?', now(), row.token_id).catch(() => undefined);
      if (row.role === 'admin') void audit({ id: row.id, email: row.email }, 'token.used', row.token_id, { ip });
    }
    return {
      user: row,
      token: { id: row.token_id, scopes: json<string[] | null>(row.t_scopes, null), blueprints: json<string[] | null>(row.t_blueprints, null), ipAllow },
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

/** Resolve the caller from a session or API token (Authorization: Bearer …, or the session cookie). */
export async function authenticate(req: FastifyRequest): Promise<Principal | undefined> {
  const header = bearer(req);
  const cookie = !header && config.SESSION_COOKIE ? cookieOf(req, cookieName()) : undefined;
  if (cookie && !cookie.startsWith(API_TOKEN_PREFIX)) {
    const found = await userFromBearer(cookie, req.ip);
    if (!found || found.user.active !== 1) return undefined;
    assertCsrf(req, cookie);
    req.principal = await principalOf(found.user);
    return req.principal;
  }
  const token = header;
  const found = token ? await userFromBearer(token, req.ip) : undefined;
  if (!found || found.user.active !== 1) return undefined;
  const principal = await principalOf(found.user);
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

/** preHandler: signed-in users and API tokens. */
export async function requireUser(req: FastifyRequest, reply: FastifyReply) {
  if (!(await authenticate(req))) return reply.code(401).send({ error: 'unauthorized' });
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
