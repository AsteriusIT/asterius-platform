import type { FastifyBaseLogger } from 'fastify';
import type { InvokerConfig, RunLog } from '@asterius/shared';
import { config } from '../config.js';
import { all, json, later, now, one, run as exec } from '../db.js';
import { conflict, badRequest, errorMessage, forbidden } from '../lib/errors.js';
import { evaluate, redact, render } from '../lib/expr.js';
import { resolveRef, stepToken } from '../secrets.js';
import { audit, SYSTEM } from '../audit.js';
import { actorOf, type Principal } from '../auth/users.js';
import { findEntity } from '../catalog/entities.js';
import { metrics } from '../metrics.js';
import { withSpan } from '../tracing.js';
import { getInvoker } from './invokers/index.js';
import type { InvokeEnv, InvokeResult, RunContext } from './types.js';
import { addLog, emitRun, getRunRow, runUrl, updateRun, type RunRow } from './runs.js';
import { canApproveStep, isTerminal, loadSteps, stepApprovalsOf, stepDefs, type StepRow } from './steps.js';
import { needsOf, type Step } from './workflow.js';
import { runAgent, StepError } from './agent.js';

/**
 * Workflow engine. A run's steps form a graph (see workflow.ts); the engine moves each step through
 *   PENDING → (condition / dependencies) → SKIPPED | QUEUED | WAITING_APPROVAL → RUNNING → SUCCESS | FAILURE
 * and finishes the run when every step is terminal. Workers execute QUEUED steps and poll RUNNING ones.
 * Every transition is a conditional UPDATE on the current status: concurrent replicas, callbacks and polls can call
 * `advance` at any time, and a step is only ever started, completed or retried once.
 */

export const stepCallbackUrl = (runId: string, stepId: string) => `${config.PUBLIC_URL}/api/v1/runs/${runId}/steps/${stepId}`;
const APPROVAL_TIMEOUT_MIN = 7 * 24 * 60;
const defaultTimeoutMin = (s: Step) => s.timeoutMinutes ?? (s.type === 'approval' ? APPROVAL_TIMEOUT_MIN : config.RUN_TIMEOUT_HOURS * 60);
const BLOCKED = '{"blocked":true}';

const stepLog =
  (runId: string, stepId: string | null, secrets: string[] = []) =>
  (message: string, level: RunLog['level'] = 'info') =>
    addLog(runId, redact(message, secrets), level, stepId);

// ---------- context ----------
export async function buildContext(r: RunRow, rows: StepRow[], forStep?: string): Promise<RunContext> {
  const entity = r.blueprint && r.entity ? ((await findEntity(r.blueprint, r.entity)) ?? null) : null;
  return {
    // Each step gets its own callback (URL + token scoped to the step).
    run: { id: r.id, url: runUrl(r.id), callback: { url: stepCallbackUrl(r.id, forStep ?? ''), token: forStep ? stepToken(r.id, forStep) : '' } },
    action: { identifier: r.action, title: r.action_title, blueprint: r.blueprint },
    inputs: json(r.inputs, {}),
    entity,
    trigger: { user: { id: r.triggered_by, email: r.user_email ?? '', name: r.user_name ?? '' }, at: r.created_at },
    steps: Object.fromEntries(rows.map((s) => [s.step_id, { status: s.status, output: json(s.output, null), link: s.link }])),
  };
}

// ---------- run start ----------
/** Create the step rows of a run that just moved to IN_PROGRESS, then start what can start. Idempotent. */
export async function initRun(runId: string) {
  const r = await getRunRow(runId);
  const defs = stepDefs(r);
  const existing = new Set((await loadSteps(runId)).map((s) => s.step_id));
  for (const [i, s] of defs.entries())
    if (!existing.has(s.id))
      await exec(
        "INSERT INTO run_steps (run_id, step_id, position, name, type, status) VALUES (?, ?, ?, ?, ?, 'PENDING')",
        runId,
        s.id,
        i,
        s.name || s.id,
        s.type,
      );
  await addLog(runId, `Workflow started: ${defs.length} step(s)`);
  await advance(runId);
}

