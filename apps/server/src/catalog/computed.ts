import type { ComputedProperty, Entity, RelationValue } from '@asterius/shared';
import { all, json, one, run } from '../db.js';
import { evaluate } from '../lib/expr.js';
import { errorMessage } from '../lib/errors.js';
import { findEntity, relationIds, searchEntities, toEntity } from './entities.js';

/**
 * Computed properties of blueprints (`computed` in the blueprint):
 *  - calculated: JSONata over the entity, evaluated whenever the entity is read;
 *  - mirror: a property of the related entity, copied;
 *  - aggregation: count / sum / min / max over the entities pointing to this one.
 * Mirror and aggregation values are materialised in `entities.computed` when the entity, or an entity it relates
 * to or is related by, is written, so they can be filtered and sorted like properties. Reads of installations
 * without computed properties pay one cached lookup.
 */

type Mirror = Extract<ComputedProperty, { kind: 'mirror' }>;
type Aggregation = Extract<ComputedProperty, { kind: 'aggregation' }>;
type Calculated = Extract<ComputedProperty, { kind: 'calculated' }>;

interface Index {
  /** Blueprints with materialised properties. */
  holders: Map<string, { mirrors: [string, Mirror, string][]; aggregations: [string, Aggregation][] }>;
  /** Blueprint → [holder blueprint, relation] of the mirrors reading from it. */
  mirrorSources: Map<string, { holder: string; relation: string }[]>;
  /** Blueprint → aggregations counting its entities. */
  aggregationSources: Map<string, { holder: string; relation: string }[]>;
  calculated: Map<string, [string, Calculated][]>;
}

let cache: { at: number; index: Index } | undefined;
export const invalidateComputed = () => {
  cache = undefined;
};

async function index(): Promise<Index> {
  if (cache && Date.now() - cache.at < 5_000) return cache.index;
  const idx: Index = { holders: new Map(), mirrorSources: new Map(), aggregationSources: new Map(), calculated: new Map() };
  const rows = await all<{ identifier: string; relations: string; computed: string }>(
    "SELECT identifier, relations, computed FROM blueprints WHERE computed != '{}'",
  );
  for (const r of rows) {
    const relations = json<Record<string, { target: string }>>(r.relations, {});
    for (const [name, def] of Object.entries(json<Record<string, ComputedProperty>>(r.computed, {}))) {
      if (def.kind === 'calculated') {
        const list = idx.calculated.get(r.identifier) ?? [];
        list.push([name, def]);
        idx.calculated.set(r.identifier, list);
        continue;
      }
      const h = idx.holders.get(r.identifier) ?? { mirrors: [], aggregations: [] };
      idx.holders.set(r.identifier, h);
      if (def.kind === 'mirror') {
        const target = relations[def.relation]?.target;
        if (!target) continue;
        h.mirrors.push([name, def, target]);
        idx.mirrorSources.set(target, [...(idx.mirrorSources.get(target) ?? []), { holder: r.identifier, relation: def.relation }]);
      } else {
        h.aggregations.push([name, def]);
        idx.aggregationSources.set(def.blueprint, [...(idx.aggregationSources.get(def.blueprint) ?? []), { holder: r.identifier, relation: def.relation }]);
      }
    }
  }
  cache = { at: Date.now(), index: idx };
  return idx;
}

const slim = (e: Entity) => ({ identifier: e.identifier, title: e.title, team: e.team, properties: e.properties, relations: e.relations });

const mirrored = (e: Entity, property: string): unknown =>
  property === 'title' ? e.title : property === 'team' ? e.team : property === 'identifier' ? e.identifier : e.properties[property];

const MAX_SOURCES = 10_000;

async function aggregate(e: Entity, def: Aggregation): Promise<number | null> {
  if (def.function === 'count' && !def.filter) {
    const r = await one<{ n: number }>(
      'SELECT count(*) AS n FROM entity_relations WHERE blueprint = ? AND relation = ? AND target_blueprint = ? AND target_identifier = ?',
      def.blueprint,
      def.relation,
      e.blueprint,
      e.identifier,
    );
    return Number(r?.n ?? 0);
  }
  const rows = await all<Parameters<typeof toEntity>[0]>(
    `SELECT e.* FROM entity_relations r JOIN entities e ON e.blueprint = r.blueprint AND e.identifier = r.identifier
     WHERE r.blueprint = ? AND r.relation = ? AND r.target_blueprint = ? AND r.target_identifier = ? LIMIT ${MAX_SOURCES}`,
    def.blueprint,
    def.relation,
    e.blueprint,
    e.identifier,
  );
  const values: number[] = [];
  let count = 0;
  for (const row of rows) {
    const src = toEntity(row);
    if (def.filter) {
      try {
        if (!(await evaluate(def.filter, slim(src)))) continue;
      } catch {
        continue;
      }
    }
    count++;
    const v = def.property ? Number(src.properties[def.property]) : NaN;
    if (Number.isFinite(v)) values.push(v);
  }
  switch (def.function) {
    case 'count':
      return count;
    case 'sum':
      return values.reduce((a, b) => a + b, 0);
    case 'min':
      return values.length ? Math.min(...values) : null;
    case 'max':
      return values.length ? Math.max(...values) : null;
  }
}

