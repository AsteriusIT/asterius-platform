import type { ApprovalPolicy, Run, RunApproval, RunLog, RunPage, RunStatus } from '@asterius/shared';
import { config } from '../config.js';
import { all, forUpdate, json, newId, now, one, run, tx, type Driver, type SqlValue } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { emit } from '../events.js';
import { audit } from '../audit.js';
import { actorOf, isAdmin, matchesSubjects, type Principal } from '../auth/users.js';
import { getEntity } from '../catalog/entities.js';
import { compact, validate } from '../catalog/validation.js';
import { canTrigger, getAction } from './actions.js';
import { metrics } from '../metrics.js';
import { wake } from './wake.js';
import { canApproveStep, loadSteps, runStepsView, stepApprovalsOf, stepDefs, stepMessage } from './steps.js';

/**
 * Run lifecycle:
 *   trigger → PENDING_APPROVAL (approval required) → QUEUED → IN_PROGRESS (workflow steps, engine.ts) → SUCCESS | FAILURE
 *                      └→ REJECTED                       └→ CANCELLED (by the requester or an admin)
 * Transitions are conditional UPDATEs on the current status, so concurrent API/worker replicas never
 * apply two transitions to the same run.
 */

export const FINAL: RunStatus[] = ['SUCCESS', 'FAILURE', 'REJECTED', 'CANCELLED'];

export interface RunRow {
  id: string;
  action: string;
  action_title: string;
  blueprint: string | null;
  entity: string | null;
  inputs: string;
  status: RunStatus;
  status_label: string | null;
  link: string | null;
  result: string | null;
  invoker: string;
  /** Snapshot of the workflow at trigger time. */
  steps: string | null;
  approval: string;
  state: string | null;
  triggered_by: string;
  team: string | null;
  worker: string | null;
  locked_until: string | null;
  next_poll_at: string | null;
  /** Run-level deadline (set when the workflow starts); housekeeping fails the run after it. */
  deadline_at: string | null;
  /** Set first by a cancel request, so workers stop starting/continuing steps while the cancellation completes. */
  cancel_requested: number;
  idempotency_key: string | null;
  created_at: string;
  started_at: string | null;
  ended_at: string | null;
  user_name?: string;
  user_email?: string;
}

const SELECT = 'SELECT r.*, u.name AS user_name, u.email AS user_email FROM runs r JOIN users u ON u.id = r.triggered_by';

async function approvalsOf(runIds: string[]): Promise<Map<string, RunApproval[]>> {
  const out = new Map<string, RunApproval[]>();
  if (!runIds.length) return out;
  const rows = await all<{ run_id: string; user_id: string; name: string; decision: RunApproval['decision']; comment: string; at: string }>(
    `SELECT a.run_id, a.user_id, u.name, a.decision, a.comment, a.at FROM run_approvals a JOIN users u ON u.id = a.user_id
     WHERE a.run_id IN (${runIds.map(() => '?').join(',')}) ORDER BY a.at`,
    ...runIds,
  );
  for (const r of rows) {
    const list = out.get(r.run_id) ?? [];
    list.push({ userId: r.user_id, userName: r.name, decision: r.decision, comment: r.comment, at: r.at });
    out.set(r.run_id, list);
  }
  return out;
}

const toRun = (r: RunRow, approvals: RunApproval[]): Run => ({
  id: r.id,
  action: r.action,
  actionTitle: r.action_title,
  blueprint: r.blueprint,
  entity: r.entity,
  inputs: json(r.inputs, {}),
  status: r.status,
  statusLabel: r.status_label,
  link: r.link,
  triggeredBy: { id: r.triggered_by, name: r.user_name ?? '', email: r.user_email ?? '' },
  approvals,
  result: json(r.result, null),
  createdAt: r.created_at,
  startedAt: r.started_at,
  endedAt: r.ended_at,
});

/** Approvers default to admins when the policy names nobody. */
const approversOf = (policy: ApprovalPolicy) => {
  const a = policy.approvers;
  return a && (a.roles?.length || a.teams?.length || a.users?.length || a.ownerTeam) ? a : { roles: ['admin' as const] };
};

export function canApprove(p: Principal, r: RunRow, approvals: RunApproval[]) {
  if (r.status !== 'PENDING_APPROVAL') return false;
  const policy = json<ApprovalPolicy>(r.approval, { required: false });
  if (!policy.allowSelfApproval && r.triggered_by === p.id) return false;
  if (approvals.some((a) => a.userId === p.id)) return false;
  return matchesSubjects(p, approversOf(policy), r.team);
}

