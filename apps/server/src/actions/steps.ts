import type { ApprovalProgress, ObjectSchema, RunApproval, RunStep, StepStatus, Subjects } from '@asterius/shared';
import { all, json } from '../db.js';
import { runCosts } from '../ai/usage.js';
import { isAdmin, matchesSubjects, type Principal } from '../auth/users.js';
import type { RunRow } from './runs.js';
import { needsOf, type Step } from './workflow.js';

/** Persistence and read model of workflow steps (run_steps, step_approvals). */

export interface StepRow {
  run_id: string;
  step_id: string;
  position: number;
  name: string;
  type: Step['type'];
  status: StepStatus;
  status_label: string | null;
  attempt: number;
  output: string | null;
  state: string | null;
  link: string | null;
  worker: string | null;
  locked_until: string | null;
  next_at: string | null;
  deadline_at: string | null;
  started_at: string | null;
  ended_at: string | null;
  /** Approval / input steps (migration 3): next reminder, reminders sent, escalation due and done. */
  remind_at?: string | null;
  reminders?: number;
  escalate_at?: string | null;
  escalated_at?: string | null;
}

export const TERMINAL: StepStatus[] = ['SUCCESS', 'FAILURE', 'SKIPPED', 'CANCELLED'];
export const isTerminal = (s: StepStatus) => TERMINAL.includes(s);

export const loadSteps = (runId: string) => all<StepRow>('SELECT * FROM run_steps WHERE run_id = ? ORDER BY position', runId);
export const stepDefs = (r: Pick<RunRow, 'steps'>) => json<Step[]>(r.steps, []);

export async function stepApprovalsOf(runIds: string[]): Promise<Map<string, RunApproval[]>> {
  const out = new Map<string, RunApproval[]>();
  if (!runIds.length) return out;
  const rows = await all<DecisionRow & { run_id: string; step_id: string; tier: number | null }>(
    `SELECT a.run_id, a.step_id, a.user_id, u.name, a.decision, a.comment, a.at, a.tier, a.on_behalf_of, b.name AS behalf_name
     FROM step_approvals a JOIN users u ON u.id = a.user_id LEFT JOIN users b ON b.id = a.on_behalf_of
     WHERE a.run_id IN (${runIds.map(() => '?').join(',')}) ORDER BY a.at`,
    ...runIds,
  );
  for (const r of rows) {
    const key = `${r.run_id}/${r.step_id}`;
    out.set(key, [...(out.get(key) ?? []), { ...toApproval(r), tier: r.tier === null ? null : Number(r.tier) }]);
  }
  return out;
}

/** A decision row (run_approvals / step_approvals joined with the users who decided and, for a delegate, on behalf of whom). */
export interface DecisionRow {
  user_id: string;
  name: string;
  decision: RunApproval['decision'];
  comment: string;
  at: string;
  on_behalf_of: string | null;
  behalf_name: string | null;
}
export const toApproval = (r: DecisionRow): RunApproval => ({
  userId: r.user_id,
  userName: r.name,
  decision: r.decision,
  comment: r.comment,
  at: r.at,
  onBehalfOf: r.on_behalf_of ? { id: r.on_behalf_of, name: r.behalf_name ?? '' } : null,
});

type ApprovalDef = Extract<Step, { type: 'approval' }>;

/** Tiered approvals: index of the open tier, the first below its minimum (`tiers.length` once all are done). */
export function openTier(def: Pick<ApprovalDef, 'tiers'>, approvals: Pick<RunApproval, 'decision' | 'tier'>[]): number {
  const tiers = def.tiers ?? [];
  for (const [i, t] of tiers.entries()) if (approvals.filter((a) => a.decision === 'approved' && a.tier === i).length < (t.minApprovals ?? 1)) return i;
  return tiers.length;
}