// ---------- graph progression ----------
export async function advance(runId: string): Promise<void> {
  const r = await getRunRow(runId);
  if (r.status !== 'IN_PROGRESS') return;
  const defs = stepDefs(r);
  let changed = true;
  // Skips cascade (a skipped dependency can unblock or block the next step): loop until stable.
  while (changed) {
    changed = false;
    const rows = await loadSteps(runId);
    const byId = new Map(rows.map((s) => [s.step_id, s]));
    let ctx: RunContext | undefined;
    for (const [i, def] of defs.entries()) {
      const row = byId.get(def.id);
      if (!row || row.status !== 'PENDING') continue;
      const deps = needsOf(defs, i).map((id) => byId.get(id)!);
      if (deps.some((d) => !isTerminal(d.status))) continue;
      const failedDep = deps.find(
        (d) =>
          d.status === 'CANCELLED' ||
          (d.status === 'SKIPPED' && d.state === BLOCKED) ||
          (d.status === 'FAILURE' && !defs.find((x) => x.id === d.step_id)?.continueOnError),
      );
      if (failedDep) {
        changed =
          (await setStep(runId, def.id, 'PENDING', { status: 'SKIPPED', status_label: `Skipped: ${failedDep.name} did not succeed`, state: BLOCKED })) ||
          changed;
        continue;
      }
      if (def.if) {
        ctx ??= await buildContext(r, rows, def.id);
        let ok: boolean;
        try {
          ok = !!(await evaluate(def.if, ctx));
        } catch (err) {
          changed = (await setStep(runId, def.id, 'PENDING', { status: 'FAILURE', status_label: `Condition error: ${errorMessage(err)}` })) || changed;
          continue;
        }
        if (!ok) {
          if (await setStep(runId, def.id, 'PENDING', { status: 'SKIPPED', status_label: 'Condition not met' })) {
            await addLog(runId, `Skipped (condition not met: ${def.if})`, 'info', def.id);
            changed = true;
          }
          continue;
        }
      }
      changed = (await startStep(r, def, rows)) || changed;
    }
  }
  await finishOrLabel(runId, defs);
}

/** PENDING → WAITING_APPROVAL (approval) or QUEUED (others). */
async function startStep(r: RunRow, def: Step, rows: StepRow[]): Promise<boolean> {
  const deadline = later(defaultTimeoutMin(def) * 60_000);
  if (def.type === 'approval') {
    let message: string | null = null;
    if (def.message) {
      const ctx = await buildContext(r, rows, def.id);
      message = String((await render(def.message, ctx, async () => '')).value ?? '');
    }
    const ok = await setStep(r.id, def.id, 'PENDING', {
      status: 'WAITING_APPROVAL',
      status_label: `Waiting for ${def.minApprovals} approval(s)`,
      state: JSON.stringify({ message }),
      started_at: now(),
      deadline_at: deadline,
    });
    if (ok) await addLog(r.id, `Waiting for ${def.minApprovals} approval(s)`, 'info', def.id);
    return ok;
  }
  const ok = await setStep(r.id, def.id, 'PENDING', { status: 'QUEUED', status_label: null, next_at: now(), deadline_at: deadline });
  return ok;
}

type StepPatch = Partial<
  Pick<StepRow, 'status' | 'status_label' | 'output' | 'state' | 'link' | 'next_at' | 'deadline_at' | 'started_at' | 'ended_at' | 'locked_until' | 'worker'>
>;

