import type { Action, ApprovalPolicy, Run, RunApproval, RunLog, RunPage, RunStatus } from '@asterius/shared';
import { config } from '../config.js';
import { all, forUpdate, json, newId, now, one, run, tx, type Driver, type SqlValue } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { emit } from '../events.js';
import { audit } from '../audit.js';
import { maskText } from '../lib/mask.js';
import { actorOf, automationPrincipal, isAdmin, matchesSubjects, principalOf, type Principal, type UserRow } from '../auth/users.js';
import { notify } from '../inbox.js';
import { findEntity, getEntity } from '../catalog/entities.js';
import { enforcePolicies } from '../policies/policies.js';
import { compact, validate } from '../catalog/validation.js';
import { canTrigger, getAction } from './actions.js';
import { assertCan } from '../auth/access.js';
import { getBlueprintCached } from '../catalog/blueprints.js';
import { metrics } from '../metrics.js';
import { runCosts } from '../ai/usage.js';
import { wake } from './wake.js';
import { notifyPendingDecision } from '../notifications/dispatch.js';
import {
  approverSubjects,
  canApproveStep,
  canManageRun,
  canSubmitInput,
  loadSteps,
  resumableSteps,
  runStepsView,
  stepApprovalsOf,
  stepDefs,
  stepMessage,
  type StepRow,
} from './steps.js';
import { decodeCursor, encodeCursor } from '../lib/cursor.js';
import { findOrg, orgRef } from '../orgs/orgs.js';
import { orgId, withOrg } from '../orgs/context.js';

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
  org_id: string;
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
  trigger_type: string | null;
  trigger_info: string | null;
  parent_run_id: string | null;
  parent_step_id: string | null;
  action_version: number | null;
  allowed_secrets: string | null;
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
  trigger: { type: r.trigger_type ?? 'form', ...json<Record<string, unknown>>(r.trigger_info, {}) },
  actionVersion: r.action_version,
  parent: r.parent_run_id ? { runId: r.parent_run_id, stepId: r.parent_step_id ?? '' } : null,
  createdAt: r.created_at,
  startedAt: r.started_at,
  endedAt: r.ended_at,
});

/** Approvers default to admins when the policy names nobody. */
const approversOf = (policy: ApprovalPolicy) => {
  const a = policy.approvers;
  return a && (a.roles?.length || a.teams?.length || a.users?.length || a.ownerTeam) ? a : { roles: ['admin', 'approver'] };
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
  const r = await one<RunRow>(`${SELECT} WHERE r.id = ? AND r.org_id = ?`, id, orgId());
  if (!r) throw notFound('Run');
  return r;
}

/**
 * Who may see a run (inputs, logs and results can hold names, environments and sometimes credentials): the requester,
 * admins, members of the team owning the target entity, anyone who decided on it, and the people entitled to approve
 * it (run-level policy or an approval step of the workflow).
 */
export async function canViewRun(p: Principal, r: RunRow, approvals: RunApproval[]): Promise<boolean> {
  if (isAdmin(p) || r.triggered_by === p.id) return true;
  if (r.team && p.teams.includes(r.team)) return true;
  if (approvals.some((a) => a.userId === p.id)) return true;
  if (approverOf(p, r)) return true;
  const stepDecisions = (await stepApprovalsOf([r.id])).entries();
  for (const [, list] of stepDecisions) if (list.some((a) => a.userId === p.id)) return true;
  return false;
}

/** Entitled to approve (now or at some point): the run-level policy, or an approval step of the workflow. */
function approverOf(p: Principal, r: RunRow) {
  const policy = json<ApprovalPolicy>(r.approval, { required: false });
  if (policy.required && matchesSubjects(p, approversOf(policy), r.team)) return true;
  return stepDefs(r).some((d) => d.type === 'approval' && matchesSubjects(p, approverSubjects(d.approvers), r.team));
}

const LOG_COLUMNS = 'seq, at, level, message, step_id AS "stepId"';
const LOG_TAIL = 1000;

/**
 * A run with its steps and log lines. Logs are bounded: the newest LOG_TAIL lines, or only the lines past `after`
 * (sequence number) for incremental polling. `GET /runs/:id/logs` pages through the whole log.
 */
