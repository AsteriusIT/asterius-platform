import { now, one, run } from '../db.js';

/**
 * Failed-login counters, in the database so every API replica sees them. The key combines the account and the client
 * address: repeated failures from one client lock that client out of that account for 15 minutes, while the real
 * owner (another address) can still sign in. The per-IP rate limit complements it.
 */
const MAX_FAILURES = 5;
const LOCK_MS = 15 * 60_000;

export async function isLocked(key: string) {
  const r = await one<{ locked_until: string | null }>('SELECT locked_until FROM login_failures WHERE key = ?', key);
  return !!r?.locked_until && r.locked_until > now();
}

export async function recordFailure(key: string) {
  await run(
    `INSERT INTO login_failures (key, count, updated_at) VALUES (?, 1, ?)
     ON CONFLICT (key) DO UPDATE SET count = login_failures.count + 1, updated_at = excluded.updated_at`,
    key,
    now(),
  );
  const r = await one<{ count: number }>('SELECT count FROM login_failures WHERE key = ?', key);
  if (Number(r?.count) >= MAX_FAILURES)
    await run('UPDATE login_failures SET count = 0, locked_until = ? WHERE key = ?', new Date(Date.now() + LOCK_MS).toISOString(), key);
}

export async function clearFailures(key: string) {
  await run('DELETE FROM login_failures WHERE key = ?', key);
}

export async function purgeLoginFailures() {
  await run('DELETE FROM login_failures WHERE updated_at < ?', new Date(Date.now() - 24 * 3600_000).toISOString());
}
