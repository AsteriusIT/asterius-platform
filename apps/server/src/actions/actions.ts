import type { Action, ActionTrigger, InvokerConfig, WorkflowStep, WorkflowTrigger } from '@asterius/shared';
import { all, bool, json, now, one, run } from '../db.js';
import { badRequest, managedError, notFound } from '../lib/errors.js';
import { actionDef, type ActionDef } from '../schemas.js';
import { validator } from '../catalog/validation.js';
import { stepsOf, validateWorkflow } from './workflow.js';
import { isAdmin, matchesSubjects, type Principal } from '../auth/users.js';

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
}

/** Stored in the trigger column when a workflow has no trigger yet (draft). */
const NO_TRIGGER = 'none';

function toAction(r: Row): Action {
  const invoker = json<InvokerConfig | null>(r.invoker, null);
  const declared = json<WorkflowStep[] | null>(r.steps, null);
  const steps = (declared ?? stepsOf({ invoker: invoker ?? undefined, steps: [], title: r.title })) as WorkflowStep[];
  // The form trigger keeps its settings in the action's columns (on = trigger column).
  const trigger: WorkflowTrigger | null =
    r.trigger === NO_TRIGGER
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
    steps,
    ...(declared || !invoker ? {} : { invoker }),
    enabled: bool(r.enabled),
    managed: bool(r.managed),
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
  return (await all<Row>('SELECT * FROM actions ORDER BY title')).map(toAction);
}

/** A workflow runs once it has a trigger and at least one step. */
export const isRunnable = (a: Action) => !!a.trigger && a.steps.length > 0;

/** Workflows this principal may start by submitting their form (on an entity of `ownerTeam` for day-2 ones). */
export const canTrigger = (a: Action, p: Principal, ownerTeam: string | null) =>
  a.enabled && isRunnable(a) && matchesSubjects(p, a.trigger?.allowed, ownerTeam);

export async function getAction(id: string): Promise<Action> {
  const r = await one<Row>('SELECT * FROM actions WHERE identifier = ?', id);
  if (!r) throw notFound(`Action ${id}`);
  return toAction(r);
}

export async function upsertAction(input: unknown, opts: { managed?: boolean } = {}): Promise<{ action: Action; created: boolean }> {
  const def: ActionDef = actionDef.parse(input);
  const t0 = def.trigger;
  if (t0?.blueprint && !(await one('SELECT identifier FROM blueprints WHERE identifier = ?', t0.blueprint)))
    throw badRequest(`Blueprint "${t0.blueprint}" does not exist`);
  if (t0 && t0.on !== 'create' && !t0.blueprint) throw badRequest(`Forms submitted on an entity ("${t0.on}") need a blueprint`);
  if (t0) validator(t0.inputs as never);
  validateWorkflow(stepsOf(def));
  const existing = await one<Row>('SELECT * FROM actions WHERE identifier = ?', def.identifier);
  if (existing && bool(existing.managed) && !opts.managed) throw managedError('Action', def.identifier);
  const t = now();
  const vals = [
    def.title,
    def.description,
    def.icon ?? null,
    t0?.blueprint ?? null,
    t0?.on ?? NO_TRIGGER,
    JSON.stringify(t0?.inputs ?? { properties: {} }),
    JSON.stringify(def.invoker ?? null),
    // Legacy single-invoker definitions keep `steps` empty (the invoker is the workflow).
    def.steps.length || !def.invoker ? JSON.stringify(def.steps) : null,
    JSON.stringify(t0?.approval ?? { required: false }),
    JSON.stringify(t0?.allowed ?? {}),
    def.enabled ? 1 : 0,
    opts.managed ? 1 : 0,
  ];
  if (existing)
    await run(
      'UPDATE actions SET title = ?, description = ?, icon = ?, blueprint = ?, trigger = ?, inputs = ?, invoker = ?, steps = ?, approval = ?, allowed = ?, enabled = ?, managed = ?, updated_at = ? WHERE identifier = ?',
      ...vals,
      t,
      def.identifier,
    );
  else
    await run(
      'INSERT INTO actions (title, description, icon, blueprint, trigger, inputs, invoker, steps, approval, allowed, enabled, managed, created_at, updated_at, identifier) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ...vals,
      t,
      t,
      def.identifier,
    );
  return { action: await getAction(def.identifier), created: !existing };
}

export async function deleteAction(id: string, opts: { managed?: boolean } = {}) {
  const a = await getAction(id);
  if (a.managed && !opts.managed) throw managedError('Action', id);
  await run('DELETE FROM actions WHERE identifier = ?', id); // past runs keep their snapshot
}
