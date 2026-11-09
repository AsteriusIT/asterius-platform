import type { Action, ActionTrigger, InvokerConfig, WorkflowStep, WorkflowTrigger } from '@asterius/shared';
import { invalidateTriggerCache } from './triggers.js';
import { assertSecretsAllowed } from './limits.js';
import { definitionDoc, nextVersion, recordVersion } from './versions.js';
import { SYSTEM, type Actor } from '../audit.js';
import { isFormLike, nextTick, validateTrigger } from './trigger-defs.js';
import { all, bool, json, now, one, run } from '../db.js';
import { badRequest, managedError, notFound } from '../lib/errors.js';
import { actionDef, type ActionDef } from '../schemas.js';
import { validator } from '../catalog/validation.js';
import { stepsOf, validateWorkflow } from './workflow.js';
import { isAdmin, matchesSubjects, type Principal } from '../auth/users.js';
import { orgId } from '../orgs/context.js';

interface Row {
  identifier: string;
  title: string;
  description: string;
  icon: string | null;
  blueprint: string | null;
  trigger: string; // ActionTrigger, or 'none' for a workflow without trigger
  inputs: string;
  invoker: string;
  steps: string | null;
  approval: string;
  allowed: string;
  enabled: number;
  managed: number;
  trigger_config: string | null;
  next_fire_at: string | null;
  version: number;
  allowed_secrets: string | null;
  /** JSON { concurrency, priority } (migration 4); NULL: defaults. */
  run_options?: string | null;
}

/** Stored in the trigger column when a workflow has no trigger yet (draft). */
const NO_TRIGGER = 'none';

function toAction(r: Row): Action {
  const invoker = json<InvokerConfig | null>(r.invoker, null);
  const declared = json<WorkflowStep[] | null>(r.steps, null);
  const steps = (declared ?? stepsOf({ invoker: invoker ?? undefined, steps: [], title: r.title })) as WorkflowStep[];
  // The form trigger keeps its settings in the action's columns (on = trigger column).
  const other = json<WorkflowTrigger | null>(r.trigger_config, null);
  const trigger: WorkflowTrigger | null = other
    ? { ...other, ...(other.type === 'schedule' ? { nextRunAt: r.next_fire_at } : {}) }
    : r.trigger === NO_TRIGGER
      ? null
      : {
          type: 'form',
          on: r.trigger as ActionTrigger,
          blueprint: r.blueprint,
          inputs: json(r.inputs, { properties: {} }),
          allowed: json(r.allowed, {}),
          approval: json(r.approval, { required: false }),
        };
  return {
    identifier: r.identifier,
    title: r.title,
    description: r.description,
    icon: r.icon,
    trigger,
    version: Number(r.version),
    ...(r.allowed_secrets ? { secrets: json<string[]>(r.allowed_secrets, []) } : {}),
    steps,
    ...(declared || !invoker ? {} : { invoker }),
    enabled: bool(r.enabled),
    managed: bool(r.managed),
    ...json<Pick<Action, 'concurrency' | 'priority'>>(r.run_options ?? null, {}),
  };
}

/** Non-admins see what an action does, not how (URLs, secret references, pipeline ids). */
export const forViewer = (a: Action, p: Principal): Action => {
  if (isAdmin(p)) return a;
  const { invoker, ...rest } = a;
  return {
    ...rest,
    ...(invoker ? { invoker: { type: invoker.type } } : {}),
    // Shape of the workflow only: ids, names, types, dependencies (no URLs, prompts or secret references).
    steps: a.steps.map(
      (s) => ({ id: s.id, name: s.name, type: s.type, needs: s.needs, ...(s.type === 'invoke' ? { invoker: { type: s.invoker.type } } : {}) }) as WorkflowStep,
    ),
  };
};

export async function listActions(): Promise<Action[]> {
  return (await all<Row>('SELECT * FROM actions WHERE org_id = ? ORDER BY title', orgId())).map(toAction);
}

/** The blueprint a trigger targets (null: none). */
export const blueprintOf = (a: Action): string | null => (a.trigger && 'blueprint' in a.trigger ? (a.trigger.blueprint ?? null) : null);

/** A workflow runs once it has a trigger and at least one step. */
export const isRunnable = (a: Action) => !!a.trigger && a.steps.length > 0;

/** Workflows this principal may start by submitting their form (on an entity of `ownerTeam` for day-2 ones). */
export const canTrigger = (a: Action, p: Principal, ownerTeam: string | null) =>
  a.enabled && isRunnable(a) && (a.trigger?.type === 'form' || a.trigger?.type === 'api') && matchesSubjects(p, a.trigger.allowed, ownerTeam);

