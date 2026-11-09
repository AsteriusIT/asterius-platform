import type { FastifyBaseLogger } from 'fastify';
import type { ApprovalPolicy, RunApproval, Subjects } from '@asterius/shared';
import { all, json, later, now, run as exec } from '../db.js';
import { audit, SYSTEM } from '../audit.js';
import { metrics } from '../metrics.js';
import { notifyPendingDecision } from '../notifications/dispatch.js';
import { addLog, emitRun, getRunRow, inRunOrg, runApprovalsOf, runApproverSets, type RunRow } from './runs.js';
import { approverSubjects, stepApprovalsOf, stepApproverSets, stepDefs, stepMessage, type StepRow } from './steps.js';
import { advance, complete, setStep } from './engine.js';
import { parseDuration } from './waiting.js';
import { wake } from './wake.js';
import type { Step } from './workflow.js';

/**
 * Approval timers (reminders, escalation, pre-start expiry), expiry outcomes and sequential tiers.
 *
 * Each timer is a due-time column (`remind_at`, `escalate_at`, `approval_expires_at`) on the run (pre-start approval)
 * or the step (approval and input steps). The housekeeping pass reads due rows and claims each one with a conditional
 * UPDATE on the value it read, so whichever replica (or concurrent pass) moves it first sends the reminder or escalates;
 * the others change nothing. Rows that stopped waiting meanwhile have their timer cleared by the same claim.
 */

type ApprovalStep = Extract<Step, { type: 'approval' }>;
type InputStep = Extract<Step, { type: 'input' }>;
interface Timers {
  remindEvery?: string;
  maxReminders?: number;
  escalate?: { after: string; approvers: Subjects };
}

export const DEFAULT_MAX_REMINDERS = 3;
const BATCH = 100;

const due = (d: string | undefined) => (d ? later(parseDuration(d)) : null);

/** Who a set of subjects names, for log lines. */
export function describeSubjects(s: Subjects): string {
  const parts = [
    ...(s.roles ?? []).map((r) => `role ${r}`),
    ...(s.teams ?? []).map((t) => `team ${t}`),
    ...(s.users ?? []),
    ...(s.ownerTeam ? ['the owning team'] : []),
  ];
  return parts.join(', ') || 'admins';
}

/** Ids of the people who decided (and of those a delegate decided for): they are not reminded. */
const decidedIds = (approvals: RunApproval[]) => approvals.flatMap((a) => [a.userId, ...(a.onBehalfOf ? [a.onBehalfOf.id] : [])]);

// ---------- arming ----------
/** A step just started waiting (approval or input): schedule its first reminder and its escalation. */
export async function armStep(runId: string, def: ApprovalStep | InputStep) {
  const t = def as Timers;
  if (!t.remindEvery && !t.escalate) return;
  await exec(
    "UPDATE run_steps SET remind_at = ?, reminders = 0, escalate_at = ?, escalated_at = NULL WHERE run_id = ? AND step_id = ? AND status IN ('WAITING_APPROVAL', 'WAITING')",
    due(t.remindEvery),
    due(t.escalate?.after),
    runId,
    def.id,
  );
}

/** A run waits for its pre-start approval: schedule reminders, escalation and expiry. */
export async function armRunApproval(runId: string, policy: ApprovalPolicy) {
  if (!policy.remindEvery && !policy.escalate && !policy.expireAfter) return;
  await exec(
    "UPDATE runs SET remind_at = ?, reminders = 0, escalate_at = ?, approval_expires_at = ? WHERE id = ? AND status = 'PENDING_APPROVAL'",
    due(policy.remindEvery),
    due(policy.escalate?.after),
    due(policy.expireAfter),
    runId,
  );
}

