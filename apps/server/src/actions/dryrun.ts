import type { DryRunResult, DryRunStep, ObjectSchema } from '@asterius/shared';
import { one } from '../db.js';
import { errorMessage } from '../lib/errors.js';
import { evaluate, render, type RefResolver } from '../lib/expr.js';
import { compact, validator } from '../catalog/validation.js';
import { findEntity } from '../catalog/entities.js';
import { actionDef } from '../schemas.js';
import type { Principal } from '../auth/users.js';
import { config } from '../config.js';
import { getAction } from './actions.js';
import { getInvoker } from './invokers/index.js';
import { parseDuration } from './waiting.js';
import { isFormLike } from './trigger-defs.js';
import { casesOf, needsOf, stepsOf, type Step } from './workflow.js';
import { expandWorkflow, withParams } from './fragments.js';
import type { RunContext } from './types.js';
import { orgId } from '../orgs/context.js';
import { appUrl } from '../orgs/orgs.js';

/**
 * Dry run: render every template, evaluate every condition and transform, validate invoker configurations and
 * secret references, and return the plan. No invoker is started, no agent is called, no external system is
 * reached and no run is created. Secret values are never read: references are checked for existence and shown
 * masked. `mock` gives outputs for steps that cannot be simulated (invokers, agents, approvals…) so that later
 * steps can be checked against realistic data.
 */

const MASK = '********';

export interface DryRunInput {
  /** Unsaved definition (the builder's current state); default: the saved action. */
  definition?: unknown;
  inputs?: Record<string, unknown>;
  /** Identifier of the entity a day-2 / event workflow runs on. */
  entity?: string | null;
  /** Step id → output to use instead of a generic sample. */
  mock?: Record<string, unknown>;
}

/** An example value for a JSON schema (agent and input steps). */
export function sampleOf(schema: ObjectSchema | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, p] of Object.entries(schema?.properties ?? {})) {
    const prop = p as { type?: string; enum?: unknown[]; default?: unknown };
    out[k] =
      prop.default ?? prop.enum?.[0] ?? { string: `<${k}>`, number: 0, integer: 0, boolean: false, array: [], object: {} }[prop.type ?? 'string'] ?? null;
  }
  return out;
}

async function secretExists(kind: string, name: string, missing: Set<string>, allowed?: string[]) {
  // References to external secret managers (vault:, awssm:, ...) are not looked up in a dry run: the provider is not called.
  if (kind !== 'secret' && kind !== 'env') return;
  if (allowed && !allowed.includes(kind === 'env' ? `env:${name}` : name)) {
    missing.add(`\${${kind}:${name}} (not in the allow-list)`);
    return;
  }
  if (kind === 'env') {
    if (process.env[name] === undefined || Object.keys(config).includes(name)) missing.add(`\${env:${name}}`);
  } else if (!(await one('SELECT name FROM secrets WHERE org_id = ? AND name = ?', orgId(), name))) missing.add(`\${secret:${name}}`);
}

