import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit.js';
import { all, newId, now, one, run, tx } from '../db.js';
import { config } from '../config.js';
import { HttpError } from '../lib/errors.js';
import { SLUG } from '../schemas.js';
import { authenticate, type UserRow } from './users.js';
import { orgId } from '../orgs/context.js';
import { addMember, findOrg, membership, verifiedDomains } from '../orgs/orgs.js';

/**
 * SCIM 2.0 provisioning (RFC 7643/7644) under /scim/v2, so an identity provider creates, updates and deactivates
 * users and team memberships immediately instead of at the next sign-in. Authentication: a bearer API token that
 * carries only the `scim` scope (created by an admin with POST /api/v1/scim/token); that scope grants nothing else.
 *  - Users are provisioned with provider `scim` (no password). The first SSO sign-in with the same verified email
 *    adopts the account (see `adoptScimUser`); users that already signed in through SSO are managed in place.
 *  - Organizations: the token is an API token of one organization, so users and groups are that organization's
 *    members and teams. Provisioning makes the user a member; an account that already exists joins only when its
 *    email domain is verified by the organization.
 *  - Deactivation (active=false or DELETE) removes the membership; an account that belongs to no other organization
 *    is also disabled, with its sessions and API tokens revoked at once.
 *  - Groups are teams: members added through SCIM are tagged `via = 'scim'`; teams defined in CONFIG_DIR stay managed
 *    (their membership can be edited here, their definition cannot).
 */

const USER = 'urn:ietf:params:scim:schemas:core:2.0:User';
const GROUP = 'urn:ietf:params:scim:schemas:core:2.0:Group';
const LIST = 'urn:ietf:params:scim:api:messages:2.0:ListResponse';
const ERROR = 'urn:ietf:params:scim:api:messages:2.0:Error';

class ScimError extends HttpError {
  constructor(
    status: number,
    message: string,
    readonly scimType?: string,
  ) {
    super(status, message);
  }
}

/** Accounts SCIM may manage: federated identities, never local passwords or service accounts. */
const MANAGED = "provider NOT IN ('local', 'service')";
/** Members of the organization of the request (first parameter: the organization id). */
const MEMBER = 'id IN (SELECT user_id FROM memberships WHERE org_id = ?)';

interface TeamRow {
  identifier: string;
  title: string;
  managed: number;
  created_at: string;
}

const base = (path: string) => `${config.PUBLIC_URL}/scim/v2${path}`;

async function toUser(u: UserRow) {
  const parts = u.name.split(' ');
  return {
    schemas: [USER],
    id: u.id,
    ...(u.external_id ? { externalId: u.external_id } : {}),
    userName: u.email,
    name: { formatted: u.name, givenName: parts[0] ?? u.name, familyName: parts.slice(1).join(' ') },
    displayName: u.name,
    emails: [{ value: u.email, primary: true }],
    active: u.active === 1,
    meta: { resourceType: 'User', created: u.created_at, lastModified: u.last_login_at ?? u.created_at, location: base(`/Users/${u.id}`) },
  };
}

async function toGroup(t: TeamRow) {
  const members = await all<{ id: string; name: string }>(
    'SELECT u.id, u.name FROM team_members m JOIN users u ON u.id = m.user_id WHERE m.org_id = ? AND m.team = ? ORDER BY u.name',
    orgId(),
    t.identifier,
  );
  return {
    schemas: [GROUP],
    id: t.identifier,
    displayName: t.title,
    members: members.map((m) => ({ value: m.id, display: m.name, $ref: base(`/Users/${m.id}`) })),
    meta: { resourceType: 'Group', created: t.created_at, location: base(`/Groups/${t.identifier}`) },
  };
}

// ---------- inputs ----------
const userInput = z
  .object({
    userName: z.string().min(3).max(320),
    externalId: z.string().max(200).optional(),
    displayName: z.string().max(200).optional(),
    name: z.object({ formatted: z.string().optional(), givenName: z.string().optional(), familyName: z.string().optional() }).partial().optional(),
    emails: z.array(z.object({ value: z.string().email(), primary: z.boolean().optional() })).optional(),
    active: z.boolean().optional(),
  })
  .passthrough();

function normalize(i: z.infer<typeof userInput>) {
  const email = (i.emails?.find((e) => e.primary)?.value ?? i.emails?.[0]?.value ?? i.userName).toLowerCase();
  if (!z.string().email().safeParse(email).success) throw new ScimError(400, 'userName or emails must be an email address', 'invalidValue');
  const name = (i.name?.formatted || [i.name?.givenName, i.name?.familyName].filter(Boolean).join(' ') || i.displayName || email).slice(0, 200);
  return { email, name, externalId: i.externalId ?? null, active: i.active ?? true };
}

