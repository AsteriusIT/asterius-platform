import { badRequest } from '../lib/errors.js';
import { checkExpression, checkTemplate, hasRefs } from '../lib/expr.js';
import { validator } from '../catalog/validation.js';
import { config } from '../config.js';
import { checkGuardrails } from '../ai/guardrails.js';
import { validateInvoker } from './invokers/index.js';
import type { ActionDef, WorkflowStepDef } from '../schemas.js';

/**
 * Workflow definitions: the steps of an action, as a graph.
 *  - `needs` omitted → the step waits for the previous step (a plain list runs sequentially);
 *  - `needs: []` → starts with the workflow; `needs: [a, b]` → waits for both (fan-in, parallel branches).
 * Steps may only depend on steps declared before them, so a workflow can never contain a cycle.
 *
 * Control flow (engine.ts):
 *  - `when`: success (default) runs after its dependencies succeeded (a failed one skips it, "blocked"); failure runs
 *    only if at least one dependency failed (or was blocked by a failure); always runs once they are all done.
 *    A failed step is *handled* when a `when: failure` step that has it upstream succeeded: it no longer fails the run.
 *  - `switch` steps pick one case; steps with `case: <switch>.<case>` of the other branches are skipped (not blocked:
 *    their dependents run as after a false `if`). The switch must be upstream of the steps naming its cases.
 *  - `forEach` on invoke / agent / transform loops inside the step (no child runs).
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

/** Transitive dependencies of every step. */
export function ancestorsOf(steps: Step[]): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  steps.forEach((s, i) => {
    const set = new Set<string>();
    for (const d of needsOf(steps, i)) {
      set.add(d);
      for (const a of out.get(d) ?? []) set.add(a);
    }
    out.set(s.id, set);
  });
  return out;
}

/** `case` of a step as a list of `<switch>.<case>` references. */
export const casesOf = (s: Pick<Step, 'case'>): string[] => (s.case === undefined ? [] : Array.isArray(s.case) ? s.case : [s.case]);

/** Run-level `vars` and `outputs`: templates without secret references (their values are stored with the run). */
export function validateRunTemplates(def: Pick<ActionDef, 'vars' | 'outputs'>) {
  for (const [what, value] of [
    ['vars', def.vars],
    ['outputs', def.outputs],
  ] as const) {
    if (!value) continue;
    try {
      checkTemplate(value);
    } catch (err) {
      throw badRequest(`${what}: ${(err as Error).message}`);
    }
    if (hasRefs(value)) throw badRequest(`${what} cannot reference secrets or environment variables (their values are stored with the run)`);
  }
}

export function validateWorkflow(steps: Step[]) {
  const seen = new Set<string>();
  const switches = new Map<string, Set<string>>();
  const ancestors = ancestorsOf(steps);
  steps.forEach((s, i) => {
    const where = `Step ${i + 1} (${s.id})`;
    if (seen.has(s.id)) throw badRequest(`${where}: the id "${s.id}" is used twice`);
    for (const n of s.needs ?? []) if (!seen.has(n)) throw badRequest(`${where}: "needs" may only name earlier steps (unknown or later step "${n}")`);
    seen.add(s.id);
    try {
      if (s.if) checkExpression(s.if);
      if (s.when === 'failure' && !needsOf(steps, i).length)
        throw new Error('when: failure needs at least one dependency (the steps whose failure it handles)');
      for (const ref of casesOf(s)) {
        const [sw, c] = ref.split('.');
        const cases = switches.get(sw);
        if (!cases) throw new Error(`case "${ref}": "${sw}" is not an earlier switch step`);
        if (!cases.has(c)) throw new Error(`case "${ref}": the switch "${sw}" has no case "${c}" (${[...cases].join(', ')})`);
        if (!ancestors.get(s.id)?.has(sw)) throw new Error(`case "${ref}": the step must run after "${sw}" (add it to needs)`);
      }
      const loop = 'forEach' in s && s.type !== 'workflow' ? s.forEach : undefined;
      if (loop) {
        checkExpression(loop.items);
        // A loop is one step: retrying it would repeat the items that already ran. Failed items are in output.results.
        if (s.retries) throw new Error('retries cannot be combined with forEach (failed items are reported in output.results)');
      }
      switch (s.type) {
        case 'invoke':
          validateInvoker(s.invoker as { type: string } & Record<string, unknown>);
          break;
        case 'approval':
          if (s.message) checkTemplate(s.message);
          if (s.tiers?.length) {
            const a = s.approvers;
            if ((a && (a.roles?.length || a.teams?.length || a.users?.length || a.ownerTeam)) || s.minApprovals > 1)
              throw new Error('use either tiers or approvers / minApprovals, not both');
            if (new Set(s.tiers.map((t) => t.name)).size !== s.tiers.length) throw new Error('tier names must be unique');
          }
          break;
        case 'agent':
          checkTemplate([s.prompt, s.system ?? '', s.apiKey ?? '']);
          // Secret values must never reach the model: only `apiKey` may reference secrets.
          if (hasRefs([s.prompt, s.system ?? '']))
            throw badRequest('prompt and system cannot reference secrets or environment variables (they are sent to the model)');
          if (s.output) validator(s.output as never);
          checkGuardrails(s);
          if (s.mcpServers.length && (s.provider ?? config.AI_PROVIDER) !== 'anthropic') throw badRequest('MCP servers need the Anthropic provider');
          break;
        case 'transform':
          for (const expr of Object.values(s.output)) checkExpression(expr);
          break;
        case 'wait': {
          const modes = [s.duration, s.until, s.event].filter(Boolean).length;
          if (modes !== 1) throw new Error('set exactly one of duration, until or event');
          if (s.until) checkTemplate(s.until);
          if (s.event?.filter) checkExpression(s.event.filter);
          break;
        }
        case 'input':
          validator(s.inputs as never);
          if (s.message) checkTemplate(s.message);
          break;
        case 'workflow':
          checkTemplate([s.inputs, s.entity ?? '']);
          if (s.forEach) checkExpression(s.forEach.items);
          break;
        case 'switch': {
          const ids = new Set<string>();
          for (const c of s.cases) {
            if (ids.has(c.id)) throw new Error(`the case id "${c.id}" is used twice`);
            ids.add(c.id);
            checkExpression(c.when);
          }
          if (s.default) ids.add(s.default);
          switches.set(s.id, ids);
          break;
        }
        case 'fragment': // inlined when the run starts (fragments.ts), where its parameters are checked
          checkTemplate(s.with);
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