/** Conditional transition: only applies when the step is still in `from` (one of). */
async function setStep(runId: string, stepId: string, from: StepRow['status'] | StepRow['status'][], patch: StepPatch): Promise<boolean> {
  const froms = Array.isArray(from) ? from : [from];
  const keys = Object.keys(patch) as (keyof StepPatch)[];
  const { changes } = await exec(
    `UPDATE run_steps SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE run_id = ? AND step_id = ? AND status IN (${froms.map(() => '?').join(',')})`,
    ...keys.map((k) => (patch[k] ?? null) as string | null),
    runId,
    stepId,
    ...froms,
  );
  return changes > 0;
}

/** All steps terminal → finish the run; otherwise show what is going on in the run's status label. */
async function finishOrLabel(runId: string, defs: Step[]) {
  const rows = await loadSteps(runId);
  if (!rows.length) return;
  if (rows.every((s) => isTerminal(s.status))) {
    const failed = rows.find((s) => {
      const def = defs.find((d) => d.id === s.step_id);
      return s.status === 'CANCELLED' || (s.status === 'FAILURE' && !def?.continueOnError);
    });
    const outputs = Object.fromEntries(rows.filter((s) => s.status === 'SUCCESS' && s.output).map((s) => [s.step_id, json(s.output, null)]));
    const link = [...rows].reverse().find((s) => s.link)?.link ?? null;
    const done = await updateRun(runId, {
      status: failed ? 'FAILURE' : 'SUCCESS',
      statusLabel: failed ? `Failed at ${failed.name}` : null,
      result: Object.keys(outputs).length ? outputs : undefined,
      link,
    });
    if (done) await audit(SYSTEM, failed ? 'run.failed' : 'run.succeeded', runId, failed ? { step: failed.step_id } : {});
    return;
  }
  const waiting = rows.filter((s) => s.status === 'WAITING_APPROVAL').map((s) => s.name);
  const running = rows.filter((s) => s.status === 'RUNNING' || s.status === 'QUEUED').map((s) => s.name);
  const label = waiting.length ? `Waiting for approval: ${waiting.join(', ')}` : running.length ? `Running: ${running.join(', ')}` : null;
  const r = await one<{ status_label: string | null }>('SELECT status_label FROM runs WHERE id = ?', runId);
  if (r && r.status_label !== label) await updateRun(runId, { statusLabel: label });
}

// ---------- step completion ----------
interface Completion {
  status: 'SUCCESS' | 'FAILURE';
  output?: unknown;
  link?: string | null;
  statusLabel?: string | null;
}

async function complete(runId: string, stepId: string, from: StepRow['status'][], c: Completion) {
  const ok = await setStep(runId, stepId, from, {
    status: c.status,
    status_label: c.statusLabel ?? null,
    ...(c.output !== undefined ? { output: JSON.stringify(c.output) } : {}),
    ...(c.link !== undefined ? { link: c.link } : {}),
    ended_at: now(),
    next_at: null,
    locked_until: null,
  });
  if (!ok) return false;
  const row = await one<StepRow>('SELECT * FROM run_steps WHERE run_id = ? AND step_id = ?', runId, stepId);
  metrics.stepFinished(row?.type ?? '?', c.status);
  await addLog(
    runId,
    c.status === 'SUCCESS' ? 'Step succeeded' : `Step failed${c.statusLabel ? `: ${c.statusLabel}` : ''}`,
    c.status === 'SUCCESS' ? 'info' : 'error',
    stepId,
  );
  await emitRun(runId, 'run.updated');
  await advance(runId);
  return true;
}

