import { all, newId, now, one, run } from './db.js';

/**
 * In-app notifications: one row per (user, event). Created by the run lifecycle (approval requested, run finished);
 * `dedupe` makes creation idempotent, so repeated run.updated events never notify twice.
 * Email and Slack preferences are stored per user; delivery through them arrives with the notification invokers.
 */

export interface NotificationView {
  id: string;
  kind: string;
  title: string;
  body: string;
  link: string | null;
  createdAt: string;
  read: boolean;
}

export interface NotificationPrefs {
  email: boolean;
  slack: boolean;
}

interface Row {
  id: string;
  kind: string;
  title: string;
  body: string;
  link: string | null;
  created_at: string;
  read_at: string | null;
}

export async function notify(userId: string, n: { kind: string; title: string; body?: string; link?: string | null; dedupe: string }) {
  if (await one('SELECT 1 AS x FROM notifications WHERE user_id = ? AND dedupe = ?', userId, n.dedupe)) return false;
  await run(
    'INSERT INTO notifications (id, user_id, kind, title, body, link, dedupe, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    newId(),
    userId,
    n.kind,
    n.title.slice(0, 200),
    (n.body ?? '').slice(0, 1000),
    n.link ?? null,
    n.dedupe,
    now(),
  );
  return true;
}

export async function listNotifications(userId: string, q: { unread?: boolean; limit: number; offset: number }) {
  const rows = await all<Row>(
    `SELECT id, kind, title, body, link, created_at, read_at FROM notifications WHERE user_id = ? ${q.unread ? 'AND read_at IS NULL' : ''}
     ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    userId,
    q.limit,
    q.offset,
  );
  const unread = await one<{ n: number }>('SELECT count(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL', userId);
  const items: NotificationView[] = rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    title: r.title,
    body: r.body,
    link: r.link,
    createdAt: r.created_at,
    read: r.read_at !== null,
  }));
  return { items, unread: Number(unread?.n ?? 0) };
}

/** Mark the given notifications (or all of the user's) as read. */
export async function markRead(userId: string, ids: string[] | 'all') {
  if (ids === 'all') return (await run('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL', now(), userId)).changes;
  let n = 0;
  for (const id of ids) n += (await run('UPDATE notifications SET read_at = ? WHERE user_id = ? AND id = ? AND read_at IS NULL', now(), userId, id)).changes;
  return n;
}

export async function getPrefs(userId: string): Promise<NotificationPrefs> {
  const r = await one<{ email: number; slack: number }>('SELECT email, slack FROM notification_prefs WHERE user_id = ?', userId);
  return { email: Number(r?.email ?? 0) === 1, slack: Number(r?.slack ?? 0) === 1 };
}

export async function setPrefs(userId: string, p: NotificationPrefs) {
  const { changes } = await run('UPDATE notification_prefs SET email = ?, slack = ? WHERE user_id = ?', p.email ? 1 : 0, p.slack ? 1 : 0, userId);
  if (!changes) await run('INSERT INTO notification_prefs (user_id, email, slack) VALUES (?, ?, ?)', userId, p.email ? 1 : 0, p.slack ? 1 : 0);
  return p;
}

/** Drop read notifications older than 90 days. */
export async function purgeNotifications() {
  const cutoff = new Date(Date.now() - 90 * 86_400_000).toISOString();
  await run('DELETE FROM notifications WHERE read_at IS NOT NULL AND created_at < ?', cutoff);
}
