import type { FastifyBaseLogger } from 'fastify';
import type { InvokerConfig, RunLog } from '@asterius/shared';
import { config } from '../config.js';
import { all, dialect, driver, forUpdate, json, later, now, one, run as exec, tx, tryAdvisoryLock, type SqlValue } from '../db.js';
import { conflict, badRequest, errorMessage, forbidden } from '../lib/errors.js';
import { evaluate, redact, redactDeep, render } from '../lib/expr.js';
import { resolveRef, stepToken } from '../secrets.js';
import { outputProblem, resolverFor } from './limits.js';
import { audit, SYSTEM } from '../audit.js';
import { actorOf, getUser, principalOf, type Principal } from '../auth/users.js';
import { findEntity } from '../catalog/entities.js';
import { scorecardLevels } from '../catalog/scorecards.js';
import { compact, validate } from '../catalog/validation.js';
import type { ObjectSchema } from '@asterius/shared';
import { emit } from '../events.js';
import { metrics } from '../metrics.js';
import { withSpan } from '../tracing.js';
import { getInvoker } from './invokers/index.js';
import type { InvokeEnv, InvokeResult, RunContext } from './types.js';
import { addLog, emitRun, getRunRow, inRunOrg, runUrl, updateRun, type RunRow } from './runs.js';
import {
  allowedToFail,
  canApproveStep,
  handledFailures,
  isTerminal,
  loadSteps,
  stepApprovalsOf,
  stepDefs,
  timedOutState,
  unhandledFailure,
  type StepRow,
} from './steps.js';
import { casesOf, needsOf, type Step } from './workflow.js';
import { runAgent, StepError, wrapUntrusted } from './agent.js';
import { wake } from './wake.js';
import { notifyPendingDecision } from '../notifications/dispatch.js';
import { cancelChildrenOf, startSubWorkflow, startWaitingStep } from './waiting.js';

/**
 * Workflow engine. A run's steps form a graph (see workflow.ts); the engine moves each step through
 *   PENDING → (when / case / condition) → SKIPPED | QUEUED | WAITING_APPROVAL → RUNNING → SUCCESS | FAILURE
 * and finishes the run when every step is terminal. Workers execute QUEUED steps and poll RUNNING ones.
 * Every transition is a conditional UPDATE on the current status: concurrent replicas, callbacks and polls can call
 * `advance` at any time, and a step is only ever started, completed or retried once.
 */

export const stepCallbackUrl = (runId: string, stepId: string) => `${config.PUBLIC_URL}/api/v1/runs/${runId}/steps/${stepId}`;
const APPROVAL_TIMEOUT_MIN = 7 * 24 * 60;
const HUMAN_STEPS = new Set<Step['type']>(['approval', 'input', 'wait']);
const defaultTimeoutMin = (s: Step) => s.timeoutMinutes ?? (HUMAN_STEPS.has(s.type) ? APPROVAL_TIMEOUT_MIN : config.STEP_TIMEOUT_MINUTES);
/** Run-level deadline: RUN_TIMEOUT_HOURS of machine time, plus the time humans (or timers) may take on waiting steps. */
export const runDeadline = (defs: Step[], startMs = Date.now()) =>
  new Date(
    startMs + config.RUN_TIMEOUT_HOURS * 3_600_000 + defs.filter((d) => HUMAN_STEPS.has(d.type)).reduce((n, d) => n + defaultTimeoutMin(d) * 60_000, 0),
  ).toISOString();
const BLOCKED = '{"blocked":true}';
/** Run-level `vars` and `outputs` never resolve secrets: their values are stored with the run. */
const noSecrets = async (): Promise<string> => {
  throw new Error('Secret references are not allowed in vars and outputs');
};
const runTemplates = (r: Pick<RunRow, 'workflow'>) => json<{ vars?: Record<string, unknown>; outputs?: Record<string, unknown> }>(r.workflow, {});

const stepLog =
  (runId: string, stepId: string | null, secrets: string[] = []) =>
  (message: string, level: RunLog['level'] = 'info') =>
    addLog(runId, redact(message, secrets), level, stepId);

// ---------- context ----------
export async function buildContext(r: RunRow, rows: StepRow[], forStep?: string): Promise<RunContext> {
  const defs = stepDefs(r);
  const entity = r.blueprint && r.entity ? ((await findEntity(r.blueprint, r.entity)) ?? null) : null;
  return {
    // Each step gets its own callback (URL + token scoped to the step).
    run: {
      id: r.id,
      url: runUrl(r.id),
      idempotencyKey: forStep ? `${r.id}/${forStep}` : r.id,
      callback: { url: stepCallbackUrl(r.id, forStep ?? ''), token: forStep ? stepToken(r.id, forStep) : '' },
    },
    action: { identifier: r.action, title: r.action_title, blueprint: r.blueprint },
    inputs: json(r.inputs, {}),
    // `entity.scorecards.<id>.level` / `.rank` (0: below the first level) for conditions and templates.
    entity: entity ? { ...entity, scorecards: await scorecardLevels(entity.blueprint, entity.identifier) } : null,
    trigger: { user: { id: r.triggered_by, email: r.user_email ?? '', name: r.user_name ?? '' }, at: r.created_at },
    vars: json(r.vars, {}),
    steps: Object.fromEntries(
      rows.map((s) => {
        const def = defs.find((d) => d.id === s.step_id);
        // Event waits: the token an earlier step (or an external system) uses to signal this step.
        const events = def?.type === 'wait' && def.event ? { url: `${stepCallbackUrl(r.id, s.step_id)}/events`, token: stepToken(r.id, s.step_id) } : undefined;
        return [s.step_id, { status: s.status, output: json(s.output, null), link: s.link, ...(events ? { events } : {}) }];
      }),
    ),
  };
}

/** Inside a `forEach` loop: `item` and `index` in the context, and an idempotency key per item. */
export interface Iteration {
  item: unknown;
  index: number;
}
const withIteration = (ctx: RunContext, it?: Iteration): RunContext =>
  it ? { ...ctx, item: it.item, index: it.index, run: { ...ctx.run, idempotencyKey: `${ctx.run.idempotencyKey}/${it.index}` } } : ctx;

// ---------- run start ----------
/** Create the step rows of a run that just moved to IN_PROGRESS, then start what can start. Idempotent. */
export async function initRun(runId: string) {
  let r = await getRunRow(runId);
  if (r.status !== 'IN_PROGRESS') return; // cancelled between the claim and the start
  const { vars } = runTemplates(r);
  if (vars && r.vars === null) {
    // Evaluated once: a retry after a crash keeps the first values (`$now()` stays stable).
    try {
      const value = (await render(vars, await buildContext(r, []), noSecrets)).value;
      await exec('UPDATE runs SET vars = ? WHERE id = ? AND vars IS NULL', JSON.stringify(value ?? {}), runId);
      r = await getRunRow(runId);
    } catch (err) {
      const message = `Variables could not be evaluated: ${errorMessage(err)}`;
      await addLog(runId, message, 'error');
      await updateRun(runId, { status: 'FAILURE', statusLabel: message.slice(0, 200) });
      return;
    }
  }
  const defs = stepDefs(r);
  // Step rows and the run deadline are created atomically; a retry after a crash finds the rows and only advances.
  await tx(async (d) => {
    const existing = new Set((await d.query<{ step_id: string }>('SELECT step_id FROM run_steps WHERE run_id = ?', [runId])).rows.map((x) => x.step_id));
    for (const [i, s] of defs.entries())
      if (!existing.has(s.id))
        await d.query("INSERT INTO run_steps (run_id, step_id, position, name, type, status) VALUES (?, ?, ?, ?, ?, 'PENDING')", [
          runId,
          s.id,
          i,
          s.name || s.id,
          s.type,
        ]);
    await d.query('UPDATE runs SET deadline_at = ? WHERE id = ? AND deadline_at IS NULL', [
      runDeadline(defs, r.started_at ? Date.parse(r.started_at) : Date.now()),
      runId,
    ]);
    if (!existing.size) await addLog(runId, `Workflow started: ${defs.length} step(s)`, 'info', null, d);
  });
  await advance(runId);
}