/** Log lines after `seq` (exclusive), oldest first. `seq` is the cursor of the incremental log stream (SSE). */
export async function runLogsAfter(id: string, seq: number, limit = 500): Promise<(RunLog & { seq: number })[]> {
  const rows = await all<RunLog & { seq: number }>(
    'SELECT seq, at, level, message, step_id AS "stepId" FROM run_logs WHERE run_id = ? AND seq > ? ORDER BY seq LIMIT ?',
    id,
    seq,
    limit,
  );
  return rows.map((l) => ({ ...l, seq: Number(l.seq) }));
}

export async function getRun(id: string, p: Principal, opts: { after?: number; logs?: boolean } = {}): Promise<Run> {
  const r = await getRunRow(id);
  const approvals = (await approvalsOf([id])).get(id) ?? [];
  if (!(await canViewRun(p, r, approvals))) throw notFound('Run'); // same answer as a missing run: do not reveal existence
  let logs: RunLog[];
  let logsTruncated = false;
  if (opts.logs === false) logs = [];
  else if (opts.after !== undefined)
    logs = await all<RunLog>(`SELECT ${LOG_COLUMNS} FROM run_logs WHERE run_id = ? AND seq > ? ORDER BY seq LIMIT 2000`, id, opts.after);
  else {
    const newest = await all<RunLog>(`SELECT ${LOG_COLUMNS} FROM run_logs WHERE run_id = ? ORDER BY seq DESC LIMIT ?`, id, LOG_TAIL + 1);
    logsTruncated = newest.length > LOG_TAIL;
    logs = newest.slice(0, LOG_TAIL).reverse();
  }
  const manage = canManageRun(p, r);
  const canResume = manage && ['FAILURE', 'CANCELLED'].includes(r.status) && !!r.steps && resumableSteps(stepDefs(r), await loadSteps(id)).length > 0;
  return {
    ...toRun(r, approvals),
    logs,
    logsTruncated,
    costUsd: (await runCosts(id)).total || null,
    steps: await runStepsView(r, p),
    canApprove: canApprove(p, r, approvals),
    canCancel: canCancel(p, r),
    canRerun: manage && FINAL.includes(r.status),
    canResume,
  };
}

/** One page of a run's log, oldest first: continue with `after = next` while `next` is not null. */
export async function getRunLogs(id: string, p: Principal, q: { after: number; limit: number; step?: string }) {
  const r = await getRunRow(id);
  if (!(await canViewRun(p, r, (await approvalsOf([id])).get(id) ?? []))) throw notFound('Run');
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
  /** Keyset cursor from a previous page (newest first). */
  cursor?: string;
  /** false: skip the second count(*) query. Default: counted unless paging by cursor. */
  count?: boolean;
}

/** Ids of non-final-or-not runs the principal is entitled to approve (policy checked in code, SQL only pre-selects). */
async function approverRunIds(p: Principal): Promise<string[]> {
  const rows = await all<RunRow>(
    `${SELECT} WHERE r.org_id = ? AND (r.approval LIKE '%"required":true%' OR r.steps LIKE '%"type":"approval"%') ORDER BY r.created_at DESC LIMIT 2000`,
    orgId(),
  );
  return rows.filter((r) => approverOf(p, r)).map((r) => r.id);
}

export async function listRuns(q: RunQuery, p: Principal): Promise<RunPage> {
  const where: string[] = ['r.org_id = ?'];
  const params: SqlValue[] = [orgId()];
  if (!isAdmin(p)) {
    // Viewer policy (see canViewRun): requester, owning team, deciders, approvers.
    const ors = [
      'r.triggered_by = ?',
      'r.id IN (SELECT run_id FROM run_approvals WHERE user_id = ?)',
      'r.id IN (SELECT run_id FROM step_approvals WHERE user_id = ?)',
    ];
    const vals: SqlValue[] = [p.id, p.id, p.id];
    if (p.teams.length) {
      ors.push(`r.team IN (${p.teams.map(() => '?').join(',')})`);
      vals.push(...p.teams);
    }
    const ids = await approverRunIds(p);
    if (ids.length) {
      ors.push(`r.id IN (${ids.map(() => '?').join(',')})`);
      vals.push(...ids);
    }
    where.push(`(${ors.join(' OR ')})`);
    params.push(...vals);
  }
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
  const base = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const listWhere = [...where];
  const listParams = [...params];
  if (q.cursor) {
    const [at, id] = decodeCursor(q.cursor, { s: 'created', d: 'desc', n: 2 });
    listWhere.push('(r.created_at, r.id) < (?, ?)');
    listParams.push(at!, id!);
  }
  const w = listWhere.length ? `WHERE ${listWhere.join(' AND ')}` : '';
  const rows = await all<RunRow>(`${SELECT} ${w} ORDER BY r.created_at DESC, r.id DESC LIMIT ? OFFSET ?`, ...listParams, q.limit + 1, q.cursor ? 0 : q.offset);
  const more = rows.length > q.limit;
  if (more) rows.pop();
  const approvals = await approvalsOf(rows.map((r) => r.id));
  const out: RunPage = { items: rows.map((r) => toRun(r, approvals.get(r.id) ?? [])) };
  const last = rows.at(-1);
  if (more && last) out.nextCursor = encodeCursor({ s: 'created', d: 'desc', v: [last.created_at, last.id] });
  if (q.count ?? !q.cursor) {
    const [total] = await all<{ n: number }>(`SELECT count(*) AS n FROM runs r ${base}`, ...params);
    out.total = Number(total?.n ?? 0);
  }
  return out;
}