async function mirrorValue(e: Entity, def: Mirror, targetBlueprint: string): Promise<unknown> {
  const ids = relationIds(e.relations[def.relation]);
  if (!ids.length) return undefined;
  const rows = await all<Parameters<typeof toEntity>[0]>(
    `SELECT * FROM entities WHERE blueprint = ? AND identifier IN (${ids.map(() => '?').join(',')})`,
    targetBlueprint,
    ...ids,
  );
  const byId = new Map(rows.map((r) => [r.identifier, toEntity(r)]));
  const values = ids
    .map((id) => byId.get(id))
    .filter((t): t is Entity => !!t)
    .map((t) => mirrored(t, def.property))
    .filter((v) => v != null);
  const many = Array.isArray(e.relations[def.relation]);
  return many ? values : values[0];
}

/** Recompute and store the materialised values of one entity. Returns whether they changed. */
export async function recomputeEntity(blueprint: string, identifier: string): Promise<boolean> {
  const holder = (await index()).holders.get(blueprint);
  if (!holder) return false;
  const e = await findEntity(blueprint, identifier);
  if (!e) return false;
  const values: Record<string, unknown> = {};
  for (const [name, def, target] of holder.mirrors) {
    const v = await mirrorValue(e, def, target);
    if (v !== undefined) values[name] = v;
  }
  for (const [name, def] of holder.aggregations) {
    try {
      const v = await aggregate(e, def);
      if (v !== null) values[name] = v;
    } catch (err) {
      console.error(`[computed] ${blueprint}/${identifier}.${name}: ${errorMessage(err)}`);
    }
  }
  const next = JSON.stringify(values);
  const current = JSON.stringify(
    Object.fromEntries(Object.entries(e.computed ?? {}).filter(([k]) => holder.mirrors.some((m) => m[0] === k) || holder.aggregations.some((a) => a[0] === k))),
  );
  if (next === current) return false;
  await run('UPDATE entities SET computed = ? WHERE blueprint = ? AND identifier = ?', next, blueprint, identifier);
  return true;
}

/**
 * After an entity was written (relations `before` → `after`) or deleted (`after` null): refresh what depends on
 * it: itself, the entities mirroring from it, and the entities aggregating it (before and after the change).
 */
export async function refreshAfterWrite(
  blueprint: string,
  identifier: string,
  before: Record<string, RelationValue> | null,
  after: Record<string, RelationValue> | null,
  relationTargets: Record<string, { target: string }>,
) {
  try {
    const idx = await index();
    if (!idx.holders.size) return;
    const affected = new Map<string, [string, string]>();
    const add = (b: string, i: string) => affected.set(`${b}/${i}`, [b, i]);
    if (after && idx.holders.has(blueprint)) add(blueprint, identifier);

    const mirrors = idx.mirrorSources.get(blueprint);
    if (mirrors?.length) {
      const refs = await all<{ blueprint: string; identifier: string; relation: string }>(
        `SELECT blueprint, identifier, relation FROM entity_relations WHERE target_blueprint = ? AND target_identifier = ? LIMIT ${MAX_SOURCES}`,
        blueprint,
        identifier,
      );
      for (const r of refs) if (mirrors.some((m) => m.holder === r.blueprint && m.relation === r.relation)) add(r.blueprint, r.identifier);
    }

    const aggs = idx.aggregationSources.get(blueprint);
    if (aggs?.length)
      for (const rel of [before, after])
        for (const a of aggs) {
          const target = relationTargets[a.relation]?.target;
          if (target === a.holder) for (const id of relationIds(rel?.[a.relation])) add(a.holder, id);
        }
    for (const [b, i] of affected.values()) await recomputeEntity(b, i);
  } catch (err) {
    console.error(`[computed] ${blueprint}/${identifier}: ${errorMessage(err)}`);
  }
}

/** Recompute every entity of a blueprint (its computed definitions changed). */
export async function recomputeBlueprint(blueprint: string): Promise<number> {
  invalidateComputed();
  let n = 0;
  for (let offset = 0; ; offset += 200) {
    const page = await searchEntities({ blueprint, sort: 'identifier', limit: 200, offset });
    for (const e of page.items) if (await recomputeEntity(blueprint, e.identifier)) n++;
    if (page.items.length < 200) break;
  }
  return n;
}

/** Add the `calculated` properties (evaluated now) to entities being read. */
export async function withCalculated<T extends Entity>(entities: T[]): Promise<T[]> {
  const idx = await index();
  if (!idx.calculated.size) return entities;
  for (const e of entities) {
    const defs = idx.calculated.get(e.blueprint);
    if (!defs) continue;
    const ctx = { ...slim(e), blueprint: e.blueprint, source: e.source, computed: e.computed ?? {} };
    const computed: Record<string, unknown> = { ...e.computed };
    for (const [name, def] of defs) {
      try {
        const v = await evaluate(def.expression, ctx);
        if (v !== undefined) computed[name] = v;
      } catch {
        // a failing expression leaves the value empty
      }
      ctx.computed = computed;
    }
    e.computed = computed;
  }
  return entities;
}
