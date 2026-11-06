import { listen, notify } from '../db.js';

/**
 * Wake-ups for idle worker loops. Workers back off to WORKER_IDLE_MAX_MS when there is nothing to do; whoever makes
 * work available (trigger, approval, step transition) calls `wake()`: loops in this process resume at once and, on
 * Postgres, NOTIFY wakes the other replicas.
 */
export const WORK_CHANNEL = 'asterius_work';
const listeners = new Set<() => void>();

export function onWake(fn: () => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function wake(broadcast = true) {
  for (const fn of listeners) fn();
  if (broadcast) void notify(WORK_CHANNEL);
}

/** Subscribe this process to wake-ups from other replicas. Returns a stop function. */
export const listenForWork = () => listen(WORK_CHANNEL, () => wake(false));