/** A failed attempt: retry with exponential backoff while attempts remain (and the error is retryable). */
export async function failStep(runId: string, stepId: string, message: string, retryable: boolean, secrets: string[] = []) {
  const r = await getRunRow(runId);
  const def = stepDefs(r).find((d) => d.id === stepId);
  const row = await one<StepRow>('SELECT * FROM run_steps WHERE run_id = ? AND step_id = ?', runId, stepId);
  if (!def || !row) return;
  const text = redact(message, secrets);
  await addLog(runId, text, 'error', stepId);
  if (retryable && Number(row.attempt) <= def.retries) {
    const delay = def.retryDelaySeconds * 2 ** (Number(row.attempt) - 1);
    const ok = await setStep(runId, stepId, 'RUNNING', {
      status: 'QUEUED',
      status_label: `Retrying in ${delay}s (attempt ${Number(row.attempt) + 1}/${def.retries + 1})`,
      next_at: later(delay * 1000),
      locked_until: null,
      state: null,
    });
    if (ok) await addLog(runId, `Retrying in ${delay}s (attempt ${Number(row.attempt) + 1}/${def.retries + 1})`, 'warn', stepId);
    return;
  }
  await complete(runId, stepId, ['RUNNING', 'QUEUED'], { status: 'FAILURE', statusLabel: text.slice(0, 200) });
}

// ---------- execution (workers) ----------
async function invokeEnv(r: RunRow, def: Extract<Step, { type: 'invoke' }>, rows: StepRow[]) {
  const ctx = await buildContext(r, rows, def.id);
  const { value, secrets } = await render(def.invoker, ctx, resolveRef);
  secrets.push(ctx.run.callback.token);
  const env: InvokeEnv = { ctx, config: value as Record<string, unknown>, log: stepLog(r.id, def.id, secrets) };
  return { env, secrets };
}

async function applyInvokeResult(runId: string, stepId: string, res: InvokeResult, polls: boolean) {
  if (res.status === 'SUCCESS' || res.status === 'FAILURE')
    return complete(runId, stepId, ['RUNNING'], { status: res.status, output: res.result ?? null, link: res.link, statusLabel: res.statusLabel });
  const ok = await setStep(runId, stepId, 'RUNNING', {
    state: JSON.stringify(res.state ?? {}),
    status_label: res.statusLabel ?? null,
    ...(res.link !== undefined ? { link: res.link } : {}),
    locked_until: null,
    next_at: polls ? later(config.RUN_POLL_SECONDS * 1000) : null,
  });
  if (ok && (res.link !== undefined || res.statusLabel !== undefined)) await emitRun(runId, 'run.updated');
}

/** Execute a step the worker just claimed (QUEUED → RUNNING). */
export async function executeStep(runId: string, stepId: string) {
  const r = await getRunRow(runId);
  const def = stepDefs(r).find((d) => d.id === stepId);
  if (!def) return;
  if (r.status !== 'IN_PROGRESS') return void (await setStep(runId, stepId, 'RUNNING', { status: 'CANCELLED', ended_at: now(), locked_until: null }));
  const rows = await loadSteps(runId);
  const row = rows.find((s) => s.step_id === stepId)!;
  await addLog(runId, `Started${Number(row.attempt) > 1 ? ` (attempt ${row.attempt}/${def.retries + 1})` : ''}`, 'info', stepId);
  await emitRun(runId, 'run.updated');
  let secrets: string[] = [];
  await withSpan('workflow.step', { 'run.id': runId, 'step.id': stepId, 'step.type': def.type }, async () => {
    try {
      if (def.type === 'invoke') {
        const inv = getInvoker(def.invoker.type);
        const built = await invokeEnv(r, def, rows);
        secrets = built.secrets;
        await applyInvokeResult(runId, stepId, await inv.start(built.env), !!inv.poll);
      } else if (def.type === 'agent') {
        const ctx = await buildContext(r, rows, stepId);
        const rendered = await render({ prompt: def.prompt, system: def.system, apiKey: def.apiKey }, ctx, resolveRef);
        secrets = rendered.secrets;
        const v = rendered.value as { prompt: unknown; system?: unknown; apiKey?: unknown };
        const prompt = typeof v.prompt === 'string' ? v.prompt : JSON.stringify(v.prompt);
        const result = await runAgent(
          { ...def, prompt, system: typeof v.system === 'string' ? v.system : undefined, apiKey: typeof v.apiKey === 'string' ? v.apiKey : undefined },
          stepLog(runId, stepId, secrets),
        );
        await setStep(runId, stepId, 'RUNNING', { state: JSON.stringify({ usage: result.usage }) });
        await complete(runId, stepId, ['RUNNING'], {
          status: 'SUCCESS',
          output: result.output,
          statusLabel: `${result.usage.model} · ${result.usage.turns} turn(s)`,
        });
      } else if (def.type === 'transform') {
        const ctx = await buildContext(r, rows, stepId);
        const output: Record<string, unknown> = {};
        for (const [k, expr] of Object.entries(def.output)) output[k] = await evaluate(expr, ctx);
        await complete(runId, stepId, ['RUNNING'], { status: 'SUCCESS', output });
      }
    } catch (err) {
      // Invokers: an exception during start may have reached the external system → not retried unless declared retryable.
      const retryable = err instanceof StepError ? err.retryable : def.type !== 'invoke' || def.retries > 0;
      await failStep(runId, stepId, `${def.type === 'invoke' ? 'Invoker' : 'Step'} error: ${errorMessage(err)}`, retryable, secrets);
    }
  });
}

