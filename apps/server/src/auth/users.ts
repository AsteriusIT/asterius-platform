import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config.js';
import { all, json, later, newId, now, one, run, tx } from '../db.js';
import type { ApiToken, PublicUser, Role, Subjects, TeamRef, UserProvider } from '@asterius/shared';
import { badRequest, conflict, notFound } from '../lib/errors.js';

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
  last_login_at: string | null;
  tour_completed_at: string | null;
  created_at: string;
}

/** The authenticated caller of a request. */
export interface Principal {
  id: string;
  email: string;
  name: string;
  role: Role;
  provider: UserProvider;
  teams: string[];
}

export async function teamsOf(userId: string): Promise<TeamRef[]> {
  return all<TeamRef>('SELECT t.identifier, t.title FROM team_members m JOIN teams t ON t.identifier = m.team WHERE m.user_id = ? ORDER BY t.title', userId);
}

export async function principalOf(u: UserRow): Promise<Principal> {
  const teams = await teamsOf(u.id);
  return { id: u.id, email: u.email, name: u.name, role: u.role, provider: u.provider, teams: teams.map((t) => t.identifier) };
}

export async function publicUser(u: UserRow): Promise<PublicUser> {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    provider: u.provider,
    role: u.role,
    active: u.active === 1,
    teams: await teamsOf(u.id),
    lastLoginAt: u.last_login_at,
    tourCompletedAt: u.tour_completed_at,
  };
}

export const getUser = (id: string) => one<UserRow>('SELECT * FROM users WHERE id = ?', id);

/** Admin bootstrap: ADMIN_EMAILS, or the very first human account when no admin exists yet. */
async function initialRole(email: string): Promise<Role> {
  if (config.ADMIN_EMAILS.includes(email.toLowerCase())) return 'admin';
  const admin = await one("SELECT id FROM users WHERE role = 'admin' AND provider != 'service' LIMIT 1");
  return admin ? 'member' : 'admin';
}

export async function createLocalUser(email: string, name: string, password: string) {
  email = email.toLowerCase();
  if (await one("SELECT id FROM users WHERE provider = 'local' AND email = ?", email)) throw conflict('An account already exists for this email');
  const id = newId();
  await run(
    "INSERT INTO users (id, provider, email, name, password_hash, role, created_at) VALUES (?, 'local', ?, ?, ?, ?, ?)",
    id,
    email,
    name,
    hashPassword(password),
    await initialRole(email),
    now(),
  );
  return (await getUser(id))!;
}

/** Entra ID sign-in: upsert the user, then synchronise team memberships and admin role from group claims. */
export async function upsertEntraUser(p: { externalId: string; email: string; name: string; groups: string[] }) {
  let user = await one<UserRow>("SELECT * FROM users WHERE provider = 'entra' AND external_id = ?", p.externalId);
  const groupAdmin = p.groups.some((g) => config.ENTRA_ADMIN_GROUPS.includes(g));
  if (user) {
    const role: Role = groupAdmin || config.ADMIN_EMAILS.includes(p.email) ? 'admin' : user.role;
    await run(
      'UPDATE users SET email = ?, name = ?, groups = ?, role = ?, last_login_at = ? WHERE id = ?',
      p.email,
      p.name,
      JSON.stringify(p.groups),
      role,
      now(),
      user.id,
    );
  } else {
    const id = newId();
    const role: Role = groupAdmin ? 'admin' : await initialRole(p.email);
    await run(
      "INSERT INTO users (id, provider, external_id, email, name, groups, role, last_login_at, created_at) VALUES (?, 'entra', ?, ?, ?, ?, ?, ?, ?)",
      id,
      p.externalId,
      p.email,
      p.name,
      JSON.stringify(p.groups),
      role,
      now(),
      now(),
    );
    user = await getUser(id);
  }
  await syncEntraTeams(user!.id, p.groups);
  return (await getUser(user!.id))!;
}

export async function syncEntraTeams(userId: string, groups: string[]) {
  const teams = await all<{ identifier: string; entra_group_id: string }>('SELECT identifier, entra_group_id FROM teams WHERE entra_group_id IS NOT NULL');
  const wanted = new Set(teams.filter((t) => groups.includes(t.entra_group_id)).map((t) => t.identifier));
  await tx(async (d) => {
    await d.query("DELETE FROM team_members WHERE user_id = ? AND via = 'entra'", [userId]);
    for (const team of wanted) {
      const existing = await d.query('SELECT team FROM team_members WHERE team = ? AND user_id = ?', [team, userId]);
      if (!existing.rows.length) await d.query("INSERT INTO team_members (team, user_id, via) VALUES (?, ?, 'entra')", [team, userId]);
    }
  });
}