/** `attr eq "value"` only (what identity providers use to look entries up). */
function parseFilter(filter: string | undefined, attrs: Record<string, string>) {
  if (!filter) return undefined;
  const m = /^\s*([A-Za-z.]+)\s+eq\s+"((?:[^"\\]|\\.)*)"\s*$/i.exec(filter);
  const column = m && attrs[m[1]!.toLowerCase()];
  if (!m || !column) throw new ScimError(400, 'Unsupported filter: use <attribute> eq "value"', 'invalidFilter');
  return { column, value: m[2]!.replace(/\\(.)/g, '$1') };
}

// ---------- operations ----------
/** Other organizations of the user (their SCIM / admins decide there). */
const otherOrgs = async (userId: string) =>
  Number((await one<{ n: number }>('SELECT count(*) AS n FROM memberships WHERE user_id = ? AND org_id != ?', userId, orgId()))?.n ?? 0);

/**
 * Deprovision in the current organization. An account that only belongs here is disabled (the membership stays, so
 * the identity provider can reactivate it); otherwise only this organization's membership, teams and tokens go.
 */
export async function deprovision(userId: string) {
  const org = orgId();
  if ((await otherOrgs(userId)) === 0) {
    await run('UPDATE users SET active = 0 WHERE id = ? AND superadmin = 0', userId);
    await run('DELETE FROM sessions WHERE user_id = ?', userId);
    await run('DELETE FROM api_tokens WHERE user_id = ?', userId);
    return;
  }
  await run('DELETE FROM memberships WHERE org_id = ? AND user_id = ?', org, userId);
  await run('DELETE FROM team_members WHERE org_id = ? AND user_id = ?', org, userId);
  await run('DELETE FROM api_tokens WHERE org_id = ? AND user_id = ?', org, userId);
}

async function getManaged(id: string) {
  const u = await one<UserRow>(`SELECT * FROM users WHERE id = ? AND ${MANAGED} AND ${MEMBER}`, id, orgId());
  if (!u) throw new ScimError(404, 'User not found');
  return u;
}

async function applyUser(id: string, v: ReturnType<typeof normalize>) {
  const clash = await one<{ id: string }>(
    'SELECT id FROM users WHERE provider = (SELECT provider FROM users WHERE id = ?) AND email = ? AND id != ?',
    id,
    v.email,
    id,
  );
  if (clash) throw new ScimError(409, 'Another user has this userName', 'uniqueness');
  // The account is global: only an organization it exclusively belongs to may change its profile or reactivate it.
  const exclusive = (await otherOrgs(id)) === 0;
  if (exclusive) await run('UPDATE users SET email = ?, name = ?, external_id = COALESCE(?, external_id) WHERE id = ?', v.email, v.name, v.externalId, id);
  if (!v.active) await deprovision(id);
  else if (exclusive) await run('UPDATE users SET active = 1 WHERE id = ?', id);
}

async function createUser(v: ReturnType<typeof normalize>) {
  const org = orgId();
  const existing = await one<UserRow>(`SELECT * FROM users WHERE email = ? AND ${MANAGED}`, v.email);
  if (existing) {
    if (await membership(org, existing.id)) throw new ScimError(409, 'A user with this userName already exists', 'uniqueness');
    // An account of another organization joins this one only for an email domain this organization proved it owns.
    const domain = v.email.split('@')[1] ?? '';
    const row = await findOrg(org);
    if (!row || !verifiedDomains(row).includes(domain))
      throw new ScimError(409, 'This account exists in another organization; verify its email domain first', 'uniqueness');
    await addMember(org, existing.id, 'member', 'sso');
    return existing.id;
  }
  const id = newId();
  // Provisioned accounts start as plain members; the admin role is never granted through SCIM.
  await run(
    "INSERT INTO users (id, provider, external_id, email, name, role, active, created_at) VALUES (?, 'scim', ?, ?, ?, 'member', ?, ?)",
    id,
    v.externalId ?? v.email,
    v.email,
    v.name,
    v.active ? 1 : 0,
    now(),
  );
  await addMember(org, id, 'member', 'sso');
  return id;
}

