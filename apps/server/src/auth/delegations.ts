import type { Delegation } from '@asterius/shared';
import { all, now, one, run } from '../db.js';
import { badRequest, notFound } from '../lib/errors.js';
import { orgId } from '../orgs/context.js';
import { findOrg, orgRef } from '../orgs/orgs.js';
import { delegationInput } from '../schemas.js';
import { getUser, principalOf, type Principal, type UserRow } from './users.js';

/**
 * Out-of-office delegation, per organization: a user names a delegate (another member), optionally for a date range.
 * While it is active the delegate may decide the approvals (and answer the input steps) the user is eligible for —
 * never their own request unless self-approval is allowed — and is notified of them. Decisions record both people
 * (`on_behalf_of`). Delegation is one hop: a delegate's own delegate gets nothing.
 */

interface Row {
  user_id: string;
  delegate_id: string;
  starts_at: string | null;
  ends_at: string | null;
  created_at: string;
  u_name: string;
  u_email: string;
  d_name: string;
  d_email: string;
}

const SELECT = `SELECT g.user_id, g.delegate_id, g.starts_at, g.ends_at, g.created_at, u.name AS u_name, u.email AS u_email, d.name AS d_name, d.email AS d_email
  FROM delegations g JOIN users u ON u.id = g.user_id JOIN users d ON d.id = g.delegate_id`;
/** In effect at `t`: inside its date range (bounds are ISO strings, compared as text). */
const ACTIVE = '(g.starts_at IS NULL OR g.starts_at <= ?) AND (g.ends_at IS NULL OR g.ends_at > ?)';

const isActive = (r: Pick<Row, 'starts_at' | 'ends_at'>, t = now()) => (!r.starts_at || r.starts_at <= t) && (!r.ends_at || r.ends_at > t);

const toView = (r: Row): Delegation => ({
  user: { id: r.user_id, name: r.u_name, email: r.u_email },
  delegate: { id: r.delegate_id, name: r.d_name, email: r.d_email },
  startsAt: r.starts_at,
  endsAt: r.ends_at,
  active: isActive(r),
  createdAt: r.created_at,
});

export async function getDelegation(userId: string): Promise<Delegation | null> {
  const r = await one<Row>(`${SELECT} WHERE g.org_id = ? AND g.user_id = ?`, orgId(), userId);
  return r ? toView(r) : null;
}

/** Admins: every delegation of the organization. */
export async function listDelegations(): Promise<Delegation[]> {
  return (await all<Row>(`${SELECT} WHERE g.org_id = ? ORDER BY u.name`, orgId())).map(toView);
}

const iso = (v: string | null | undefined) => (v ? new Date(v).toISOString() : null);

export async function setDelegation(userId: string, input: unknown): Promise<Delegation> {
  const d = delegationInput.parse(input);
  const delegate = await one<UserRow>(
    `SELECT u.* FROM users u JOIN memberships m ON m.user_id = u.id
     WHERE m.org_id = ? AND u.active = 1 AND u.provider != 'service' AND (u.id = ? OR lower(u.email) = lower(?))`,
    orgId(),
    d.delegate,
    d.delegate,
  );
  if (!delegate) throw badRequest(`No active member "${d.delegate}" in this organization`);
  if (delegate.id === userId) throw badRequest('You cannot delegate to yourself');
  const endsAt = iso(d.endsAt);
  if (endsAt && endsAt <= now()) throw badRequest('endsAt is in the past');
  const args = [delegate.id, iso(d.startsAt), endsAt];
  const { changes } = await run(
    'UPDATE delegations SET delegate_id = ?, starts_at = ?, ends_at = ? WHERE org_id = ? AND user_id = ?',
    ...args,
    orgId(),
    userId,
  );
  if (!changes)
    await run(
      'INSERT INTO delegations (delegate_id, starts_at, ends_at, org_id, user_id, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      ...args,
      orgId(),
      userId,
      now(),
    );
  return (await getDelegation(userId))!;
}

export async function clearDelegation(userId: string, mustExist = false) {
  const { changes } = await run('DELETE FROM delegations WHERE org_id = ? AND user_id = ?', orgId(), userId);
  if (!changes && mustExist) throw notFound('Delegation');
  return changes > 0;
}

/** Ids of the people `userId` is the active delegate of. */
async function activeDelegatorIds(userId: string): Promise<string[]> {
  const t = now();
  return (
    await all<{ user_id: string }>(`SELECT g.user_id FROM delegations g WHERE g.org_id = ? AND g.delegate_id = ? AND ${ACTIVE}`, orgId(), userId, t, t)
  ).map((r) => r.user_id);
}

/** The principal with `delegators` loaded (the people it may currently decide for). Idempotent. */
export async function withDelegators(p: Principal): Promise<Principal> {
  if (p.delegators) return p;
  const ids = await activeDelegatorIds(p.id);
  if (!ids.length) return { ...p, delegators: [] };
  const org = p.org ?? orgRef((await findOrg(orgId()))!);
  const delegators: Principal[] = [];
  for (const id of ids) {
    const u = await getUser(id);
    if (u && Number(u.active) === 1) delegators.push(await principalOf(u, org));
  }
  return { ...p, delegators };
}

/** Active delegate of each of `userIds` (delegator id → delegate id). */
export async function activeDelegates(userIds: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!userIds.length) return out;
  const t = now();
  const rows = await all<{ user_id: string; delegate_id: string }>(
    `SELECT g.user_id, g.delegate_id FROM delegations g WHERE g.org_id = ? AND ${ACTIVE} AND g.user_id IN (${userIds.map(() => '?').join(',')})`,
    orgId(),
    t,
    t,
    ...userIds,
  );
  for (const r of rows) out.set(r.user_id, r.delegate_id);
  return out;
}

/** Attach `delegators` to a set of principals (members of an organization) with one query. */
export async function attachDelegators(ps: Principal[]): Promise<Principal[]> {
  const byId = new Map(ps.map((p) => [p.id, p]));
  const delegates = await activeDelegates(ps.map((p) => p.id));
  const out = new Map(ps.map((p) => [p.id, { ...p, delegators: [] as Principal[] }]));
  for (const [user, delegate] of delegates) {
    const from = byId.get(user);
    if (from) out.get(delegate)?.delegators.push(from);
  }
  return [...out.values()];
}
