import type { Fragment, FragmentVersion, ObjectSchema } from '@asterius/shared';
import { all, bool, json, now, one, run } from '../db.js';
import { badRequest, conflict, errorMessage, HttpError, managedError, notFound } from '../lib/errors.js';
import { staleVersion } from '../lib/conflict.js';
import { checkExpression, checkTemplate, hasRefs, render, type RefResolver } from '../lib/expr.js';
import { validator } from '../catalog/validation.js';
import { fragmentDef, STEP_ID, type FragmentDef } from '../schemas.js';
import { orgId } from '../orgs/context.js';
import { SYSTEM, type Actor } from '../audit.js';
import { needsOf, validateWorkflow, type Step } from './workflow.js';

/**
 * Step fragments: reusable groups of steps (`fragments`, per organization) that workflows include with a
 * `{ type: fragment, fragment: <id>, with: { param: value } }` step.
 *
 * Expansion happens when a run is created (and, to validate, when an action is saved): the run's snapshot holds the
 * fragment's steps inlined, so later edits of the fragment only apply to new runs.
 *  - inner step ids become `<fragment step id>__<inner id>` (and `steps.<inner id>` references are rewritten);
 *  - the fragment's entry steps wait for what the fragment step waited for; its `if` applies to every inlined step;
 *  - a synthetic transform step keeps the fragment step's id: it waits for the fragment's exit steps and computes
 *    `outputs`, so `needs: [<id>]` and `steps.<id>.output.<name>` keep working in the caller;
 *  - parameters: the `with` values (literals or `{{ }}` templates over the caller's context, never secret
 *    references) are stored in the snapshot and rendered when an inlined step runs; inside the fragment they are
 *    `params.<name>` in templates and expressions.
 * Fragments may include fragments, up to MAX_DEPTH levels, without cycles.
 */

export const MAX_DEPTH = 3;
const MAX_EXPANDED_STEPS = 200;

type FragmentStep = Extract<Step, { type: 'fragment' }>;

/** Where an inlined step comes from (kept in the run snapshot). */
export interface FragmentOrigin {
  /** Top-level fragment step of the workflow (groups the steps on the run page). */
  root: string;
  /** The fragment step that inlined this step. */
  step: string;
  fragment: string;
  version: number;
  /** `with` of each enclosing fragment step, outermost first (each rendered in the context of the previous one). */
  params: Record<string, unknown>[];
}
export type ExpandedStep = Exclude<Step, FragmentStep> & { fragmentOf?: FragmentOrigin };

export type FragmentLookup = (id: string) => Promise<{ def: FragmentDef; version: number } | undefined>;

// ---------- storage ----------
interface Row {
  identifier: string;
  title: string;
  description: string;
  params: string;
  steps: string;
  outputs: string;
  version: number;
  managed: number;
  updated_at: string;
}

const defOf = (r: Row): FragmentDef => ({
  identifier: r.identifier,
  title: r.title,
  description: r.description,
  params: json(r.params, { properties: {} }),
  steps: json(r.steps, []),
  outputs: json(r.outputs, {}),
});

const toFragment = (r: Row): Fragment => ({
  ...(defOf(r) as unknown as Omit<Fragment, 'version' | 'managed' | 'updatedAt'>),
  version: Number(r.version),
  managed: bool(r.managed),
  updatedAt: r.updated_at,
});

export async function listFragments(): Promise<Fragment[]> {
  return (await all<Row>('SELECT * FROM fragments WHERE org_id = ? ORDER BY title', orgId())).map(toFragment);
}

export async function getFragment(id: string): Promise<Fragment> {
  const r = await one<Row>('SELECT * FROM fragments WHERE org_id = ? AND identifier = ?', orgId(), id);
  if (!r) throw notFound(`Fragment ${id}`);
  return toFragment(r);
}

