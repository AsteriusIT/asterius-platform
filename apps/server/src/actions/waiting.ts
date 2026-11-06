import type { ObjectSchema } from '@asterius/shared';
import { config } from '../config.js';
import { dialect, driver, json, later, now, one, run as exec } from '../db.js';
import { badRequest, conflict, errorMessage, forbidden } from '../lib/errors.js';
import { evaluate, render } from '../lib/expr.js';
import { compact, validate } from '../catalog/validation.js';
import { audit } from '../audit.js';
import { actorOf, getUser, principalOf, type Principal } from '../auth/users.js';
import { complete, buildContext, setStep } from './engine.js';
import { addLog, emitRun, getRunRow, startAutomatedRun, type RunRow } from './runs.js';
import { getAction } from './actions.js';
import { notifyPendingDecision } from '../notifications/dispatch.js';
import { canSubmitInput, loadSteps, stepDefs, type StepRow } from './steps.js';
import type { Step } from './workflow.js';

/**
 * Steps that wait for something outside the worker: time (`wait`), a person (`input`), another run (`workflow`,
 * with or without `forEach`). They sit in WAITING with a JSON `state` describing what they wait for, and:
 *  - time-based and child-run steps have `next_at` set: workers visit them when it is due (`claimWaits`, claimed by
 *    moving `next_at` forward with a conditional UPDATE, like status polls);
 *  - input and event waits have no `next_at`: they are completed by the API call that answers them;
 *  - timeouts are handled by the engine's housekeeping (`deadline_at`), which also cancels child runs.
 */

type WaitStep = Extract<Step, { type: 'wait' }>;
type InputStep = Extract<Step, { type: 'input' }>;
type CallStep = Extract<Step, { type: 'workflow' }>;

const MAX_DEPTH = 5;
const MAX_ITEMS = 200;
const VISIT_EVERY_MS = config.WORKFLOW_VISIT_MS;
const UNITS: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
const FINAL_RUN = ['SUCCESS', 'FAILURE', 'REJECTED', 'CANCELLED'];

export const parseDuration = (d: string) => {
  const m = /^(\d+)([smhd])$/.exec(d);
  if (!m) throw new Error(`Invalid duration "${d}" (30s, 15m, 2h, 7d)`);
  return Number(m[1]) * UNITS[m[2]];
};

interface WaitState {
  kind: 'wait' | 'input' | 'workflow' | 'foreach';
  until?: string;
  event?: { name: string; filter?: string };
  message?: string | null;
  runId?: string;
  items?: unknown[];
  runs?: (string | null)[];
  results?: ({ status: string; result: unknown; runId: string } | null)[];
  maxConcurrency?: number;
  failFast?: boolean;
}

const stateOf = (row: Pick<StepRow, 'state'>) => json<WaitState | null>(row.state, null);

// ---------- starting ----------
/** PENDING → WAITING for `wait` and `input` steps (called by the engine when the dependencies are done). */
export async function startWaitingStep(r: RunRow, def: WaitStep | InputStep, rows: StepRow[], deadline: string): Promise<boolean> {
  const ctx = await buildContext(r, rows, def.id);
  const noRef = async () => '';
  let state: WaitState;
  let nextAt: string | null = null;
  let label: string;
  let dl = deadline;
  if (def.type === 'input') {
    const message = def.message ? String((await render(def.message, ctx, noRef)).value ?? '') : null;
    state = { kind: 'input', message };
    label = 'Waiting for input';
  } else if (def.event) {
    state = { kind: 'wait', event: def.event };
    label = `Waiting for event "${def.event.name}"`;
  } else {
    const until = def.until ? new Date(String((await render(def.until, ctx, noRef)).value ?? '')) : new Date(Date.now() + parseDuration(def.duration ?? '0s'));
    if (Number.isNaN(until.getTime())) {
      await setStep(r.id, def.id, 'PENDING', { status: 'FAILURE', status_label: `Invalid wait time "${def.until}"`, ended_at: now() });
      return true;
    }
    nextAt = until.toISOString();
    dl = new Date(Math.max(Date.parse(deadline), until.getTime() + 3_600_000)).toISOString();
    state = { kind: 'wait', until: nextAt };
    label = `Waiting until ${nextAt}`;
  }
  const ok = await setStep(r.id, def.id, 'PENDING', {
    status: 'WAITING',
    status_label: label,
    state: JSON.stringify(state),
    next_at: nextAt,
    deadline_at: dl,
    started_at: now(),
  });
  if (ok) {
    await addLog(r.id, label, 'info', def.id);
    if (def.type === 'input')
      void notifyPendingDecision({ run: r, kind: 'input', subjects: def.assignees, stepName: def.name || def.id, message: (state as WaitState).message }).catch(
        () => undefined,
      );
  }
  return ok;
}

