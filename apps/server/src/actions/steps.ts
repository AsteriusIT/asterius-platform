import type { ObjectSchema, RunApproval, RunStep, StepStatus, Subjects } from '@asterius/shared';
import { all, json } from '../db.js';
import { runCosts } from '../ai/usage.js';
import { isAdmin, matchesSubjects, type Principal } from '../auth/users.js';
import type { RunRow } from './runs.js';
import { ancestorsOf, casesOf, needsOf, type Step } from './workflow.js';

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
  sla_due_at?: string | null;
  sla_breached_at?: string | null;
}

export const TERMINAL: StepStatus[] = ['SUCCESS', 'FAILURE', 'SKIPPED', 'CANCELLED'];
export const isTerminal = (s: StepStatus) => TERMINAL.includes(s);

export const loadSteps = (runId: string) => all<StepRow>('SELECT * FROM run_steps WHERE run_id = ? ORDER BY position', runId);
export const stepDefs = (r: Pick<RunRow, 'steps'>) => json<Step[]>(r.steps, []);

export async function stepApprovalsOf(runIds: string[]): Promise<Map<string, RunApproval[]>> {
  const out = new Map<string, RunApproval[]>();
  if (!runIds.length) return out;
  const rows = await all<{ run_id: string; step_id: string; user_id: string; name: string; decision: RunApproval['decision']; comment: string; at: string }>(
    `SELECT a.run_id, a.step_id, a.user_id, u.name, a.decision, a.comment, a.at FROM step_approvals a JOIN users u ON u.id = a.user_id
     WHERE a.run_id IN (${runIds.map(() => '?').join(',')}) ORDER BY a.at`,
    ...runIds,
  );
  for (const r of rows) {
    const key = `${r.run_id}/${r.step_id}`;
    out.set(key, [...(out.get(key) ?? []), { userId: r.user_id, userName: r.name, decision: r.decision, comment: r.comment, at: r.at }]);
  }
  return out;
}

/** Approvers default to admins when a step names nobody. */
export const approverSubjects = (s: Subjects | undefined): Subjects =>
  s && (s.roles?.length || s.teams?.length || s.users?.length || s.ownerTeam) ? s : { roles: ['admin', 'approver'] };

export function canApproveStep(p: Principal, run: RunRow, def: Step, row: StepRow, approvals: RunApproval[]) {
  if (def.type !== 'approval' || row.status !== 'WAITING_APPROVAL' || run.status !== 'IN_PROGRESS') return false;
  if (!def.allowSelfApproval && run.triggered_by === p.id) return false;
  if (approvals.some((a) => a.userId === p.id)) return false;
  return matchesSubjects(p, approverSubjects(def.approvers), run.team);
}

/** Who may answer an input step: the assignees, or the requester and admins when none are named. */
export function canSubmitInput(p: Principal, r: RunRow, def: Step, row: StepRow) {
  if (def.type !== 'input' || row.status !== 'WAITING' || r.status !== 'IN_PROGRESS') return false;
  const named = def.assignees && (def.assignees.roles?.length || def.assignees.teams?.length || def.assignees.users?.length || def.assignees.ownerTeam);
  if (!named) return isAdmin(p) || r.triggered_by === p.id;
  return matchesSubjects(p, def.assignees, r.team);
}

export const canManageRun = (p: Principal, r: Pick<RunRow, 'triggered_by'>) => isAdmin(p) || r.triggered_by === p.id;
/** `state` of a step skipped because a dependency did not succeed (engine.ts). */
export const BLOCKED_STATE = '{"blocked":true}';
const REOPENABLE: RunRow['status'][] = ['IN_PROGRESS', 'FAILURE', 'CANCELLED'];

/** Marks the `state` of a step failed by a timeout with `onTimeout: continue` (treated like continueOnError). */
export const timedOutState = (state: string | null, how: 'continue' | 'skip') => JSON.stringify({ ...json<object>(state, {}), timedOut: how });

type FlowRow = Pick<StepRow, 'step_id' | 'status' | 'state'>;

/** A failure of this step does not fail the workflow (continueOnError, or a timeout with `onTimeout: continue`). */
export const allowedToFail = (def: Pick<Step, 'continueOnError'> | undefined, row: Pick<StepRow, 'state'>) =>
  !!def?.continueOnError || (!!row.state?.includes('"timedOut":"continue"') && json<{ timedOut?: string }>(row.state, {}).timedOut === 'continue');