const canCancel = (p: Principal, r: RunRow) => !FINAL.includes(r.status) && (isAdmin(p) || r.triggered_by === p.id);

export async function getRunRow(id: string) {
  const r = await one<RunRow>(`${SELECT} WHERE r.id = ?`, id);
  if (!r) throw notFound('Run');
  return r;
}

const LOG_COLUMNS = 'seq, at, level, message, step_id AS "stepId"';
const LOG_TAIL = 1000;

/**
 * A run with its steps and log lines. Logs are bounded: the newest LOG_TAIL lines, or only the lines past `after`
 * (sequence number) for incremental polling. `GET /runs/:id/logs` pages through the whole log.
 */
export async function getRun(id: string, p: Principal, opts: { after?: number } = {}): Promise<Run> {
  const r = await getRunRow(id);
  const approvals = (await approvalsOf([id])).get(id) ?? [];
  let logs: RunLog[];
  let logsTruncated = false;
  if (opts.after !== undefined)
    logs = await all<RunLog>(`SELECT ${LOG_COLUMNS} FROM run_logs WHERE run_id = ? AND seq > ? ORDER BY seq LIMIT 2000`, id, opts.after);
  else {
    const newest = await all<RunLog>(`SELECT ${LOG_COLUMNS} FROM run_logs WHERE run_id = ? ORDER BY seq DESC LIMIT ?`, id, LOG_TAIL + 1);
    logsTruncated = newest.length > LOG_TAIL;
    logs = newest.slice(0, LOG_TAIL).reverse();
  }
  return { ...toRun(r, approvals), logs, logsTruncated, steps: await runStepsView(r, p), canApprove: canApprove(p, r, approvals), canCancel: canCancel(p, r) };
}

/** One page of a run's log, oldest first: continue with `after = next` while `next` is not null. */
export async function getRunLogs(id: string, q: { after: number; limit: number; step?: string }) {
  await getRunRow(id);
  const rows = await all<RunLog>(
    `SELECT ${LOG_COLUMNS} FROM run_logs WHERE run_id = ? AND seq > ?${q.step ? ' AND step_id = ?' : ''} ORDER BY seq LIMIT ?`,
    id,
    q.after,
    ...(q.step ? [q.step] : []),
    q.limit + 1,
  );
  const items = rows.slice(0, q.limit);
  return { items, next: rows.length > q.limit ? (items[items.length - 1]?.seq ?? null) : null };
}

export interface RunQuery {
  mine?: string;
  status?: RunStatus[];
  action?: string;
  blueprint?: string;
  entity?: string;
  limit: number;
  offset: number;
}

export async function listRuns(q: RunQuery): Promise<RunPage> {
  const where: string[] = [];
  const params: SqlValue[] = [];
  const add = (clause: string, v: SqlValue) => {
    where.push(clause);
    params.push(v);
  };
  if (q.mine) add('r.triggered_by = ?', q.mine);
  if (q.action) add('r.action = ?', q.action);
  if (q.blueprint) add('r.blueprint = ?', q.blueprint);
  if (q.entity) add('r.entity = ?', q.entity);
  if (q.status?.length) {
    where.push(`r.status IN (${q.status.map(() => '?').join(',')})`);
    params.push(...q.status);
  }
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const [total] = await all<{ n: number }>(`SELECT count(*) AS n FROM runs r ${w}`, ...params);
  const rows = await all<RunRow>(`${SELECT} ${w} ORDER BY r.created_at DESC LIMIT ? OFFSET ?`, ...params, q.limit, q.offset);
  const approvals = await approvalsOf(rows.map((r) => r.id));
  return { items: rows.map((r) => toRun(r, approvals.get(r.id) ?? [])), total: Number(total?.n ?? 0) };
}

