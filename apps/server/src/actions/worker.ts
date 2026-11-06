import os from 'node:os';
import type { FastifyBaseLogger } from 'fastify';
import { config } from '../config.js';
import { all, now, run } from '../db.js';
import { metrics } from '../metrics.js';
import { claimPolls, claimSteps, initRun, stepHousekeeping } from './engine.js';

/**
 * Workflow worker (PLATFORM_ROLE=all|worker). Any number of worker replicas can run: runs and steps are claimed with
 * conditional UPDATEs (status / lease columns), never with in-memory state.
 *   - QUEUED runs → IN_PROGRESS, their steps are created and the workflow starts (engine.initRun);
 *   - QUEUED steps (due) are executed: invokers, agent calls, transforms (up to WORKER_CONCURRENCY at once);
 *   - RUNNING invoke steps are polled every RUN_POLL_SECONDS (pipelines, jobs);
 *   - housekeeping: interrupted steps, timeouts (steps and approvals), interrupted runs.
 */
export const WORKER_ID = process.env.WORKER_ID ?? `${os.hostname()}-${process.pid}`;

let active = 0;
let stopping = false;

function spawner(log: FastifyBaseLogger) {
  return (fn: () => Promise<void>) => {
    active++;
    fn()
      .catch((err) => log.error({ err }, 'workflow task failed'))
      .finally(() => active--);
  };
}

async function tick(log: FastifyBaseLogger) {
  const spawn = spawner(log);
  // 1. start queued runs (cheap: creates step rows, no external call)
  for (const { id } of await all<{ id: string }>("SELECT id FROM runs WHERE status = 'QUEUED' ORDER BY created_at LIMIT 20")) {
    const t = now();
    const { changes } = await run(
      "UPDATE runs SET status = 'IN_PROGRESS', worker = ?, started_at = ?, updated_at = ? WHERE id = ? AND status = 'QUEUED'",
      WORKER_ID,
      t,
      t,
      id,
    );
    if (changes) spawn(() => initRun(id));
  }
  // 2. execute due steps, 3. poll running ones
  await claimSteps(WORKER_ID, config.WORKER_CONCURRENCY - active, spawn);
  await claimPolls(config.WORKER_CONCURRENCY - active, spawn);
}

export function startRunWorker(log: FastifyBaseLogger) {
  const loop = async () => {
    if (stopping) return;
    try {
      await tick(log);
      metrics.loopTick('runs');
    } catch (err) {
      log.error({ err }, 'run worker tick failed');
    }
    setTimeout(loop, 1_000).unref();
  };
  void loop();
  const hk = setInterval(() => stepHousekeeping(log).catch((err) => log.error({ err }, 'workflow housekeeping failed')), 30_000);
  hk.unref();
  return async () => {
    stopping = true;
    clearInterval(hk);
    // Let in-flight steps record their result (graceful shutdown, terminationGracePeriodSeconds).
    for (let i = 0; i < 100 && active > 0; i++) await new Promise((r) => setTimeout(r, 200));
  };
}
