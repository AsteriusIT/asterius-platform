import { all, json, newId, now, run, type SqlValue } from './db.js';
import { componentLogger } from './logger.js';
import type { AuditEntry } from '@asterius/shared';

/** Append-only audit log of changes and decisions: who, what, on which target. */

export interface Actor {
  id: string | null;
  email: string | null;
}

const log = componentLogger('audit');

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
    log.error({ err, action, target }, 'could not record audit entry'); // never break the action itself
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

export async function listAudit(q: { search?: string; limit: number; offset: number }): Promise<AuditEntry[]> {
  const where: string[] = [];
  const params: SqlValue[] = [];
  if (q.search) {
    where.push("(action LIKE ? ESCAPE '\\' OR target LIKE ? ESCAPE '\\' OR actor_email LIKE ? ESCAPE '\\')");
    const s = `%${q.search.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    params.push(s, s, s);
  }
  const rows = await all<Row>(
    `SELECT id, at, action, actor_email, target, detail FROM audit_log ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY at DESC LIMIT ? OFFSET ?`,
    ...params,
    q.limit,
    q.offset,
  );
  return rows.map((r) => ({ id: r.id, at: r.at, action: r.action, actorEmail: r.actor_email, target: r.target, detail: json(r.detail, {}) }));
}