/** PATCH operations on a User: replace/add of active, userName, name.*, displayName, emails. */
async function patchUser(u: UserRow, ops: PatchOps) {
  const cur = { email: u.email, name: u.name, externalId: u.external_id, active: u.active === 1 };
  for (const op of ops) {
    const verb = op.op.toLowerCase();
    if (verb === 'remove') throw new ScimError(400, 'remove is not supported on users', 'invalidPath');
    const values: Record<string, unknown> = op.path ? { [op.path]: op.value } : (op.value as Record<string, unknown>);
    for (const [path, value] of Object.entries(values ?? {})) {
      switch (path.toLowerCase()) {
        case 'active':
          cur.active = value === true || value === 'True' || value === 'true';
          break;
        case 'username':
          cur.email = String(value).toLowerCase();
          break;
        case 'displayname':
        case 'name.formatted':
          cur.name = String(value).slice(0, 200);
          break;
        case 'externalid':
          cur.externalId = String(value);
          break;
        case 'emails':
          cur.email = String((value as { value: string }[])[0]?.value ?? cur.email).toLowerCase();
          break;
        case 'name': {
          const n = value as { formatted?: string; givenName?: string; familyName?: string };
          cur.name = (n.formatted || [n.givenName, n.familyName].filter(Boolean).join(' ') || cur.name).slice(0, 200);
          break;
        }
        default:
          break; // unknown attributes are ignored, as the RFC allows
      }
    }
  }
  if (!z.string().email().safeParse(cur.email).success) throw new ScimError(400, 'userName must be an email address', 'invalidValue');
  await applyUser(u.id, cur);
}

type PatchOps = { op: string; path?: string; value?: unknown }[];
const patchBody = z.object({
  schemas: z.array(z.string()).optional(),
  Operations: z
    .array(z.object({ op: z.string(), path: z.string().optional(), value: z.unknown().optional() }))
    .min(1)
    .max(100),
});

async function managedTeam(id: string) {
  const t = await one<TeamRow>('SELECT identifier, title, managed, created_at FROM teams WHERE org_id = ? AND identifier = ?', orgId(), id);
  if (!t) throw new ScimError(404, 'Group not found');
  return t;
}

async function setMembers(team: string, userIds: string[], mode: 'add' | 'remove' | 'replace') {
  const org = orgId();
  const users = userIds.length
    ? await all<{ id: string }>(`SELECT id FROM users WHERE ${MANAGED} AND ${MEMBER} AND id IN (${userIds.map(() => '?').join(',')})`, org, ...userIds)
    : [];
  const valid = new Set(users.map((u) => u.id));
  if (mode !== 'remove' && valid.size !== new Set(userIds).size) throw new ScimError(400, 'Unknown member', 'invalidValue');
  await tx(async (d) => {
    if (mode === 'replace') await d.query("DELETE FROM team_members WHERE org_id = ? AND team = ? AND via = 'scim'", [org, team]);
    for (const id of valid) {
      if (mode === 'remove') {
        await d.query('DELETE FROM team_members WHERE org_id = ? AND team = ? AND user_id = ?', [org, team, id]);
        continue;
      }
      const has = await d.query('SELECT team FROM team_members WHERE org_id = ? AND team = ? AND user_id = ?', [org, team, id]);
      if (!has.rows.length) await d.query("INSERT INTO team_members (org_id, team, user_id, via) VALUES (?, ?, ?, 'scim')", [org, team, id]);
    }
  });
}

const memberIds = (v: unknown) => (Array.isArray(v) ? v : [v]).map((m) => String((m as { value?: unknown })?.value ?? '')).filter(Boolean);

// ---------- auth ----------
async function requireScim(req: FastifyRequest, reply: FastifyReply) {
  let ok = false;
  try {
    const p = await authenticate(req);
    ok = !!p?.token?.scopes?.includes('scim');
  } catch {
    // a token without the scim scope is refused by the scope guard: treated as unauthenticated here
  }
  if (!ok)
    return reply
      .code(401)
      .header('www-authenticate', 'Bearer')
      .send({ schemas: [ERROR], status: '401', detail: 'A SCIM bearer token is required' });
}

