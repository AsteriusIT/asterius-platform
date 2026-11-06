import { all, json, newId, now, run, type SqlValue } from './db.js';
import type { AuditEntry } from '@asterius/shared';

/** Append-only audit log of changes and decisions: who, what, on which target. */

export interface Actor {
  id: string | null;
  email: string | null;
}

export const SYSTEM: Actor = { id: null, email: 'system' };

export async function audit(actor: Actor, action: string, target: string | null, detail: Record<string, unknown> = {}) {
  try {
    await run(
      'INSERT INTO audit_log (id, at, action, actor_id, actor_email, target, detail) VALUES (?, ?, ?, ?, ?, ?, ?)',
      newId(),
      now(),
      action,
      actor.id,
      actor.email,
      target,
      JSON.stringify(detail),
    );
  } catch (err) {
    console.error('[audit] could not record', action, err); // never break the action itself
  }
}

interface Row {
  id: string;
  at: string;
  action: string;
  actor_email: string | null;
  target: string | null;
  detail: string;
}

export interface AuditQuery {
  search?: string;
  actor?: string;
  /** Prefix match: `webhook.` matches every webhook action. */
  action?: string;
  target?: string;
  /** ISO timestamps, inclusive. */
  from?: string;
  to?: string;
  limit: number;
  offset: number;
}

const like = (v: string) => `%${v.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

export async function listAudit(q: AuditQuery): Promise<AuditEntry[]> {
  const where: string[] = [];
  const params: SqlValue[] = [];
  const add = (clause: string, ...v: SqlValue[]) => {
    where.push(clause);
    params.push(...v);
  };
  if (q.search)
    add("(action LIKE ? ESCAPE '\\' OR target LIKE ? ESCAPE '\\' OR actor_email LIKE ? ESCAPE '\\')", like(q.search), like(q.search), like(q.search));
  if (q.actor) add("actor_email LIKE ? ESCAPE '\\'", like(q.actor));
  if (q.action) add("action LIKE ? ESCAPE '\\'", `${like(q.action).slice(1)}`);
  if (q.target) add("target LIKE ? ESCAPE '\\'", like(q.target));
  if (q.from) add('at >= ?', q.from);
  if (q.to) add('at <= ?', q.to);
  const rows = await all<Row>(
    `SELECT id, at, action, actor_email, target, detail FROM audit_log ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY at DESC LIMIT ? OFFSET ?`,
    ...params,
    q.limit,
    q.offset,
  );
  return rows.map((r) => ({ id: r.id, at: r.at, action: r.action, actorEmail: r.actor_email, target: r.target, detail: json(r.detail, {}) }));
}

/** Distinct values for the filter dropdowns. */
export async function auditFacets(): Promise<{ actions: string[]; actors: string[] }> {
  const actions = await all<{ v: string }>('SELECT DISTINCT action AS v FROM audit_log ORDER BY action LIMIT 300');
  const actors = await all<{ v: string }>('SELECT DISTINCT actor_email AS v FROM audit_log WHERE actor_email IS NOT NULL ORDER BY actor_email LIMIT 300');
  return { actions: actions.map((a) => a.v), actors: actors.map((a) => a.v) };
}