export async function dryRun(actionId: string, p: Principal, input: DryRunInput): Promise<DryRunResult> {
  const saved = input.definition ? undefined : await getAction(actionId);
  const def = input.definition ? actionDef.parse({ ...(input.definition as object), identifier: actionId }) : undefined;
  const trigger = def ? def.trigger : (saved?.trigger ?? null);
  const steps = (await expandWorkflow(def ? stepsOf(def) : (saved?.steps as Step[]))) as Step[];
  const title = def?.title ?? saved?.title ?? actionId;
  const runTemplates = { vars: def ? def.vars : saved?.vars, outputs: def ? def.outputs : saved?.outputs };
  const blueprint = trigger && 'blueprint' in trigger ? (trigger.blueprint ?? null) : null;

  const inputErrors: string[] = [];
  const inputs = compact(input.inputs ?? {});
  if (isFormLike(trigger as never)) {
    const schema = (trigger as { inputs: ObjectSchema }).inputs;
    const v = validator(schema);
    if (!v(inputs))
      for (const e of v.errors ?? [])
        inputErrors.push(`${e.instancePath ? e.instancePath.slice(1) : ((e.params as { missingProperty?: string }).missingProperty ?? 'value')}: ${e.message}`);
  }
  const entity = blueprint && input.entity ? ((await findEntity(blueprint, input.entity)) ?? null) : null;
  if (blueprint && input.entity && !entity) inputErrors.push(`entity: ${blueprint}/${input.entity} does not exist`);

  const missing = new Set<string>();
  const resolver: RefResolver = async (kind, name) => {
    await secretExists(kind, name, missing, def ? def.secrets : saved?.secrets);
    return MASK;
  };
  const ctx: RunContext = {
    run: {
      id: 'dry-run',
      url: await appUrl('/runs/dry-run'),
      idempotencyKey: 'dry-run',
      callback: { url: `${config.PUBLIC_URL}/api/v1/runs/dry-run/steps/<step>`, token: MASK },
    },
    action: { identifier: actionId, title, blueprint },
    inputs,
    entity,
    trigger: { user: { id: p.id, email: p.email, name: p.name }, at: new Date().toISOString() },
    steps: {},
  };

  const noSecrets: RefResolver = async () => {
    throw new Error('Secret references are not allowed in vars and outputs');
  };
  let vars: Record<string, unknown> | undefined;
  const runErrors: string[] = [];
  if (runTemplates.vars)
    try {
      vars = (await render(runTemplates.vars, ctx, noSecrets)).value as Record<string, unknown>;
      ctx.vars = vars;
    } catch (err) {
      runErrors.push(`vars: ${errorMessage(err)}`);
    }

  const out: DryRunStep[] = [];
  const skip = (s: Step, r: DryRunStep, why: string) => {
    r.status = 'skipped';
    r.errors.length = 0;
    r.rendered = { skipped: why };
    ctx.steps[s.id] = { status: 'SKIPPED', output: null, link: null };
  };
  for (const [i, s] of steps.entries()) {
    const r: DryRunStep = { id: s.id, type: s.type, status: 'planned', errors: [] };
    out.push(r);
    try {
      // Control flow: the test assumes every planned step succeeds and steps with errors fail.
      const deps = needsOf(steps, i).map((id) => ctx.steps[id]?.status);
      if (s.when === 'failure' && !deps.includes('FAILURE')) {
        skip(s, r, 'when: failure, and no dependency fails in this test');
        continue;
      }
      const refs = casesOf(s);
      if (refs.length && !refs.some((ref) => (ctx.steps[ref.split('.')[0]]?.output as { case?: string } | null)?.case === ref.split('.')[1])) {
        skip(s, r, 'branch not taken');
        continue;
      }
      const sctx = await withParams(ctx, s);
      if (s.if) {
        r.condition = !!(await evaluate(s.if, sctx));
        if (!r.condition) {
          r.status = 'skipped';
          ctx.steps[s.id] = { status: 'SKIPPED', output: null, link: null };
          continue;
        }
      }
      const { rendered, output } = await simulateLoop(s, sctx, resolver, input.mock?.[s.id], r);
      r.rendered = rendered;
      r.output = output;
      ctx.steps[s.id] = { status: 'SUCCESS', output, link: null };
    } catch (err) {
      r.status = 'error';
      r.errors.push(errorMessage(err));
      ctx.steps[s.id] = { status: 'FAILURE', output: null, link: null };
    }
  }
  let outputs: Record<string, unknown> | undefined;
  if (runTemplates.outputs)
    try {
      outputs = (await render(runTemplates.outputs, ctx, noSecrets)).value as Record<string, unknown>;
    } catch (err) {
      runErrors.push(`outputs: ${errorMessage(err)}`);
    }
  return {
    valid: !inputErrors.length && !missing.size && !runErrors.length && out.every((s) => s.status !== 'error' && !s.errors.length),
    inputErrors: [...inputErrors, ...runErrors],
    missingSecrets: [...missing],
    steps: out,
    ...(vars ? { vars } : {}),
    ...(outputs ? { outputs } : {}),
  };
}