// ---------- graph progression ----------
export async function advance(runId: string): Promise<void> {
  const r = await getRunRow(runId);
  if (r.status !== 'IN_PROGRESS' || r.cancel_requested) return;
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
      const when = def.when ?? 'success';
      const failedDep = deps.find(
        (d) =>
          d.status === 'CANCELLED' ||
          (d.status === 'SKIPPED' && d.state === BLOCKED) ||
          (d.status === 'FAILURE' &&
            !allowedToFail(
              defs.find((x) => x.id === d.step_id),
              d,
            )),
      );
      if (when === 'success' && failedDep) {
        changed =
          (await setStep(runId, def.id, 'PENDING', { status: 'SKIPPED', status_label: `Skipped: ${failedDep.name} did not succeed`, state: BLOCKED })) ||
          changed;
        continue;
      }
      // when: failure → only after a failure (also one allowed to fail, or upstream of a blocked dependency).
      if (when === 'failure' && !deps.some((d) => d.status === 'FAILURE' || d.status === 'CANCELLED' || (d.status === 'SKIPPED' && d.state === BLOCKED))) {
        if (await setStep(runId, def.id, 'PENDING', { status: 'SKIPPED', status_label: 'Skipped: no dependency failed' })) {
          await addLog(runId, 'Skipped (when: failure, and no dependency failed)', 'info', def.id);
          changed = true;
        }
        continue;
      }
      const refs = casesOf(def);
      if (refs.length) {
        const chosen = (sw: string) => {
          const row = byId.get(sw);
          return row?.status === 'SUCCESS' ? (json<{ case?: string | null }>(row.output, {}).case ?? null) : null;
        };
        if (!refs.some((ref) => chosen(ref.split('.')[0]) === ref.split('.')[1])) {
          const taken = [...new Set(refs.map((ref) => ref.split('.')[0]))].map((sw) => `${sw}: ${chosen(sw) ?? 'none'}`).join(', ');
          if (await setStep(runId, def.id, 'PENDING', { status: 'SKIPPED', status_label: `Branch not taken (${taken})` })) {
            await addLog(runId, `Skipped (branch not taken: ${taken})`, 'info', def.id);
            changed = true;
          }
          continue;
        }
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
      if (def.type === 'switch') {
        changed = (await decideSwitch(r, def, rows)) || changed;
        continue;
      }
      changed = (await startStep(r, def, rows)) || changed;
    }
  }
  await finishOrLabel(runId, defs);
}

/** A switch step is decided by the engine itself (no worker): the first case whose `when` holds, else `default`. */
async function decideSwitch(r: RunRow, def: Extract<Step, { type: 'switch' }>, rows: StepRow[]): Promise<boolean> {
  const ctx = await buildContext(r, rows, def.id);
  let chosen: string | null = null;
  try {
    for (const c of def.cases)
      if (await evaluate(c.when, ctx)) {
        chosen = c.id;
        break;
      }
  } catch (err) {
    const message = `Case error: ${errorMessage(err)}`;
    return complete(r.id, def.id, ['PENDING'], { status: 'FAILURE', statusLabel: message.slice(0, 200), log: message, noAdvance: true });
  }
  chosen ??= def.default ?? null;
  return complete(r.id, def.id, ['PENDING'], {
    status: 'SUCCESS',
    output: { case: chosen },
    statusLabel: chosen ? `Case: ${chosen}` : 'No case matched',
    noAdvance: true,
  });
}

/** PENDING → WAITING_APPROVAL (approval) or QUEUED (others). */
async function startStep(r: RunRow, def: Step, rows: StepRow[]): Promise<boolean> {
  const deadline = later(defaultTimeoutMin(def) * 60_000);
  if (def.type === 'wait' || def.type === 'input') return startWaitingStep(r, def, rows, deadline);
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
    if (ok) {
      await addLog(r.id, `Waiting for ${def.minApprovals} approval(s)`, 'info', def.id);
      void notifyPendingDecision({
        run: r,
        kind: 'approval',
        subjects: def.approvers,
        allowSelf: def.allowSelfApproval,
        stepName: def.name || def.id,
        message,
      }).catch(() => undefined);
    }
    return ok;
  }
  const ok = await setStep(r.id, def.id, 'PENDING', { status: 'QUEUED', status_label: null, next_at: now(), deadline_at: deadline });
  if (ok) wake();
  return ok;
}

type StepPatch = Partial<
  Pick<StepRow, 'status' | 'status_label' | 'output' | 'state' | 'link' | 'next_at' | 'deadline_at' | 'started_at' | 'ended_at' | 'locked_until' | 'worker'>
>;

/**
 * Fencing token of a claimed step: `attempt` grows with every claim, so a worker whose lease was lost and whose step was
 * re-claimed (even by the same process) can no longer write results.
 */
export interface Owner {
  worker: string;
  attempt: number;
}

function stepUpdate(runId: string, stepId: string, from: StepRow['status'] | StepRow['status'][], patch: StepPatch, owner?: Owner) {
  const froms = Array.isArray(from) ? from : [from];
  const keys = Object.keys(patch) as (keyof StepPatch)[];
  const params: SqlValue[] = [...keys.map((k) => (patch[k] ?? null) as string | null), runId, stepId, ...froms];
  if (owner) params.push(owner.worker, owner.attempt);
  return {
    sql: `UPDATE run_steps SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE run_id = ? AND step_id = ? AND status IN (${froms.map(() => '?').join(',')})${owner ? ' AND worker = ? AND attempt = ?' : ''}`,
    params,
  };
}

/** Conditional transition: only applies when the step is still in `from` (one of) and, when given, still owned. */
export async function setStep(runId: string, stepId: string, from: StepRow['status'] | StepRow['status'][], patch: StepPatch, owner?: Owner): Promise<boolean> {
  const { sql, params } = stepUpdate(runId, stepId, from, patch, owner);
  return (await exec(sql, ...params)).changes > 0;
}