// ---------- visiting due steps (workers) ----------
export async function claimWaits(slots: number, spawn: (fn: () => Promise<void>) => void) {
  if (slots <= 0) return 0;
  // One statement claims the due steps (SKIP LOCKED on Postgres) by moving next_at forward, like status polls.
  const { rows } = await driver.query<{ run_id: string; step_id: string }>(
    `UPDATE run_steps SET next_at = ?
     WHERE status = 'WAITING' AND next_at IS NOT NULL AND (run_id, step_id) IN (
       SELECT run_id, step_id FROM run_steps WHERE status = 'WAITING' AND next_at IS NOT NULL AND next_at <= ?
       ORDER BY next_at LIMIT ?${dialect === 'postgres' ? ' FOR UPDATE SKIP LOCKED' : ''}) RETURNING run_id, step_id`,
    [later(30_000), now(), slots],
  );
  for (const s of rows) spawn(() => visit(s.run_id, s.step_id));
  return rows.length;
}

async function visit(runId: string, stepId: string) {
  const r = await getRunRow(runId);
  const row = (await loadSteps(runId)).find((s) => s.step_id === stepId);
  if (!row || row.status !== 'WAITING' || r.status !== 'IN_PROGRESS') return;
  const state = stateOf(row);
  try {
    if (state?.kind === 'wait') await complete(runId, stepId, ['WAITING'], { status: 'SUCCESS', output: { waitedUntil: state.until } });
    else if (state?.kind === 'workflow') await visitChild(r, row, state);
    else if (state?.kind === 'foreach') await visitFanOut(r, row, state);
  } catch (err) {
    await complete(runId, stepId, ['WAITING'], { status: 'FAILURE', statusLabel: errorMessage(err).slice(0, 200) });
  }
}

// ---------- events and inputs ----------
export async function deliverEvent(runId: string, stepId: string, name: string, payload: unknown): Promise<boolean> {
  const r = await getRunRow(runId);
  const row = (await loadSteps(runId)).find((s) => s.step_id === stepId);
  const state = row && stateOf(row);
  if (!row || row.status !== 'WAITING' || state?.kind !== 'wait' || !state.event) throw conflict(`Step "${stepId}" is not waiting for an event`);
  if (state.event.name !== name) return false;
  if (state.event.filter) {
    const ctx = { ...(await buildContext(r, await loadSteps(runId), stepId)), event: payload };
    if (!(await evaluate(state.event.filter, ctx))) return false;
  }
  await addLog(runId, `Event "${name}" received`, 'info', stepId);
  return complete(runId, stepId, ['WAITING'], { status: 'SUCCESS', output: { event: name, payload: payload ?? null } });
}

export async function submitInput(p: Principal, runId: string, stepId: string, values: Record<string, unknown>) {
  const r = await getRunRow(runId);
  const def = stepDefs(r).find((d) => d.id === stepId);
  const row = (await loadSteps(runId)).find((s) => s.step_id === stepId);
  if (!def || !row) throw badRequest(`No step "${stepId}" in this run`);
  if (def.type !== 'input' || row.status !== 'WAITING') throw conflict('This step is not waiting for input');
  if (!canSubmitInput(p, r, def, row)) throw forbidden('You cannot answer this step');
  const clean = compact(values);
  validate(def.inputs as ObjectSchema, clean, 'inputs');
  await addLog(runId, `Input provided by ${p.name}`, 'info', stepId);
  await audit(actorOf(p), 'run.step_input', `${r.action} · ${row.name}`, { runId, step: stepId });
  await complete(runId, stepId, ['WAITING'], { status: 'SUCCESS', output: clean, statusLabel: `Provided by ${p.name}` });
}

