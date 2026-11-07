import type { Entity, Policy } from '@asterius/shared';
import { all, bool, json, now, one, run } from '../db.js';
import { checkExpression, evaluate } from '../lib/expr.js';
import { errorMessage, managedError, notFound } from '../lib/errors.js';
import { audit, SYSTEM, type Actor } from '../audit.js';
import { orgId } from '../orgs/context.js';
import { policyDef, type PolicyDef } from '../schemas.js';
import { HttpError } from '../lib/errors.js';
import type { Principal } from '../auth/users.js';

/**
 * Policy gate. Enabled policies of the organization are evaluated (JSONata, with the usual timeout) before a run is
 * queued and before an entity is created, updated or deleted through the API or the catalog invoker. A policy allows
 * only when its expression evaluates to `true`; anything else, and any evaluation error, denies (fail closed) with
 * a 403 naming the policy, and an audit entry.
 */

interface Row {
  identifier: string;
  title: string;
  description: string;
  enabled: number;
  target: string;
  filters: string;
  expression: string;
  message: string;
  managed: number;
}

const toPolicy = (r: Row): Policy => ({
  identifier: r.identifier,
  title: r.title,
  description: r.description,
  enabled: bool(r.enabled),
  target: r.target as Policy['target'],
  match: json(r.filters, {}),
  expression: r.expression,
  message: r.message,
  managed: bool(r.managed),
});

export async function listPolicies(): Promise<Policy[]> {
  return (await all<Row>('SELECT * FROM policies WHERE org_id = ? ORDER BY title', orgId())).map(toPolicy);
}

export async function getPolicy(id: string): Promise<Policy> {
  const r = await one<Row>('SELECT * FROM policies WHERE org_id = ? AND identifier = ?', orgId(), id);
  if (!r) throw notFound(`Policy ${id}`);
  return toPolicy(r);
}

// Consulted on every run and entity write (syncs write thousands): cache briefly, per organization.
const cache = new Map<string, { at: number; list: Policy[] }>();
async function enabledPolicies(target: Policy['target']): Promise<Policy[]> {
  const key = `${orgId()}/${target}`;
  const c = cache.get(key);
  if (c && Date.now() - c.at < 2_000) return c.list;
  const list = (await listPolicies()).filter((p) => p.enabled && p.target === target);
  cache.set(key, { at: Date.now(), list });
  return list;
}
const invalidate = () => {
  for (const k of [...cache.keys()]) if (k.startsWith(`${orgId()}/`)) cache.delete(k);
};

export async function upsertPolicy(input: unknown, opts: { managed?: boolean } = {}) {
  const def: PolicyDef = policyDef.parse(input);
  checkExpression(def.expression);
  const org = orgId();
  const existing = await one<Row>('SELECT * FROM policies WHERE org_id = ? AND identifier = ?', org, def.identifier);
  if (existing && bool(existing.managed) && !opts.managed) throw managedError('Policy', def.identifier);
  const t = now();
  const vals = [def.title, def.description, def.enabled ? 1 : 0, def.target, JSON.stringify(def.match), def.expression, def.message, opts.managed ? 1 : 0, t];
  if (existing)
    await run(
      'UPDATE policies SET title = ?, description = ?, enabled = ?, target = ?, filters = ?, expression = ?, message = ?, managed = ?, updated_at = ? WHERE org_id = ? AND identifier = ?',
      ...vals,
      org,
      def.identifier,
    );
  else
    await run(
      'INSERT INTO policies (title, description, enabled, target, filters, expression, message, managed, updated_at, created_at, org_id, identifier) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ...vals,
      t,
      org,
      def.identifier,
    );
  invalidate();
  return { policy: await getPolicy(def.identifier), created: !existing };
}

export async function deletePolicy(id: string, opts: { managed?: boolean } = {}) {
  const p = await getPolicy(id);
  if (p.managed && !opts.managed) throw managedError('Policy', id);
  await run('DELETE FROM policies WHERE org_id = ? AND identifier = ?', orgId(), id);
  invalidate();
}

// ---------- evaluation ----------
export interface PolicyContext {
  inputs?: Record<string, unknown>;
  entity?: unknown;
  previous?: unknown;
  principal: Pick<Principal, 'id' | 'email' | 'name'> & Partial<Pick<Principal, 'role' | 'roles' | 'provider' | 'teams'>>;
  action?: { identifier: string; title: string } | null;
  blueprint?: string | null;
  operation?: 'create' | 'update' | 'delete' | 'run';
}

