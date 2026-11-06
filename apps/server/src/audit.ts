import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { all, dialect, json, newId, now, one, run, tx, type SqlValue } from './db.js';
import { config } from './config.js';
import { likeEscape } from './db.js';
import { metrics } from './metrics.js';
import type { AuditEntry } from '@asterius/shared';
import { decodeCursor, encodeCursor } from './lib/cursor.js';

/**
 * Append-only audit log of changes and decisions: who, what, on which target.
 *  - Writes never break the action being audited, but failures are counted (asterius_audit_write_failures_total),
 *    logged and retried, not silently dropped.
 *  - AUDIT_HASH_CHAIN=true links entries (each hash covers the previous one; HMAC-keyed with AUDIT_CHAIN_KEY when set),
 *    so edits, deletions in the middle or reordering are detected by `verifyAuditChain`.
 *  - Entries can be exported (CSV / NDJSON) and streamed to a SIEM (audit-stream.ts).
 */

export interface Actor {
  id: string | null;
  email: string | null;
}

export const SYSTEM: Actor = { id: null, email: 'system' };

const CHAIN_LOCK = 726210;
const retryQueue: { actor: Actor; action: string; target: string | null; detail: Record<string, unknown> }[] = [];

export const chainHash = (p: {
  prev: string;
  seq: number;
  id: string;
  at: string;
  action: string;
  actorId: string | null;
  actorEmail: string | null;
  target: string | null;
  detail: string;
}) => {
  const data = JSON.stringify([p.prev, p.seq, p.id, p.at, p.action, p.actorId, p.actorEmail, p.target, p.detail]);
  return config.AUDIT_CHAIN_KEY ? createHmac('sha256', config.AUDIT_CHAIN_KEY).update(data).digest('hex') : createHash('sha256').update(data).digest('hex');
};

async function insert(actor: Actor, action: string, target: string | null, detail: Record<string, unknown>) {
  const id = newId();
  const text = JSON.stringify(detail);
  if (!config.AUDIT_HASH_CHAIN) {
    await run(
      'INSERT INTO audit_log (id, at, action, actor_id, actor_email, target, detail) VALUES (?, ?, ?, ?, ?, ?, ?)',
      id,
      now(),
      action,
      actor.id,
      actor.email,
      target,
      text,
    );
    return;
  }
  // Chained: serialize across replicas, read the tip, append.
  await tx(async (d) => {
    if (dialect === 'postgres') await d.query('SELECT pg_advisory_xact_lock(?)', [CHAIN_LOCK]);
    const tip = (
      await d.query<{ chain_seq: number; hash: string }>('SELECT chain_seq, hash FROM audit_log WHERE chain_seq IS NOT NULL ORDER BY chain_seq DESC LIMIT 1')
    ).rows[0];
    const seq = Number(tip?.chain_seq ?? 0) + 1;
    const prev = tip?.hash ?? '';
    const at = now();
    const hash = chainHash({ prev, seq, id, at, action, actorId: actor.id, actorEmail: actor.email, target, detail: text });
    await d.query(
      'INSERT INTO audit_log (id, at, action, actor_id, actor_email, target, detail, chain_seq, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [id, at, action, actor.id, actor.email, target, text, seq, prev, hash],
    );
  });
}

