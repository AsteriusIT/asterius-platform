import { all, run } from '../db.js';

/**
 * Database-backed store for @fastify/rate-limit: one atomic upsert per request, so the limit holds across API replicas
 * (the default in-memory store multiplies the limit by the number of pods). Selected with RATE_LIMIT_STORE=database.
 */

interface StoreOptions {
  continueExceeding?: boolean;
  exponentialBackoff?: boolean;
}
type Callback = (err: Error | null, res?: { current: number; ttl: number }) => void;

export class DatabaseRateLimitStore {
  private readonly scope: string;

  constructor(options: StoreOptions & { max?: number | (() => number); timeWindow?: number | string } = {}, scope = 'global') {
    void options;
    this.scope = scope;
  }

  /** Each route configuration gets its own counters (keys are prefixed by the limit they enforce). */
  child(routeOptions: { max?: unknown; timeWindow?: unknown }) {
    return new DatabaseRateLimitStore({}, `${String(routeOptions.max)}/${String(routeOptions.timeWindow)}`);
  }

  incr(key: string, cb: Callback, timeWindow: number) {
    const now = Date.now();
    all<{ count: number; window_start: number }>(
      `INSERT INTO rate_limits (key, count, window_start) VALUES (?, 1, ?)
       ON CONFLICT (key) DO UPDATE SET
         count = CASE WHEN rate_limits.window_start + ? <= ? THEN 1 ELSE rate_limits.count + 1 END,
         window_start = CASE WHEN rate_limits.window_start + ? <= ? THEN ? ELSE rate_limits.window_start END
       RETURNING count, window_start`,
      `${this.scope}|${key}`,
      now,
      timeWindow,
      now,
      timeWindow,
      now,
      now,
    ).then(
      ([r]) => cb(null, { current: Number(r!.count), ttl: Math.max(0, timeWindow - (now - Number(r!.window_start))) }),
      (err: Error) => cb(err),
    );
  }

  read(key: string, cb: Callback, timeWindow: number) {
    const now = Date.now();
    all<{ count: number; window_start: number }>('SELECT count, window_start FROM rate_limits WHERE key = ?', `${this.scope}|${key}`).then(
      ([r]) =>
        !r || Number(r.window_start) + timeWindow <= now
          ? cb(null, { current: 0, ttl: 0 })
          : cb(null, { current: Number(r.count), ttl: timeWindow - (now - Number(r.window_start)) }),
      (err: Error) => cb(err),
    );
  }
}

/** Drop counters whose window ended (called by the maintenance loop). */
export async function purgeRateLimits(): Promise<number> {
  return (await run('DELETE FROM rate_limits WHERE window_start < ?', Date.now() - 3600_000)).changes;
}
