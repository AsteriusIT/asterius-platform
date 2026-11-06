import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Access, Blueprint, BlueprintPermissions, EffectivePermissions, Subjects } from '@asterius/shared';
import { listBlueprints } from '../catalog/blueprints.js';
import type { SqlValue } from '../db.js';
import { forbidden } from '../lib/errors.js';
import { canEditEntity, isAdmin, matchesSubjects, requireUser, type Principal } from './users.js';

/**
 * Fine-grained access control. Roles: `admin` (everything), `member`, and delegated roles granted on top
 * (`integration-admin`: integrations, `blueprint-owner`: blueprints, `approver`: default approver of workflows),
 * plus any custom role slug usable in blueprint permissions. Blueprints carry optional rules per operation;
 * without a rule read/run are open to every signed-in user and write/delete need the owner team (or admin).
 */
export type Operation = keyof BlueprintPermissions;

/** Principal of unattended automation (AI agent tools): matches only rules that name nobody. */
export const ANONYMOUS: Principal = { id: '', email: '', name: 'anonymous', role: 'member', roles: [], provider: 'service', teams: [] };

/** preHandler factory: admins and holders of one of the delegated roles. */
export const requireRole = (...roles: string[]) =>
  async function (req: FastifyRequest, reply: FastifyReply) {
    await requireUser(req, reply);
    if (reply.sent) return;
    if (!isAdmin(req.principal) && !roles.some((r) => req.principal.roles.includes(r)))
      return reply.code(403).send({ error: `Admin or ${roles.join('/')} role required` });
  };

const isRule = (s: Subjects | undefined): s is Subjects => !!s && !!(s.roles?.length || s.teams?.length || s.users?.length || s.ownerTeam);

/** May the principal perform `op` on an entity of `bp` owned by `ownerTeam`? */
export function can(p: Principal, bp: Pick<Blueprint, 'permissions'>, op: Operation, ownerTeam: string | null): boolean {
  if (isAdmin(p)) return true;
  const rule = bp.permissions?.[op];
  if (isRule(rule)) return matchesSubjects(p, rule, ownerTeam);
  return op === 'read' || op === 'run' ? true : canEditEntity(p, ownerTeam);
}

/** Access on every entity (true), only on entities of the principal's teams ('team'), or none (false). */
export function accessOf(p: Principal, bp: Pick<Blueprint, 'permissions'>, op: Operation): Access {
  if (isAdmin(p)) return true;
  const rule = bp.permissions?.[op];
  if (!isRule(rule)) return op === 'read' || op === 'run' ? true : p.teams.length ? 'team' : false;
  if (matchesSubjects(p, { ...rule, ownerTeam: false }, null) && (rule.roles?.length || rule.teams?.length || rule.users?.length)) return true;
  return rule.ownerTeam && p.teams.length ? 'team' : false;
}

export function assertCan(p: Principal, bp: Blueprint, op: Operation, ownerTeam: string | null) {
  if (!can(p, bp, op, ownerTeam)) throw forbidden(`You are not allowed to ${op} ${bp.identifier} entities`);
}

// ---------- read filter pushed into SQL ----------
let restrictedCache: { at: number; list: Blueprint[] } | undefined;
async function restrictedBlueprints(): Promise<Blueprint[]> {
  if (restrictedCache && Date.now() - restrictedCache.at < 3_000) return restrictedCache.list;
  const list = (await listBlueprints()).filter((b) => isRule(b.permissions?.read));
  restrictedCache = { at: Date.now(), list };
  return list;
}
export const invalidateAccessCache = () => {
  restrictedCache = undefined;
};

/**
 * SQL condition (columns `blueprint` and `team`) restricting rows to what the principal may read. It is part of the
 * query itself, so pagination and totals never include hidden rows.
 */
export async function readFilter(p: Principal, alias = ''): Promise<{ sql: string; params: SqlValue[] } | undefined> {
  if (isAdmin(p)) return undefined;
  const restricted = await restrictedBlueprints();
  if (!restricted.length) return undefined;
  const col = (c: string) => (alias ? `${alias}.${c}` : c);
  const hidden: string[] = [];
  const partial: Blueprint[] = [];
  for (const b of restricted) {
    const a = accessOf(p, b, 'read');
    if (a === true) continue;
    hidden.push(b.identifier);
    if (a === 'team') partial.push(b);
  }
  if (!hidden.length) return undefined;
  const params: SqlValue[] = [...hidden];
  let sql = `${col('blueprint')} NOT IN (${hidden.map(() => '?').join(',')})`;
  for (const b of partial) {
    sql += ` OR (${col('blueprint')} = ? AND ${col('team')} IN (${p.teams.map(() => '?').join(',')}))`;
    params.push(b.identifier, ...p.teams);
  }
  return { sql: `(${sql})`, params };
}

/** Blueprints the principal can see at all. */
export const visibleBlueprints = (p: Principal, all: Blueprint[]) => all.filter((b) => accessOf(p, b, 'read') !== false);

export async function effectivePermissions(p: Principal): Promise<EffectivePermissions> {
  const out: EffectivePermissions['blueprints'] = {};
  for (const b of await listBlueprints())
    out[b.identifier] = { read: accessOf(p, b, 'read'), write: accessOf(p, b, 'write'), delete: accessOf(p, b, 'delete'), run: accessOf(p, b, 'run') };
  return { roles: [p.role, ...p.roles], admin: isAdmin(p), blueprints: out };
}