/** Reads the stored fragments (memoized for one expansion); `override` replaces one definition (validating a change). */
export function fragmentLookup(override?: FragmentDef): FragmentLookup {
  const memo = new Map<string, Promise<{ def: FragmentDef; version: number } | undefined>>();
  return (id) => {
    if (override?.identifier === id) return Promise.resolve({ def: override, version: 0 });
    let p = memo.get(id);
    if (!p) {
      p = one<Row>('SELECT * FROM fragments WHERE org_id = ? AND identifier = ?', orgId(), id).then((r) =>
        r ? { def: defOf(r), version: Number(r.version) } : undefined,
      );
      memo.set(id, p);
    }
    return p;
  };
}

// ---------- expansion ----------
const PARAM_REF = /(?<![\w.$])params\.([A-Za-z_][A-Za-z0-9_]*)/g;

/** `steps.<inner id>` → `steps.<prefix><inner id>` in every string of `value`. */
function rewriteRefs<T>(value: T, ids: string[], prefix: string): T {
  if (!ids.length) return value;
  const re = new RegExp(`(?<![\\w.$])steps\\.(${ids.join('|')})(?![A-Za-z0-9_])`, 'g');
  return JSON.parse(JSON.stringify(value).replace(re, `steps.${prefix}$1`)) as T;
}

/** The `with` of a fragment step against the fragment's parameters: unknown, missing, secret refs, literal types. */
function checkParams(def: FragmentDef, given: Record<string, unknown>, where: string): Record<string, unknown> {
  const props = (def.params.properties ?? {}) as Record<string, Record<string, unknown>>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(given)) {
    if (!(k in props)) throw badRequest(`${where}: unknown parameter "${k}" (declared: ${Object.keys(props).join(', ') || 'none'})`);
    out[k] = v;
  }
  for (const [k, p] of Object.entries(props)) if (!(k in out) && p.default !== undefined) out[k] = p.default;
  for (const r of def.params.required ?? []) if (!(r in out)) throw badRequest(`${where}: missing required parameter "${r}"`);
  if (hasRefs(out)) throw badRequest(`${where}: parameters cannot reference secrets or environment variables (reference them inside the fragment)`);
  try {
    checkTemplate(out);
  } catch (err) {
    throw badRequest(`${where}: ${errorMessage(err)}`);
  }
  // Literal values (not templates) are checked against the parameter schema now; templates when the run renders them.
  const literal = Object.fromEntries(Object.entries(out).filter(([, v]) => !JSON.stringify(v).includes('{{')));
  const check = validator({ properties: Object.fromEntries(Object.keys(literal).map((k) => [k, props[k]])) } as ObjectSchema);
  if (!check(literal)) {
    const problems = (check.errors ?? []).map((e) => `${e.instancePath.slice(1).replaceAll('/', '.') || 'value'} ${e.message}`);
    throw badRequest(`${where}: parameter ${problems.join('; ')}`);
  }
  return out;
}

interface Scope {
  depth: number;
  stack: string[];
  chain: Record<string, unknown>[];
  root?: string;
}

async function expandList(steps: Step[], scope: Scope, lookup: FragmentLookup): Promise<ExpandedStep[]> {
  const out: ExpandedStep[] = [];
  for (const [i, s] of steps.entries()) {
    const needs = needsOf(steps, i);
    if (s.type === 'fragment') out.push(...(await expandFragment(s, needs, scope, lookup)));
    else out.push({ ...s, needs });
  }
  return out;
}

