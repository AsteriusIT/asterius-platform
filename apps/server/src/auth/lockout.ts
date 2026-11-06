import { one, run } from '../db.js';

/** Per-account lockout after repeated failed sign-ins, shared by all API replicas (complements the per-IP rate limit). */

const MAX_FAILURES = 5;
const LOCK_MS = 15 * 60_000;

export async function isLocked(email: string): Promise<boolean> {
  const r = await one<{ locked_until: number }>('SELECT locked_until FROM login_failures WHERE email = ?', email);
  return Number(r?.locked_until ?? 0) > Date.now();
}

/** Atomic: the fifth failure sets the lock and resets the counter. */
export async function recordFailure(email: string) {
  await run(
    `INSERT INTO login_failures (email, count, locked_until) VALUES (?, 1, 0)
     ON CONFLICT (email) DO UPDATE SET
       count = CASE WHEN login_failures.count + 1 >= ? THEN 0 ELSE login_failures.count + 1 END,
       locked_until = CASE WHEN login_failures.count + 1 >= ? THEN ? ELSE login_failures.locked_until END`,
    email,
    MAX_FAILURES,
    MAX_FAILURES,
    Date.now() + LOCK_MS,
  );
}

export async function clearFailures(email: string) {
  await run('DELETE FROM login_failures WHERE email = ?', email);
}

export async function purgeLockouts() {
  await run('DELETE FROM login_failures WHERE locked_until < ? AND count = 0', Date.now());
}