/** Poll an IN_PROGRESS invoke step (pipelines, jobs). */
export async function pollStep(runId: string, stepId: string) {
  const r = await getRunRow(runId);
  const def = stepDefs(r).find((d) => d.id === stepId);
  if (!def || def.type !== 'invoke' || r.status !== 'IN_PROGRESS') return;
  const rows = await loadSteps(runId);
  const row = rows.find((s) => s.step_id === stepId);
  if (!row || row.status !== 'RUNNING') return;
  let secrets: string[] = [];
  try {
    const inv = getInvoker(def.invoker.type);
    if (!inv.poll) return;
    const built = await invokeEnv(r, def, rows);
    secrets = built.secrets;
    await applyInvokeResult(runId, stepId, await inv.poll(built.env, json(row.state, {})), true);
  } catch (err) {
    await addLog(runId, redact(`Status check failed: ${errorMessage(err)}`, secrets), 'warn', stepId);
    await setStep(runId, stepId, 'RUNNING', { next_at: later(config.RUN_POLL_SECONDS * 2000) });
  }
}

// ---------- updates from external systems (callback API) ----------
export interface StepUpdate {
  status?: 'IN_PROGRESS' | 'SUCCESS' | 'FAILURE';
  statusLabel?: string | null;
  link?: string | null;
  result?: unknown;
  logs?: { message: string; level?: RunLog['level'] }[];
}

export async function updateStep(runId: string, stepId: string, u: StepUpdate): Promise<boolean> {
  const row = await one<StepRow>('SELECT * FROM run_steps WHERE run_id = ? AND step_id = ?', runId, stepId);
  if (!row || row.status !== 'RUNNING') return false;
  for (const l of u.logs ?? []) await addLog(runId, l.message, l.level ?? 'info', stepId);
  if (u.status === 'SUCCESS' || u.status === 'FAILURE')
    return complete(runId, stepId, ['RUNNING'], { status: u.status, output: u.result, link: u.link, statusLabel: u.statusLabel });
  if (u.statusLabel !== undefined || u.link !== undefined) {
    await setStep(runId, stepId, 'RUNNING', {
      ...(u.statusLabel !== undefined ? { status_label: u.statusLabel } : {}),
      ...(u.link !== undefined ? { link: u.link } : {}),
    });
    await emitRun(runId, 'run.updated');
  }
  return true;
}

/** Legacy run-level callback (`PATCH /runs/:id`): applies to the single running invoke step. */
export async function runningInvokeStep(runId: string): Promise<string | undefined> {
  const rows = (await loadSteps(runId)).filter((s) => s.status === 'RUNNING' && s.type === 'invoke');
  return rows.length === 1 ? rows[0].step_id : undefined;
}