async function expandFragment(s: FragmentStep, needs: string[], scope: Scope, lookup: FragmentLookup): Promise<ExpandedStep[]> {
  const where = `Step ${s.id} (fragment ${s.fragment})`;
  if (scope.stack.includes(s.fragment)) throw badRequest(`${where}: a fragment cannot include itself (${[...scope.stack, s.fragment].join(' → ')})`);
  if (scope.depth >= MAX_DEPTH) throw badRequest(`${where}: fragments can be nested ${MAX_DEPTH} levels deep at most`);
  const found = await lookup(s.fragment);
  if (!found) throw badRequest(`${where}: unknown fragment "${s.fragment}"`);
  const { def, version } = found;
  const params = checkParams(def, s.with ?? {}, where);
  const prefix = `${s.id}__`;
  const ids = def.steps.map((x) => x.id);
  const inner = def.steps.map((x, j) => {
    const id = `${prefix}${x.id}`;
    if (!STEP_ID.test(id))
      throw badRequest(
        `${where}: the inlined step id "${id}" is too long (at most 41 characters): shorten the id of the fragment step or of the fragment's steps`,
      );
    const own = needsOf(def.steps, j);
    const step = { ...rewriteRefs(x, ids, prefix), id, needs: own.length ? own.map((n) => `${prefix}${n}`) : needs } as Step;
    // Branches of a switch inside the fragment: `case: <switch>.<case>` names the inlined switch.
    const inlined = (ref: string) => (ids.includes(ref.split('.')[0]) ? `${prefix}${ref}` : ref);
    if (x.case) step.case = Array.isArray(x.case) ? x.case.map(inlined) : inlined(x.case);
    return step;
  });
  const exits = inner.filter((x) => !inner.some((y) => y.needs!.includes(x.id))).map((x) => x.id);
  const chain = [...scope.chain, params];
  const root = scope.root ?? s.id;
  const origin: FragmentOrigin = { root, step: s.id, fragment: s.fragment, version, params: chain };
  const expanded = await expandList(inner, { depth: scope.depth + 1, stack: [...scope.stack, s.fragment], chain, root }, lookup);
  const output: ExpandedStep = {
    id: s.id,
    name: s.name || def.title,
    type: 'transform',
    output: rewriteRefs(def.outputs, ids, prefix),
    needs: exits,
    retries: 0,
    retryDelaySeconds: 30,
    continueOnError: false,
    fragmentOf: origin,
  };
  const steps = [...expanded.map((x) => (x.fragmentOf ? x : { ...x, fragmentOf: origin })), output];
  // The fragment step's condition gates every inlined step (a skipped entry step alone would not stop the others).
  if (s.if) for (const x of steps) x.if = x.if ? `(${s.if}) and (${x.if})` : s.if;
  return steps;
}

/** Inline the fragments of a workflow (the list itself when it has none). */
export async function expandSteps(steps: Step[], lookup: FragmentLookup = fragmentLookup()): Promise<ExpandedStep[]> {
  if (!steps.some((s) => s.type === 'fragment')) return steps as ExpandedStep[];
  const out = await expandList(steps, { depth: 0, stack: [], chain: [] }, lookup);
  if (out.length > MAX_EXPANDED_STEPS) throw badRequest(`With its fragments inlined the workflow has ${out.length} steps (at most ${MAX_EXPANDED_STEPS})`);
  return out;
}

/** Expand and validate the result as a workflow (save time and run creation). */
export async function expandWorkflow(steps: Step[], lookup?: FragmentLookup): Promise<ExpandedStep[]> {
  const out = await expandSteps(steps, lookup);
  if (out !== steps)
    try {
      validateWorkflow(out as Step[]);
    } catch (err) {
      throw badRequest(`With its fragments inlined: ${errorMessage(err)}`);
    }
  return out;
}

// ---------- parameters at run time ----------
const noRefs: RefResolver = async () => {
  throw badRequest('Secret and environment references are not allowed in fragment parameters');
};

/** The context of an inlined step: `params` rendered from the snapshot (and no stray `params` for other steps). */
export async function withParams<C extends object>(ctx: C, def: unknown): Promise<C & { params?: Record<string, unknown> }> {
  const chain = (def as { fragmentOf?: FragmentOrigin } | undefined)?.fragmentOf?.params;
  const { params: _ignored, ...base } = ctx as C & { params?: unknown };
  void _ignored;
  if (!chain?.length) return base as C;
  let params: Record<string, unknown> | undefined;
  for (const w of chain) params = (await render(w, params ? { ...base, params } : base, noRefs, { noRefs: true })).value as Record<string, unknown>;
  return { ...(base as C), params: params ?? {} };
}

