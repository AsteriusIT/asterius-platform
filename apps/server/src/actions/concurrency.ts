import { all, later, now, one, run as exec } from '../db.js';

/**
 * Concurrency groups (`concurrency: { group, max, mode }` on an action). A run of a group needs one of the group's
 * `max` slots to be IN_PROGRESS. Slots are rows of `run_slots` keyed by (org, group, slot number), with a unique run id:
 * taking one is a conditional INSERT, so any number of replicas can admit runs at the same time without exceeding `max`
 * and without in-memory state. A run keeps its slot until it ends: `emitRun` frees it on the final transition, and
 * `reapSlots` frees whatever a crash left behind (slots of finished runs, or of runs that do not exist a minute later).
 *
 * Queue mode: QUEUED runs of a group are admitted in priority, then FIFO order; the head of a full group blocks the
 * runs behind it, so nobody overtakes. Reject mode takes the slot when the run is created (409 when none is free).
 */

const FINAL = "('SUCCESS', 'FAILURE', 'REJECTED', 'CANCELLED')";

/** Free the slots of runs that ended, and of runs that never got created (crash between the slot and the insert). */
export async function reapSlots(org: string, group: string) {
  await exec(
    `DELETE FROM run_slots WHERE org_id = ? AND grp = ? AND (
       EXISTS (SELECT 1 FROM runs r WHERE r.id = run_slots.run_id AND r.status IN ${FINAL})
       OR (acquired_at < ? AND NOT EXISTS (SELECT 1 FROM runs r WHERE r.id = run_slots.run_id)))`,
    org,
    group,
    later(-60_000),
  );
}

const holds = async (runId: string) => !!(await one<{ x: number }>('SELECT 1 AS x FROM run_slots WHERE run_id = ?', runId));

/** Take a free slot of the group for this run (true when it holds one, also when it already did). Race-free. */
export async function acquireSlot(org: string, group: string, max: number, runId: string): Promise<boolean> {
  if (await holds(runId)) return true;
  await reapSlots(org, group);
  const used = new Set((await all<{ slot: number }>('SELECT slot FROM run_slots WHERE org_id = ? AND grp = ?', org, group)).map((s) => Number(s.slot)));
  for (let slot = 0; slot < max; slot++) {
    if (used.has(slot)) continue;
    // The primary key (org, group, slot) and the unique run id decide between concurrent callers.
    const { changes } = await exec(
      'INSERT INTO run_slots (org_id, grp, slot, run_id, acquired_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING',
      org,
      group,
      slot,
      runId,
      now(),
    );
    if (changes) return true;
    if (await holds(runId)) return true; // a concurrent call gave this run a slot
  }
  return false;
}

export async function releaseSlot(runId: string) {
  await exec('DELETE FROM run_slots WHERE run_id = ?', runId);
}

/** Runs holding a slot of the group or queued before this one (what it waits for). */
export async function runsAhead(r: { id: string; org_id: string; concurrency_group: string | null; priority: number; created_at: string }) {
  if (!r.concurrency_group) return 0;
  const row = await one<{ n: number }>(
    `SELECT count(*) AS n FROM runs WHERE org_id = ? AND concurrency_group = ? AND id <> ? AND (
       status = 'IN_PROGRESS'
       OR (status = 'QUEUED' AND (priority > ? OR (priority = ? AND (created_at < ? OR (created_at = ? AND id < ?)))))
       OR id IN (SELECT run_id FROM run_slots WHERE org_id = ? AND grp = ?))`,
    r.org_id,
    r.concurrency_group,
    r.id,
    r.priority,
    r.priority,
    r.created_at,
    r.created_at,
    r.id,
    r.org_id,
    r.concurrency_group,
  );
  return Number(row?.n ?? 0);
}

/**
 * Admit QUEUED runs of concurrency groups (QUEUED → IN_PROGRESS) while their group has a free slot, in priority then
 * creation order per group. Returns the ids claimed by this worker; the caller starts them.
 */
export async function admitGrouped(worker: string, limit: number): Promise<string[]> {
  const out: string[] = [];
  if (limit <= 0) return out;
  const groups = await all<{ org_id: string; grp: string }>(
    `SELECT org_id, concurrency_group AS grp FROM runs WHERE status = 'QUEUED' AND concurrency_group IS NOT NULL
     GROUP BY org_id, concurrency_group ORDER BY max(priority) DESC, min(created_at) LIMIT 50`,
  );
  for (const g of groups) {
    const heads = await all<{ id: string; concurrency_max: number | null }>(
      `SELECT id, concurrency_max FROM runs WHERE org_id = ? AND concurrency_group = ? AND status = 'QUEUED'
       ORDER BY priority DESC, created_at, id LIMIT 20`,
      g.org_id,
      g.grp,
    );
    for (const h of heads) {
      if (out.length >= limit) return out;
      if (!(await acquireSlot(g.org_id, g.grp, Number(h.concurrency_max ?? 1), h.id))) break; // full: the rest keeps waiting in order
      const t = now();
      const { changes } = await exec(
        "UPDATE runs SET status = 'IN_PROGRESS', status_label = NULL, worker = ?, started_at = ?, updated_at = ? WHERE id = ? AND status = 'QUEUED'",
        worker,
        t,
        t,
        h.id,
      );
      // Lost: another worker claimed it (and keeps the slot) or it was cancelled (reaped with the next admission).
      if (changes) out.push(h.id);
    }
  }
  return out;
}
