import type { ObjectSchema, RunApproval, RunStep, StepStatus, Subjects } from '@asterius/shared';
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

/** Top-level fragment step an inlined step belongs to (fragments.ts). */
const fragmentOf = (def: Step | undefined) => (def as { fragmentOf?: { root: string } } | undefined)?.fragmentOf?.root;

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
      ...(fragmentOf(def) ? { fragment: fragmentOf(def) } : {}),
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
      ...(p && def
        ? { canApprove: canApproveStep(p, run, def, row, list), canRetry: canRetryStep(p, run, row), canSubmit: canSubmitInput(p, run, def, row) }
        : {}),
      startedAt: row.started_at,
      endedAt: row.ended_at,
    };
  });
}