// ---------- definitions ----------
/** Checks of a fragment on its own: graph, outputs, parameters used, nesting (depth, cycles, unknown fragments). */
export async function validateFragment(def: FragmentDef, lookup: FragmentLookup = fragmentLookup(def)) {
  validateWorkflow(def.steps);
  validator(def.params as ObjectSchema);
  for (const [k, expr] of Object.entries(def.outputs))
    try {
      checkExpression(expr);
    } catch (err) {
      throw badRequest(`Output ${k}: ${errorMessage(err)}`);
    }
  const declared = new Set(Object.keys(def.params.properties ?? {}));
  for (const m of JSON.stringify([def.steps, def.outputs]).matchAll(PARAM_REF))
    if (!declared.has(m[1])) throw badRequest(`params.${m[1]} is used but not declared in params`);
  for (const s of def.steps)
    if (s.type === 'fragment' && s.if && new RegExp(PARAM_REF.source).test(s.if))
      throw badRequest(`Step ${s.id}: the condition of a nested fragment step cannot use params (put the condition on its steps)`);
  // Inline it once as a caller would (templated placeholders for every parameter).
  const probe: FragmentStep = {
    id: 'f',
    type: 'fragment',
    retries: 0,
    retryDelaySeconds: 30,
    continueOnError: false,
    fragment: def.identifier,
    with: Object.fromEntries([...declared].map((k) => [k, '{{ null }}'])),
  };
  await expandWorkflow([probe], lookup);
}

/** Actions and fragments whose steps include this fragment directly. */
export async function fragmentUsers(id: string): Promise<{ actions: string[]; fragments: string[] }> {
  const org = orgId();
  const uses = (steps: string | null) => json<Step[]>(steps, []).some((s) => s.type === 'fragment' && s.fragment === id);
  const actions = await all<{ identifier: string; steps: string | null }>(
    'SELECT identifier, steps FROM actions WHERE org_id = ? AND steps LIKE ? ORDER BY identifier',
    org,
    '%"type":"fragment"%',
  );
  const fragments = await all<{ identifier: string; steps: string }>(
    'SELECT identifier, steps FROM fragments WHERE org_id = ? AND identifier != ? AND steps LIKE ? ORDER BY identifier',
    org,
    id,
    '%"type":"fragment"%',
  );
  return { actions: actions.filter((a) => uses(a.steps)).map((a) => a.identifier), fragments: fragments.filter((f) => uses(f.steps)).map((f) => f.identifier) };
}

/** The 412 of a save whose If-Match is not the stored version: who saved the current version, and when. */
async function staleFragment(id: string, expected: number) {
  const cur = await one<{ version: number }>('SELECT version FROM fragments WHERE org_id = ? AND identifier = ?', orgId(), id);
  const current = cur ? Number(cur.version) : null;
  const last =
    current === null
      ? undefined
      : await one<{ actor_id: string | null; actor_email: string | null; at: string }>(
          'SELECT actor_id, actor_email, created_at AS at FROM fragment_versions WHERE org_id = ? AND fragment = ? AND version = ?',
          orgId(),
          id,
          current,
        );
  return staleVersion(`Fragment ${id} is at version ${current ?? 'none'}, not ${expected}; reload and retry`, current, last);
}

