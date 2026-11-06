import { one, run } from '../db.js';

/**
 * Cross-replica cache invalidation. Definitions (blueprints, teams, webhooks) are cached per process; every write bumps
 * the single-row `config_version` table and every process compares it (at most once per second) before trusting a cache,
 * so a change is seen by all replicas within about a second instead of after each cache's own TTL.
 */

const CHECK_EVERY_MS = 1000;
const listeners = new Set<() => void>();
let seen = -1;
let checkedAt = 0;
let inflight: Promise<void> | undefined;

/** Register a function that drops a cache; called whenever any replica changed definitions. */
export function onConfigChange(fn: () => void) {
  listeners.add(fn);
}

const fire = () => {
  for (const fn of listeners) fn();
};

/** Call before reading a definition cache. Cheap: one tiny query per process per second. */
export function syncCaches(): Promise<void> {
  if (Date.now() - checkedAt < CHECK_EVERY_MS) return inflight ?? Promise.resolve();
  checkedAt = Date.now();
  inflight = (async () => {
    try {
      const row = await one<{ version: number }>('SELECT version FROM config_version WHERE id = 1');
      const v = Number(row?.version ?? 0);
      if (seen !== -1 && v !== seen) fire();
      seen = v;
    } catch {
      // never fail a request because the version check failed; caches keep their TTLs
    } finally {
      inflight = undefined;
    }
  })();
  return inflight;
}

/** Announce a definition change: invalidates local caches immediately and, through the table, the other replicas'. */
export async function bumpConfigVersion() {
  fire();
  await run('UPDATE config_version SET version = version + 1 WHERE id = 1');
  checkedAt = 0; // re-read next time so `seen` follows our own bump
}