/** Who may approve an approval step now: the open tier's approvers (or the step's), plus the escalation approvers once escalated. */
export function stepApproverSets(def: ApprovalDef, row: Pick<StepRow, 'escalated_at'>, approvals: Pick<RunApproval, 'decision' | 'tier'>[]): Subjects[] {
  const base = def.tiers?.length
    ? approverSubjects(def.tiers[Math.min(openTier(def, approvals), def.tiers.length - 1)].approvers)
    : approverSubjects(def.approvers);
  return row.escalated_at && def.escalate ? [base, def.escalate.approvers] : [base];
}

/**
 * Whose eligibility a decision by `p` uses: `p` itself, or a person `p` is the active delegate of (`p.delegators`).
 * Null when `p` cannot decide: not eligible, already decided (also through a delegate), or the requester without
 * self-approval — a delegate never approves their own request, nor the request of the person they stand in for.
 */
export function decidingFor(
  p: Principal,
  o: { sets: Subjects[]; team: string | null; requester: string; allowSelf: boolean; approvals: Pick<RunApproval, 'userId' | 'onBehalfOf'>[] },
): Principal | null {
  const decided = (id: string) => o.approvals.some((a) => a.userId === id || a.onBehalfOf?.id === id);
  if ((!o.allowSelf && o.requester === p.id) || decided(p.id)) return null;
  const can = (x: Principal) => !decided(x.id) && (o.allowSelf || x.id !== o.requester) && o.sets.some((s) => matchesSubjects(x, s, o.team));
  if (can(p)) return p;
  return (p.delegators ?? []).find(can) ?? null;
}

/** Approvers default to admins when a step names nobody. */
export const approverSubjects = (s: Subjects | undefined): Subjects =>
  s && (s.roles?.length || s.teams?.length || s.users?.length || s.ownerTeam) ? s : { roles: ['admin', 'approver'] };

/** The person whose approval `p` gives on this step (themselves or a delegator), or null when `p` cannot decide. */
export function stepDecider(p: Principal, run: RunRow, def: Step, row: StepRow, approvals: RunApproval[]): Principal | null {
  if (def.type !== 'approval' || row.status !== 'WAITING_APPROVAL' || run.status !== 'IN_PROGRESS') return null;
  return decidingFor(p, {
    sets: stepApproverSets(def, row, approvals),
    team: run.team,
    requester: run.triggered_by,
    allowSelf: def.allowSelfApproval,
    approvals,
  });
}

export const canApproveStep = (p: Principal, run: RunRow, def: Step, row: StepRow, approvals: RunApproval[]) => !!stepDecider(p, run, def, row, approvals);

/** Who may answer an input step: the assignees, or the requester and admins when none are named (or their active delegates). */
export function inputResponder(p: Principal, r: RunRow, def: Step, row: StepRow): Principal | null {
  if (def.type !== 'input' || row.status !== 'WAITING' || r.status !== 'IN_PROGRESS') return null;
  const named = def.assignees && (def.assignees.roles?.length || def.assignees.teams?.length || def.assignees.users?.length || def.assignees.ownerTeam);
  const can = (x: Principal) => (named ? matchesSubjects(x, def.assignees, r.team) : isAdmin(x) || r.triggered_by === x.id);
  return can(p) ? p : ((p.delegators ?? []).find(can) ?? null);
}

export const canSubmitInput = (p: Principal, r: RunRow, def: Step, row: StepRow) => !!inputResponder(p, r, def, row);

/** Tiers, escalation and reminders of an approval or input step (run page). */
function approvalProgress(def: Step | undefined, row: StepRow, approvals: RunApproval[]): ApprovalProgress | null {
  if (def?.type !== 'approval' && def?.type !== 'input') return null;
  const timers = { reminders: Number(row.reminders ?? 0), nextReminderAt: row.remind_at ?? null };
  if (def.type === 'input') return def.remindEvery ? timers : null;
  const open = openTier(def, approvals);
  return {
    ...(def.tiers?.length
      ? {
          tiers: def.tiers.map((t, i) => ({
            name: t.name,
            minApprovals: t.minApprovals ?? 1,
            approved: approvals.filter((a) => a.decision === 'approved' && a.tier === i).length,
            state: i < open ? ('done' as const) : i === open ? ('open' as const) : ('waiting' as const),
          })),
        }
      : {}),
    escalatedAt: row.escalated_at ?? null,
    escalateAt: row.escalate_at ?? null,
    ...timers,
  };
}

