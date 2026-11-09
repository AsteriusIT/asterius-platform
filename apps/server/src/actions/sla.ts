import { all, later, one, run as exec } from '../db.js';
import { emit } from '../events.js';
import { metrics } from '../metrics.js';
import { notifySlaBreach } from '../notifications/dispatch.js';
import { addLog, getRunRow } from './runs.js';
import { stepDefs } from './steps.js';

/**
 * Service levels. `slaMinutes` on a step starts a clock when the step starts (leaves PENDING); `slaMinutes` on the
 * action starts one when the run is requested. The due time is stored in `sla_due_at`; housekeeping (one replica,
 * advisory lock) reads only rows whose `sla_due_at` has passed (partial index) and claims each with a conditional
 * UPDATE that clears it: a breach is reported exactly once across replicas, and a run or step that finished in time
 * is visited once to clear its clock. A breach emits `step.sla_breached` / `run.sla_breached`, counts in
 * `asterius_sla_breaches_total`, logs a warning on the run and notifies the requester and the organization's admins.
 * It never stops the run (timeouts do that).
 */

const STEP_OPEN = "status NOT IN ('SUCCESS', 'FAILURE', 'SKIPPED', 'CANCELLED')";
const RUN_OPEN = "status NOT IN ('SUCCESS', 'FAILURE', 'REJECTED', 'CANCELLED')";

/** Start the SLA clock of a step that just started (not again after a breach, e.g. when it is retried). */
export async function armStepSla(runId: string, stepId: string, minutes: number) {
  await exec(
    'UPDATE run_steps SET sla_due_at = ? WHERE run_id = ? AND step_id = ? AND sla_due_at IS NULL AND sla_breached_at IS NULL',
    later(minutes * 60_000),
    runId,
    stepId,
  );
}

type Guard = (what: string, runId: string, fn: () => Promise<unknown>) => Promise<unknown>;

/** Housekeeping pass: handle the step and run SLA clocks that are due at `t`. */
export async function checkSlas(t: string, batch: number, guard: Guard) {
  for (const s of await all<{ run_id: string; step_id: string }>(
    'SELECT run_id, step_id FROM run_steps WHERE sla_due_at IS NOT NULL AND sla_due_at <= ? LIMIT ?',
    t,
    batch,
  ))
    await guard('step sla', s.run_id, () => stepDue(s.run_id, s.step_id, t));
  for (const r of await all<{ id: string }>('SELECT id FROM runs WHERE sla_due_at IS NOT NULL AND sla_due_at <= ? LIMIT ?', t, batch))
    await guard('run sla', r.id, () => runDue(r.id, t));
}

async function stepDue(runId: string, stepId: string, t: string) {
  const { changes } = await exec(
    `UPDATE run_steps SET sla_due_at = NULL, sla_breached_at = ? WHERE run_id = ? AND step_id = ? AND sla_due_at IS NOT NULL AND sla_due_at <= ? AND ${STEP_OPEN}`,
    t,
    runId,
    stepId,
    t,
  );
  if (!changes) {
    // Finished in time (or claimed by another pass): just stop the clock.
    await exec('UPDATE run_steps SET sla_due_at = NULL WHERE run_id = ? AND step_id = ? AND sla_due_at <= ?', runId, stepId, t);
    return;
  }
  const r = await getRunRow(runId);
  const row = await one<{ name: string; type: string; status: string; started_at: string | null }>(
    'SELECT name, type, status, started_at FROM run_steps WHERE run_id = ? AND step_id = ?',
    runId,
    stepId,
  );
  const minutes = stepDefs(r).find((d) => d.id === stepId)?.slaMinutes ?? null;
  const name = row?.name ?? stepId;
  metrics.slaBreached('step', r.action);
  await addLog(runId, `SLA breached: still ${row?.status ?? 'running'} after ${minutes ?? '?'} minute(s)`, 'warn', stepId);
  await emit({
    type: 'step.sla_breached',
    blueprint: r.blueprint,
    data: {
      runId,
      action: r.action,
      stepId,
      name,
      stepType: row?.type,
      status: row?.status,
      slaMinutes: minutes,
      startedAt: row?.started_at ?? null,
      breachedAt: t,
    },
  });
  await notifySlaBreach({
    runId,
    requester: r.triggered_by,
    title: `SLA breached: ${name}`,
    body: `${r.action_title}: step "${name}" is still ${row?.status ?? 'running'} after ${minutes ?? '?'} minute(s)`,
    dedupe: `${runId}:${stepId}`,
  });
}

async function runDue(runId: string, t: string) {
  const { changes } = await exec(
    `UPDATE runs SET sla_due_at = NULL, sla_breached_at = ? WHERE id = ? AND sla_due_at IS NOT NULL AND sla_due_at <= ? AND ${RUN_OPEN}`,
    t,
    runId,
    t,
  );
  if (!changes) {
    await exec('UPDATE runs SET sla_due_at = NULL WHERE id = ? AND sla_due_at <= ?', runId, t);
    return;
  }
  const r = await getRunRow(runId);
  const minutes = Math.round((Date.parse(t) - Date.parse(r.created_at)) / 60_000);
  metrics.slaBreached('run', r.action);
  await addLog(runId, `SLA breached: the run is still ${r.status} ${minutes} minute(s) after it was requested`, 'warn');
  await emit({
    type: 'run.sla_breached',
    blueprint: r.blueprint,
    data: { runId, action: r.action, actionTitle: r.action_title, status: r.status, createdAt: r.created_at, breachedAt: t },
  });
  await notifySlaBreach({
    runId,
    requester: r.triggered_by,
    title: `SLA breached: ${r.action_title}`,
    body: `The run is still ${r.status} ${minutes} minute(s) after it was requested`,
    dedupe: runId,
  });
}
