import type { Action, StepStatus, WorkflowStep, WorkflowStepType } from '@asterius/shared';

/** Client-side helpers for workflows (same rules as apps/server/src/actions/workflow.ts). */

export const needsOf = (steps: Pick<WorkflowStep, 'id' | 'needs'>[], i: number) => steps[i].needs ?? (i > 0 ? [steps[i - 1].id] : []);

/** Columns of the graph: each step one stage after the latest of its dependencies. */
export function stagesOf<T extends { id: string; needs?: string[] }>(steps: T[]): T[][] {
  const level = new Map<string, number>();
  steps.forEach((s, i) => {
    const deps = needsOf(steps, i);
    level.set(s.id, deps.length ? Math.max(...deps.map((d) => level.get(d) ?? 0)) + 1 : 0);
  });
  const stages: T[][] = [];
  for (const s of steps) (stages[level.get(s.id) ?? 0] ??= []).push(s);
  return stages.filter(Boolean);
}

export const STEP_TYPES: Record<WorkflowStepType, { label: string; color: string; hint: string }> = {
  invoke: { label: 'Integration', color: 'blue', hint: 'Call a pipeline, a webhook, a Kubernetes Job or the catalog' },
  approval: { label: 'Approval', color: 'yellow', hint: 'Wait for people to approve before continuing' },
  agent: { label: 'AI agent', color: 'grape', hint: 'Ask Claude; its answer (text or structured JSON) feeds later steps' },
  transform: { label: 'Transform', color: 'teal', hint: 'Compute values from inputs and earlier outputs (JSONata)' },
  wait: { label: 'Wait', color: 'orange', hint: 'Pause for a duration, until a time, or until an external event arrives' },
  input: { label: 'Input', color: 'cyan', hint: 'Ask the requester or an operator for more data mid-run' },
  workflow: { label: 'Sub-workflow', color: 'indigo', hint: 'Run another workflow (once, or for each item of a list) and use its result' },
};

export const STEP_STATUS_COLORS: Record<StepStatus, string> = {
  PENDING: 'gray',
  QUEUED: 'gray',
  RUNNING: 'blue',
  WAITING_APPROVAL: 'yellow',
  WAITING: 'orange',
  SUCCESS: 'brand',
  FAILURE: 'red',
  SKIPPED: 'gray',
  CANCELLED: 'gray',
};

export const STEP_STATUS_LABELS: Record<StepStatus, string> = {
  PENDING: 'Pending',
  QUEUED: 'Queued',
  RUNNING: 'Running',
  WAITING_APPROVAL: 'Waiting for approval',
  WAITING: 'Waiting',
  SUCCESS: 'Succeeded',
  FAILURE: 'Failed',
  SKIPPED: 'Skipped',
  CANCELLED: 'Cancelled',
};

/** "github-workflow" for a one-step action, "workflow · 3 steps" otherwise. */
export function workflowSummary(a: Pick<Action, 'steps' | 'invoker'>) {
  const steps = a.steps ?? [];
  if (!steps.length) return 'no steps yet';
  if (steps.length === 1 && steps[0].type === 'invoke') return steps[0].invoker?.type ?? a.invoker?.type ?? 'invoke';
  return `workflow · ${steps.length} steps`;
}

/** Label and colour of a trigger in tables. */
export function triggerBadge(t: NonNullable<Action['trigger']>): { label: string; color: string } {
  switch (t.type) {
    case 'form':
      return { label: `form · ${t.on}`, color: t.on === 'delete' ? 'red' : t.on === 'create' ? 'green' : 'blue' };
    case 'api':
      return { label: 'api', color: 'cyan' };
    case 'schedule':
      return { label: `schedule · ${t.cron}`, color: 'grape' };
    case 'event':
      return { label: `event · ${t.event}`, color: 'orange' };
    case 'webhook':
      return { label: 'webhook', color: 'teal' };
  }
}
