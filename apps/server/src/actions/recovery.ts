import type { Run } from '@asterius/shared';
import { json, now, run as exec } from '../db.js';
import { badRequest, conflict, forbidden } from '../lib/errors.js';
import { audit } from '../audit.js';
import { actorOf, type Principal } from '../auth/users.js';
import { advance } from './engine.js';
import { addLog, emitRun, getRun, getRunRow, triggerRun, startAutomatedRun, type RunRow } from './runs.js';
import { canManageRun, loadSteps, resumableSteps, stepDefs, BLOCKED_STATE } from './steps.js';
import { getAction } from './actions.js';
import { acquireSlot } from './concurrency.js';

/**
 * Re-running and recovering runs:
 *  - rerun: a new run of the action with the same inputs and entity, linked to the original;
 *  - resume: the failed run continues in place; successful steps keep their outputs, failed / cancelled steps
 *    (and the steps that were skipped because of them) start over;
 *  - retry a step: the same for one failed step of a run that is still in progress or finished.
 * Only the requester and admins may do it. Every change is a conditional UPDATE, so concurrent clicks and
 * workers never apply a transition twice.
 */

const RESUMABLE = ['FAILURE', 'CANCELLED'];

const mustManage = (p: Principal, r: RunRow) => {
  if (!canManageRun(p, r)) throw forbidden('Only the requester or an admin can do this');
};

export async function rerun(p: Principal, runId: string): Promise<Run> {
  const r = await getRunRow(runId);
  mustManage(p, r);
  if (!['SUCCESS', 'FAILURE', 'REJECTED', 'CANCELLED'].includes(r.status)) throw conflict('Only finished runs can be run again');
  const action = await getAction(r.action);
  const inputs = json<Record<string, unknown>>(r.inputs, {});
  const source = { type: 'rerun' as const, info: { of: r.id } };
  let id: string;
  if (action.trigger?.type === 'form' || action.trigger?.type === 'api') {
    // Same checks as a fresh submission: permissions, inputs validated against the current form, approval.
    id = (await triggerRun(p, r.action, { entity: r.entity, inputs }, undefined, source)).run.id;
  } else id = await startAutomatedRun(r.action, { blueprint: r.blueprint, entity: r.entity, inputs, source, as: p });
  await addLog(r.id, `Run again as ${id} by ${p.name}`);
  await audit(actorOf(p), 'run.rerun', r.action, { runId: r.id, newRunId: id });
  return getRun(id, p);
}

/** Reset steps to PENDING (only those still in a failed state) and drop their approvals. */
async function resetSteps(runId: string, ids: string[]): Promise<string[]> {
  const reset: string[] = [];
  for (const id of ids) {
    const { changes } = await exec(
      `UPDATE run_steps SET status = 'PENDING', status_label = NULL, attempt = 0, output = NULL, state = NULL, link = NULL, worker = NULL,
         locked_until = NULL, next_at = NULL, deadline_at = NULL, started_at = NULL, ended_at = NULL
       WHERE run_id = ? AND step_id = ? AND status IN ('FAILURE', 'CANCELLED', 'SKIPPED')`,
      runId,
      id,
    );
    if (changes) {
      await exec('DELETE FROM step_approvals WHERE run_id = ? AND step_id = ?', runId, id);
      reset.push(id);
    }
  }
  return reset;
}

async function reopen(p: Principal, r: RunRow, stepIds: string[], what: string): Promise<Run> {
  // A finished run of a concurrency group continues only with a free slot of its group.
  if (RESUMABLE.includes(r.status) && r.concurrency_group && !(await acquireSlot(r.org_id, r.concurrency_group, Number(r.concurrency_max ?? 1), r.id)))
    throw conflict(`The concurrency group "${r.concurrency_group}" is full; try again later`);
  const reset = await resetSteps(r.id, stepIds);
  if (!reset.length) throw conflict('Nothing to resume: the steps changed meanwhile');
  if (RESUMABLE.includes(r.status)) {
    const t = now();
    // Steps first (the engine ignores runs that are not in progress), then the run.
    const { changes } = await exec(
      `UPDATE runs SET status = 'IN_PROGRESS', status_label = NULL, ended_at = NULL, updated_at = ? WHERE id = ? AND status IN ('FAILURE', 'CANCELLED')`,
      t,
      r.id,
    );
    if (!changes) throw conflict('The run changed meanwhile; reload');
  }
  await addLog(r.id, `${what} by ${p.name}: ${reset.join(', ')}`, 'warn');
  await audit(actorOf(p), 'run.resumed', r.action, { runId: r.id, steps: reset });
  await emitRun(r.id, 'run.updated');
  await advance(r.id);
  return getRun(r.id, p);
}

export async function resume(p: Principal, runId: string): Promise<Run> {
  const r = await getRunRow(runId);
  mustManage(p, r);
  if (!RESUMABLE.includes(r.status)) throw conflict('Only failed or cancelled runs can be resumed');
  if (!r.steps) throw badRequest('This run has no workflow steps to resume');
  const ids = resumableSteps(stepDefs(r), await loadSteps(runId));
  return reopen(p, r, ids, 'Resumed');
}

export async function retryStep(p: Principal, runId: string, stepId: string): Promise<Run> {
  const r = await getRunRow(runId);
  mustManage(p, r);
  if (!['IN_PROGRESS', ...RESUMABLE].includes(r.status)) throw conflict('This run is not running or failed');
  const rows = await loadSteps(runId);
  const row = rows.find((s) => s.step_id === stepId);
  if (!row) throw badRequest(`No step "${stepId}" in this run`);
  if (row.status !== 'FAILURE' && !(row.status === 'CANCELLED' && r.status !== 'IN_PROGRESS')) throw conflict('Only a failed step can be retried');
  // The steps that were skipped because this one failed start over with it.
  const blocked = rows.filter((s) => s.status === 'SKIPPED' && s.state === BLOCKED_STATE).map((s) => s.step_id);
  return reopen(p, r, [stepId, ...blocked], `Step "${row.name}" retried`);
}