// ---------- sub-workflows ----------
async function startChild(r: RunRow, def: CallStep, ctx: unknown, item?: unknown, index?: number): Promise<string> {
  const rendered = await render({ inputs: def.inputs, entity: def.entity }, { ...(ctx as object), item, index }, async () => {
    throw new Error('Secret references are not allowed in sub-workflow inputs');
  });
  const { inputs, entity } = rendered.value as { inputs: Record<string, unknown>; entity?: unknown };
  const action = await getAction(def.action);
  const form = action.trigger?.type === 'form' || action.trigger?.type === 'api' ? action.trigger : null;
  if (form) validate(form.inputs, compact(inputs), 'inputs');
  const depth = (json<{ depth?: number }>(r.trigger_info, {}).depth ?? 0) + 1;
  if (depth > MAX_DEPTH) throw new Error(`Sub-workflows are nested too deeply (limit ${MAX_DEPTH}); check for a workflow calling itself`);
  const user = await getUser(r.triggered_by);
  if (!user) throw new Error('The requester of this run does not exist anymore');
  return startAutomatedRun(def.action, {
    blueprint: form?.blueprint ?? null,
    entity: entity == null || entity === '' ? null : String(entity as string | number),
    inputs,
    source: { type: 'workflow', info: { parentRunId: r.id, parentStepId: def.id, depth } },
    parent: { runId: r.id, stepId: def.id },
    as: await principalOf(user),
  });
}

/** Execute a `workflow` step a worker just claimed (RUNNING): start the child run(s) and wait. */
export async function startSubWorkflow(r: RunRow, def: CallStep, rows: StepRow[]) {
  const ctx = await buildContext(r, rows, def.id);
  if (!def.forEach) {
    const childId = await startChild(r, def, ctx);
    await park(r.id, def.id, { kind: 'workflow', runId: childId }, `Waiting for ${def.action} (${childId.slice(0, 8)})`);
    return;
  }
  const items = await evaluate(def.forEach.items, ctx);
  const list = items === undefined || items === null ? [] : Array.isArray(items) ? items : [items];
  if (list.length > MAX_ITEMS) throw new Error(`The list has ${list.length} items; fan-out is limited to ${MAX_ITEMS}`);
  if (!list.length) {
    await complete(r.id, def.id, ['RUNNING'], { status: 'SUCCESS', output: { results: [], succeeded: 0, failed: 0 }, statusLabel: 'Nothing to do' });
    return;
  }
  const state: WaitState = {
    kind: 'foreach',
    items: list,
    runs: list.map(() => null),
    results: list.map(() => null),
    maxConcurrency: def.forEach.maxConcurrency ?? 3,
    failFast: !!def.forEach.failFast,
  };
  await park(r.id, def.id, state, `Fan-out over ${list.length} item(s)`);
  await addLog(r.id, `Fan-out over ${list.length} item(s), ${state.maxConcurrency} at a time`, 'info', def.id);
}

/** RUNNING → WAITING with the state to resume from, visited again shortly. */
async function park(runId: string, stepId: string, state: WaitState, label: string) {
  await setStep(runId, stepId, 'RUNNING', {
    status: 'WAITING',
    status_label: label,
    state: JSON.stringify(state),
    next_at: later(VISIT_EVERY_MS),
    locked_until: null,
  });
  await emitRun(runId, 'run.updated');
}

const rearm = (runId: string, stepId: string, state: WaitState, label?: string) =>
  setStep(runId, stepId, 'WAITING', {
    state: JSON.stringify(state),
    next_at: later(VISIT_EVERY_MS),
    ...(label ? { status_label: label } : {}),
  });

async function childRun(id: string) {
  return one<{ status: string; result: string | null; status_label: string | null }>('SELECT status, result, status_label FROM runs WHERE id = ?', id);
}

async function visitChild(r: RunRow, row: StepRow, state: WaitState) {
  const child = await childRun(state.runId!);
  if (!child || !FINAL_RUN.includes(child.status)) return void (await rearm(r.id, row.step_id, state));
  const output = { runId: state.runId, status: child.status, result: json(child.result, null) };
  await complete(r.id, row.step_id, ['WAITING'], {
    status: child.status === 'SUCCESS' ? 'SUCCESS' : 'FAILURE',
    output,
    statusLabel: child.status === 'SUCCESS' ? null : `Child run ${child.status.toLowerCase()}${child.status_label ? `: ${child.status_label}` : ''}`,
    link: `/runs/${state.runId}`,
  });
}

