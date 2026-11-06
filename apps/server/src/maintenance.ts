import type { FastifyBaseLogger } from 'fastify';
import { config } from './config.js';
import { all, run, withAdvisoryLock } from './db.js';
import { purgeExpiredAuth } from './auth/users.js';
import { refreshBlueprintStats } from './catalog/blueprints.js';
import { purgeRateLimits } from './lib/rate-limit-store.js';
import { metrics } from './metrics.js';
import { purgeNotifications } from './inbox.js';
import { purgeExpiredTombstones } from './catalog/entities.js';
import { purgeVersions } from './catalog/history.js';
import { evaluateEverything, purgeScorecardHistory } from './catalog/scorecards.js';

/** Rows deleted per statement: small enough to keep locks short on a busy Postgres (runs cascade to logs and steps). */
const CHUNK = 2000;
const RUN_CHUNK = 200;
const PAUSE_MS = 50;
/** Pending webhook deliveries older than this are given up on (8 attempts with backoff finish within hours). */
const DELIVERY_HORIZON_DAYS = 7;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Delete rows matching `where` in chunks (`DELETE … WHERE key IN (SELECT key … LIMIT n)`), pausing between chunks so
 * concurrent traffic is not starved. Works on SQLite and Postgres.
 */
export async function deleteInChunks(
  table: string,
  key: string,
  where: string,
  params: (string | number)[],
  chunk = CHUNK,
  pauseMs = PAUSE_MS,
): Promise<number> {
  let total = 0;
  for (;;) {
    const { changes } = await run(`DELETE FROM ${table} WHERE ${key} IN (SELECT ${key} FROM ${table} WHERE ${where} LIMIT ${Math.trunc(chunk)})`, ...params);
    total += changes;
    if (changes < chunk) break;
    await sleep(pauseMs);
  }
  metrics.purged(table, total);
  return total;
}

/** Hourly housekeeping (one replica at a time): expired sessions, data past RETENTION_DAYS (audit: AUDIT_RETENTION_DAYS). */
export async function housekeeping(log: FastifyBaseLogger) {
  await withAdvisoryLock(726203, async () => {
    await purgeExpiredAuth();
    await purgeNotifications();
    metrics.purged('rate_limits', await purgeRateLimits());
    const cutoff = new Date(Date.now() - config.RETENTION_DAYS * 86400_000).toISOString();
    const horizon = new Date(Date.now() - DELIVERY_HORIZON_DAYS * 86400_000).toISOString();
    const finished = "('SUCCESS', 'FAILURE', 'REJECTED', 'CANCELLED')";
    const runs = await deleteInChunks('runs', 'id', `status IN ${finished} AND ended_at < ?`, [cutoff], RUN_CHUNK);
    const stale = await run(
      "UPDATE deliveries SET status = 'failed', last_error = 'expired: not delivered within the retry horizon', locked_until = NULL WHERE status = 'pending' AND created_at < ?",
      horizon,
    );
    metrics.purged('deliveries_expired', stale.changes);
    const deliveries = await deleteInChunks('deliveries', 'id', "status != 'pending' AND created_at < ?", [cutoff]);
    const audit = await deleteInChunks('audit_log', 'id', 'at < ?', [new Date(Date.now() - config.AUDIT_RETENTION_DAYS * 86400_000).toISOString()]);
    await run('DELETE FROM ingest_deliveries WHERE received_at < ?', new Date(Date.now() - 24 * 3600_000).toISOString());
    await run("DELETE FROM inbound_events WHERE status != 'pending' AND received_at < ?", cutoff);
    // Sync history: RETENTION_DAYS, but always keep the last 20 per integration.
    let syncs = 0;
    for (const { integration } of await all<{ integration: string }>('SELECT DISTINCT integration FROM sync_runs')) {
      const keep = await all<{ started_at: string }>(
        'SELECT started_at FROM sync_runs WHERE integration = ? ORDER BY started_at DESC LIMIT 1 OFFSET 19',
        integration,
      );
      if (keep[0])
        syncs += await deleteInChunks('sync_runs', 'id', 'integration = ? AND started_at < ? AND started_at < ?', [integration, keep[0].started_at, cutoff]);
    }
    // Scorecards depend on relations too: re-evaluate everything once an hour; trends are kept for a year.
    const scored = await evaluateEverything();
    await purgeScorecardHistory(new Date(Date.now() - 365 * 86400_000).toISOString());
    if (scored) log.debug({ scored }, 'scorecards re-evaluated');
    const versions = await purgeVersions(new Date(Date.now() - config.HISTORY_RETENTION_DAYS * 86400_000).toISOString());
    metrics.purged('entity_versions', versions.changes);
    const tombstones = await purgeExpiredTombstones();
    metrics.purged('entity_tombstones', tombstones.changes);
    if (tombstones.changes) log.info({ tombstones: tombstones.changes }, 'retention: expired tombstones purged');
    if (versions.changes) log.info({ versions: versions.changes }, 'retention: old entity versions deleted');
    if (runs + deliveries + audit + syncs + stale.changes)
      log.info({ runs, deliveries, audit, syncs, expiredDeliveries: stale.changes }, 'retention: old records deleted');
  });
}

export function startMaintenance(log: FastifyBaseLogger) {
  const tick = () => housekeeping(log).catch((err) => log.error({ err }, 'housekeeping failed'));
  const stats = () => refreshBlueprintStats().catch((err) => log.error({ err }, 'blueprint stats refresh failed'));
  setTimeout(tick, 30_000).unref();
  setTimeout(stats, 5_000).unref();
  const timer = setInterval(tick, 3600_000);
  const statsTimer = setInterval(stats, 60_000);
  timer.unref();
  statsTimer.unref();
  return () => {
    clearInterval(timer);
    clearInterval(statsTimer);
  };
}