/** Decisions waiting for this principal: run-level approvals and approval steps of running workflows. */
export async function pendingApprovals(p: Principal): Promise<Run[]> {
  const rows = await all<RunRow>(`${SELECT} WHERE r.status = 'PENDING_APPROVAL' ORDER BY r.created_at LIMIT 500`);
  const approvals = await approvalsOf(rows.map((r) => r.id));
  const out: Run[] = rows
    .filter((r) => canApprove(p, r, approvals.get(r.id) ?? []))
    .map((r) => ({ ...toRun(r, approvals.get(r.id) ?? []), canApprove: true, pendingStep: null }));
  const waiting = await all<RunRow & { step_id: string }>(
    `${SELECT.replace('SELECT r.*', 'SELECT DISTINCT r.*, s.step_id')} JOIN run_steps s ON s.run_id = r.id
     WHERE s.status = 'WAITING_APPROVAL' AND r.status = 'IN_PROGRESS' ORDER BY r.created_at LIMIT 500`,
  );
  const stepApprovals = await stepApprovalsOf([...new Set(waiting.map((w) => w.id))]);
  for (const w of waiting) {
    const def = stepDefs(w).find((d) => d.id === w.step_id);
    const row = (await loadSteps(w.id)).find((s) => s.step_id === w.step_id);
    if (!def || !row || !canApproveStep(p, w, def, row, stepApprovals.get(`${w.id}/${w.step_id}`) ?? [])) continue;
    out.push({ ...toRun(w, []), pendingStep: { id: row.step_id, name: row.name, message: stepMessage(row) } });
  }
  return out;
}

/**
 * Append a log line unless the run already holds RUN_LOG_MAX_LINES (one notice is added when the cap is hit), so a
 * chatty step cannot grow a run's log without bound. The cap check and insert are a single statement.
 */
export async function addLog(runId: string, message: string, level: RunLog['level'] = 'info', stepId: string | null = null, d?: Driver) {
  const cap = config.RUN_LOG_MAX_LINES;
  const exec = (sql: string, ...params: SqlValue[]) => (d ? d.query(sql, params) : run(sql, ...params));
  const insert = (lvl: string, msg: string, step: string | null, guard: string, ...guardParams: SqlValue[]) =>
    exec(
      `INSERT INTO run_logs (run_id, at, level, message, step_id) SELECT CAST(? AS TEXT), CAST(? AS TEXT), CAST(? AS TEXT), CAST(? AS TEXT), CAST(? AS TEXT) WHERE ${guard}`,
      runId,
      now(),
      lvl,
      msg,
      step,
      ...guardParams,
    );
  const { changes } = await insert(level, message.slice(0, 8000), stepId, '(SELECT count(*) FROM run_logs WHERE run_id = ?) < ?', runId, cap);
  if (changes) return;
  const notice = `Log limit reached (${cap} lines): further output is dropped`;
  await insert('warn', notice, null, 'NOT EXISTS (SELECT 1 FROM run_logs WHERE run_id = ? AND message = ?)', runId, notice);
}

export async function emitRun(id: string, type: 'run.created' | 'run.updated') {
  const r = await getRunRow(id);
  const steps = (await loadSteps(id)).map((s) => ({ id: s.step_id, name: s.name, type: s.type, status: s.status }));
  await emit({ type, blueprint: r.blueprint, data: { run: { ...toRun(r, (await approvalsOf([id])).get(id) ?? []), steps } } });
}

// ---------- trigger ----------
/**
 * Create a run. With an `idempotencyKey` (Idempotency-Key header), retrying the same request returns the original run
 * (`created: false`) instead of starting a second one; the same key with other inputs is a 409.
 */
