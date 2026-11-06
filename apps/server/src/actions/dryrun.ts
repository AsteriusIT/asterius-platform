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
import { stepsOf, type Step } from './workflow.js';
import type { RunContext } from './types.js';

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

async function secretExists(kind: 'secret' | 'env', name: string, missing: Set<string>) {
  if (kind === 'env') {
    if (process.env[name] === undefined || Object.keys(config).includes(name)) missing.add(`\${env:${name}}`);
  } else if (!(await one('SELECT name FROM secrets WHERE name = ?', name))) missing.add(`\${secret:${name}}`);
}

export async function dryRun(actionId: string, p: Principal, input: DryRunInput): Promise<DryRunResult> {
  const saved = input.definition ? undefined : await getAction(actionId);
  const def = input.definition ? actionDef.parse({ ...(input.definition as object), identifier: actionId }) : undefined;
  const trigger = def ? def.trigger : (saved?.trigger ?? null);
  const steps: Step[] = def ? stepsOf(def) : (saved?.steps as Step[]);
  const title = def?.title ?? saved?.title ?? actionId;
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
    await secretExists(kind, name, missing);
    return MASK;
  };
  const ctx: RunContext = {
    run: { id: 'dry-run', url: `${config.PUBLIC_URL}/runs/dry-run`, callback: { url: `${config.PUBLIC_URL}/api/v1/runs/dry-run/steps/<step>`, token: MASK } },
    action: { identifier: actionId, title, blueprint },
    inputs,
    entity,
    trigger: { user: { id: p.id, email: p.email, name: p.name }, at: new Date().toISOString() },
    steps: {},
  };

  const out: DryRunStep[] = [];
  for (const s of steps) {
    const r: DryRunStep = { id: s.id, type: s.type, status: 'planned', errors: [] };
    out.push(r);
    try {
      if (s.if) {
        r.condition = !!(await evaluate(s.if, ctx));
        if (!r.condition) {
          r.status = 'skipped';
          ctx.steps[s.id] = { status: 'SKIPPED', output: null, link: null };
          continue;
        }
      }
      const { rendered, output } = await simulate(s, ctx, resolver, input.mock?.[s.id], r);
      r.rendered = rendered;
      r.output = output;
      ctx.steps[s.id] = { status: 'SUCCESS', output, link: null };
    } catch (err) {
      r.status = 'error';
      r.errors.push(errorMessage(err));
      ctx.steps[s.id] = { status: 'FAILURE', output: null, link: null };
    }
  }
  return {
    valid: !inputErrors.length && !missing.size && out.every((s) => s.status !== 'error' && !s.errors.length),
    inputErrors,
    missingSecrets: [...missing],
    steps: out,
  };
}

async function simulate(s: Step, ctx: RunContext, resolver: RefResolver, mock: unknown, r: DryRunStep): Promise<{ rendered: unknown; output: unknown }> {
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
  }
}