/** All steps terminal → finish the run; otherwise show what is going on in the run's status label. */
async function finishOrLabel(runId: string, defs: Step[]) {
  const rows = await loadSteps(runId);
  if (!rows.length) return;
  if (rows.every((s) => isTerminal(s.status))) {
    // A failure handled by a `when: failure` step that succeeded does not fail the run.
    const failed = unhandledFailure(defs, rows);
    const handled = handledFailures(defs, rows);
    let outputs: unknown = Object.fromEntries(rows.filter((s) => s.status === 'SUCCESS' && s.output).map((s) => [s.step_id, json(s.output, null)]));
    let outputsError: string | null = null;
    const r = await getRunRow(runId);
    const templates = runTemplates(r).outputs;
    if (templates) {
      try {
        outputs = (await render(templates, await buildContext(r, rows), noSecrets)).value;
      } catch (err) {
        outputsError = `Run outputs could not be evaluated: ${errorMessage(err)}`;
        await addLog(runId, outputsError, failed ? 'warn' : 'error');
      }
    }
    const fails = !!failed || !!outputsError;
    const link = [...rows].reverse().find((s) => s.link)?.link ?? null;
    const recovered = rows.filter((s) => handled.has(s.step_id)).map((s) => s.name);
    const done = await updateRun(runId, {
      status: fails ? 'FAILURE' : 'SUCCESS',
      statusLabel: failed
        ? `Failed at ${failed.name}`
        : outputsError
          ? outputsError.slice(0, 200)
          : recovered.length
            ? `Recovered: ${recovered.join(', ')}`
            : null,
      result: outputs && typeof outputs === 'object' && Object.keys(outputs).length ? outputs : undefined,
      link,
    });
    if (done) await audit(SYSTEM, fails ? 'run.failed' : 'run.succeeded', runId, failed ? { step: failed.step_id } : {});
    return;
  }
  const waiting = rows.filter((s) => s.status === 'WAITING_APPROVAL').map((s) => s.name);
  const running = rows.filter((s) => ['RUNNING', 'QUEUED', 'WAITING'].includes(s.status)).map((s) => s.name);
  const label = waiting.length ? `Waiting for approval: ${waiting.join(', ')}` : running.length ? `Running: ${running.join(', ')}` : null;
  const r = await one<{ status_label: string | null }>('SELECT status_label FROM runs WHERE id = ?', runId);
  if (r && r.status_label !== label) await updateRun(runId, { statusLabel: label });
}

// ---------- step completion ----------
interface Completion {
  /** SKIPPED: a timeout with `onTimeout: skip`. */
  status: 'SUCCESS' | 'FAILURE' | 'SKIPPED';
  output?: unknown;
  link?: string | null;
  statusLabel?: string | null;
  /** Error text logged before the outcome, only by the call that actually made the transition. */
  log?: string;
  state?: string;
  /** The caller advances the run itself (the engine deciding a switch inside `advance`). */
  noAdvance?: boolean;
}

/** The transition and its log lines commit together; only the caller that wins the conditional update advances the run. */
export async function complete(runId: string, stepId: string, from: StepRow['status'][], c: Completion, owner?: Owner) {
  if (c.status === 'SUCCESS' && c.output !== undefined) {
    const problem = await outputProblem(runId, stepId, c.output);
    if (problem) c = { status: 'FAILURE', statusLabel: problem };
  }
  const { sql, params } = stepUpdate(
    runId,
    stepId,
    from,
    {
      status: c.status,
      status_label: c.statusLabel ?? null,
      ...(c.output !== undefined ? { output: JSON.stringify(c.output) } : {}),
      ...(c.link !== undefined ? { link: c.link } : {}),
      ...(c.state !== undefined ? { state: c.state } : {}),
      ended_at: now(),
      next_at: null,
      locked_until: null,
    },
    owner,
  );
  const row = await tx(async (d) => {
    const { rows } = await d.query<{ type: string; name: string }>(`${sql} RETURNING type, name`, params);
    if (!rows.length) return undefined;
    if (c.log) await addLog(runId, c.log, 'error', stepId, d);
    await addLog(
      runId,
      c.status === 'SUCCESS' ? 'Step succeeded' : `Step ${c.status === 'SKIPPED' ? 'skipped' : 'failed'}${c.statusLabel ? `: ${c.statusLabel}` : ''}`,
      c.status === 'FAILURE' ? 'error' : c.status === 'SKIPPED' ? 'warn' : 'info',
      stepId,
      d,
    );
    return rows[0];
  });
  if (row === undefined) return false;
  metrics.stepFinished(row.type, c.status);
  await emit({
    type: 'step.finished',
    blueprint: null,
    data: { runId, stepId, name: row.name, stepType: row.type, status: c.status, statusLabel: c.statusLabel ?? null, link: c.link ?? null },
  });
  await emitRun(runId, 'run.updated');
  if (!c.noAdvance) await advance(runId);
  return true;
}

/** A failed attempt: retry with exponential backoff while attempts remain (and the error is retryable). */
export async function failStep(runId: string, stepId: string, message: string, retryable: boolean, secrets: string[] = [], owner?: Owner) {
  const r = await getRunRow(runId);
  const def = stepDefs(r).find((d) => d.id === stepId);
  const row = await one<StepRow>('SELECT * FROM run_steps WHERE run_id = ? AND step_id = ?', runId, stepId);
  if (!def || !row) return;
  const text = redact(message, secrets);
  if (retryable && Number(row.attempt) <= def.retries) {
    const delay = def.retryDelaySeconds * 2 ** (Number(row.attempt) - 1);
    const label = `Retrying in ${delay}s (attempt ${Number(row.attempt) + 1}/${def.retries + 1})`;
    const { sql, params } = stepUpdate(
      runId,
      stepId,
      'RUNNING',
      { status: 'QUEUED', status_label: label, next_at: later(delay * 1000), locked_until: null, state: null },
      owner,
    );
    await tx(async (d) => {
      if (!(await d.query(sql, params)).changes) return;
      await addLog(runId, text, 'error', stepId, d);
      await addLog(runId, label, 'warn', stepId, d);
    });
    return;
  }
  await complete(runId, stepId, ['RUNNING', 'QUEUED'], { status: 'FAILURE', statusLabel: text.slice(0, 200), log: text }, owner);
}

// ---------- execution (workers) ----------
async function invokeEnv(r: RunRow, def: Extract<Step, { type: 'invoke' }>, rows: StepRow[], it?: Iteration) {
  const ctx = withIteration(await buildContext(r, rows, def.id), it);
  const { value, secrets } = await render(def.invoker, ctx, resolverFor(r));
  secrets.push(ctx.run.callback.token);
  const env: InvokeEnv = { ctx, config: value as Record<string, unknown>, log: stepLog(r.id, def.id, secrets) };
  return { env, secrets };
}

async function applyInvokeResult(runId: string, stepId: string, res: InvokeResult, polls: boolean, secrets: string[] = [], owner?: Owner, loopRow?: StepRow) {
  // Whatever the external system echoed back (webhook answers, job output) is stored: mask the secrets it may contain.
  res = { ...res, result: redactDeep(res.result, secrets), statusLabel: res.statusLabel == null ? res.statusLabel : redact(res.statusLabel, secrets) };
  if (loopRow) return applyLoopResult(runId, stepId, loopRow, res, polls);
  if (res.status === 'SUCCESS' || res.status === 'FAILURE')
    return complete(runId, stepId, ['RUNNING'], { status: res.status, output: res.result ?? null, link: res.link, statusLabel: res.statusLabel }, owner);
  const ok = await setStep(
    runId,
    stepId,
    'RUNNING',
    {
      state: JSON.stringify(res.state ?? {}),
      status_label: res.statusLabel ?? null,
      ...(res.link !== undefined ? { link: res.link } : {}),
      locked_until: null,
      next_at: polls ? later(config.RUN_POLL_SECONDS * 1000) : null,
    },
    owner,
  );
  if (ok && (res.link !== undefined || res.statusLabel !== undefined)) await emitRun(runId, 'run.updated');
}

/** True when the run was cancelled or finished (or is being cancelled): steps must not start or continue. */
async function runStopped(runId: string) {
  const r = await one<{ status: string; cancel_requested: number }>('SELECT status, cancel_requested FROM runs WHERE id = ?', runId);
  return !r || r.status !== 'IN_PROGRESS' || !!Number(r.cancel_requested);
}

/**
 * Renew the step lease while it executes (every third of the lease, at most every 15 s). Calls `onLost` when the lease
 * cannot be renewed (the step was re-claimed, failed by housekeeping or cancelled) or the run was cancelled, so the
 * executor stops instead of running twice or billing for a cancelled run. Transient database errors are retried at the
 * next beat. Returns the stop function.
 */