/** Failed steps *handled* by a `when: failure` step downstream of them that succeeded. */
export function handledFailures(defs: Step[], rows: FlowRow[]): Set<string> {
  const status = new Map(rows.map((r) => [r.step_id, r.status]));
  const handlers = defs.filter((d) => d.when === 'failure' && status.get(d.id) === 'SUCCESS');
  const out = new Set<string>();
  if (!handlers.length) return out;
  const anc = ancestorsOf(defs);
  for (const r of rows) if (r.status === 'FAILURE' && handlers.some((h) => anc.get(h.id)?.has(r.step_id))) out.add(r.step_id);
  return out;
}

/** The step that makes a finished workflow fail: cancelled, or failed without being allowed to fail or handled. */
export function unhandledFailure<R extends FlowRow>(defs: Step[], rows: R[]): R | undefined {
  const handled = handledFailures(defs, rows);
  return rows.find(
    (s) =>
      s.status === 'CANCELLED' ||
      (s.status === 'FAILURE' &&
        !allowedToFail(
          defs.find((d) => d.id === s.step_id),
          s,
        ) &&
        !handled.has(s.step_id)),
  );
}

/** `ids` and every terminal step downstream of them (their outcome depended on the steps that start over). */
export function withDownstream(defs: Step[], rows: FlowRow[], ids: string[]): string[] {
  const anc = ancestorsOf(defs);
  const seeds = new Set(ids);
  return rows.filter((s) => seeds.has(s.step_id) || (isTerminal(s.status) && [...(anc.get(s.step_id) ?? [])].some((a) => seeds.has(a)))).map((s) => s.step_id);
}

/**
 * Steps to start over when a run resumes: failed or cancelled ones (not those allowed to fail or handled), the steps
 * skipped because of them, and whatever ran downstream of them (`when: always` / `failure` steps, branch decisions).
 */
export function resumableSteps(defs: Step[], rows: FlowRow[]): string[] {
  const handled = handledFailures(defs, rows);
  const seeds = rows
    .filter((s) => {
      const def = defs.find((d) => d.id === s.step_id);
      return (
        (s.status === 'FAILURE' && !allowedToFail(def, s) && !handled.has(s.step_id)) ||
        s.status === 'CANCELLED' ||
        (s.status === 'SKIPPED' && s.state === BLOCKED_STATE)
      );
    })
    .map((s) => s.step_id);
  return seeds.length ? withDownstream(defs, rows, seeds) : [];
}

export const canRetryStep = (p: Principal, r: RunRow, row: Pick<StepRow, 'status'>) =>
  canManageRun(p, r) && row.status === 'FAILURE' && REOPENABLE.includes(r.status);

/** Steps an admin may force to SKIPPED or SUCCESS (operations.ts), in a run in progress or failed. */
export const FORCEABLE: StepStatus[] = ['PENDING', 'QUEUED', 'RUNNING', 'WAITING', 'WAITING_APPROVAL', 'FAILURE'];
export const canForceStep = (p: Principal, r: RunRow, row: Pick<StepRow, 'status'>) =>
  isAdmin(p) && FORCEABLE.includes(row.status) && ['IN_PROGRESS', 'FAILURE'].includes(r.status) && !Number(r.cancel_requested);

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
  const handled = handledFailures(defs, rows);
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
      continueOnError: allowedToFail(def, row),
      ...(def?.when && def.when !== 'success' ? { when: def.when } : {}),
      ...(def && casesOf(def).length ? { case: casesOf(def) } : {}),
      ...(handled.has(row.step_id) ? { handled: true } : {}),
      output: json(row.output, null),
      link: row.link,
      message: stepMessage(row),
      form: def?.type === 'input' ? (def.inputs as ObjectSchema) : def?.type === 'approval' ? ((def.fields as ObjectSchema | undefined) ?? null) : null,
      choices: def?.type === 'approval' ? (def.choices ?? null) : null,
      children: childrenOf(row),
      costUsd: costs.get(row.step_id) ?? null,
      approvals: list,
      ...(p && def
        ? {
            canApprove: canApproveStep(p, run, def, row, list),
            canRetry: canRetryStep(p, run, row),
            canSubmit: canSubmitInput(p, run, def, row),
            canSkip: canForceStep(p, run, row),
            canComplete: canForceStep(p, run, row),
          }
        : {}),
      slaBreachedAt: row.sla_breached_at ?? null,
      startedAt: row.started_at,
      endedAt: row.ended_at,
    };
  });
}
