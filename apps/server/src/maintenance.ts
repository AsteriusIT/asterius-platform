import type { FastifyBaseLogger } from 'fastify';
import { config } from './config.js';
import { all, run, withAdvisoryLock } from './db.js';
import { purgeExpiredAuth } from './auth/users.js';
import { purgeVersions } from './catalog/history.js';
import { evaluateEverything, purgeScorecardHistory } from './catalog/scorecards.js';

/** Hourly housekeeping (one replica at a time): expired sessions, data past RETENTION_DAYS. */
export async function housekeeping(log: FastifyBaseLogger) {
  await withAdvisoryLock(726203, async () => {
    await purgeExpiredAuth();
    const cutoff = new Date(Date.now() - config.RETENTION_DAYS * 86400_000).toISOString();
    const finished = "('SUCCESS', 'FAILURE', 'REJECTED', 'CANCELLED')";
    const runs = await run(`DELETE FROM runs WHERE status IN ${finished} AND ended_at < ?`, cutoff);
    const deliveries = await run("DELETE FROM deliveries WHERE status != 'pending' AND created_at < ?", cutoff);
    const audit = await run('DELETE FROM audit_log WHERE at < ?', cutoff);
    // Sync history: RETENTION_DAYS, but always keep the last 20 per integration.
    let syncs = 0;
    for (const { integration } of await all<{ integration: string }>('SELECT DISTINCT integration FROM sync_runs')) {
      const keep = await all<{ started_at: string }>(
        'SELECT started_at FROM sync_runs WHERE integration = ? ORDER BY started_at DESC LIMIT 1 OFFSET 19',
        integration,
      );
      if (keep[0])
        syncs += (await run('DELETE FROM sync_runs WHERE integration = ? AND started_at < ? AND started_at < ?', integration, keep[0].started_at, cutoff))
          .changes;
    }
    // Scorecards depend on relations too: re-evaluate everything once an hour; trends are kept for a year.
    const scored = await evaluateEverything();
    await purgeScorecardHistory(new Date(Date.now() - 365 * 86400_000).toISOString());
    if (scored) log.debug({ scored }, 'scorecards re-evaluated');
    const versions = await purgeVersions(new Date(Date.now() - config.HISTORY_RETENTION_DAYS * 86400_000).toISOString());
    if (versions.changes) log.info({ versions: versions.changes }, 'retention: old entity versions deleted');
    if (runs.changes + deliveries.changes + audit.changes + syncs)
      log.info({ runs: runs.changes, deliveries: deliveries.changes, audit: audit.changes, syncs }, 'retention: old records deleted');
  });
}

export function startMaintenance(log: FastifyBaseLogger) {
  const tick = () => housekeeping(log).catch((err) => log.error({ err }, 'housekeeping failed'));
  setTimeout(tick, 30_000).unref();
  const timer = setInterval(tick, 3600_000);
  timer.unref();
  return () => clearInterval(timer);
}