export async function triggerRun(
  p: Principal,
  actionId: string,
  body: { entity?: string | null; inputs?: Record<string, unknown> },
  idempotencyKey?: string,
): Promise<{ run: Run; created: boolean }> {
  const action = await getAction(actionId);
  if (!action.enabled) throw badRequest(`Action "${action.title}" is disabled`);
  const trigger = action.trigger;
  if (!trigger) throw badRequest(`"${action.title}" has no trigger yet: set up its form submission trigger`);
  if (!action.steps.length) throw badRequest(`"${action.title}" has no steps yet: add a step to its workflow`);
  let entityTeam: string | null = null;
  let entityId: string | null = null;
  if (trigger.on !== 'create') {
    if (!body.entity) throw badRequest(`"${action.title}" runs on an existing ${trigger.blueprint} entity: pass "entity"`);
    const e = await getEntity(trigger.blueprint!, body.entity);
    entityTeam = e.team;
    entityId = e.identifier;
  }
  if (!canTrigger(action, p, entityTeam)) throw forbidden(`You are not allowed to run "${action.title}"`);
  const inputs = compact(body.inputs ?? {});
  validate(trigger.inputs, inputs, 'inputs');

  const replay = async () => {
    const existing = await one<RunRow>(
      `${SELECT} WHERE r.triggered_by = ? AND r.action = ? AND r.idempotency_key = ?`,
      p.id,
      action.identifier,
      idempotencyKey ?? '',
    );
    if (!existing) return undefined;
    if (JSON.stringify(compact(json(existing.inputs, {}))) !== JSON.stringify(inputs) || (existing.entity ?? null) !== entityId)
      throw conflict('This Idempotency-Key was already used with a different request');
    return { run: await getRun(existing.id, p), created: false };
  };
  if (idempotencyKey) {
    const hit = await replay();
    if (hit) return hit;
  }
  const id = newId();
  const t = now();
  const status: RunStatus = trigger.approval.required ? 'PENDING_APPROVAL' : 'QUEUED';
  const inserted = await run(
    `INSERT INTO runs (id, action, action_title, blueprint, entity, inputs, status, invoker, steps, approval, triggered_by, team, created_at, updated_at, idempotency_key)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
    id,
    action.identifier,
    action.title,
    trigger.blueprint,
    entityId,
    JSON.stringify(inputs),
    status,
    JSON.stringify(action.invoker ?? null),
    JSON.stringify(action.steps), // snapshot: editing the action never changes runs in flight
    JSON.stringify(trigger.approval),
    p.id,
    entityTeam,
    t,
    t,
    idempotencyKey ?? null,
  );
  if (!inserted.changes) {
    // A concurrent request with the same key won the unique index.
    const hit = await replay();
    if (hit) return hit;
    throw conflict('The run could not be created; retry');
  }
  await addLog(id, `Triggered by ${p.name} <${p.email}>${entityId ? ` on ${trigger.blueprint}/${entityId}` : ''}`);
  if (status === 'PENDING_APPROVAL') await addLog(id, `Waiting for ${trigger.approval.minApprovals ?? 1} approval(s)`);
  await audit(actorOf(p), 'run.triggered', `${action.identifier}${entityId ? ` → ${trigger.blueprint}/${entityId}` : ''}`, { runId: id });
  await emitRun(id, 'run.created');
  if (status === 'QUEUED') wake();
  return { run: await getRun(id, p), created: true };
}

// ---------- approvals ----------
export async function decide(p: Principal, runId: string, decision: 'approved' | 'rejected', comment: string): Promise<Run> {
  const r = await getRunRow(runId);
  const approvals = (await approvalsOf([runId])).get(runId) ?? [];
  if (r.status !== 'PENDING_APPROVAL') throw conflict('This run is not waiting for approval');
  if (!canApprove(p, r, approvals)) throw forbidden('You cannot approve this run');
  if (decision === 'rejected' && !comment.trim()) throw badRequest('Give a reason when rejecting');
  const policy = json<ApprovalPolicy>(r.approval, { required: true });
  // Insert the decision, count and transition in one transaction holding a row lock on the run: concurrent approvers
  // are serialized, so the last one always sees every other approval (and a duplicate is a 409, not a key violation).
  const outcome = await tx(async (d) => {
    const cur = (await d.query<{ status: RunStatus }>(`SELECT status FROM runs WHERE id = ?${forUpdate}`, [runId])).rows[0];
    if (cur?.status !== 'PENDING_APPROVAL') throw conflict('This run is not waiting for approval');
    const decided = (await d.query<{ user_id: string; decision: string }>('SELECT user_id, decision FROM run_approvals WHERE run_id = ?', [runId])).rows;
    if (decided.some((a) => a.user_id === p.id)) throw conflict('You already decided on this run');
    await d.query('INSERT INTO run_approvals (run_id, user_id, decision, comment, at) VALUES (?, ?, ?, ?, ?)', [runId, p.id, decision, comment, now()]);
    const approvedCount = decided.filter((a) => a.decision === 'approved').length + (decision === 'approved' ? 1 : 0);
    let next: RunStatus | null = null;
    if (decision === 'rejected') next = 'REJECTED';
    else if (approvedCount >= (policy.minApprovals ?? 1)) next = 'QUEUED';
    if (next) {
      const t = now();
      await d.query(`UPDATE runs SET status = ?, ended_at = ?, updated_at = ? WHERE id = ? AND status = 'PENDING_APPROVAL'`, [
        next,
        next === 'REJECTED' ? t : null,
        t,
        runId,
      ]);
    }
    return next;
  });
  await addLog(
    runId,
    `${decision === 'approved' ? 'Approved' : 'Rejected'} by ${p.name}${comment ? `: ${comment}` : ''}`,
    decision === 'approved' ? 'info' : 'warn',
  );
  await audit(actorOf(p), `run.${decision}`, r.action, { runId, comment });
  if (outcome) {
    await addLog(runId, outcome === 'QUEUED' ? 'Approved: queued for execution' : 'Run rejected');
    if (outcome === 'QUEUED') wake();
    if (outcome === 'REJECTED') metrics.runFinished(r.action, outcome, 'workflow', null);
  }
  await emitRun(runId, 'run.updated');
  return getRun(runId, p);
}

// ---------- cancel ----------
/**
 * Two-phase cancellation. A run in progress first gets `cancel_requested` (workers then stop starting or continuing
 * steps), its steps are cancelled (`cancelSteps`, engine: asks external systems to stop), and only then the run turns
 * CANCELLED. If the run moves meanwhile (a worker claimed a QUEUED run, an approval completed) the request is
 * re-evaluated against the new status instead of failing.
 */
export async function cancelRun(p: Principal, runId: string, cancelSteps: (r: RunRow) => Promise<void>): Promise<Run> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const r = await getRunRow(runId);
    if (!canCancel(p, r)) throw forbidden(FINAL.includes(r.status) ? 'This run is already finished' : 'Only the requester or an admin can cancel');
    const stopSteps = async () => {
      try {
        await cancelSteps(r);
      } catch (err) {
        await addLog(runId, `Could not cancel the external run: ${(err as Error).message}`, 'warn');
      }
    };
    if (r.status === 'IN_PROGRESS') {
      await run("UPDATE runs SET cancel_requested = 1, updated_at = ? WHERE id = ? AND status = 'IN_PROGRESS'", now(), runId);
      await stopSteps();
    }
    const t = now();
    const { changes } = await run(
      `UPDATE runs SET status = 'CANCELLED', ended_at = ?, updated_at = ?, next_poll_at = NULL WHERE id = ? AND status = ?`,
      t,
      t,
      runId,
      r.status,
    );
    if (!changes) continue; // the run moved on: look again
    if (r.status === 'IN_PROGRESS') await stopSteps(); // a step started while we were cancelling
    await addLog(runId, `Cancelled by ${p.name}`, 'warn');
    await audit(actorOf(p), 'run.cancelled', r.action, { runId });
    await emitRun(runId, 'run.updated');
    return getRun(runId, p);
  }
  throw conflict('The run keeps changing; try again');
}

// ---------- updates from the invoker / the external system ----------
export interface RunUpdate {
  status?: 'IN_PROGRESS' | 'SUCCESS' | 'FAILURE';
  statusLabel?: string | null;
  link?: string | null;
  result?: unknown;
  state?: Record<string, unknown>;
  logs?: { message: string; level?: RunLog['level'] }[];
}

/**
 * Apply an update to an IN_PROGRESS run (from a worker poll or the callback API). Final statuses end the run.
 * Returns false when the run is not in progress anymore (cancelled, already finished).
 */
export async function updateRun(runId: string, u: RunUpdate): Promise<boolean> {
  const r = await getRunRow(runId);
  if (r.status !== 'IN_PROGRESS') return false;
  for (const l of u.logs ?? []) await addLog(runId, l.message, l.level ?? 'info');
  const sets: string[] = ['updated_at = ?'];
  const params: SqlValue[] = [now()];
  const set = (clause: string, v: SqlValue) => {
    sets.push(clause);
    params.push(v);
  };
  if (u.statusLabel !== undefined) set('status_label = ?', u.statusLabel);
  if (u.link !== undefined) set('link = ?', u.link);
  if (u.result !== undefined) set('result = ?', JSON.stringify(u.result));
  if (u.state !== undefined) set('state = ?', JSON.stringify(u.state));
  const final = u.status === 'SUCCESS' || u.status === 'FAILURE';
  if (final) {
    sets.push('status = ?', 'ended_at = ?', 'next_poll_at = NULL', 'locked_until = NULL');
    params.push(u.status!, now());
  }
  const { changes } = await run(`UPDATE runs SET ${sets.join(', ')} WHERE id = ? AND status = 'IN_PROGRESS'`, ...params, runId);
  if (!changes) return false;
  if (final) {
    await addLog(runId, u.status === 'SUCCESS' ? 'Run succeeded' : 'Run failed', u.status === 'SUCCESS' ? 'info' : 'error');
    const seconds = r.started_at ? (Date.now() - Date.parse(r.started_at)) / 1000 : null;
    metrics.runFinished(r.action, u.status!, 'workflow', seconds);
  }
  if (final || u.statusLabel !== undefined || u.link !== undefined) await emitRun(runId, 'run.updated');
  return true;
}

export const runUrl = (id: string) => `${config.PUBLIC_URL}/runs/${id}`;