export async function upsertFragment(
  input: unknown,
  opts: { managed?: boolean; actor?: Actor; /** Only save over this version (412 otherwise). */ ifMatch?: number } = {},
): Promise<{ fragment: Fragment; created: boolean; changed: boolean }> {
  const def = fragmentDef.parse(input);
  await validateFragment(def);
  const org = orgId();
  const existing = await one<Row>('SELECT * FROM fragments WHERE org_id = ? AND identifier = ?', org, def.identifier);
  if (existing && bool(existing.managed) && !opts.managed) throw managedError('Fragment', def.identifier);
  if (opts.ifMatch !== undefined && (existing ? Number(existing.version) : undefined) !== opts.ifMatch) throw await staleFragment(def.identifier, opts.ifMatch);
  const doc = JSON.stringify(def);
  let version: number;
  let changed = true;
  if (existing) {
    changed = JSON.stringify(defOf(existing)) !== doc;
    version = Number(existing.version) + (changed ? 1 : 0);
  } else {
    // History outlives a deleted fragment: a re-created one continues the numbering.
    const max = await one<{ v: number | null }>('SELECT max(version) AS v FROM fragment_versions WHERE org_id = ? AND fragment = ?', org, def.identifier);
    version = Number(max?.v ?? 0) + 1;
  }
  if (changed) {
    const actor = opts.actor ?? SYSTEM;
    try {
      await run(
        'INSERT INTO fragment_versions (org_id, fragment, version, definition, actor_id, actor_email, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        org,
        def.identifier,
        version,
        doc,
        actor.id,
        actor.email,
        now(),
      );
    } catch {
      if (opts.ifMatch !== undefined) throw await staleFragment(def.identifier, opts.ifMatch);
      throw conflict('The fragment was changed by someone else meanwhile; reload and try again');
    }
  }
  const t = now();
  const vals = [def.title, def.description, JSON.stringify(def.params), JSON.stringify(def.steps), JSON.stringify(def.outputs), version, opts.managed ? 1 : 0];
  if (existing)
    await run(
      'UPDATE fragments SET title = ?, description = ?, params = ?, steps = ?, outputs = ?, version = ?, managed = ?, updated_at = ? WHERE org_id = ? AND identifier = ?',
      ...vals,
      changed ? t : existing.updated_at,
      org,
      def.identifier,
    );
  else
    await run(
      'INSERT INTO fragments (title, description, params, steps, outputs, version, managed, created_at, updated_at, org_id, identifier) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ...vals,
      t,
      t,
      org,
      def.identifier,
    );
  return { fragment: await getFragment(def.identifier), created: !existing, changed };
}

/** Refused (409, `usedBy`) while an action or another fragment includes it. Past runs keep their inlined copy. */
export async function deleteFragment(id: string, opts: { managed?: boolean } = {}) {
  const f = await getFragment(id);
  if (f.managed && !opts.managed) throw managedError('Fragment', id);
  const usedBy = await fragmentUsers(id);
  if (usedBy.actions.length || usedBy.fragments.length) {
    const names = [...usedBy.actions.map((a) => `action ${a}`), ...usedBy.fragments.map((x) => `fragment ${x}`)];
    throw new HttpError(409, `Fragment "${id}" is used by ${names.join(', ')}: remove it from them first`, { usedBy });
  }
  await run('DELETE FROM fragments WHERE org_id = ? AND identifier = ?', orgId(), id);
}

/** Fragments ordered so that the ones included by others come first (configuration files, imports). */
export function dependencyOrder<T extends { identifier: string; steps: { type: string }[] }>(defs: T[]): T[] {
  const byId = new Map(defs.map((d) => [d.identifier, d]));
  const out: T[] = [];
  const seen = new Set<string>();
  const visit = (d: T) => {
    if (seen.has(d.identifier)) return;
    seen.add(d.identifier);
    for (const s of d.steps) {
      const dep = s.type === 'fragment' ? byId.get((s as { fragment?: string }).fragment ?? '') : undefined;
      if (dep) visit(dep);
    }
    out.push(d);
  };
  defs.forEach(visit);
  return out;
}

export async function listFragmentVersions(id: string): Promise<FragmentVersion[]> {
  const rows = await all<{ version: number; actor_email: string | null; created_at: string; definition: string }>(
    'SELECT version, actor_email, created_at, definition FROM fragment_versions WHERE org_id = ? AND fragment = ? ORDER BY version DESC LIMIT 200',
    orgId(),
    id,
  );
  return rows.map((r) => ({ version: Number(r.version), actor: r.actor_email, at: r.created_at, definition: json(r.definition, {}) }));
}

export async function getFragmentVersion(id: string, version: number): Promise<FragmentVersion> {
  const r = await one<{ version: number; actor_email: string | null; created_at: string; definition: string }>(
    'SELECT version, actor_email, created_at, definition FROM fragment_versions WHERE org_id = ? AND fragment = ? AND version = ?',
    orgId(),
    id,
    version,
  );
  if (!r) throw notFound(`Version ${version} of fragment ${id}`);
  return { version: Number(r.version), actor: r.actor_email, at: r.created_at, definition: json(r.definition, {}) };
}
