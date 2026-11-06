import type { RunApproval, RunStep, StepStatus, Subjects } from '@asterius/shared';
import { all, json } from '../db.js';
import { runCosts } from '../ai/usage.js';
import { matchesSubjects, type Principal } from '../auth/users.js';
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
  s && (s.roles?.length || s.teams?.length || s.users?.length || s.ownerTeam) ? s : { roles: ['admin'] };

export function canApproveStep(p: Principal, run: RunRow, def: Step, row: StepRow, approvals: RunApproval[]) {
  if (def.type !== 'approval' || row.status !== 'WAITING_APPROVAL' || run.status !== 'IN_PROGRESS') return false;
  if (!def.allowSelfApproval && run.triggered_by === p.id) return false;
  if (approvals.some((a) => a.userId === p.id)) return false;
  return matchesSubjects(p, approverSubjects(def.approvers), run.team);
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
      costUsd: costs.get(row.step_id) ?? null,
      approvals: list,
      ...(p && def ? { canApprove: canApproveStep(p, run, def, row, list) } : {}),
      startedAt: row.started_at,
      endedAt: row.ended_at,
    };
  });
}