export async function createServiceAccount(name: string, role: Role) {
  const id = newId();
  const email = `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${id.slice(0, 6)}@service.local`;
  await run("INSERT INTO users (id, provider, email, name, role, created_at) VALUES (?, 'service', ?, ?, ?, ?)", id, email, name, role, now());
  return (await getUser(id))!;
}

export async function listUsers(): Promise<PublicUser[]> {
  const users = await all<UserRow>('SELECT * FROM users ORDER BY provider, name');
  return Promise.all(users.map(publicUser));
}

export async function updateUser(id: string, patch: { role?: Role; active?: boolean; teams?: string[] }) {
  const u = await getUser(id);
  if (!u) throw notFound('User');
  if (patch.role) await run('UPDATE users SET role = ? WHERE id = ?', patch.role, id);
  if (patch.active !== undefined) {
    await run('UPDATE users SET active = ? WHERE id = ?', patch.active ? 1 : 0, id);
    if (!patch.active) await run('DELETE FROM sessions WHERE user_id = ?', id);
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
  return publicUser((await getUser(id))!);
}

// ---------- sessions ----------
export async function createSession(userId: string) {
  const token = randomToken();
  await run('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)', sha256(token), userId, later(config.SESSION_DAYS * 86400_000));
  await run('UPDATE users SET last_login_at = ? WHERE id = ?', now(), userId);
  return token;
}

export async function deleteSession(token: string) {
  await run('DELETE FROM sessions WHERE token_hash = ?', sha256(token));
}

export async function purgeExpiredAuth() {
  const t = now();
  await run('DELETE FROM sessions WHERE expires_at < ?', t);
  await run('DELETE FROM oauth_states WHERE expires_at < ?', t);
}

// ---------- API tokens ----------
export async function createApiToken(p: { name: string; userId: string; createdBy: string; expiresInDays?: number | null }) {
  const token = `${API_TOKEN_PREFIX}${randomToken()}`;
  const id = newId();
  await run(
    'INSERT INTO api_tokens (id, name, token_hash, prefix, user_id, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    id,
    p.name,
    sha256(token),
    token.slice(0, 10),
    p.userId,
    p.createdBy,
    now(),
    p.expiresInDays ? later(p.expiresInDays * 86400_000) : null,
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
  }>(
    `SELECT t.id, t.name, t.prefix, t.user_id, u.name AS user_name, t.created_at, t.expires_at, t.last_used_at
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
  }));
}

export async function deleteApiToken(id: string, userId?: string) {
  const { changes } = userId
    ? await run('DELETE FROM api_tokens WHERE id = ? AND user_id = ?', id, userId)
    : await run('DELETE FROM api_tokens WHERE id = ?', id);
  if (!changes) throw notFound('Token');
}

const lastUsedWrites = new Map<string, number>();

async function userFromBearer(token: string): Promise<UserRow | undefined> {
  const hash = sha256(token);
  if (token.startsWith(API_TOKEN_PREFIX)) {
    const row = await one<UserRow & { token_id: string; token_expires: string | null }>(
      'SELECT u.*, t.id AS token_id, t.expires_at AS token_expires FROM api_tokens t JOIN users u ON u.id = t.user_id WHERE t.token_hash = ?',
      hash,
    );
    if (!row || (row.token_expires && row.token_expires < now())) return undefined;
    // Record usage at most once a minute per token.
    if ((lastUsedWrites.get(row.token_id) ?? 0) < Date.now() - 60_000) {
      lastUsedWrites.set(row.token_id, Date.now());
      void run('UPDATE api_tokens SET last_used_at = ? WHERE id = ?', now(), row.token_id).catch(() => undefined);
    }
    return row;
  }
  return one<UserRow>('SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?', hash, now());
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

/** Resolve the caller from a session or API token (Authorization: Bearer …). */
export async function authenticate(req: FastifyRequest): Promise<Principal | undefined> {
  const token = bearer(req);
  const user = token ? await userFromBearer(token) : undefined;
  if (!user || user.active !== 1) return undefined;
  req.principal = await principalOf(user);
  return req.principal;
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
  if (s.roles?.includes(p.role)) return true;
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