function startHeartbeat(runId: string, stepId: string, owner: Owner, leaseMs: number, onLost: () => void) {
  let stopped = false;
  const beat = async () => {
    try {
      const { changes } = await exec(
        "UPDATE run_steps SET locked_until = ? WHERE run_id = ? AND step_id = ? AND status = 'RUNNING' AND worker = ? AND attempt = ? AND locked_until IS NOT NULL",
        later(leaseMs),
        runId,
        stepId,
        owner.worker,
        owner.attempt,
      );
      if (!stopped && (!changes || (await runStopped(runId)))) {
        stop();
        onLost();
      }
    } catch {
      // transient database error: the lease has two more beats of slack
    }
  };
  const timer = setInterval(() => void beat(), Math.max(50, Math.min(leaseMs / 3, 15_000)));
  const stop = () => {
    stopped = true;
    clearInterval(timer);
  };
  return stop;
}

/** Per-team Claude credential: a secret named `anthropic-api-key-<team>` (used when the step sets no apiKey). */
async function teamApiKey(team: string | null): Promise<string | undefined> {
  if (!team) return undefined;
  const name = `anthropic-api-key-${team}`;
  if (!(await one('SELECT name FROM secrets WHERE name = ?', name))) return undefined;
  return resolveRef('secret', name);
}

async function executeAgent(
  r: RunRow,
  rows: StepRow[],
  def: Extract<Step, { type: 'agent' }>,
  setSecrets: (s: string[]) => void,
  signal?: AbortSignal,
  it?: Iteration,
) {
  const ctx = withIteration(await buildContext(r, rows, def.id), it);
  // Text sent to the model: interpolated values are fenced as untrusted data and secrets cannot be referenced.
  const text = await render({ prompt: def.prompt, system: def.system }, ctx, resolverFor(r), { wrap: (t, expr) => wrapUntrusted(t, expr), noRefs: true });
  const creds = await render({ apiKey: def.apiKey ?? '', mcpTokens: def.mcpServers.map((s) => s.token ?? '') }, ctx, resolverFor(r));
  const secrets = [...creds.secrets];
  setSecrets(secrets);
  const v = text.value as { prompt: unknown; system?: unknown };
  const c = creds.value as { apiKey?: unknown; mcpTokens?: unknown[] };
  const user = await getUser(r.triggered_by);
  if (!user) throw new StepError('The user who started this run no longer exists', false);
  const principal = await principalOf(user);
  const team = r.team ?? principal.teams[0] ?? null;
  let apiKey = typeof c.apiKey === 'string' && c.apiKey ? c.apiKey : undefined;
  if (!apiKey && (def.provider ?? config.AI_PROVIDER) === 'anthropic') {
    apiKey = await teamApiKey(team);
    if (apiKey) secrets.push(apiKey);
  }
  return runAgent(
    {
      ...def,
      prompt: typeof v.prompt === 'string' ? v.prompt : JSON.stringify(v.prompt),
      system: typeof v.system === 'string' ? v.system : undefined,
      apiKey,
      mcpTokens: (c.mcpTokens ?? []).map((t) => (typeof t === 'string' ? t : '')),
    },
    stepLog(r.id, def.id, secrets),
    { runId: r.id, stepId: def.id, action: r.action, team: r.team, principal, signal },
  );
}

/** Execute a step the worker just claimed (QUEUED → RUNNING). `owner` is the claim's fencing token. */
export async function executeStep(runId: string, stepId: string, owner: Owner) {
  const r = await getRunRow(runId);
  const def = stepDefs(r).find((d) => d.id === stepId);
  if (!def) return;
  if (r.status !== 'IN_PROGRESS' || r.cancel_requested)
    return void (await setStep(runId, stepId, 'RUNNING', { status: 'CANCELLED', ended_at: now(), locked_until: null }, owner));
  const rows = await loadSteps(runId);
  const row = rows.find((s) => s.step_id === stepId)!;
  await emit({ type: 'step.started', blueprint: null, data: { runId, stepId, name: row.name, stepType: row.type, attempt: Number(row.attempt) } });
  const looping = loopOf(row);
  await addLog(
    runId,
    looping
      ? `Continuing the loop (item ${looping.results.filter(Boolean).length + 1}/${looping.items.length})`
      : `Started${Number(row.attempt) > 1 ? ` (attempt ${row.attempt}/${def.retries + 1})` : ''}`,
    'info',
    stepId,
  );
  await emitRun(runId, 'run.updated');
  let secrets: string[] = [];
  let lost = false;
  const abort = new AbortController();
  const stopBeat = startHeartbeat(runId, stepId, owner, LEASES[def.type] || 60_000, () => {
    lost = true;
    abort.abort();
  });
  try {
    await withSpan('workflow.step', { 'run.id': runId, 'step.id': stepId, 'step.type': def.type }, async () => {
      try {
        if ((def.type === 'invoke' || def.type === 'agent' || def.type === 'transform') && def.forEach) {
          await executeLoop(r, rows, row, def, owner, {
            lost: () => lost,
            signal: abort.signal,
            setSecrets: (s) => (secrets = s),
          });
        } else if (def.type === 'invoke') {
          const inv = getInvoker(def.invoker.type);
          const built = await invokeEnv(r, def, rows);
          secrets = built.secrets;
          const res = await inv.start(built.env);
          stopBeat();
          // The run was cancelled (or the lease lost) while the external call was in flight: stop the job we just started.
          if (lost || (await runStopped(runId))) {
            if (inv.cancel && res.state) {
              await inv.cancel(built.env, res.state).catch((err) => addLog(runId, `Could not cancel the external run: ${errorMessage(err)}`, 'warn', stepId));
              await addLog(runId, 'Cancellation requested from the external system', 'warn', stepId);
            }
            await setStep(runId, stepId, 'RUNNING', { status: 'CANCELLED', ended_at: now(), next_at: null, locked_until: null }, owner);
            return;
          }
          await applyInvokeResult(runId, stepId, res, !!inv.poll, secrets, owner);
        } else if (def.type === 'agent') {
          const result = await executeAgent(r, rows, def, (s) => (secrets = s), abort.signal);
          stopBeat();
          if (lost) return;
          await setStep(runId, stepId, 'RUNNING', { state: JSON.stringify({ usage: result.usage }) }, owner);
          await complete(
            runId,
            stepId,
            ['RUNNING'],
            {
              status: 'SUCCESS',
              output: result.output,
              statusLabel: `${result.usage.model} · ${result.usage.turns} turn(s)${result.usage.costUsd !== null ? ` · $${result.usage.costUsd.toFixed(4)}` : ''}`,
            },
            owner,
          );
        } else if (def.type === 'workflow') {
          stopBeat();
          if (lost) return;
          await startSubWorkflow(r, def, rows);
        } else if (def.type === 'transform') {
          const ctx = await buildContext(r, rows, stepId);
          const output: Record<string, unknown> = {};
          for (const [k, expr] of Object.entries(def.output)) output[k] = await evaluate(expr, ctx);
          await complete(runId, stepId, ['RUNNING'], { status: 'SUCCESS', output }, owner);
        }
      } catch (err) {
        if (lost) return void (await addLog(runId, 'Step stopped: its lease was lost or the run was cancelled', 'warn', stepId));
        // Invokers: an exception during start may have reached the external system → not retried unless declared retryable.
        const retryable = err instanceof StepError ? err.retryable : (def.type !== 'invoke' && def.type !== 'workflow') || def.retries > 0;
        await failStep(runId, stepId, `${def.type === 'invoke' ? 'Invoker' : 'Step'} error: ${errorMessage(err)}`, retryable, secrets, owner);
      }
    });
  } finally {
    stopBeat();
  }
}