// ---------- tiers ----------
/** A tier reached its minimum and the next one opens: label, log, fresh reminders, notify its approvers. */
export async function openTier(r: RunRow, def: ApprovalStep, index: number, approvals: RunApproval[]) {
  const tier = def.tiers![index]!;
  const prev = def.tiers![index - 1];
  const need = tier.minApprovals ?? 1;
  await setStep(r.id, def.id, 'WAITING_APPROVAL', { status_label: `Waiting for ${need} approval(s) · tier "${tier.name}"` });
  if (def.remindEvery)
    await exec(
      "UPDATE run_steps SET remind_at = ?, reminders = 0 WHERE run_id = ? AND step_id = ? AND status = 'WAITING_APPROVAL'",
      due(def.remindEvery),
      r.id,
      def.id,
    );
  await addLog(r.id, `${prev ? `Tier "${prev.name}" approved; ` : ''}tier "${tier.name}" open: waiting for ${need} approval(s)`, 'info', def.id);
  const row = (await all<StepRow>('SELECT * FROM run_steps WHERE run_id = ? AND step_id = ?', r.id, def.id))[0];
  if (row)
    void notifyPendingDecision({
      run: r,
      kind: 'approval',
      subjects: stepApproverSets(def, row, approvals),
      allowSelf: def.allowSelfApproval,
      stepName: `${def.name || def.id} (tier "${tier.name}")`,
      message: stepMessage(row),
      exclude: decidedIds(approvals),
    }).catch(() => undefined);
  await emitRun(r.id, 'run.updated');
}

// ---------- expiry ----------
/**
 * Housekeeping found an approval step past its deadline. With `onExpiry` it decides the outcome here (and wins over
 * any generic timeout handling): fail (the default), reject, approve or skip. Returns false when the step has no
 * `onExpiry`, so the caller applies the default timeout.
 */
export async function expireApprovalStep(s: StepRow): Promise<boolean> {
  if (s.status !== 'WAITING_APPROVAL') return false;
  const r = await getRunRow(s.run_id);
  const def = stepDefs(r).find((d) => d.id === s.step_id);
  if (def?.type !== 'approval' || !def.onExpiry) return false;
  const approvals = (await stepApprovalsOf([r.id])).get(`${r.id}/${s.step_id}`) ?? [];
  const approved = approvals.filter((a) => a.decision === 'approved').map((a) => a.userName);
  switch (def.onExpiry) {
    case 'fail':
      await complete(r.id, s.step_id, ['WAITING_APPROVAL'], { status: 'FAILURE', statusLabel: 'Approval expired' });
      break;
    case 'reject':
      await complete(r.id, s.step_id, ['WAITING_APPROVAL'], {
        status: 'FAILURE',
        statusLabel: 'Rejected: the approval expired',
        output: { approved: false, expired: true, by: null, comment: 'The approval expired' },
      });
      break;
    case 'approve':
      await complete(r.id, s.step_id, ['WAITING_APPROVAL'], {
        status: 'SUCCESS',
        statusLabel: 'Approved: the approval expired',
        output: { approved: true, expired: true, by: approved, comments: [] },
      });
      break;
    case 'skip':
      if (
        await setStep(r.id, s.step_id, 'WAITING_APPROVAL', { status: 'SKIPPED', status_label: 'Skipped: the approval expired', ended_at: now(), next_at: null })
      ) {
        await addLog(r.id, 'The approval expired: step skipped', 'warn', s.step_id);
        await emitRun(r.id, 'run.updated');
        await advance(r.id);
      }
      break;
  }
  return true;
}

/** The pre-start approval expired: fail (default), reject, or start the workflow anyway (approve / skip). */
async function expireRun(r: Pick<RunRow, 'id' | 'approval_expires_at'>) {
  const run = await getRunRow(r.id);
  const policy = json<ApprovalPolicy>(run.approval, { required: false });
  const outcome = policy.onExpiry ?? 'fail';
  const status = outcome === 'fail' ? 'FAILURE' : outcome === 'reject' ? 'REJECTED' : 'QUEUED';
  const label = { fail: 'Approval expired', reject: 'Rejected: the approval expired', approve: 'Approved: the approval expired', skip: null }[outcome];
  const t = now();
  // Claimed by the transition itself; a run that stopped waiting only gets its timer cleared.
  const { changes } = await exec(
    `UPDATE runs SET status = ?, status_label = ?, ended_at = ?, updated_at = ?, approval_expires_at = NULL, remind_at = NULL, escalate_at = NULL
     WHERE id = ? AND status = 'PENDING_APPROVAL' AND approval_expires_at = ?`,
    status,
    label,
    status === 'QUEUED' ? null : t,
    t,
    r.id,
    r.approval_expires_at!,
  );
  if (!changes) return void (await exec('UPDATE runs SET approval_expires_at = NULL WHERE id = ? AND approval_expires_at = ?', r.id, r.approval_expires_at!));
  const text = {
    fail: 'The approval expired: run failed',
    reject: 'The approval expired: run rejected',
    approve: 'The approval expired: approved, queued for execution',
    skip: 'The approval expired: approval skipped, queued for execution',
  }[outcome];
  await addLog(r.id, text, status === 'QUEUED' ? 'warn' : 'error');
  await audit(SYSTEM, 'run.approval_expired', run.action, { runId: r.id, outcome });
  if (status === 'QUEUED') wake();
  else metrics.runFinished(run.action, status, 'workflow', null);
  await emitRun(r.id, 'run.updated');
}