// ---------- approval steps ----------
export async function decideStep(p: Principal, runId: string, stepId: string, decision: 'approved' | 'rejected', comment: string) {
  const r = await getRunRow(runId);
  const def = stepDefs(r).find((d) => d.id === stepId);
  const row = await one<StepRow>('SELECT * FROM run_steps WHERE run_id = ? AND step_id = ?', runId, stepId);
  if (!def || !row) throw badRequest(`No step "${stepId}" in this run`);
  if (def.type !== 'approval' || row.status !== 'WAITING_APPROVAL') throw conflict('This step is not waiting for approval');
  const approvals = (await stepApprovalsOf([runId])).get(`${runId}/${stepId}`) ?? [];
  if (!canApproveStep(p, r, def, row, approvals)) throw forbidden('You cannot approve this step');
  if (decision === 'rejected' && !comment.trim()) throw badRequest('Give a reason when rejecting');
  await exec(
    'INSERT INTO step_approvals (run_id, step_id, user_id, decision, comment, at) VALUES (?, ?, ?, ?, ?, ?)',
    runId,
    stepId,
    p.id,
    decision,
    comment,
    now(),
  );
  await addLog(
    runId,
    `${decision === 'approved' ? 'Approved' : 'Rejected'} by ${p.name}${comment ? `: ${comment}` : ''}`,
    decision === 'approved' ? 'info' : 'warn',
    stepId,
  );
  await audit(actorOf(p), `run.step_${decision}`, `${r.action} · ${row.name}`, { runId, step: stepId, comment });
  const all = [...approvals, { userId: p.id, userName: p.name, decision, comment, at: now() }];
  const approved = all.filter((a) => a.decision === 'approved');
  if (decision === 'rejected')
    await complete(runId, stepId, ['WAITING_APPROVAL'], {
      status: 'FAILURE',
      statusLabel: `Rejected by ${p.name}`,
      output: { approved: false, by: p.name, comment },
    });
  else if (approved.length >= def.minApprovals)
    await complete(runId, stepId, ['WAITING_APPROVAL'], {
      status: 'SUCCESS',
      statusLabel: `Approved by ${approved.map((a) => a.userName).join(', ')}`,
      output: { approved: true, by: approved.map((a) => a.userName), comments: approved.map((a) => a.comment).filter(Boolean) },
    });
  else {
    await setStep(runId, stepId, 'WAITING_APPROVAL', { status_label: `${approved.length}/${def.minApprovals} approval(s)` });
    await emitRun(runId, 'run.updated');
  }
}

// ---------- cancellation ----------
/** Best effort: ask the external system to stop a running invoke step (pipeline, job). */
async function cancelExternal(r: RunRow, row: StepRow) {
  const def = stepDefs(r).find((d) => d.id === row.step_id);
  if (row.status !== 'RUNNING' || def?.type !== 'invoke' || !row.state) return;
  try {
    const inv = getInvoker(def.invoker.type);
    if (!inv.cancel) return;
    const { env } = await invokeEnv(r, def, await loadSteps(r.id));
    await inv.cancel(env, json(row.state, {}));
    await addLog(r.id, 'Cancellation requested from the external system', 'warn', row.step_id);
  } catch (err) {
    await addLog(r.id, `Could not cancel the external run: ${errorMessage(err)}`, 'warn', row.step_id);
  }
}

export async function cancelSteps(r: RunRow) {
  for (const row of await loadSteps(r.id)) {
    if (isTerminal(row.status)) continue;
    await cancelExternal(r, row);
    await setStep(r.id, row.step_id, ['PENDING', 'QUEUED', 'RUNNING', 'WAITING_APPROVAL'], {
      status: 'CANCELLED',
      ended_at: now(),
      next_at: null,
      locked_until: null,
    });
  }
}

