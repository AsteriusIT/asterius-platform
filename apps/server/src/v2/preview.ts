import type { Action, ObjectSchema } from '@asterius/shared';
import { canTrigger, getAction } from '../actions/actions.js';
import { scopedResolver } from '../actions/limits.js';
import type { RunContext } from '../actions/types.js';
import { compact, validator } from '../catalog/validation.js';
import { findEntity } from '../catalog/entities.js';
import { config } from '../config.js';
import type { Principal } from '../auth/users.js';
import { badRequest, forbidden } from '../lib/errors.js';
import { render } from '../lib/expr.js';
import { precheckConfig, runPrecheck, type PrecheckOutput } from '../actions/invokers/service-spec.js';
import { toYaml } from './spec.js';

/**
 * Form preview (docs/V2.md §6 step 2): before the user confirms, compute the Service spec the run would commit,
 * evaluate it with OPA and render it with the render service. Uses the configuration of the action's
 * `service-precheck` step, rendered with the submitted inputs, exactly as the run will. Nothing is written.
 * Unlike the in-run check, an unreachable OPA or render service does not fail: the preview says so and the run's
 * own pre-check (fail closed) decides.
 */

export const PREVIEW_RUN_ID = 'preview';

export type PreviewResult =
  { supported: false } | ({ supported: true; step: string; inputErrors: string[]; specYaml: string | null; canSubmit: boolean } & PrecheckOutput);

export const precheckStepOf = (a: Action) => a.steps.find((s) => s.type === 'invoke' && s.invoker.type === 'service-precheck');

export async function previewAction(
  p: Principal,
  actionId: string,
  body: { inputs?: Record<string, unknown>; entity?: string | null },
): Promise<PreviewResult> {
  const action = await getAction(actionId);
  const step = precheckStepOf(action);
  if (!step || step.type !== 'invoke') return { supported: false };
  const trigger = action.trigger;
  if (trigger?.type !== 'form' && trigger?.type !== 'api') return { supported: false };
  let entity = null;
  if (trigger.on !== 'create') {
    if (!body.entity) throw badRequest(`"${action.title}" runs on an existing ${trigger.blueprint} entity: pass "entity"`);
    entity = (await findEntity(trigger.blueprint!, body.entity)) ?? null;
    if (!entity) throw badRequest(`${trigger.blueprint}/${body.entity} does not exist`);
  }
  if (!canTrigger(action, p, entity?.team ?? null)) throw forbidden(`You are not allowed to run "${action.title}"`);

  const inputs = compact(body.inputs ?? {});
  const v = validator(trigger.inputs as ObjectSchema); // also applies defaults, as the run does
  const inputErrors = v(inputs)
    ? []
    : (v.errors ?? []).map(
        (e) => `${e.instancePath ? e.instancePath.slice(1) : ((e.params as { missingProperty?: string }).missingProperty ?? 'value')}: ${e.message}`,
      );
  const ctx: RunContext = {
    run: { id: PREVIEW_RUN_ID, url: `${config.PUBLIC_URL}/runs/${PREVIEW_RUN_ID}`, idempotencyKey: PREVIEW_RUN_ID, callback: { url: '', token: '' } },
    action: { identifier: action.identifier, title: action.title, blueprint: trigger.blueprint ?? null },
    inputs,
    entity,
    trigger: { user: { id: p.id, email: p.email, name: p.name }, at: new Date().toISOString() },
    steps: {},
  };
  const rendered = (await render(step.invoker, ctx, scopedResolver(action.secrets ?? null))).value;
  const parsed = precheckConfig.safeParse(rendered);
  if (!parsed.success) {
    return {
      supported: true,
      step: step.id,
      inputErrors: inputErrors.length ? inputErrors : parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
      specYaml: null,
      canSubmit: false,
      allowed: null,
      operation: '',
      specPath: '',
      service: null,
      policy: { status: 'unavailable', allowed: null, violations: [], error: 'the pre-check could not be configured from these inputs' },
      render: { status: 'skipped', resources: [] },
      schema: { status: 'skipped', violations: [] },
    };
  }
  const out = await runPrecheck(parsed.data, { runId: PREVIEW_RUN_ID, user: p.email });
  return {
    supported: true,
    step: step.id,
    inputErrors,
    specYaml: out.service ? toYaml(out.service) : null,
    // A denial is final; an unavailable OPA is not (the run checks again and fails closed).
    canSubmit: !inputErrors.length && out.policy.status !== 'denied',
    ...out,
  };
}