export async function getAction(id: string): Promise<Action> {
  const r = await one<Row>('SELECT * FROM actions WHERE org_id = ? AND identifier = ?', orgId(), id);
  if (!r) throw notFound(`Action ${id}`);
  return toAction(r);
}

export async function upsertAction(
  input: unknown,
  opts: { managed?: boolean; actor?: Actor; note?: string } = {},
): Promise<{ action: Action; created: boolean }> {
  const def: ActionDef = actionDef.parse(input);
  const t0 = def.trigger;
  if (t0) validateTrigger(t0);
  if (def.steps.some((s) => s.type === 'workflow' && s.action === def.identifier)) throw badRequest('A workflow cannot call itself as a sub-workflow');
  if (t0?.type === 'event' && t0.action === def.identifier) throw badRequest('Trigger: a workflow cannot be triggered by its own runs');
  const triggerBlueprint = t0 && 'blueprint' in t0 ? (t0.blueprint ?? null) : null;
  const org = orgId();
  if (triggerBlueprint && !(await one('SELECT identifier FROM blueprints WHERE org_id = ? AND identifier = ?', org, triggerBlueprint)))
    throw badRequest(`Blueprint "${triggerBlueprint}" does not exist`);
  const form = isFormLike(t0) ? t0 : null;
  if (form && form.on !== 'create' && !form.blueprint) throw badRequest(`Forms submitted on an entity ("${form.on}") need a blueprint`);
  if (form) validator(form.inputs as never);
  validateWorkflow(stepsOf(def));
  assertSecretsAllowed(def.secrets, [def.steps, def.invoker, t0]);
  const existing = await one<Row>('SELECT * FROM actions WHERE org_id = ? AND identifier = ?', org, def.identifier);
  if (existing && bool(existing.managed) && !opts.managed) throw managedError('Action', def.identifier);
  const t = now();
  const doc = definitionDoc(def);
  const next = await nextVersion(def.identifier, existing ? Number(existing.version) : undefined, doc);
  // The (action, version) key makes concurrent edits of the same version fail instead of overwriting each other.
  if (next.isNew) await recordVersion(def.identifier, next.version, doc, opts.actor ?? SYSTEM, opts.note);
  const vals = [
    def.title,
    def.description,
    def.icon ?? null,
    triggerBlueprint,
    t0 ? (form ? form.on : t0.type) : NO_TRIGGER,
    JSON.stringify(form?.inputs ?? { properties: {} }),
    JSON.stringify(def.invoker ?? null),
    // Legacy single-invoker definitions keep `steps` empty (the invoker is the workflow).
    def.steps.length || !def.invoker ? JSON.stringify(def.steps) : null,
    JSON.stringify(form?.approval ?? { required: false }),
    JSON.stringify(form?.allowed ?? {}),
    def.enabled ? 1 : 0,
    opts.managed ? 1 : 0,
    t0 && t0.type !== 'form' ? JSON.stringify(t0) : null,
    t0?.type === 'schedule' && def.enabled ? nextTick(t0) : null,
    next.version,
    def.secrets ? JSON.stringify(def.secrets) : null,
  ];
  if (existing)
    await run(
      'UPDATE actions SET title = ?, description = ?, icon = ?, blueprint = ?, trigger = ?, inputs = ?, invoker = ?, steps = ?, approval = ?, allowed = ?, enabled = ?, managed = ?, trigger_config = ?, next_fire_at = ?, version = ?, allowed_secrets = ?, updated_at = ? WHERE org_id = ? AND identifier = ?',
      ...vals,
      t,
      org,
      def.identifier,
    );
  else
    await run(
      'INSERT INTO actions (title, description, icon, blueprint, trigger, inputs, invoker, steps, approval, allowed, enabled, managed, trigger_config, next_fire_at, version, allowed_secrets, created_at, updated_at, org_id, identifier) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ...vals,
      t,
      t,
      org,
      def.identifier,
    );
  const runOptions = def.concurrency || def.priority !== undefined ? JSON.stringify({ concurrency: def.concurrency, priority: def.priority }) : null;
  await run('UPDATE actions SET run_options = ? WHERE org_id = ? AND identifier = ?', runOptions, org, def.identifier);
  invalidateTriggerCache();
  return { action: await getAction(def.identifier), created: !existing };
}

export async function deleteAction(id: string, opts: { managed?: boolean } = {}) {
  const a = await getAction(id);
  if (a.managed && !opts.managed) throw managedError('Action', id);
  await run('DELETE FROM actions WHERE org_id = ? AND identifier = ?', orgId(), id); // past runs keep their snapshot
  invalidateTriggerCache();
}
