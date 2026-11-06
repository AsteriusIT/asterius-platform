import os from 'node:os';
import type { FastifyBaseLogger } from 'fastify';
import { config } from '../config.js';
import { beat, registerLoop } from '../health.js';
import { claimPolls, claimRuns, claimSteps, stepHousekeeping } from './engine.js';
import { listenForWork, onWake } from './wake.js';

/**
 * Workflow worker (PLATFORM_ROLE=all|worker). Any number of worker replicas can run: runs and steps are claimed with
 * single conditional UPDATE … RETURNING statements (SKIP LOCKED on Postgres), never with in-memory state.
 *   - QUEUED runs → IN_PROGRESS, their steps are created and the workflow starts (engine.initRun);
 *   - QUEUED steps (due) are executed: invokers, agent calls, transforms;
 *   - RUNNING invoke steps are polled every RUN_POLL_SECONDS (pipelines, jobs);
 *   - housekeeping (one replica at a time): interrupted steps, timeouts (steps, approvals, runs), interrupted runs.
 * Everything in flight (starting runs, executing steps, polls) counts against WORKER_CONCURRENCY. When idle the loop
 * backs off up to WORKER_IDLE_MAX_MS and is woken by new work (see wake.ts).
 */
export const WORKER_ID = process.env.WORKER_ID ?? `${os.hostname()}-${process.pid}`;

const MIN_IDLE_MS = 250;

export function startRunWorker(log: FastifyBaseLogger) {
  let active = 0;
  let stopping = false;
  let nudge: (() => void) | undefined;
  let nudged = false; // a wake-up that arrived while the loop was busy must not be lost
  let idleMs = MIN_IDLE_MS;

  /** Wake the loop now (new work, or a slot freed). */
  const poke = () => {
    idleMs = MIN_IDLE_MS;
    nudged = true;
    nudge?.();
  };
  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        nudge = undefined;
        resolve();
      };
      const timer = setTimeout(done, ms);
      nudge = done;
    });

  const spawn = (fn: () => Promise<void>) => {
    active++;
    fn()
      .catch((err) => log.error({ err }, 'workflow task failed'))
      .finally(() => {
        active--;
        poke();
      });
  };

  /** One pass: claim what fits in the free slots. Returns how many tasks were started. */
  const tick = async () => {
    let claimed = 0;
    const free = () => config.WORKER_CONCURRENCY - active;
    claimed += await claimRuns(WORKER_ID, Math.min(free(), 20), spawn);
    claimed += await claimSteps(WORKER_ID, free(), spawn);
    claimed += await claimPolls(free(), spawn);
    return claimed;
  };

  const unregister = registerLoop('workflow-worker', 60_000);
  const offWake = onWake(poke);
  const stopListening = listenForWork();

  const loop = (async () => {
    while (!stopping) {
      try {
        const claimed = config.WORKER_CONCURRENCY - active > 0 ? await tick() : 0;
        // Work found: look again at once (more may be waiting). Nothing: back off, doubling up to the idle maximum.
        // A full worker just waits for a task to finish (poke).
        if (claimed) continue;
        idleMs = Math.min(idleMs * 2, config.WORKER_IDLE_MAX_MS);
      } catch (err) {
        log.error({ err }, 'run worker tick failed');
        idleMs = Math.min(idleMs * 2, config.WORKER_IDLE_MAX_MS);
      } finally {
        beat('workflow-worker');
      }
      if (!stopping && !nudged) await sleep(config.WORKER_CONCURRENCY - active > 0 ? idleMs : config.WORKER_IDLE_MAX_MS);
      nudged = false;
    }
  })();

  const runHousekeeping = () => {
    beat('workflow-housekeeping');
    return stepHousekeeping(log).catch((err) => log.error({ err }, 'workflow housekeeping failed'));
  };
  const unregisterHk = registerLoop('workflow-housekeeping', 5 * 60_000);
  const hk = setInterval(() => void runHousekeeping(), 30_000);
  hk.unref();

  return async () => {
    stopping = true;
    clearInterval(hk);
    offWake();
    unregister();
    unregisterHk();
    nudge?.();
    await loop;
    await stopListening();
    // Let in-flight steps record their result (graceful shutdown, terminationGracePeriodSeconds).
    for (let i = 0; i < 100 && active > 0; i++) await new Promise((r) => setTimeout(r, 200));
  };
}