const APPROVAL_SCAN = 200;

/**
 * Decisions waiting for this principal: run-level approvals and approval steps of running workflows.
 * Candidates are read by keyset (oldest first) in batches of 200 with the cheap exclusions in SQL (own earlier
 * decisions); the policy check (roles, teams, self-approval) runs in memory on the batch, whose steps and approvals are
 * loaded with one query each. No row cap: stops once `limit` items were collected and returns a cursor for the rest.
 */
export async function pendingApprovals(
  p: Principal,
  opts: { limit?: number; cursor?: string; scanLimit?: number } = {},
): Promise<{ items: Run[]; nextCursor?: string }> {
  const limit = opts.limit ?? 200;
  const scanMax = opts.scanLimit ?? Infinity;
  const items: Run[] = [];
  let after = opts.cursor ? decodeCursor(opts.cursor, { s: 'approvals', d: 'asc', n: 2 }) : undefined;
  let scanned = 0;
  for (;;) {
    const rows = await all<RunRow>(
      `${SELECT} WHERE r.org_id = ? AND (r.status = 'PENDING_APPROVAL' AND NOT EXISTS (SELECT 1 FROM run_approvals a WHERE a.run_id = r.id AND a.user_id = ?)
          OR r.status = 'IN_PROGRESS' AND EXISTS (SELECT 1 FROM run_steps s WHERE s.run_id = r.id AND s.status IN ('WAITING_APPROVAL', 'WAITING')))
        ${after ? 'AND (r.created_at, r.id) > (?, ?)' : ''} ORDER BY r.created_at, r.id LIMIT ?`,
      orgId(),
      p.id,
      ...(after ?? []),
      APPROVAL_SCAN,
    );
    if (!rows.length) return { items };
    scanned += rows.length;
    const approvals = await approvalsOf(rows.filter((r) => r.status === 'PENDING_APPROVAL').map((r) => r.id));
    const inProgress = rows.filter((r) => r.status === 'IN_PROGRESS');
    const stepRows = inProgress.length
      ? await all<StepRow>(
          `SELECT * FROM run_steps WHERE status IN ('WAITING_APPROVAL', 'WAITING') AND run_id IN (${inProgress.map(() => '?').join(',')}) ORDER BY run_id, position`,
          ...inProgress.map((r) => r.id),
        )
      : [];
    const stepApprovals = await stepApprovalsOf(inProgress.map((r) => r.id));
    for (const [i, r] of rows.entries()) {
      if (r.status === 'PENDING_APPROVAL') {
        if (canApprove(p, r, approvals.get(r.id) ?? [])) items.push({ ...toRun(r, approvals.get(r.id) ?? []), canApprove: true, pendingStep: null });
      } else {
        for (const row of stepRows.filter((sr) => sr.run_id === r.id)) {
          const def = stepDefs(r).find((d) => d.id === row.step_id);
          if (!def) continue;
          const kind = def.type === 'input' ? 'input' : 'approval';
          const allowed = kind === 'input' ? canSubmitInput(p, r, def, row) : canApproveStep(p, r, def, row, stepApprovals.get(`${r.id}/${row.step_id}`) ?? []);
          if (allowed) items.push({ ...toRun(r, []), pendingStep: { id: row.step_id, name: row.name, message: stepMessage(row), kind } });
        }
      }
      if (items.length >= limit && i < rows.length - 1) return { items, nextCursor: encodeCursor({ s: 'approvals', d: 'asc', v: [r.created_at, r.id] }) };
    }
    const last = rows[rows.length - 1]!;
    after = [last.created_at, last.id];
    if (items.length >= limit || scanned >= scanMax)
      return rows.length === APPROVAL_SCAN ? { items, nextCursor: encodeCursor({ s: 'approvals', d: 'asc', v: after }) } : { items };
    if (rows.length < APPROVAL_SCAN) return { items };
  }
}

