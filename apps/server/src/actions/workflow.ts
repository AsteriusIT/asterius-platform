import { badRequest } from '../lib/errors.js';
import { checkExpression, checkTemplate } from '../lib/expr.js';
import { validator } from '../catalog/validation.js';
import { validateInvoker } from './invokers/index.js';
import type { ActionDef, WorkflowStepDef } from '../schemas.js';

/**
 * Workflow definitions: the steps of an action, as a graph.
 *  - `needs` omitted → the step waits for the previous step (a plain list runs sequentially);
 *  - `needs: []` → starts with the workflow; `needs: [a, b]` → waits for both (fan-in, parallel branches).
 * Steps may only depend on steps declared before them, so a workflow can never contain a cycle.
 */

export type Step = WorkflowStepDef;

/** A legacy single-invoker action is a one-step workflow. */
export function stepsOf(def: Pick<ActionDef, 'steps' | 'invoker' | 'title'>): Step[] {
  if (def.steps?.length) return def.steps;
  if (!def.invoker) return []; // a draft: steps are added one by one
  return [
    {
      id: 'run',
      name: def.title,
      type: 'invoke',
      invoker: def.invoker!,
      retries: 0,
      retryDelaySeconds: 30,
      continueOnError: false,
    },
  ];
}

/** Effective dependencies of the step at `index`. */
export const needsOf = (steps: Step[], index: number): string[] => steps[index].needs ?? (index > 0 ? [steps[index - 1].id] : []);

export function validateWorkflow(steps: Step[]) {
  const seen = new Set<string>();
  steps.forEach((s, i) => {
    const where = `Step ${i + 1} (${s.id})`;
    if (seen.has(s.id)) throw badRequest(`${where}: the id "${s.id}" is used twice`);
    for (const n of s.needs ?? []) if (!seen.has(n)) throw badRequest(`${where}: "needs" may only name earlier steps (unknown or later step "${n}")`);
    seen.add(s.id);
    try {
      if (s.if) checkExpression(s.if);
      switch (s.type) {
        case 'invoke':
          validateInvoker(s.invoker as { type: string } & Record<string, unknown>);
          break;
        case 'approval':
          if (s.message) checkTemplate(s.message);
          break;
        case 'agent':
          checkTemplate([s.prompt, s.system ?? '', s.apiKey ?? '']);
          if (s.output) validator(s.output as never);
          break;
        case 'transform':
          for (const expr of Object.values(s.output)) checkExpression(expr);
          break;
      }
    } catch (err) {
      throw badRequest(`${where}: ${(err as Error).message}`);
    }
  });
}

/** Columns for display: each step goes one stage after the latest of its dependencies. */
export function stagesOf(steps: Pick<Step, 'id' | 'needs'>[]): string[][] {
  const level = new Map<string, number>();
  steps.forEach((s, i) => {
    const deps = s.needs ?? (i > 0 ? [steps[i - 1].id] : []);
    level.set(s.id, deps.length ? Math.max(...deps.map((d) => level.get(d) ?? 0)) + 1 : 0);
  });
  const stages: string[][] = [];
  for (const s of steps) (stages[level.get(s.id)!] ??= []).push(s.id);
  return stages.filter(Boolean);
}