// ---------- reminders and escalation ----------
async function remindStep(s: StepRow) {
  const r = await getRunRow(s.run_id);
  const def = stepDefs(r).find((d) => d.id === s.step_id);
  const waiting =
    r.status === 'IN_PROGRESS' && ((def?.type === 'approval' && s.status === 'WAITING_APPROVAL') || (def?.type === 'input' && s.status === 'WAITING'));
  const t = (def ?? {}) as Timers;
  const max = t.maxReminders ?? DEFAULT_MAX_REMINDERS;
  const n = Number(s.reminders ?? 0) + 1;
  const next = waiting && n < max ? due(t.remindEvery) : null;
  const { changes } = await exec(
    'UPDATE run_steps SET remind_at = ?, reminders = reminders + ? WHERE run_id = ? AND step_id = ? AND remind_at = ?',
    next,
    waiting ? 1 : 0,
    s.run_id,
    s.step_id,
    s.remind_at!,
  );
  if (!changes || !waiting || !def) return;
  const approvals = (await stepApprovalsOf([r.id])).get(`${r.id}/${s.step_id}`) ?? [];
  await addLog(r.id, `Reminder ${n}/${max} sent to the ${def.type === 'input' ? 'people asked' : 'approvers'} who have not decided`, 'info', s.step_id);
  await notifyPendingDecision({
    run: r,
    kind: def.type === 'input' ? 'input' : 'approval',
    subjects: def.type === 'approval' ? stepApproverSets(def, s, approvals) : (def as InputStep).assignees,
    allowSelf: def.type === 'approval' ? def.allowSelfApproval : undefined,
    stepName: def.name || def.id,
    message: stepMessage(s),
    reminder: { n, of: max },
    exclude: decidedIds(approvals),
  });
}

async function escalateStep(s: StepRow) {
  const t = now();
  const { changes } = await exec(
    "UPDATE run_steps SET escalate_at = NULL, escalated_at = ? WHERE run_id = ? AND step_id = ? AND escalate_at = ? AND status = 'WAITING_APPROVAL'",
    t,
    s.run_id,
    s.step_id,
    s.escalate_at!,
  );
  if (!changes)
    return void (await exec(
      'UPDATE run_steps SET escalate_at = NULL WHERE run_id = ? AND step_id = ? AND escalate_at = ?',
      s.run_id,
      s.step_id,
      s.escalate_at!,
    ));
  const r = await getRunRow(s.run_id);
  const def = stepDefs(r).find((d) => d.id === s.step_id);
  if (def?.type !== 'approval' || !def.escalate || r.status !== 'IN_PROGRESS') return;
  const to = approverSubjects(def.escalate.approvers);
  await addLog(r.id, `Escalated: no decision within ${def.escalate.after}; ${describeSubjects(to)} may now approve`, 'warn', s.step_id);
  await audit(SYSTEM, 'run.step_escalated', `${r.action} · ${s.name}`, { runId: r.id, step: s.step_id });
  const approvals = (await stepApprovalsOf([r.id])).get(`${r.id}/${s.step_id}`) ?? [];
  await notifyPendingDecision({
    run: r,
    kind: 'approval',
    subjects: to,
    allowSelf: def.allowSelfApproval,
    stepName: def.name || def.id,
    message: stepMessage(s),
    escalation: { after: def.escalate.after },
    exclude: decidedIds(approvals),
  });
  await emitRun(r.id, 'run.updated'); // in-app notifications for the people now eligible
}