/** Number of decisions waiting for this principal (home badge); counts at most `max` and reports whether more exist. */
export async function countPendingApprovals(p: Principal, max = 99): Promise<number> {
  const { items, nextCursor } = await pendingApprovals(p, { limit: max + 1 });
  return nextCursor ? max + 1 : items.length;
}

/**
 * Append a log line unless the run already holds RUN_LOG_MAX_LINES (one notice is added when the cap is hit), so a
 * chatty step cannot grow a run's log without bound. The per-run counter is bumped atomically (cross-replica), so the
 * cap check is O(1); `d` runs it inside the caller's transaction.
 */
export async function addLog(runId: string, message: string, level: RunLog['level'] = 'info', stepId: string | null = null, d?: Driver) {
  const max = config.RUN_LOG_MAX_LINES;
  const q = async <T>(sql: string, ...params: SqlValue[]): Promise<T[]> => (d ? (await d.query<T>(sql, params)).rows : all<T>(sql, ...params));
  const [r] = await q<{ log_count: number }>('UPDATE runs SET log_count = log_count + 1 WHERE id = ? AND log_count <= ? RETURNING log_count', runId, max);
  if (!r) return;
  const truncated = Number(r.log_count) > max;
  const args: SqlValue[] = [
    runId,
    now(),
    truncated ? 'warn' : level,
    truncated ? `Log limit of ${max} lines reached: further lines are dropped` : maskText(message, []).slice(0, 8000), // callers redact known secrets; this also masks credential shapes
    stepId,
  ];
  const sql = 'INSERT INTO run_logs (run_id, at, level, message, step_id) VALUES (?, ?, ?, ?, ?)';
  if (d) await d.query(sql, args);
  else await run(sql, ...args);
}

export async function emitRun(id: string, type: 'run.created' | 'run.updated' | 'approval.requested' | 'approval.decided') {
  const r = await getRunRow(id);
  const steps = (await loadSteps(id)).map((s) => ({ id: s.step_id, name: s.name, type: s.type, status: s.status }));
  const data = { run: { ...toRun(r, (await approvalsOf([id])).get(id) ?? []), steps } };
  await emit({ type, blueprint: r.blueprint, data });
  if (type === 'run.updated' && FINAL.includes(r.status)) await emit({ type: 'run.finished', blueprint: r.blueprint, data });
  if (type === 'run.created' || type === 'run.updated') await notifyRun(r).catch((err) => console.error('[notifications] could not notify', id, err));
}

const FINAL_TEXT: Partial<Record<RunStatus, string>> = { SUCCESS: 'succeeded', FAILURE: 'failed', REJECTED: 'was rejected', CANCELLED: 'was cancelled' };

/** In-app notifications for a run lifecycle change: approvers when a decision is needed, the requester when it ends. */
async function notifyRun(r: RunRow) {
  const link = `/runs/${r.id}`;
  const finalText = FINAL_TEXT[r.status];
  if (finalText) {
    await notify(r.triggered_by, { kind: `run.${r.status.toLowerCase()}`, title: `${r.action_title} ${finalText}`, link, dedupe: `run:${r.id}:${r.status}` });
    return;
  }
  const wantsApproval = r.status === 'PENDING_APPROVAL';
  const waitingSteps = r.status === 'IN_PROGRESS' ? (await loadSteps(r.id)).filter((s) => s.status === 'WAITING_APPROVAL') : [];
  if (!wantsApproval && !waitingSteps.length) return;
  const approvals = (await approvalsOf([r.id])).get(r.id) ?? [];
  const stepApprovals = await stepApprovalsOf([r.id]);
  const defs = stepDefs(r);
  // Members of the run's organization (the context of the run).
  const org = await currentOrgRef();
  const members = await all<UserRow>(
    "SELECT u.* FROM users u JOIN memberships m ON m.user_id = u.id WHERE m.org_id = ? AND u.active = 1 AND u.provider != 'service'",
    org.id,
  );
  for (const u of members) {
    const p = await principalOf(u, org);
    if (wantsApproval && canApprove(p, r, approvals))
      await notify(u.id, {
        kind: 'approval.requested',
        title: `Approval requested: ${r.action_title}`,
        body: `By ${r.user_name ?? 'someone'}`,
        link,
        dedupe: `approval:${r.id}`,
      });
    for (const row of waitingSteps) {
      const def = defs.find((d) => d.id === row.step_id);
      if (def && canApproveStep(p, r, def, row, stepApprovals.get(`${r.id}/${row.step_id}`) ?? []))
        await notify(u.id, {
          kind: 'approval.requested',
          title: `Approval requested: ${row.name}`,
          body: `${r.action_title}, by ${r.user_name ?? 'someone'}`,
          link: `${link}?step=${row.step_id}`,
          dedupe: `approval:${r.id}:${row.step_id}`,
        });
    }
  }
}