/** Poll an IN_PROGRESS invoke step (pipelines, jobs). */
export async function pollStep(runId: string, stepId: string) {
  const r = await getRunRow(runId);
  const def = stepDefs(r).find((d) => d.id === stepId);
  if (!def || def.type !== 'invoke' || r.status !== 'IN_PROGRESS' || r.cancel_requested) return;
  const rows = await loadSteps(runId);
  const row = rows.find((s) => s.step_id === stepId);
  if (!row || row.status !== 'RUNNING') return;
  let secrets: string[] = [];
  try {
    const inv = getInvoker(def.invoker.type);
    if (!inv.poll) return;
    const loop = loopOf(row);
    if (loop && loop.current === undefined) return; // the worker is between two items
    const built = await invokeEnv(r, def, rows, loop ? iterationOf(loop) : undefined);
    secrets = built.secrets;
    const state = loop ? (loop.inner ?? {}) : json<Record<string, unknown>>(row.state, {});
    await applyInvokeResult(runId, stepId, await inv.poll(built.env, state), true, secrets, undefined, loop ? row : undefined);
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

/** Secret values a step was given (rendered invoker config + its callback token): used to mask what it reports back. */
export async function stepSecrets(runId: string, stepId: string): Promise<string[]> {
  try {
    const r = await getRunRow(runId);
    const def = stepDefs(r).find((d) => d.id === stepId);
    if (!def) return [];
    if (def.type === 'invoke') return (await invokeEnv(r, def, await loadSteps(runId))).secrets;
    return [stepToken(runId, stepId)];
  } catch {
    return [stepToken(runId, stepId)];
  }
}

export async function updateStep(runId: string, stepId: string, u: StepUpdate): Promise<boolean> {
  const row = await one<StepRow>('SELECT * FROM run_steps WHERE run_id = ? AND step_id = ?', runId, stepId);
  if (!row || row.status !== 'RUNNING') return false;
  // Loops: a callback reports the item in flight (none while the worker is between two items).
  const loop = loopOf(row);
  if (loop && loop.current === undefined) return false;
  // The external system may echo credentials (a pipeline printing its environment): mask before anything is stored.
  const secrets = await stepSecrets(runId, stepId);
  for (const l of u.logs ?? []) await addLog(runId, redact(l.message, secrets), l.level ?? 'info', stepId);
  u = {
    ...u,
    result: redactDeep(u.result, secrets),
    statusLabel: u.statusLabel == null ? u.statusLabel : redact(u.statusLabel, secrets),
    link: u.link == null ? u.link : redact(u.link, secrets),
  };
  if (loop && (u.status === 'SUCCESS' || u.status === 'FAILURE'))
    return settleLoopItem(runId, stepId, row, { status: u.status, result: u.result, link: u.link ?? undefined, statusLabel: u.statusLabel ?? undefined });
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
export async function decideStep(
  p: Principal,
  runId: string,
  stepId: string,
  decision: 'approved' | 'rejected',
  comment: string,
  extra: { choice?: string; values?: Record<string, unknown> } = {},
) {
  const r = await getRunRow(runId);
  const def = stepDefs(r).find((d) => d.id === stepId);
  const row = await one<StepRow>('SELECT * FROM run_steps WHERE run_id = ? AND step_id = ?', runId, stepId);
  if (!def || !row) throw badRequest(`No step "${stepId}" in this run`);
  if (def.type !== 'approval' || row.status !== 'WAITING_APPROVAL') throw conflict('This step is not waiting for approval');
  const approvals = (await stepApprovalsOf([runId])).get(`${runId}/${stepId}`) ?? [];
  if (!canApproveStep(p, r, def, row, approvals)) throw forbidden('You cannot approve this step');
  if (decision === 'rejected' && !comment.trim()) throw badRequest('Give a reason when rejecting');
  let values: Record<string, unknown> | null = null;
  if (decision === 'approved') {
    if (def.choices?.length && !(extra.choice && def.choices.includes(extra.choice))) throw badRequest(`Choose one of: ${def.choices.join(', ')}`);
    if (def.fields) {
      values = compact(extra.values ?? {});
      validate(def.fields as ObjectSchema, values, 'values');
    }
  }
  // Insert, count and decide under a row lock on the step: concurrent approvers are serialized (see runs.decide).
  const outcome = await tx(async (d) => {
    const cur = (await d.query<{ status: string }>(`SELECT status FROM run_steps WHERE run_id = ? AND step_id = ?${forUpdate}`, [runId, stepId])).rows[0];
    if (cur?.status !== 'WAITING_APPROVAL') throw conflict('This step is not waiting for approval');
    const decided = (
      await d.query<{ user_id: string; user_name: string; decision: string; comment: string }>(
        'SELECT a.user_id, u.name AS user_name, a.decision, a.comment FROM step_approvals a JOIN users u ON u.id = a.user_id WHERE a.run_id = ? AND a.step_id = ? ORDER BY a.at',
        [runId, stepId],
      )
    ).rows;
    if (decided.some((a) => a.user_id === p.id)) throw conflict('You already decided on this step');
    await d.query('INSERT INTO step_approvals (run_id, step_id, user_id, decision, comment, at, choice, form_values) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [
      runId,
      stepId,
      p.id,
      decision,
      comment,
      now(),
      decision === 'approved' ? (extra.choice ?? null) : null,
      values ? JSON.stringify(values) : null,
    ]);
    return [...decided, { user_id: p.id, user_name: p.name, decision, comment }].filter((a) => a.decision === 'approved');
  });
  await addLog(
    runId,
    `${decision === 'approved' ? 'Approved' : 'Rejected'} by ${p.name}${comment ? `: ${comment}` : ''}`,
    decision === 'approved' ? 'info' : 'warn',
    stepId,
  );
  await audit(actorOf(p), `run.step_${decision}`, `${r.action} · ${row.name}`, { runId, step: stepId, comment });
  const approved = outcome;
  if (decision === 'rejected')
    await complete(runId, stepId, ['WAITING_APPROVAL'], {
      status: 'FAILURE',
      statusLabel: `Rejected by ${p.name}`,
      output: { approved: false, by: p.name, comment },
    });
  else if (approved.length >= def.minApprovals)
    await complete(runId, stepId, ['WAITING_APPROVAL'], {
      status: 'SUCCESS',
      statusLabel: `Approved by ${approved.map((a) => a.user_name).join(', ')}`,
      output: {
        approved: true,
        by: approved.map((a) => a.user_name),
        comments: approved.map((a) => a.comment).filter(Boolean),
        ...(await approvalExtras(runId, stepId)),
      },
    });
  else {
    await setStep(runId, stepId, 'WAITING_APPROVAL', { status_label: `${approved.length}/${def.minApprovals} approval(s)` });
    await emitRun(runId, 'run.updated');
  }
}

/** Choice and field values given with the approvals of a step (the last choice wins; values are merged). */
async function approvalExtras(runId: string, stepId: string) {
  const rows = await all<{ choice: string | null; form_values: string | null }>(
    "SELECT choice, form_values FROM step_approvals WHERE run_id = ? AND step_id = ? AND decision = 'approved' ORDER BY at",
    runId,
    stepId,
  );
  const choice = rows
    .map((r) => r.choice)
    .filter(Boolean)
    .pop();
  const values = Object.assign({}, ...rows.map((r) => json<Record<string, unknown>>(r.form_values, {})));
  return { ...(choice ? { choice } : {}), ...(Object.keys(values).length ? { values } : {}) };
}

// ---------- cancellation ----------
/** Best effort: ask the external system to stop a running invoke step (pipeline, job). */
async function cancelExternal(r: RunRow, row: StepRow) {
  const def = stepDefs(r).find((d) => d.id === row.step_id);
  if (row.status !== 'RUNNING' || def?.type !== 'invoke' || !row.state) return;
  const loop = loopOf(row);
  if (loop && !loop.inner) return; // no item in flight
  try {
    const inv = getInvoker(def.invoker.type);
    if (!inv.cancel) return;
    const { env } = await invokeEnv(r, def, await loadSteps(r.id), loop ? iterationOf(loop) : undefined);
    await inv.cancel(env, loop ? loop.inner! : json(row.state, {}));
    await addLog(r.id, 'Cancellation requested from the external system', 'warn', row.step_id);
  } catch (err) {
    await addLog(r.id, `Could not cancel the external run: ${errorMessage(err)}`, 'warn', row.step_id);
  }
}

export async function cancelSteps(r: RunRow) {
  for (const row of await loadSteps(r.id)) {
    if (isTerminal(row.status)) continue;
    await cancelExternal(r, row);
    await cancelChildrenOf(row);
    await setStep(r.id, row.step_id, ['PENDING', 'QUEUED', 'RUNNING', 'WAITING_APPROVAL', 'WAITING'], {
      status: 'CANCELLED',
      ended_at: now(),
      next_at: null,
      locked_until: null,
    });
  }
}

// ---------- inline loops (forEach on invoke, agent and transform steps) ----------
/**
 * The progress of a loop lives in the step `state` (`{"forEach": …}`), so it survives workers:
 *  - transform: every item in one execution; agent: items in parallel (maxConcurrency) in one execution, under the
 *    step lease (its heartbeat stops the loop when the lease is lost);
 *  - invoke: one item at a time. Items that finish at once are chained in the same execution; an item that goes on
 *    (poll or callback) parks the step with the item's invoker state in `inner`. When it ends, the step goes back to
 *    QUEUED (compare-and-set on the state) and the next claim (a new fencing token) starts the next item.
 */
const MAX_LOOP_ITEMS = 200;
const LOOP_PREFIX = '{"forEach":';
type LoopStep = Extract<Step, { type: 'invoke' | 'agent' | 'transform' }>;
interface LoopItem {
  item: unknown;
  status: 'SUCCESS' | 'FAILURE' | 'SKIPPED';
  output: unknown;
  error?: string;
  link?: string;
}
interface LoopState {
  items: unknown[];
  results: (LoopItem | null)[];
  /** Invoke: the item in flight and its invoker state. */
  current?: number;
  inner?: Record<string, unknown>;
  failFast?: boolean;
}
const loopOf = (row: Pick<StepRow, 'state'>): LoopState | undefined =>
  row.state?.startsWith(LOOP_PREFIX) ? json<{ forEach?: LoopState }>(row.state, {}).forEach : undefined;
const loopState = (l: LoopState) => JSON.stringify({ forEach: l });
const iterationOf = (l: LoopState): Iteration => ({ item: l.items[l.current ?? 0], index: l.current ?? 0 });
const loopFailed = (l: LoopState) => l.results.some((x) => x?.status === 'FAILURE');
const loopDone = (l: LoopState) => l.results.every(Boolean) || (!!l.failFast && loopFailed(l));

function loopOutcome(l: LoopState): Completion {
  const results = l.items.map((item, i) => l.results[i] ?? { item, status: 'SKIPPED' as const, output: null });
  const succeeded = results.filter((x) => x.status === 'SUCCESS').length;
  const failed = results.filter((x) => x.status === 'FAILURE').length;
  return {
    status: failed ? 'FAILURE' : 'SUCCESS',
    output: { results, succeeded, failed },
    statusLabel: failed ? `${failed} of ${results.length} item(s) failed${l.failFast ? ' (fail fast)' : ''}` : `${succeeded} item(s) succeeded`,
  };
}

interface LoopControl {
  lost: () => boolean;
  signal: AbortSignal;
  setSecrets: (s: string[]) => void;
}

async function executeLoop(r: RunRow, rows: StepRow[], row: StepRow, def: LoopStep, owner: Owner, ctl: LoopControl) {
  let loop = loopOf(row);
  if (!loop) {
    const value = await evaluate(def.forEach!.items, await buildContext(r, rows, def.id));
    const items = value === undefined || value === null ? [] : Array.isArray(value) ? value : [value];
    if (items.length > MAX_LOOP_ITEMS) throw new StepError(`The list has ${items.length} items; loops are limited to ${MAX_LOOP_ITEMS}`, false);
    loop = { items, results: items.map(() => null), failFast: !!def.forEach!.failFast };
    await addLog(r.id, `Looping over ${items.length} item(s)`, 'info', def.id);
  }
  const l = loop;
  const failure = (i: number, err: unknown): LoopItem => ({ item: l.items[i], status: 'FAILURE', output: null, error: errorMessage(err).slice(0, 500) });
  if (def.type === 'transform') {
    const ctx = await buildContext(r, rows, def.id);
    for (let i = 0; i < l.items.length && !loopDone(l); i++) {
      if (l.results[i]) continue;
      try {
        const output: Record<string, unknown> = {};
        const itemCtx = withIteration(ctx, { item: l.items[i], index: i });
        for (const [k, expr] of Object.entries(def.output)) output[k] = await evaluate(expr, itemCtx);
        l.results[i] = { item: l.items[i], status: 'SUCCESS', output };
      } catch (err) {
        l.results[i] = failure(i, err);
      }
    }
  } else if (def.type === 'agent') {
    const secrets = new Set<string>();
    let next = 0;
    const lane = async () => {
      for (;;) {
        if (ctl.lost() || loopDone(l)) return;
        const i = next++;
        if (i >= l.items.length) return;
        if (l.results[i]) continue;
        try {
          const res = await executeAgent(r, rows, def, (s) => s.forEach((x) => secrets.add(x)), ctl.signal, { item: l.items[i], index: i });
          l.results[i] = { item: l.items[i], status: 'SUCCESS', output: res.output };
        } catch (err) {
          if (!ctl.lost()) l.results[i] = failure(i, redact(errorMessage(err), [...secrets]));
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(def.forEach!.maxConcurrency ?? 1, Math.max(l.items.length, 1)) }, lane));
    ctl.setSecrets([...secrets]);
  } else {
    const inv = getInvoker(def.invoker.type);
    for (let i = 0; i < l.items.length && !loopDone(l); i++) {
      if (l.results[i]) continue;
      if (ctl.lost() || (await runStopped(r.id))) return;
      const it = { item: l.items[i], index: i };
      const built = await invokeEnv(r, def, rows, it);
      ctl.setSecrets(built.secrets);
      let res: InvokeResult;
      try {
        res = await inv.start(built.env);
      } catch (err) {
        // The call may have reached the external system: the item fails, it is not started again.
        l.results[i] = failure(i, redact(errorMessage(err), built.secrets));
        continue;
      }
      res = {
        ...res,
        result: redactDeep(res.result, built.secrets),
        statusLabel: res.statusLabel == null ? res.statusLabel : redact(res.statusLabel, built.secrets),
      };
      if (res.status !== 'IN_PROGRESS') {
        l.results[i] = {
          item: l.items[i],
          status: res.status,
          output: res.result ?? null,
          ...(res.status === 'FAILURE' ? { error: res.statusLabel ?? 'Failed' } : {}),
          ...(res.link ? { link: res.link } : {}),
        };
        continue;
      }
      if (ctl.lost() || (await runStopped(r.id))) {
        if (inv.cancel && res.state) await inv.cancel(built.env, res.state).catch(() => undefined);
        await setStep(r.id, def.id, 'RUNNING', { status: 'CANCELLED', ended_at: now(), next_at: null, locked_until: null }, owner);
        return;
      }
      // Park on this item: polls or the callback settle it (settleLoopItem).
      const ok = await setStep(
        r.id,
        def.id,
        'RUNNING',
        {
          state: loopState({ ...l, current: i, inner: res.state ?? {} }),
          status_label: `Item ${i + 1}/${l.items.length}${res.statusLabel ? `: ${res.statusLabel}` : ''}`,
          ...(res.link !== undefined ? { link: res.link } : {}),
          locked_until: null,
          next_at: inv.poll ? later(config.RUN_POLL_SECONDS * 1000) : null,
        },
        owner,
      );
      if (ok) await emitRun(r.id, 'run.updated');
      return;
    }
  }
  if (ctl.lost()) return;
  await complete(r.id, def.id, ['RUNNING'], { ...loopOutcome(l), state: loopState(l) }, owner);
}

/** A poll of the item in flight: still going (keep its invoker state) or done (settle it). */
async function applyLoopResult(runId: string, stepId: string, row: StepRow, res: InvokeResult, polls: boolean) {
  if (res.status === 'SUCCESS' || res.status === 'FAILURE')
    return settleLoopItem(runId, stepId, row, { status: res.status, result: res.result, link: res.link, statusLabel: res.statusLabel });
  const loop = loopOf(row)!;
  await exec(
    'UPDATE run_steps SET state = ?, status_label = ?, next_at = ? WHERE run_id = ? AND step_id = ? AND status = ? AND state = ?',
    loopState({ ...loop, inner: res.state ?? loop.inner ?? {} }),
    `Item ${(loop.current ?? 0) + 1}/${loop.items.length}${res.statusLabel ? `: ${res.statusLabel}` : ''}`,
    polls ? later(config.RUN_POLL_SECONDS * 1000) : null,
    runId,
    stepId,
    'RUNNING',
    row.state,
  );
}

/**
 * The item in flight ended (poll or callback). Compare-and-set on the state: a stale poll or a duplicate callback
 * cannot settle an item twice. Then finish the loop, or hand the step back to the workers for the next item.
 */
async function settleLoopItem(
  runId: string,
  stepId: string,
  row: StepRow,
  res: { status: 'SUCCESS' | 'FAILURE'; result?: unknown; link?: string; statusLabel?: string },
): Promise<boolean> {
  const loop = loopOf(row);
  if (!loop || loop.current === undefined) return false;
  const i = loop.current;
  const next: LoopState = { items: loop.items, results: [...loop.results], failFast: loop.failFast };
  next.results[i] = {
    item: loop.items[i],
    status: res.status,
    output: res.result ?? null,
    ...(res.status === 'FAILURE' ? { error: res.statusLabel ?? 'Failed' } : {}),
    ...(res.link ? { link: res.link } : {}),
  };
  const state = loopState(next);
  const { changes } = await exec(
    'UPDATE run_steps SET state = ? WHERE run_id = ? AND step_id = ? AND status = ? AND state = ?',
    state,
    runId,
    stepId,
    'RUNNING',
    row.state,
  );
  if (!changes) return false;
  await addLog(
    runId,
    `Item ${i + 1}/${loop.items.length} ${res.status === 'SUCCESS' ? 'succeeded' : 'failed'}`,
    res.status === 'SUCCESS' ? 'info' : 'error',
    stepId,
  );
  if (loopDone(next)) return complete(runId, stepId, ['RUNNING'], loopOutcome(next));
  const requeued = await exec(
    "UPDATE run_steps SET status = 'QUEUED', next_at = ?, locked_until = NULL, status_label = ? WHERE run_id = ? AND step_id = ? AND status = 'RUNNING' AND state = ?",
    now(),
    `${next.results.filter(Boolean).length}/${next.items.length} item(s) done`,
    runId,
    stepId,
    state,
  );
  if (requeued.changes) {
    wake();
    await emitRun(runId, 'run.updated');
  }
  return requeued.changes > 0;
}

// ---------- worker loops ----------
/** Lease of a claimed step by type. Renewed by the executor's heartbeat; mutable so tests can shorten it. */
export const LEASES: Record<Step['type'], number> = {
  invoke: 5 * 60_000,
  agent: 15 * 60_000,
  transform: 60_000,
  approval: 0,
  wait: 0,
  input: 0,
  workflow: 2 * 60_000,
  switch: 0,
};

// Postgres: concurrent replicas skip rows another claim already locked instead of queueing behind or racing for them.
const skipLocked = dialect === 'postgres' ? ' FOR UPDATE SKIP LOCKED' : '';

/** Claim up to `limit` QUEUED runs in one statement (QUEUED → IN_PROGRESS) and start their workflows through `spawn`. */
export async function claimRuns(worker: string, limit: number, spawn: (fn: () => Promise<void>) => void) {
  if (limit <= 0) return 0;
  const t = now();
  const { rows } = await driver.query<{ id: string }>(
    `WITH picked AS MATERIALIZED (SELECT id FROM runs WHERE status = 'QUEUED' ORDER BY created_at LIMIT ?${skipLocked})
     UPDATE runs SET status = 'IN_PROGRESS', worker = ?, started_at = ?, updated_at = ?
     WHERE status = 'QUEUED' AND id IN (SELECT id FROM picked) RETURNING id`,
    [limit, worker, t, t],
  );
  for (const { id } of rows) spawn(() => inRunOrg(id, () => initRun(id)));
  return rows.length;
}

/** Claim up to `slots` due QUEUED steps in one statement (QUEUED → RUNNING with a lease) and execute them through `spawn`. */
export async function claimSteps(worker: string, slots: number, spawn: (fn: () => Promise<void>) => void) {
  if (slots <= 0) return 0;
  const t = now();
  const { rows } = await driver.query<StepRow>(
    `WITH picked AS MATERIALIZED (
       SELECT run_id, step_id FROM run_steps WHERE status = 'QUEUED' AND (next_at IS NULL OR next_at <= ?)
       ORDER BY next_at NULLS FIRST LIMIT ?${skipLocked})
     UPDATE run_steps SET status = 'RUNNING', attempt = attempt + 1, worker = ?,
       locked_until = CASE type WHEN 'agent' THEN ? WHEN 'transform' THEN ? ELSE ? END,
       started_at = COALESCE(started_at, ?), next_at = NULL, status_label = NULL
     WHERE status = 'QUEUED' AND (run_id, step_id) IN (SELECT run_id, step_id FROM picked) RETURNING *`,
    [t, slots, worker, later(LEASES.agent), later(LEASES.transform), later(LEASES.invoke), t],
  );
  for (const s of rows) spawn(() => inRunOrg(s.run_id, () => executeStep(s.run_id, s.step_id, { worker, attempt: Number(s.attempt) })));
  return rows.length;
}

/** Poll due RUNNING invoke steps (claimed in one statement by moving next_at forward). */
export async function claimPolls(slots: number, spawn: (fn: () => Promise<void>) => void) {
  if (slots <= 0) return 0;
  const { rows } = await driver.query<{ run_id: string; step_id: string }>(
    `WITH picked AS MATERIALIZED (
       SELECT run_id, step_id FROM run_steps WHERE status = 'RUNNING' AND next_at IS NOT NULL AND next_at <= ?
       ORDER BY next_at LIMIT ?${skipLocked})
     UPDATE run_steps SET next_at = ?
     WHERE status = 'RUNNING' AND next_at IS NOT NULL AND (run_id, step_id) IN (SELECT run_id, step_id FROM picked) RETURNING run_id, step_id`,
    [now(), slots, later(5 * 60_000)],
  );
  for (const s of rows) spawn(() => inRunOrg(s.run_id, () => pollStep(s.run_id, s.step_id)));
  return rows.length;
}

/**
 * End a run that is still IN_PROGRESS from outside its workflow (run deadline, interrupted cancellation): stop its
 * steps (asking external systems to stop) and set the final status. Idempotent; the conditional update picks one winner.
 */
async function terminateRun(runId: string, status: 'FAILURE' | 'CANCELLED', label: string | null, message: string) {
  const r = await getRunRow(runId);
  if (r.status !== 'IN_PROGRESS') return false;
  await cancelSteps(r);
  const t = now();
  const { changes } = await exec(
    "UPDATE runs SET status = ?, status_label = ?, ended_at = ?, updated_at = ?, next_poll_at = NULL WHERE id = ? AND status = 'IN_PROGRESS'",
    status,
    label,
    t,
    t,
    runId,
  );
  if (!changes) return false;
  await addLog(runId, message, status === 'FAILURE' ? 'error' : 'warn');
  await audit(SYSTEM, status === 'FAILURE' ? 'run.timed_out' : 'run.cancelled', runId, {});
  metrics.runFinished(r.action, status, 'workflow', r.started_at ? (Date.now() - Date.parse(r.started_at)) / 1000 : null);
  await emitRun(runId, 'run.updated');
  return true;
}

/**
 * What a passed step deadline does (`onTimeout`): fail (default), skip (SKIPPED, not blocking its dependents) or
 * continue (FAILURE that does not fail the run, like continueOnError).
 * Hook: an approval step's own expiry policy (`onExpiry`), when set, takes precedence over `onTimeout` for
 * WAITING_APPROVAL steps: return its outcome here first.
 */
export function timeoutOutcome(def: Step | undefined, row: Pick<StepRow, 'status' | 'state'>): Completion {
  const label = row.status === 'WAITING_APPROVAL' ? 'Approval expired' : 'Timed out';
  switch (def?.onTimeout ?? 'fail') {
    case 'skip':
      return { status: 'SKIPPED', statusLabel: `${label}: skipped`, state: timedOutState(row.state, 'skip') };
    case 'continue':
      return { status: 'FAILURE', statusLabel: `${label}: continuing`, state: timedOutState(row.state, 'continue') };
    default:
      return { status: 'FAILURE', statusLabel: label };
  }
}

const HOUSEKEEPING_LOCK = 726204;
const BATCH = 100;

/**
 * Recovery and timeouts. One replica per period (advisory lock); every query is bounded and index-backed, and it only
 * visits work that is actually due: stale leases, passed deadlines, interrupted cancellations and runs that nothing is
 * driving anymore. Healthy in-flight runs (including ones waiting days for an approval) are not touched.
 */
export async function stepHousekeeping(log: FastifyBaseLogger) {
  await tryAdvisoryLock(HOUSEKEEPING_LOCK, async () => {
    const t = now();
    // Every action runs in the organization of its run (the scans themselves span organizations).
    const guard = (what: string, runId: string, fn: () => Promise<unknown>) => inRunOrg(runId, fn).catch((err) => log.error({ err, runId }, what));
    // A worker died (or lost its database) while executing a step: invokers may have called the external system →
    // failed, not retried. The fencing token keeps a step that was re-claimed meanwhile untouched.
    for (const s of await all<StepRow>(
      `SELECT * FROM run_steps WHERE status = 'RUNNING' AND locked_until IS NOT NULL AND locked_until < ? AND (state IS NULL OR state LIKE '${LOOP_PREFIX}%') LIMIT ?`,
      t,
      BATCH,
    ))
      await guard('step recovery', s.run_id, () =>
        failStep(
          s.run_id,
          s.step_id,
          'The worker executing this step stopped before it finished',
          s.type !== 'invoke',
          [],
          s.worker ? { worker: s.worker, attempt: Number(s.attempt) } : undefined,
        ),
      );
    // Step timeouts (running steps and approvals). Only the replica winning the transition cancels the external job.
    for (const s of await all<StepRow>(
      "SELECT * FROM run_steps WHERE status IN ('QUEUED', 'RUNNING', 'WAITING_APPROVAL', 'WAITING') AND deadline_at IS NOT NULL AND deadline_at < ? LIMIT ?",
      t,
      BATCH,
    ))
      await guard('step timeout', s.run_id, async () => {
        const def = stepDefs(await getRunRow(s.run_id)).find((d) => d.id === s.step_id);
        const won = await complete(s.run_id, s.step_id, ['RUNNING', 'WAITING_APPROVAL', 'QUEUED', 'WAITING'], timeoutOutcome(def, s));
        if (won) await cancelChildrenOf(s);
        const r = won && s.status === 'RUNNING' ? await getRunRow(s.run_id).catch(() => undefined) : undefined;
        if (r) await cancelExternal(r, s);
      });
    // Run deadline (RUN_TIMEOUT_HOURS): claim by setting cancel_requested so workers stop at once, then terminate.
    for (const r of await all<{ id: string }>(
      "SELECT id FROM runs WHERE status = 'IN_PROGRESS' AND deadline_at IS NOT NULL AND deadline_at < ? AND cancel_requested = 0 LIMIT ?",
      t,
      BATCH,
    ))
      await guard('run deadline', r.id, async () => {
        const { changes } = await exec(
          "UPDATE runs SET cancel_requested = 1, updated_at = ? WHERE id = ? AND status = 'IN_PROGRESS' AND cancel_requested = 0",
          t,
          r.id,
        );
        if (changes)
          await terminateRun(r.id, 'FAILURE', 'Timed out', `The run exceeded its time limit (RUN_TIMEOUT_HOURS=${config.RUN_TIMEOUT_HOURS}) and was stopped`);
      });
    // A cancellation or deadline stop whose requester died half way: finish it.
    for (const r of await all<{ id: string; deadline_at: string | null }>(
      "SELECT id, deadline_at FROM runs WHERE status = 'IN_PROGRESS' AND cancel_requested = 1 AND updated_at < ? LIMIT ?",
      later(-60_000),
      BATCH,
    ))
      await guard('cancel recovery', r.id, () =>
        r.deadline_at && r.deadline_at < t
          ? terminateRun(r.id, 'FAILURE', 'Timed out', `The run exceeded its time limit (RUN_TIMEOUT_HOURS=${config.RUN_TIMEOUT_HOURS}) and was stopped`)
          : terminateRun(r.id, 'CANCELLED', null, 'Cancellation completed'),
      );
    // Runs that nothing drives anymore: no steps yet (start interrupted) or no active step (a transition's follow-up
    // was interrupted, or the workflow completed without being finalized).
    for (const r of await all<{ id: string; n: number }>(
      `SELECT r.id, (SELECT count(*) FROM run_steps s WHERE s.run_id = r.id) AS n FROM runs r
       WHERE r.status = 'IN_PROGRESS' AND r.cancel_requested = 0 AND r.started_at < ?
         AND NOT EXISTS (SELECT 1 FROM run_steps s WHERE s.run_id = r.id AND s.status IN ('QUEUED', 'RUNNING', 'WAITING_APPROVAL', 'WAITING')) LIMIT ?`,
      later(-60_000),
      BATCH,
    ))
      await guard('run recovery', r.id, () => (Number(r.n) === 0 ? initRun(r.id) : advance(r.id)));
  });
}

export type { InvokerConfig };