/** Inline `forEach` (invoke, agent, transform): each item is simulated (the first 20 are rendered). */
export async function simulateLoop(s: Step, ctx: RunContext, resolver: RefResolver, mock: unknown, r: DryRunStep) {
  const loop = s.type === 'invoke' || s.type === 'agent' || s.type === 'transform' ? s.forEach : undefined;
  if (!loop) return simulate(s, ctx, resolver, mock, r);
  const value = await evaluate(loop.items, ctx);
  const items = value == null ? [] : Array.isArray(value) ? value : [value];
  if (items.length > 200) r.errors.push(`${items.length} items: loops are limited to 200`);
  const single = { ...s, forEach: undefined } as Step;
  const rendered: unknown[] = [];
  const results: { item: unknown; status: string; output: unknown }[] = [];
  for (const [index, item] of items.entries()) {
    const one = await simulate(single, { ...ctx, item, index }, resolver, undefined, r);
    if (index < 20) rendered.push(one.rendered);
    results.push({ item, status: 'SUCCESS', output: one.output });
  }
  return { rendered: { count: items.length, items: rendered }, output: mock !== undefined ? mock : { results, succeeded: results.length, failed: 0 } };
}

/** Simulate one step (shared with the workflow tests, workflow-tests.ts). */
export async function simulate(s: Step, ctx: RunContext, resolver: RefResolver, mock: unknown, r: DryRunStep): Promise<{ rendered: unknown; output: unknown }> {
  const sample = (fallback: unknown) => (mock !== undefined ? mock : fallback);
  switch (s.type) {
    case 'invoke': {
      const rendered = (await render(s.invoker, ctx, resolver)).value as Record<string, unknown>;
      getInvoker(s.invoker.type).validate(rendered);
      return { rendered, output: sample({ simulated: true }) };
    }
    case 'agent': {
      const rendered = (await render({ prompt: s.prompt, system: s.system, model: s.model, apiKey: s.apiKey }, ctx, resolver)).value;
      return { rendered, output: sample(s.output ? sampleOf(s.output as ObjectSchema) : { text: '<agent answer>' }) };
    }
    case 'approval': {
      const message = s.message ? (await render(s.message, ctx, resolver)).value : null;
      return {
        rendered: { message, approvers: s.approvers ?? 'admins', minApprovals: s.minApprovals },
        output: sample({
          approved: true,
          by: [],
          comments: [],
          ...(s.choices?.length ? { choice: s.choices[0] } : {}),
          ...(s.fields ? { values: sampleOf(s.fields as ObjectSchema) } : {}),
        }),
      };
    }
    case 'transform': {
      const output: Record<string, unknown> = {};
      for (const [k, expr] of Object.entries(s.output)) output[k] = await evaluate(expr, ctx);
      return { rendered: output, output };
    }
    case 'wait': {
      if (s.event) return { rendered: { event: s.event }, output: sample({ event: s.event.name, payload: null }) };
      const until = s.until
        ? String((await render(s.until, ctx, resolver)).value ?? '')
        : new Date(Date.now() + parseDuration(s.duration ?? '0s')).toISOString();
      if (Number.isNaN(Date.parse(until))) throw new Error(`"${until}" is not a date-time`);
      return { rendered: { until }, output: sample({ waitedUntil: until }) };
    }
    case 'input': {
      const message = s.message ? (await render(s.message, ctx, resolver)).value : null;
      return { rendered: { message, form: s.inputs }, output: sample(sampleOf(s.inputs as ObjectSchema)) };
    }
    case 'switch': {
      let chosen: string | null = null;
      for (const c of s.cases)
        if (await evaluate(c.when, ctx)) {
          chosen = c.id;
          break;
        }
      chosen ??= s.default ?? null;
      return { rendered: { case: chosen }, output: mock !== undefined ? mock : { case: chosen } };
    }
    case 'workflow': {
      await getAction(s.action); // 404 when the child does not exist
      const items = s.forEach ? await evaluate(s.forEach.items, ctx) : [undefined];
      const list = Array.isArray(items) ? items : items == null ? [] : [items];
      if (s.forEach) r.errors.push(...(list.length > 200 ? [`${list.length} items: fan-out is limited to 200`] : []));
      const children = [];
      for (const [i, item] of list.slice(0, 20).entries())
        children.push((await render({ inputs: s.inputs, entity: s.entity }, { ...ctx, item, index: i }, resolver)).value);
      return { rendered: { action: s.action, count: list.length, children }, output: sample({ runId: '<child run>', status: 'SUCCESS', result: {} }) };
    }
    case 'fragment': // already inlined by expandWorkflow
      return { rendered: { fragment: s.fragment }, output: sample(null) };
  }
}
