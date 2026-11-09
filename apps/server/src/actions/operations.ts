import type { Run } from '@asterius/shared';
import { now, run as exec, tx } from '../db.js';
import { badRequest, conflict, forbidden } from '../lib/errors.js';
import { audit } from '../audit.js';
import { emit } from '../events.js';
import { metrics } from '../metrics.js';
import { actorOf, isAdmin, type Principal } from '../auth/users.js';
import { advance, cancelExternal, runDeadline, setStep } from './engine.js';
import { addLog, emitRun, getRun, getRunRow } from './runs.js';
import { BLOCKED_STATE, canManageRun, FORCEABLE, loadSteps, stepDefs } from './steps.js';
import { outputProblem } from './limits.js';
import { cancelChildrenOf } from './waiting.js';
import { acquireSlot } from './concurrency.js';
import { wake } from './wake.js';

/**
 * Operator controls of a healthy run:
 *  - pause / unpause (requester and admins): a paused run starts no new step. Running steps finish, waits and approvals
 *    keep working, but their successors wait for the unpause. The run deadline does not run while paused: unpausing
 *    extends it (and the timeouts of queued steps) by the paused time. Housekeeping leaves paused runs alone.
 *  - skip / complete a step (admins, with a comment): force a pending, queued, running, waiting or failed step to
 *    SKIPPED or SUCCESS. The transition is conditional on the step's status and attempt (the fencing token) and bumps
 *    the attempt, so an executor still in flight can no longer write its result over the forced one.
 * Every change is a conditional UPDATE, logged on the run, audited and emitted as run.updated.
 */

export async function pauseRun(p: Principal, runId: string): Promise<Run> {
  const r = await getRunRow(runId);
  if (!canManageRun(p, r)) throw forbidden('Only the requester or an admin can pause this run');
  if (r.status !== 'IN_PROGRESS' || Number(r.cancel_requested)) throw conflict('Only a run in progress can be paused');
  if (r.paused_at) throw conflict('This run is already paused');
  const t = now();
  const { changes } = await exec(
    "UPDATE runs SET paused_at = ?, paused_by = ?, status_label = ?, updated_at = ? WHERE id = ? AND status = 'IN_PROGRESS' AND cancel_requested = 0 AND paused_at IS NULL",
    t,
    p.name,
    `Paused by ${p.name}`,
    t,
    runId,
  );
  if (!changes) throw conflict('The run changed meanwhile; reload');
  await addLog(runId, `Paused by ${p.name}: running steps finish, no new step starts`, 'warn');
  await audit(actorOf(p), 'run.paused', r.action, { runId });
  await emitRun(runId, 'run.updated');
  return getRun(runId, p);
}

export async function unpauseRun(p: Principal, runId: string): Promise<Run> {
  const r = await getRunRow(runId);
  if (!canManageRun(p, r)) throw forbidden('Only the requester or an admin can unpause this run');
  if (r.status !== 'IN_PROGRESS' || !r.paused_at) throw conflict('This run is not paused');
  const pausedMs = Math.max(0, Date.now() - Date.parse(r.paused_at));
  const shift = (at: string | null) => (at ? new Date(Date.parse(at) + pausedMs).toISOString() : null);
  const { changes } = await exec(
    "UPDATE runs SET paused_at = NULL, paused_by = NULL, status_label = NULL, deadline_at = ?, updated_at = ? WHERE id = ? AND status = 'IN_PROGRESS' AND paused_at = ?",
    shift(r.deadline_at),
    now(),
    runId,
    r.paused_at,
  );
  if (!changes) throw conflict('The run changed meanwhile; reload');
  // Queued steps were held by the pause: their timeouts move with it.
  for (const s of await loadSteps(runId))
    if (s.status === 'QUEUED' && s.deadline_at) await setStep(runId, s.step_id, 'QUEUED', { deadline_at: shift(s.deadline_at) });
  await addLog(runId, `Unpaused by ${p.name} after ${Math.round(pausedMs / 1000)}s`, 'info');
  await audit(actorOf(p), 'run.unpaused', r.action, { runId, pausedSeconds: Math.round(pausedMs / 1000) });
  await emitRun(runId, 'run.updated');
  await advance(runId);
  wake();
  return getRun(runId, p);
}