// ---------- trigger ----------
export interface RunSource {
  type: 'form' | 'api' | 'schedule' | 'event' | 'webhook' | 'workflow' | 'rerun';
  info?: Record<string, unknown>;
}

interface NewRun {
  p: Principal;
  action: Action;
  blueprint: string | null;
  entity: string | null;
  entityTeam: string | null;
  inputs: Record<string, unknown>;
  approval: ApprovalPolicy;
  source: RunSource;
  parent?: { runId: string; stepId: string };
  /** Retrying a request with the same key returns the original run (`replay`). */
  idempotencyKey?: string;
}

async function insertRun(n: NewRun): Promise<{ id: string; replay?: false } | { replay: true }> {
  const { p, action } = n;
  // Policy gate: before anything is stored or queued.
  await enforcePolicies(
    'run',
    {
      principal: p,
      action: { identifier: action.identifier, title: action.title },
      blueprint: n.blueprint,
      operation: 'run',
      inputs: n.inputs,
      entity: n.entity ? await findEntity(n.blueprint!, n.entity) : null,
    },
    actorOf(p),
  );
  const id = newId();
  const t = now();
  const status: RunStatus = n.approval.required ? 'PENDING_APPROVAL' : 'QUEUED';
  const inserted = await run(
    `INSERT INTO runs (id, org_id, action, action_title, blueprint, entity, inputs, status, invoker, steps, approval, triggered_by, team, trigger_type, trigger_info, parent_run_id, parent_step_id, action_version, allowed_secrets, created_at, updated_at, idempotency_key)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
    id,
    orgId(),
    action.identifier,
    action.title,
    n.blueprint,
    n.entity,
    JSON.stringify(n.inputs),
    status,
    JSON.stringify(action.invoker ?? null),
    JSON.stringify(action.steps), // snapshot: editing the action never changes runs in flight
    JSON.stringify(n.approval),
    p.id,
    n.entityTeam,
    n.source.type,
    JSON.stringify(n.source.info ?? {}),
    n.parent?.runId ?? null,
    n.parent?.stepId ?? null,
    action.version,
    action.secrets ? JSON.stringify(action.secrets) : null,
    t,
    t,
    n.idempotencyKey ?? null,
  );
  // A concurrent request with the same idempotency key won the unique index.
  if (!inserted.changes) return { replay: true };
  const via = n.source.type === 'form' || n.source.type === 'api' ? '' : ` (${n.source.type})`;
  const where = n.entity ? ` on ${n.blueprint}/${n.entity}` : '';
  await addLog(id, `Triggered by ${p.name} <${p.email}>${where}${via}`);
  if (status === 'PENDING_APPROVAL') {
    await addLog(id, `Waiting for ${n.approval.minApprovals ?? 1} approval(s)`);
    void notifyPendingDecision({
      run: { id, action_title: action.title, team: n.entityTeam, triggered_by: p.id, user_name: p.name },
      kind: 'approval',
      subjects: n.approval.approvers,
      allowSelf: n.approval.allowSelfApproval,
    }).catch(() => undefined);
  }
  await audit(actorOf(p), 'run.triggered', `${action.identifier}${n.entity ? ` → ${n.blueprint}/${n.entity}` : ''}`, { runId: id, source: n.source.type });
  await emitRun(id, 'run.created');
  if (status === 'PENDING_APPROVAL') await emitRun(id, 'approval.requested');
  if (status === 'QUEUED') wake();
  return { id };
}

function checkRunnable(action: Action) {
  if (!action.enabled) throw badRequest(`Action "${action.title}" is disabled`);
  if (!action.trigger) throw badRequest(`"${action.title}" has no trigger yet: set up its form submission trigger`);
  if (!action.steps.length) throw badRequest(`"${action.title}" has no steps yet: add a step to its workflow`);
}

export async function triggerRun(
  p: Principal,
  actionId: string,
  body: { entity?: string | null; inputs?: Record<string, unknown> },
  idempotencyKey?: string,
  source?: RunSource,
): Promise<{ run: Run; created: boolean }> {
  const action = await getAction(actionId);
  checkRunnable(action);
  const trigger = action.trigger;
  if (trigger?.type !== 'form' && trigger?.type !== 'api')
    throw badRequest(`"${action.title}" is started by its ${trigger?.type} trigger, not by a form or an API call`);
  let entityTeam: string | null = null;
  let entityId: string | null = null;
  if (trigger.on !== 'create') {
    if (!body.entity) throw badRequest(`"${action.title}" runs on an existing ${trigger.blueprint} entity: pass "entity"`);
    const e = await getEntity(trigger.blueprint!, body.entity);
    entityTeam = e.team;
    entityId = e.identifier;
    assertCan(p, await getBlueprintCached(trigger.blueprint!), 'run', e.team);
  }
  if (!canTrigger(action, p, entityTeam)) throw forbidden(`You are not allowed to run "${action.title}"`);
  const inputs = compact(body.inputs ?? {});
  validate(trigger.inputs, inputs, 'inputs');
  const res = await insertRun({
    p,
    action,
    blueprint: trigger.blueprint ?? null,
    entity: entityId,
    entityTeam,
    inputs,
    approval: trigger.approval,
    source: source ?? { type: trigger.type },
    idempotencyKey,
  });
  if (res.replay) {
    const existing = await one<RunRow>(
      `${SELECT} WHERE r.triggered_by = ? AND r.action = ? AND r.idempotency_key = ?`,
      p.id,
      action.identifier,
      idempotencyKey ?? '',
    );
    if (!existing) throw conflict('The run could not be created; retry');
    if (JSON.stringify(compact(json(existing.inputs, {}))) !== JSON.stringify(inputs) || (existing.entity ?? null) !== entityId)
      throw conflict('This Idempotency-Key was already used with a different request');
    return { run: await getRun(existing.id, p), created: false };
  }
  return { run: await getRun(res.id, p), created: true };
}

/**
 * Start a run on behalf of the platform (schedule, event, webhook, parent workflow): the run belongs to the
 * automation service account, there is no form validation and no approval gate before the workflow.
 */
export async function startAutomatedRun(
  actionId: string,
  o: {
    blueprint?: string | null;
    entity?: string | null;
    inputs: Record<string, unknown>;
    source: RunSource;
    as?: Principal;
    parent?: { runId: string; stepId: string };
  },
): Promise<string> {
  const action = await getAction(actionId);
  checkRunnable(action);
  const entity = o.entity && o.blueprint ? await getEntity(o.blueprint, o.entity) : null;
  const res = await insertRun({
    p: o.as ?? (await automationPrincipal()),
    action,
    blueprint: o.blueprint ?? null,
    entity: entity?.identifier ?? null,
    entityTeam: entity?.team ?? null,
    inputs: o.inputs,
    approval: { required: false, minApprovals: 1, allowSelfApproval: false },
    source: o.source,
    parent: o.parent,
  });
  if (res.replay) throw conflict('The run could not be created; retry');
  return res.id;
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
  await emitRun(runId, 'approval.decided');
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

const currentOrgRef = async () => orgRef((await findOrg(orgId()))!);

/** Organization of a run, outside any organization context (callbacks from pipelines, workers). */
export async function runOrg(id: string): Promise<string | undefined> {
  return (await one<{ org_id: string }>('SELECT org_id FROM runs WHERE id = ?', id))?.org_id;
}

/** Run `fn` in the organization of a run (workers, callbacks). */
export async function inRunOrg<T>(runId: string, fn: () => Promise<T>): Promise<T> {
  const org = await runOrg(runId);
  if (!org) throw notFound('Run');
  return withOrg(org, fn);
}