export const canManageRun = (p: Principal, r: Pick<RunRow, 'triggered_by'>) => isAdmin(p) || r.triggered_by === p.id;
/** `state` of a step skipped because a dependency did not succeed (engine.ts). */
export const BLOCKED_STATE = '{"blocked":true}';
const REOPENABLE: RunRow['status'][] = ['IN_PROGRESS', 'FAILURE', 'CANCELLED'];

/** Steps to start over when a run resumes: failed or cancelled ones (not those allowed to fail) and the steps skipped because of them. */
export function resumableSteps(defs: Step[], rows: Pick<StepRow, 'step_id' | 'status' | 'state'>[]): string[] {
  return rows
    .filter((s) => {
      const def = defs.find((d) => d.id === s.step_id);
      return (s.status === 'FAILURE' && !def?.continueOnError) || s.status === 'CANCELLED' || (s.status === 'SKIPPED' && s.state === BLOCKED_STATE);
    })
    .map((s) => s.step_id);
}

export const canRetryStep = (p: Principal, r: RunRow, row: Pick<StepRow, 'status'>) =>
  canManageRun(p, r) && row.status === 'FAILURE' && REOPENABLE.includes(r.status);

/** Child runs started by a `workflow` step (one, or one per item of a fan-out). */
function childrenOf(row: StepRow): { runId: string; status: string; item?: unknown }[] | undefined {
  const s = json<{ kind?: string; runId?: string; runs?: (string | null)[]; items?: unknown[]; results?: ({ status: string } | null)[] } | null>(
    row.state,
    null,
  );
  if (s?.kind === 'workflow' && s.runId) return [{ runId: s.runId, status: 'RUNNING' }];
  if (s?.kind === 'foreach')
    return (s.runs ?? []).flatMap((id, i) => (id ? [{ runId: id, status: s.results?.[i]?.status ?? 'RUNNING', item: s.items?.[i] }] : []));
  return undefined;
}

export const stepMessage = (row: StepRow) => json<{ message?: string }>(row.state, {}).message ?? null;

export async function runStepsView(run: RunRow, p: Principal | null): Promise<RunStep[]> {
  const defs = stepDefs(run);
  const rows = await loadSteps(run.id);
  const approvals = await stepApprovalsOf([run.id]);
  const costs = (await runCosts(run.id)).steps;
  return rows.map((row) => {
    const i = defs.findIndex((d) => d.id === row.step_id);
    const def = defs[i];
    const list = approvals.get(`${run.id}/${row.step_id}`) ?? [];
    return {
      id: row.step_id,
      name: row.name,
      type: row.type,
      needs: def ? needsOf(defs, i) : [],
      status: row.status,
      statusLabel: row.status_label,
      attempt: Number(row.attempt),
      maxAttempts: (def?.retries ?? 0) + 1,
      continueOnError: !!def?.continueOnError,
      output: json(row.output, null),
      link: row.link,
      message: stepMessage(row),
      form: def?.type === 'input' ? (def.inputs as ObjectSchema) : def?.type === 'approval' ? ((def.fields as ObjectSchema | undefined) ?? null) : null,
      choices: def?.type === 'approval' ? (def.choices ?? null) : null,
      children: childrenOf(row),
      costUsd: costs.get(row.step_id) ?? null,
      approvals: list,
      approval: approvalProgress(def, row, list),
      ...(p && def
        ? { canApprove: canApproveStep(p, run, def, row, list), canRetry: canRetryStep(p, run, row), canSubmit: canSubmitInput(p, run, def, row) }
        : {}),
      startedAt: row.started_at,
      endedAt: row.ended_at,
    };
  });
}