export async function forceStep(p: Principal, runId: string, stepId: string, kind: 'skip' | 'complete', comment: string, output?: unknown): Promise<Run> {
  if (!isAdmin(p)) throw forbidden('Only admins can skip or complete a step');
  if (!comment.trim()) throw badRequest('Give a reason (comment)');
  const r = await getRunRow(runId);
  if (!['IN_PROGRESS', 'FAILURE'].includes(r.status) || Number(r.cancel_requested))
    throw conflict('Only steps of a run in progress or failed can be skipped or completed');
  const row = (await loadSteps(runId)).find((s) => s.step_id === stepId);
  if (!row) throw badRequest(`No step "${stepId}" in this run`);
  const verb = kind === 'skip' ? 'skipped' : 'completed';
  if (!FORCEABLE.includes(row.status)) throw conflict(`Step "${row.name}" is ${row.status.toLowerCase()}: it cannot be ${verb}`);
  if (kind === 'complete' && output !== undefined) {
    const problem = await outputProblem(runId, stepId, output);
    if (problem) throw badRequest(problem);
  }
  // A failed run continues: it needs its concurrency slot back first.
  if (r.status === 'FAILURE' && r.concurrency_group && !(await acquireSlot(r.org_id, r.concurrency_group, Number(r.concurrency_max ?? 1), r.id)))
    throw conflict(`The concurrency group "${r.concurrency_group}" is full; try again later`);

  const status = kind === 'skip' ? 'SKIPPED' : 'SUCCESS';
  const label = `${kind === 'skip' ? 'Skipped' : 'Completed'} by ${p.name}: ${comment.trim()}`.slice(0, 200);
  const t = now();
  // Fencing: only the status and attempt we saw; the attempt grows so the executor of that attempt cannot write anymore.
  const won = await tx(async (d) => {
    const { changes } = await d.query(
      `UPDATE run_steps SET status = ?, status_label = ?, output = ?, attempt = attempt + 1, worker = NULL, locked_until = NULL, next_at = NULL,
         ended_at = ?, started_at = COALESCE(started_at, ?)
       WHERE run_id = ? AND step_id = ? AND status = ? AND attempt = ?`,
      [status, label, kind === 'complete' ? JSON.stringify(output ?? null) : null, t, t, runId, stepId, row.status, row.attempt],
    );
    if (!changes) return false;
    await addLog(runId, `Step ${verb} by ${p.name}: ${comment.trim()}`, 'warn', stepId, d);
    // The steps skipped because this one failed are evaluated again (those still blocked are skipped again).
    await d.query(
      "UPDATE run_steps SET status = 'PENDING', status_label = NULL, state = NULL, ended_at = NULL WHERE run_id = ? AND status = 'SKIPPED' AND state = ?",
      [runId, BLOCKED_STATE],
    );
    return true;
  });
  if (!won) throw conflict(`Step "${row.name}" changed meanwhile; reload`);
  // The work in flight is over: stop external jobs (skip) and child runs.
  if (kind === 'skip' && row.status === 'RUNNING') await cancelExternal(r, row);
  await cancelChildrenOf(row);
  if (r.status === 'FAILURE') {
    const deadline = r.deadline_at && r.deadline_at > now() ? r.deadline_at : runDeadline(stepDefs(r));
    await exec(
      "UPDATE runs SET status = 'IN_PROGRESS', status_label = NULL, ended_at = NULL, deadline_at = ?, updated_at = ? WHERE id = ? AND status = 'FAILURE'",
      deadline,
      now(),
      runId,
    );
  }
  await audit(actorOf(p), kind === 'skip' ? 'run.step_skipped' : 'run.step_completed', `${r.action} · ${row.name}`, {
    runId,
    step: stepId,
    from: row.status,
    comment: comment.trim(),
  });
  metrics.stepFinished(row.type, status);
  await emit({
    type: 'step.finished',
    blueprint: null,
    data: { runId, stepId, name: row.name, stepType: row.type, status, statusLabel: label, link: row.link, forcedBy: p.name },
  });
  await emitRun(runId, 'run.updated');
  await advance(runId);
  return getRun(runId, p);
}
