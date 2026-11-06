import { all, json, newId, now, run, type SqlValue } from './db.js';
import type { AuditEntry } from '@asterius/shared';
import { decodeCursor, encodeCursor } from './lib/cursor.js';

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

export async function listAudit(q: {
  search?: string;
  limit: number;
  offset: number;
  cursor?: string;
}): Promise<{ entries: AuditEntry[]; nextCursor?: string }> {
  const where: string[] = [];
  const params: SqlValue[] = [];
  if (q.search) {
    where.push("(action LIKE ? ESCAPE '\\' OR target LIKE ? ESCAPE '\\' OR actor_email LIKE ? ESCAPE '\\')");
    const s = `%${q.search.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    params.push(s, s, s);
  }
  if (q.cursor) {
    where.push('(at, id) < (?, ?)');
    params.push(...decodeCursor(q.cursor, { s: 'audit', d: 'desc', n: 2 }));
  }
  const rows = await all<Row>(
    `SELECT id, at, action, actor_email, target, detail FROM audit_log ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY at DESC, id DESC LIMIT ? OFFSET ?`,
    ...params,
    q.limit + 1,
    q.cursor ? 0 : q.offset,
  );
  const more = rows.length > q.limit;
  if (more) rows.pop();
  const last = rows.at(-1);
  return {
    entries: rows.map((r) => ({ id: r.id, at: r.at, action: r.action, actorEmail: r.actor_email, target: r.target, detail: json(r.detail, {}) })),
    nextCursor: more && last ? encodeCursor({ s: 'audit', d: 'desc', v: [last.at, last.id] }) : undefined,
  };
}