async function remindRun(row: Pick<RunRow, 'id' | 'remind_at'>) {
  const r = await getRunRow(row.id);
  const policy = json<ApprovalPolicy>(r.approval, { required: false });
  const waiting = r.status === 'PENDING_APPROVAL';
  const max = policy.maxReminders ?? DEFAULT_MAX_REMINDERS;
  const n = Number(r.reminders ?? 0) + 1;
  const next = waiting && n < max ? due(policy.remindEvery) : null;
  const { changes } = await exec(
    'UPDATE runs SET remind_at = ?, reminders = reminders + ? WHERE id = ? AND remind_at = ?',
    next,
    waiting ? 1 : 0,
    r.id,
    row.remind_at!,
  );
  if (!changes || !waiting) return;
  const approvals = await runApprovalsOf(r.id);
  await addLog(r.id, `Reminder ${n}/${max} sent to the approvers who have not decided`);
  await notifyPendingDecision({
    run: r,
    kind: 'approval',
    subjects: runApproverSets(r, policy),
    allowSelf: policy.allowSelfApproval,
    reminder: { n, of: max },
    exclude: decidedIds(approvals),
  });
}

async function escalateRun(row: Pick<RunRow, 'id' | 'escalate_at'>) {
  const { changes } = await exec(
    "UPDATE runs SET escalate_at = NULL, escalated_at = ? WHERE id = ? AND escalate_at = ? AND status = 'PENDING_APPROVAL'",
    now(),
    row.id,
    row.escalate_at!,
  );
  if (!changes) return void (await exec('UPDATE runs SET escalate_at = NULL WHERE id = ? AND escalate_at = ?', row.id, row.escalate_at!));
  const r = await getRunRow(row.id);
  const policy = json<ApprovalPolicy>(r.approval, { required: false });
  if (!policy.escalate) return;
  const to = approverSubjects(policy.escalate.approvers);
  await addLog(r.id, `Escalated: no decision within ${policy.escalate.after}; ${describeSubjects(to)} may now approve`, 'warn');
  await audit(SYSTEM, 'run.escalated', r.action, { runId: r.id });
  await notifyPendingDecision({
    run: r,
    kind: 'approval',
    subjects: to,
    allowSelf: policy.allowSelfApproval,
    escalation: { after: policy.escalate.after },
    exclude: decidedIds(await runApprovalsOf(r.id)),
  });
  await emitRun(r.id, 'run.updated');
}

/**
 * Due reminders, escalations and pre-start expiries (called by the engine's housekeeping). Every action is claimed
 * with a conditional UPDATE, so concurrent passes never send a reminder twice. Each runs in its run's organization.
 */
export async function approvalTimers(log?: FastifyBaseLogger) {
  const t = now();
  const guard = (what: string, runId: string, fn: () => Promise<unknown>) =>
    inRunOrg(runId, fn).catch((err) => (log ? log.error({ err, runId }, what) : console.error(`[approvals] ${what}`, runId, err)));
  const isDue = (v: string | null | undefined): v is string => !!v && v <= t;
  // Two bounded scans (steps, runs), each served by the partial indexes on the due-time columns.
  for (const s of await all<StepRow>(
    'SELECT * FROM run_steps WHERE (remind_at IS NOT NULL AND remind_at <= ?) OR (escalate_at IS NOT NULL AND escalate_at <= ?) LIMIT ?',
    t,
    t,
    BATCH,
  )) {
    if (isDue(s.escalate_at)) await guard('step escalation', s.run_id, () => escalateStep(s));
    if (isDue(s.remind_at)) await guard('step reminder', s.run_id, () => remindStep(s));
  }
  for (const r of await all<Pick<RunRow, 'id' | 'remind_at' | 'escalate_at' | 'approval_expires_at'>>(
    `SELECT id, remind_at, escalate_at, approval_expires_at FROM runs
     WHERE (remind_at IS NOT NULL AND remind_at <= ?) OR (escalate_at IS NOT NULL AND escalate_at <= ?)
        OR (approval_expires_at IS NOT NULL AND approval_expires_at <= ?) LIMIT ?`,
    t,
    t,
    t,
    BATCH,
  )) {
    if (isDue(r.approval_expires_at)) {
      await guard('approval expiry', r.id, () => expireRun(r));
      continue; // the run stopped waiting: expiry cleared its other timers
    }
    if (isDue(r.escalate_at)) await guard('approval escalation', r.id, () => escalateRun(r));
    if (isDue(r.remind_at)) await guard('approval reminder', r.id, () => remindRun(r));
  }
}