export async function scimRoutes(app: FastifyInstance) {
  app.addContentTypeParser('application/scim+json', { parseAs: 'string' }, (_req, body, done) => {
    try {
      done(null, body ? JSON.parse(body as string) : undefined);
    } catch {
      done(Object.assign(new Error('Invalid JSON body'), { statusCode: 400 }), undefined);
    }
  });

  await app.register(
    async (s) => {
      s.addHook('preHandler', requireScim);
      s.addHook('onSend', async (_req, reply) => {
        reply.header('content-type', 'application/scim+json; charset=utf-8');
      });
      s.setErrorHandler((err, req, reply) => {
        if (err instanceof ScimError)
          return reply
            .code(err.statusCode)
            .send({ schemas: [ERROR], status: String(err.statusCode), ...(err.scimType ? { scimType: err.scimType } : {}), detail: err.message });
        if (err instanceof z.ZodError)
          return reply
            .code(400)
            .send({ schemas: [ERROR], status: '400', scimType: 'invalidValue', detail: err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') });
        const status = err instanceof HttpError ? err.statusCode : ((err as { statusCode?: number }).statusCode ?? 500);
        if (status >= 500) req.log.error({ err }, 'scim request failed');
        return reply.code(status).send({ schemas: [ERROR], status: String(status), detail: status >= 500 ? 'Internal error' : (err as Error).message });
      });

      const actor = (req: FastifyRequest) => ({ id: req.principal.id, email: req.principal.email });

      s.get('/ServiceProviderConfig', async () => ({
        schemas: ['urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig'],
        patch: { supported: true },
        bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
        filter: { supported: true, maxResults: 200 },
        changePassword: { supported: false },
        sort: { supported: false },
        etag: { supported: false },
        authenticationSchemes: [{ type: 'oauthbearertoken', name: 'Bearer token', description: 'API token with the scim scope' }],
      }));
      s.get('/ResourceTypes', async () => ({
        schemas: [LIST],
        totalResults: 2,
        Resources: [
          { id: 'User', name: 'User', endpoint: '/Users', schema: USER },
          { id: 'Group', name: 'Group', endpoint: '/Groups', schema: GROUP },
        ],
      }));
      s.get('/Schemas', async () => ({ schemas: [LIST], totalResults: 0, Resources: [] }));

      // ---- Users ----
      const paging = z.object({
        startIndex: z.coerce.number().int().min(1).default(1),
        count: z.coerce.number().int().min(0).max(200).default(100),
        filter: z.string().max(300).optional(),
      });
      s.get('/Users', async (req) => {
        const q = paging.parse(req.query);
        const f = parseFilter(q.filter, { username: 'email', externalid: 'external_id', 'emails.value': 'email' });
        const where = `WHERE ${MANAGED} AND ${MEMBER}${f ? ` AND ${f.column} = ?` : ''}`;
        const params = [orgId(), ...(f ? [f.column === 'email' ? f.value.toLowerCase() : f.value] : [])];
        const total = Number((await one<{ n: number }>(`SELECT count(*) AS n FROM users ${where}`, ...params))?.n ?? 0);
        const rows = await all<UserRow>(`SELECT * FROM users ${where} ORDER BY created_at, id LIMIT ? OFFSET ?`, ...params, q.count, q.startIndex - 1);
        return { schemas: [LIST], totalResults: total, startIndex: q.startIndex, itemsPerPage: rows.length, Resources: await Promise.all(rows.map(toUser)) };
      });
      s.get('/Users/:id', async (req) => toUser(await getManaged((req.params as { id: string }).id)));
      s.post('/Users', async (req, reply) => {
        const v = normalize(userInput.parse(req.body));
        const id = await createUser(v);
        await audit(actor(req), 'scim.user_created', v.email);
        return reply
          .code(201)
          .header('location', base(`/Users/${id}`))
          .send(await toUser(await getManaged(id)));
      });
      s.put('/Users/:id', async (req) => {
        const u = await getManaged((req.params as { id: string }).id);
        const v = normalize(userInput.parse(req.body));
        await applyUser(u.id, v);
        await audit(actor(req), 'scim.user_updated', v.email, { active: v.active });
        return toUser(await getManaged(u.id));
      });
      s.patch('/Users/:id', async (req) => {
        const u = await getManaged((req.params as { id: string }).id);
        await patchUser(u, patchBody.parse(req.body).Operations);
        const after = await getManaged(u.id);
        await audit(actor(req), 'scim.user_patched', after.email, { active: after.active === 1 });
        return toUser(after);
      });
      s.delete('/Users/:id', async (req, reply) => {
        const u = await getManaged((req.params as { id: string }).id);
        await deprovision(u.id);
        await audit(actor(req), 'scim.user_deprovisioned', u.email);
        return reply.code(204).send();
      });

      // ---- Groups (teams) ----
      s.get('/Groups', async (req) => {
        const q = paging.parse(req.query);
        const f = parseFilter(q.filter, { displayname: 'title', id: 'identifier' });
        const where = `WHERE org_id = ?${f ? ` AND ${f.column} = ?` : ''}`;
        const params = [orgId(), ...(f ? [f.value] : [])];
        const total = Number((await one<{ n: number }>(`SELECT count(*) AS n FROM teams ${where}`, ...params))?.n ?? 0);
        const rows = await all<TeamRow>(
          `SELECT identifier, title, managed, created_at FROM teams ${where} ORDER BY title LIMIT ? OFFSET ?`,
          ...params,
          q.count,
          q.startIndex - 1,
        );
        return { schemas: [LIST], totalResults: total, startIndex: q.startIndex, itemsPerPage: rows.length, Resources: await Promise.all(rows.map(toGroup)) };
      });
      s.get('/Groups/:id', async (req) => toGroup(await managedTeam((req.params as { id: string }).id)));
      s.post('/Groups', async (req, reply) => {
        const body = z
          .object({ displayName: z.string().min(1).max(100), members: z.array(z.object({ value: z.string() })).optional() })
          .passthrough()
          .parse(req.body);
        const identifier = body.displayName
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-+|-+$/g, '')
          .replace(/^[^a-z]+/, 'g-')
          .slice(0, 64);
        if (!SLUG.test(identifier)) throw new ScimError(400, 'displayName cannot be turned into a team identifier', 'invalidValue');
        if (await one('SELECT identifier FROM teams WHERE org_id = ? AND identifier = ?', orgId(), identifier))
          throw new ScimError(409, 'A group with this name already exists', 'uniqueness');
        await run(
          "INSERT INTO teams (org_id, identifier, title, description, managed, created_at) VALUES (?, ?, ?, 'Provisioned by SCIM', 0, ?)",
          orgId(),
          identifier,
          body.displayName,
          now(),
        );
        if (body.members?.length)
          await setMembers(
            identifier,
            body.members.map((m) => m.value),
            'add',
          );
        await audit(actor(req), 'scim.group_created', identifier);
        return reply
          .code(201)
          .header('location', base(`/Groups/${identifier}`))
          .send(await toGroup(await managedTeam(identifier)));
      });
      s.put('/Groups/:id', async (req) => {
        const t = await managedTeam((req.params as { id: string }).id);
        const body = z
          .object({ displayName: z.string().min(1).max(100).optional(), members: z.array(z.object({ value: z.string() })).default([]) })
          .passthrough()
          .parse(req.body);
        if (body.displayName && !t.managed)
          await run('UPDATE teams SET title = ? WHERE org_id = ? AND identifier = ?', body.displayName, orgId(), t.identifier);
        await setMembers(
          t.identifier,
          body.members.map((m) => m.value),
          'replace',
        );
        await audit(actor(req), 'scim.group_updated', t.identifier, { members: body.members.length });
        return toGroup(await managedTeam(t.identifier));
      });
      s.patch('/Groups/:id', async (req) => {
        const t = await managedTeam((req.params as { id: string }).id);
        for (const op of patchBody.parse(req.body).Operations) {
          const verb = op.op.toLowerCase();
          const path = op.path ?? '';
          if (/^members/i.test(path) || (!path && verb !== 'remove')) {
            if (!path && op.value && typeof op.value === 'object' && 'displayName' in op.value && !t.managed)
              await run(
                'UPDATE teams SET title = ? WHERE org_id = ? AND identifier = ?',
                String((op.value as { displayName: string }).displayName),
                orgId(),
                t.identifier,
              );
            const filtered = /members\[value eq "([^"]+)"\]/i.exec(path)?.[1];
            if (verb === 'remove') await setMembers(t.identifier, filtered ? [filtered] : memberIds(op.value), 'remove');
            else if (verb === 'add' || verb === 'replace') {
              const ids = memberIds(path ? op.value : ((op.value as { members?: unknown })?.members ?? []));
              await setMembers(t.identifier, ids, verb === 'add' ? 'add' : 'replace');
            }
          } else if (/^displayname$/i.test(path) && !t.managed)
            await run('UPDATE teams SET title = ? WHERE org_id = ? AND identifier = ?', String(op.value), orgId(), t.identifier);
          else throw new ScimError(400, `Unsupported path "${path}"`, 'invalidPath');
        }
        await audit(actor(req), 'scim.group_patched', t.identifier);
        return toGroup(await managedTeam(t.identifier));
      });
      s.delete('/Groups/:id', async (req, reply) => {
        const t = await managedTeam((req.params as { id: string }).id);
        if (t.managed) throw new ScimError(400, 'This group is defined in the configuration files and cannot be deleted', 'mutability');
        const owned = await one<{ n: number }>('SELECT count(*) AS n FROM entities WHERE org_id = ? AND team = ?', orgId(), t.identifier);
        if (Number(owned?.n) > 0) throw new ScimError(409, `The team owns ${owned!.n} entities; reassign them first`, 'mutability');
        await run('DELETE FROM teams WHERE org_id = ? AND identifier = ?', orgId(), t.identifier);
        await audit(actor(req), 'scim.group_deleted', t.identifier);
        return reply.code(204).send();
      });
    },
    { prefix: '/scim/v2' },
  );
}