// ---------- worker loops ----------
const LEASES: Record<Step['type'], number> = { invoke: 5 * 60_000, agent: 15 * 60_000, transform: 60_000, approval: 0 };

/** Claim due QUEUED steps (up to `slots`) and run them through `spawn`. */
export async function claimSteps(worker: string, slots: number, spawn: (fn: () => Promise<void>) => void) {
  if (slots <= 0) return;
  const due = await all<StepRow>(
    "SELECT * FROM run_steps WHERE status = 'QUEUED' AND (next_at IS NULL OR next_at <= ?) ORDER BY next_at LIMIT ?",
    now(),
    slots,
  );
  for (const s of due) {
    const t = now();
    const { changes } = await exec(
      "UPDATE run_steps SET status = 'RUNNING', attempt = attempt + 1, worker = ?, locked_until = ?, started_at = COALESCE(started_at, ?), next_at = NULL, status_label = NULL WHERE run_id = ? AND step_id = ? AND status = 'QUEUED' AND (next_at IS NULL OR next_at <= ?)",
      worker,
      later(LEASES[s.type] || 60_000),
      t,
      s.run_id,
      s.step_id,
      t,
    );
    if (changes) spawn(() => executeStep(s.run_id, s.step_id));
  }
}

/** Poll due RUNNING invoke steps (claimed by moving next_at forward). */
export async function claimPolls(slots: number, spawn: (fn: () => Promise<void>) => void) {
  if (slots <= 0) return;
  const due = await all<StepRow>(
    "SELECT * FROM run_steps WHERE status = 'RUNNING' AND next_at IS NOT NULL AND next_at <= ? ORDER BY next_at LIMIT ?",
    now(),
    slots,
  );
  for (const s of due) {
    const { changes } = await exec(
      'UPDATE run_steps SET next_at = ? WHERE run_id = ? AND step_id = ? AND next_at = ?',
      later(5 * 60_000),
      s.run_id,
      s.step_id,
      s.next_at,
    );
    if (changes) spawn(() => pollStep(s.run_id, s.step_id));
  }
}

export async function stepHousekeeping(log: FastifyBaseLogger) {
  const t = now();
  // A worker died while starting a step: invokers may have called the external system → failed, not retried.
  for (const s of await all<StepRow>("SELECT * FROM run_steps WHERE status = 'RUNNING' AND locked_until IS NOT NULL AND locked_until < ? AND state IS NULL", t))
    await failStep(s.run_id, s.step_id, 'The worker executing this step stopped before it finished', s.type !== 'invoke').catch((err) =>
      log.error({ err }, 'step recovery'),
    );
  // Timeouts (running steps and approvals).
  for (const s of await all<StepRow>(
    "SELECT * FROM run_steps WHERE status IN ('RUNNING', 'WAITING_APPROVAL', 'QUEUED') AND deadline_at IS NOT NULL AND deadline_at < ?",
    t,
  )) {
    const r = await getRunRow(s.run_id).catch(() => undefined);
    if (r && s.status === 'RUNNING') await cancelExternal(r, s);
    await complete(s.run_id, s.step_id, ['RUNNING', 'WAITING_APPROVAL', 'QUEUED'], {
      status: 'FAILURE',
      statusLabel: s.status === 'WAITING_APPROVAL' ? 'Approval expired' : 'Timed out',
    }).catch((err) => log.error({ err }, 'step timeout'));
  }
  // Runs whose start or end was interrupted: create missing steps / finish completed workflows.
  for (const r of await all<{ id: string; n: number }>(
    "SELECT r.id, (SELECT count(*) FROM run_steps s WHERE s.run_id = r.id) AS n FROM runs r WHERE r.status = 'IN_PROGRESS' AND r.started_at < ?",
    later(-60_000),
  ))
    await (Number(r.n) === 0 ? initRun(r.id) : advance(r.id)).catch((err) => log.error({ err, runId: r.id }, 'run recovery'));
}

export type { InvokerConfig };