export async function audit(actor: Actor, action: string, target: string | null, detail: Record<string, unknown> = {}) {
  try {
    await insert(actor, action, target, detail);
    // Entries that failed earlier are retried as soon as the database accepts writes again.
    for (let e = retryQueue.shift(); e; e = retryQueue.shift()) await insert(e.actor, e.action, e.target, e.detail);
  } catch (err) {
    metrics.auditFailure();
    console.error(JSON.stringify({ level: 'error', msg: 'audit write failed', action, error: (err as Error).message }));
    if (retryQueue.length < 1000) retryQueue.push({ actor, action, target, detail });
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

const toEntry = (r: Row): AuditEntry => ({ id: r.id, at: r.at, action: r.action, actorEmail: r.actor_email, target: r.target, detail: json(r.detail, {}) });

export interface AuditQuery {
  search?: string;
  /** Exact action, or a prefix ending in `*` (`token.*`). */
  action?: string;
  actor?: string;
  target?: string;
  from?: string;
  to?: string;
}

function filter(q: AuditQuery) {
  const where: string[] = [];
  const params: SqlValue[] = [];
  const like = (s: string) => `%${likeEscape(s)}%`;
  if (q.search) {
    where.push("(action LIKE ? ESCAPE '\\' OR target LIKE ? ESCAPE '\\' OR actor_email LIKE ? ESCAPE '\\')");
    params.push(like(q.search), like(q.search), like(q.search));
  }
  if (q.action) {
    if (q.action.endsWith('*')) {
      where.push("action LIKE ? ESCAPE '\\'");
      params.push(`${likeEscape(q.action.slice(0, -1))}%`);
    } else {
      where.push('action = ?');
      params.push(q.action);
    }
  }
  if (q.actor) {
    where.push("actor_email LIKE ? ESCAPE '\\'");
    params.push(like(q.actor));
  }
  if (q.target) {
    where.push("target LIKE ? ESCAPE '\\'");
    params.push(like(q.target));
  }
  if (q.from) {
    where.push('at >= ?');
    params.push(q.from);
  }
  if (q.to) {
    where.push('at <= ?');
    params.push(q.to);
  }
  return { w: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
}

export async function listAudit(q: AuditQuery & { limit: number; offset: number; cursor?: string }): Promise<{ entries: AuditEntry[]; nextCursor?: string }> {
  const { w, params } = filter(q);
  let where = w;
  if (q.cursor) {
    where = `${w ? `${w} AND` : 'WHERE'} (at, id) < (?, ?)`;
    params.push(...decodeCursor(q.cursor, { s: 'audit', d: 'desc', n: 2 }));
  }
  const rows = await all<Row>(
    `SELECT id, at, action, actor_email, target, detail FROM audit_log ${where} ORDER BY at DESC, id DESC LIMIT ? OFFSET ?`,
    ...params,
    q.limit + 1,
    q.cursor ? 0 : q.offset,
  );
  const more = rows.length > q.limit;
  if (more) rows.pop();
  const last = rows.at(-1);
  return { entries: rows.map(toEntry), nextCursor: more && last ? encodeCursor({ s: 'audit', d: 'desc', v: [last.at, last.id] }) : undefined };
}

/** Distinct actions and most active actors, to build filters. */
export async function auditFacets(q: AuditQuery = {}) {
  const { w, params } = filter(q);
  const actions = await all<{ action: string; n: number }>(
    `SELECT action, count(*) AS n FROM audit_log ${w} GROUP BY action ORDER BY n DESC LIMIT 200`,
    ...params,
  );
  const actors = await all<{ actor_email: string; n: number }>(
    `SELECT actor_email, count(*) AS n FROM audit_log ${w ? `${w} AND` : 'WHERE'} actor_email IS NOT NULL GROUP BY actor_email ORDER BY n DESC LIMIT 100`,
    ...params,
  );
  return { actions: actions.map((a) => ({ value: a.action, count: Number(a.n) })), actors: actors.map((a) => ({ value: a.actor_email, count: Number(a.n) })) };
}

/** Oldest first, in pages, for exports (bounded by AUDIT_EXPORT_MAX rows). */
export async function* exportAudit(q: AuditQuery): AsyncGenerator<AuditEntry> {
  const { w, params } = filter(q);
  const PAGE = 1000;
  for (let offset = 0; offset < config.AUDIT_EXPORT_MAX; offset += PAGE) {
    const rows = await all<Row>(
      `SELECT id, at, action, actor_email, target, detail FROM audit_log ${w} ORDER BY at, id LIMIT ? OFFSET ?`,
      ...params,
      PAGE,
      offset,
    );
    for (const r of rows) yield toEntry(r);
    if (rows.length < PAGE) return;
  }
}

/** Neutralize spreadsheet formula injection (=, +, -, @, tab, CR) and quote for CSV. */
export const csvCell = (v: unknown) => {
  let s = v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v as string | number | boolean);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
export const CSV_HEADER = 'id,at,action,actor,target,detail\n';
export const csvRow = (e: AuditEntry) => `${[e.id, e.at, e.action, e.actorEmail, e.target, e.detail].map(csvCell).join(',')}\n`;

// ---------- tamper evidence ----------
export interface ChainReport {
  enabled: boolean;
  ok: boolean;
  checked: number;
  /** Sequence number of the first entry that does not verify. */
  brokenAt?: number;
  reason?: string;
}

const eq = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/**
 * Walk the chain from its oldest remaining entry (older ones may have been purged by retention; that entry's
 * `prev_hash` is the anchor) and recompute every hash. Entries written while the chain was disabled are ignored.
 */
export async function verifyAuditChain(): Promise<ChainReport> {
  let checked = 0;
  let expectedSeq: number | undefined;
  let prevHash: string | undefined;
  const BATCH = 500;
  for (let after = 0; ;) {
    const rows = await all<{
      id: string;
      at: string;
      action: string;
      actor_id: string | null;
      actor_email: string | null;
      target: string | null;
      detail: string;
      chain_seq: number;
      prev_hash: string;
      hash: string;
    }>('SELECT * FROM audit_log WHERE chain_seq > ? ORDER BY chain_seq LIMIT ?', after, BATCH);
    if (!rows.length) break;
    for (const r of rows) {
      const seq = Number(r.chain_seq);
      if (expectedSeq !== undefined && seq !== expectedSeq) return { enabled: true, ok: false, checked, brokenAt: expectedSeq, reason: 'missing entry' };
      if (prevHash !== undefined && !eq(r.prev_hash, prevHash)) return { enabled: true, ok: false, checked, brokenAt: seq, reason: 'broken link' };
      const h = chainHash({
        prev: r.prev_hash,
        seq,
        id: r.id,
        at: r.at,
        action: r.action,
        actorId: r.actor_id,
        actorEmail: r.actor_email,
        target: r.target,
        detail: r.detail,
      });
      if (!eq(h, r.hash)) return { enabled: true, ok: false, checked, brokenAt: seq, reason: 'entry was modified' };
      prevHash = r.hash;
      expectedSeq = seq + 1;
      after = seq;
      checked++;
    }
  }
  return { enabled: config.AUDIT_HASH_CHAIN, ok: true, checked };
}

export const auditCount = async () => Number((await one<{ n: number }>('SELECT count(*) AS n FROM audit_log'))?.n ?? 0);