const matches = (p: Policy, c: PolicyContext) => {
  const m = p.match;
  if (p.target === 'run') return !m.actions?.length || (!!c.action && m.actions.includes(c.action.identifier));
  return (
    (!m.blueprints?.length || (!!c.blueprint && m.blueprints.includes(c.blueprint))) &&
    (!m.operations?.length || (!!c.operation && m.operations.includes(c.operation as never)))
  );
};

async function deniedMessage(p: Policy, ctx: unknown): Promise<string> {
  const tpl = p.message || 'Denied by policy';
  if (!tpl.includes('{{')) return tpl;
  try {
    const { render } = await import('../lib/expr.js');
    return String((await render(tpl, ctx, async () => '', { noRefs: true })).value);
  } catch {
    return tpl;
  }
}

/** Throws a 403 (with `details: { policy, message }`) when an enabled, matching policy of the target does not allow. */
export async function enforcePolicies(target: Policy['target'], c: PolicyContext, actor: Actor = SYSTEM) {
  const policies = (await enabledPolicies(target)).filter((p) => matches(p, c));
  if (!policies.length) return;
  const ctx = {
    inputs: c.inputs ?? {},
    entity: c.entity ?? null,
    previous: c.previous ?? null,
    principal: {
      id: c.principal.id,
      email: c.principal.email,
      name: c.principal.name,
      role: c.principal.role ?? null,
      roles: c.principal.roles ?? [],
      provider: c.principal.provider ?? null,
      teams: c.principal.teams ?? [],
    },
    action: c.action ?? null,
    blueprint: c.blueprint ?? null,
    operation: c.operation ?? null,
  };
  for (const p of policies) {
    let reason: string | undefined;
    try {
      if ((await evaluate(p.expression, ctx)) !== true) reason = await deniedMessage(p, ctx);
    } catch (err) {
      reason = `${(await deniedMessage(p, ctx)) || 'Denied by policy'} (policy evaluation failed: ${errorMessage(err)})`;
    }
    if (reason === undefined) continue;
    const subject =
      target === 'run'
        ? (c.action?.identifier ?? '')
        : `${c.blueprint}/${(c.entity as { identifier?: string } | null)?.identifier ?? (c.previous as { identifier?: string } | null)?.identifier ?? ''}`;
    await audit(actor, 'policy.denied', p.identifier, { target, operation: c.operation, subject, message: reason });
    throw new HttpError(403, `Denied by policy "${p.identifier}": ${reason}`, { policy: p.identifier, message: reason });
  }
}

type EntityLike = {
  identifier: string;
  title?: string | null;
  team?: string | null;
  properties?: Record<string, unknown>;
  relations?: Record<string, unknown>;
};
const snapshot = (e: Entity) => ({ identifier: e.identifier, title: e.title, team: e.team, properties: e.properties, relations: e.relations });

/** Gate a create/update (the entity is what would be stored: `merge` is applied) before it is written. */
export async function enforceEntityWrite(
  o: { principal: PolicyContext['principal']; blueprint: string; input: EntityLike; existing?: Entity; merge?: boolean },
  actor?: Actor,
) {
  const { input, existing } = o;
  const entity = {
    identifier: input.identifier,
    title: input.title?.trim() || existing?.title || input.identifier,
    team: input.team === undefined ? (existing?.team ?? null) : input.team,
    properties: o.merge && existing ? { ...existing.properties, ...input.properties } : (input.properties ?? {}),
    relations: o.merge && existing ? { ...existing.relations, ...input.relations } : (input.relations ?? {}),
  };
  await enforcePolicies(
    'entity',
    { principal: o.principal, blueprint: o.blueprint, operation: existing ? 'update' : 'create', entity, previous: existing ? snapshot(existing) : null },
    actor ?? { id: o.principal.id, email: o.principal.email },
  );
}

/** Gate a delete. */
export async function enforceEntityDelete(o: { principal: PolicyContext['principal']; blueprint: string; existing: Entity }, actor?: Actor) {
  await enforcePolicies(
    'entity',
    { principal: o.principal, blueprint: o.blueprint, operation: 'delete', entity: null, previous: snapshot(o.existing) },
    actor ?? { id: o.principal.id, email: o.principal.email },
  );
}