async function visitFanOut(r: RunRow, row: StepRow, state: WaitState) {
  const def = stepDefs(r).find((d) => d.id === row.step_id) as CallStep;
  const runs = state.runs!;
  const results = state.results!;
  for (const [i, id] of runs.entries()) {
    if (!id || results[i]) continue;
    const c = await childRun(id);
    if (c && FINAL_RUN.includes(c.status)) results[i] = { status: c.status, result: json(c.result, null), runId: id };
  }
  const failed = results.filter((x) => x && x.status !== 'SUCCESS').length;
  const succeeded = results.filter((x) => x?.status === 'SUCCESS').length;
  if (state.failFast && failed) {
    for (const [i, id] of runs.entries()) if (id && !results[i]) await cancelChildRun(id);
    await complete(r.id, row.step_id, ['WAITING'], {
      status: 'FAILURE',
      output: summary(state, results),
      statusLabel: `${failed} of ${runs.length} failed (fail fast)`,
    });
    return;
  }
  let active = runs.filter((id, i) => id && !results[i]).length;
  const ctx = active < state.maxConcurrency! ? await buildContext(r, await loadSteps(r.id), row.step_id) : undefined;
  for (let i = 0; ctx && i < runs.length && active < state.maxConcurrency!; i++) {
    if (runs[i] || results[i]) continue;
    try {
      runs[i] = await startChild(r, def, ctx, state.items![i], i);
      active++;
    } catch (err) {
      runs[i] = '';
      results[i] = { status: 'FAILURE', result: { error: errorMessage(err) }, runId: '' };
      await addLog(r.id, `Item ${i + 1}: ${errorMessage(err)}`, 'error', row.step_id);
    }
  }
  const done = results.filter(Boolean).length;
  if (done === runs.length) {
    const failedNow = results.filter((x) => x && x.status !== 'SUCCESS').length;
    await complete(r.id, row.step_id, ['WAITING'], {
      status: failedNow ? 'FAILURE' : 'SUCCESS',
      output: summary(state, results),
      statusLabel: failedNow ? `${failedNow} of ${runs.length} failed` : `${succeeded} of ${runs.length} succeeded`,
    });
    return;
  }
  await rearm(r.id, row.step_id, state, `${done}/${runs.length} done, ${active} running`);
}

const summary = (state: WaitState, results: WaitState['results']) => ({
  results: state.items!.map((item, i) => ({ item, ...(results![i] ?? { status: 'CANCELLED', result: null, runId: state.runs![i] ?? null }) })),
  succeeded: results!.filter((x) => x?.status === 'SUCCESS').length,
  failed: results!.filter((x) => x && x.status !== 'SUCCESS').length,
});

// ---------- cancellation (children follow their parent) ----------
export async function cancelChildRun(runId: string) {
  const t = now();
  const { changes } = await exec(
    "UPDATE runs SET status = 'CANCELLED', ended_at = ?, updated_at = ?, next_poll_at = NULL WHERE id = ? AND status IN ('PENDING_APPROVAL', 'QUEUED', 'IN_PROGRESS')",
    t,
    t,
    runId,
  );
  if (!changes) return;
  const child = await getRunRow(runId);
  // The engine stops the child's own steps (lazy import: engine.ts imports this module).
  const { cancelSteps } = await import('./engine.js');
  await cancelSteps(child);
  await addLog(runId, 'Cancelled with its parent run', 'warn');
  await emitRun(runId, 'run.updated');
}

/** The child runs a waiting step started (cancel / timeout of the parent). */
export async function cancelChildrenOf(row: StepRow) {
  if (row.status !== 'WAITING') return;
  const state = stateOf(row);
  const ids = state?.kind === 'workflow' ? [state.runId] : state?.kind === 'foreach' ? (state.runs ?? []) : [];
  for (const id of ids) if (id) await cancelChildRun(id).catch(() => undefined);
}
