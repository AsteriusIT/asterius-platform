import type { Blueprint } from '@asterius/shared';
import { all, bool, json, now, one, run, tx } from '../db.js';
import { badRequest, conflict, managedError, notFound } from '../lib/errors.js';
import { blueprintDef, type BlueprintDef } from '../schemas.js';
import { validator } from './validation.js';
import { LRU } from '../lib/lru.js';
import { bumpConfigVersion, onConfigChange, syncCaches } from '../lib/config-version.js';
import { invalidateComputed, recomputeBlueprint } from './computed.js';
import { validateStored } from './impact.js';
import { checkExpression } from '../lib/expr.js';

interface Row {
  identifier: string;
  title: string;
  description: string;
  icon: string | null;
  schema: string;
  relations: string;
  computed?: string;
  managed: number;
  created_at: string;
  updated_at: string;
  n?: number;
}

const toBlueprint = (r: Row): Blueprint => ({
  identifier: r.identifier,
  title: r.title,
  description: r.description,
  icon: r.icon,
  schema: json(r.schema, { properties: {} }),
  relations: json(r.relations, {}),
  computed: json(r.computed, {}),
  managed: bool(r.managed),
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  ...(r.n !== undefined ? { entityCount: Number(r.n) } : {}),
});

export async function listBlueprints(): Promise<Blueprint[]> {
  // One grouped scan of the primary key instead of a correlated count per blueprint.
  const rows = await all<Row>(
    `SELECT b.*, COALESCE(c.n, 0) AS n FROM blueprints b LEFT JOIN (SELECT blueprint, count(*) AS n FROM entities GROUP BY blueprint) c ON c.blueprint = b.identifier ORDER BY b.title`,
  );
  return rows.map(toBlueprint);
}

/**
 * Blueprints with entity counts from the `blueprint_stats` table (refreshed every minute by the maintenance loop):
 * the home page is the most requested endpoint and must not count entities. Live counts until the first refresh.
 */
export async function homeBlueprints(): Promise<Blueprint[]> {
  const rows = await all<Row>(`SELECT b.*, s.entity_count AS n FROM blueprints b LEFT JOIN blueprint_stats s ON s.blueprint = b.identifier ORDER BY b.title`);
  if (rows.some((r) => r.n === null || r.n === undefined)) return listBlueprints();
  return rows.map(toBlueprint);
}

/** Recompute blueprint_stats (idempotent; skipped when another replica refreshed it in the last 30 s). */
export async function refreshBlueprintStats(force = false) {
  if (!force) {
    const last = await one<{ at: string | null }>('SELECT max(updated_at) AS at FROM blueprint_stats');
    if (last?.at && Date.parse(last.at) > Date.now() - 30_000) return;
  }
  const t = now();
  const counts = await all<{ blueprint: string; n: number }>('SELECT blueprint, count(*) AS n FROM entities GROUP BY blueprint');
  const known = new Map(counts.map((c) => [c.blueprint, Number(c.n)]));
  for (const b of await all<{ identifier: string }>('SELECT identifier FROM blueprints'))
    await run(
      'INSERT INTO blueprint_stats (blueprint, entity_count, updated_at) VALUES (?, ?, ?) ON CONFLICT (blueprint) DO UPDATE SET entity_count = excluded.entity_count, updated_at = excluded.updated_at',
      b.identifier,
      known.get(b.identifier) ?? 0,
      t,
    );
  await run('DELETE FROM blueprint_stats WHERE blueprint NOT IN (SELECT identifier FROM blueprints)');
}

export async function getBlueprint(id: string): Promise<Blueprint> {
  const r = await one<Row>('SELECT * FROM blueprints WHERE identifier = ?', id);
  if (!r) throw notFound(`Blueprint ${id}`);
  return toBlueprint(r);
}

// Entity writes look the blueprint up on every call (integration syncs write thousands): cache briefly.
const cache = new LRU<string, Blueprint>(500, 5_000);
onConfigChange(() => cache.clear());
export async function getBlueprintCached(id: string): Promise<Blueprint> {
  await syncCaches(); // another replica may have changed the definition
  const c = cache.get(id);
  if (c) return c;
  const bp = await getBlueprint(id);
  cache.set(id, bp);
  return bp;
}

export interface WriteOpts {
  managed?: boolean;
  /** Config loader: blueprints of one batch may reference each other. */
  knownTargets?: Set<string>;
}

export async function upsertBlueprint(input: unknown, opts: WriteOpts = {}): Promise<{ blueprint: Blueprint; created: boolean }> {
  const def: BlueprintDef = blueprintDef.parse(input);
  validator(def.schema as never); // the property schemas must compile
  for (const r of def.schema.required ?? []) if (!def.schema.properties[r]) throw badRequest(`Required property "${r}" is not defined`);
  for (const [name, rel] of Object.entries(def.relations)) {
    if (def.schema.properties[name]) throw badRequest(`"${name}" is both a property and a relation`);
    if (rel.target === def.identifier || opts.knownTargets?.has(rel.target)) continue;
    if (!(await one('SELECT identifier FROM blueprints WHERE identifier = ?', rel.target)))
      throw badRequest(`Relation "${name}": blueprint "${rel.target}" does not exist`);
  }
  for (const [name, c] of Object.entries(def.computed)) {
    if (def.schema.properties[name] || def.relations[name]) throw badRequest(`Computed property "${name}" clashes with a property or relation`);
    if (c.kind === 'calculated') checkExpression(c.expression);
    else if (c.kind === 'mirror') {
      if (!def.relations[c.relation]) throw badRequest(`Computed "${name}": relation "${c.relation}" does not exist`);
    } else {
      if (c.function !== 'count' && !c.property) throw badRequest(`Computed "${name}": ${c.function} needs a property`);
      if (c.filter) checkExpression(c.filter);
      const source = c.blueprint === def.identifier ? def : opts.knownTargets?.has(c.blueprint) ? undefined : await getBlueprint(c.blueprint).catch(() => null);
      if (source === null) throw badRequest(`Computed "${name}": blueprint "${c.blueprint}" does not exist`);
      if (source && source.relations[c.relation]?.target !== def.identifier)
        throw badRequest(`Computed "${name}": "${c.blueprint}.${c.relation}" is not a relation to "${def.identifier}"`);
    }
  }
  const existing = await one<Row>('SELECT * FROM blueprints WHERE identifier = ?', def.identifier);
  if (existing && bool(existing.managed) && !opts.managed) throw managedError('Blueprint', def.identifier);
  const t = now();
  const values = [
    def.title,
    def.description,
    def.icon ?? null,
    JSON.stringify(def.schema),
    JSON.stringify(def.relations),
    JSON.stringify(def.computed),
    opts.managed ? 1 : 0,
  ];
  if (existing)
    await run(
      'UPDATE blueprints SET title = ?, description = ?, icon = ?, schema = ?, relations = ?, computed = ?, managed = ?, updated_at = ? WHERE identifier = ?',
      ...values,
      t,
      def.identifier,
    );
  else
    await run(
      'INSERT INTO blueprints (title, description, icon, schema, relations, computed, managed, created_at, updated_at, identifier) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ...values,
      t,
      t,
      def.identifier,
    );
  await bumpConfigVersion();
  invalidateComputed();
  if (existing) await syncRelationIndex(def.identifier, def.relations);
  // Existing entities are re-validated in the background; the report shows in the blueprint builder.
  if (existing && (existing.schema !== JSON.stringify(def.schema) || existing.relations !== JSON.stringify(def.relations)))
    void validateStored(def.identifier).catch((err) => console.error(`[impact] ${def.identifier}: ${(err as Error).message}`));
  // Materialised values follow the definitions: recompute in the background when they changed.
  if (JSON.stringify(def.computed) !== (existing?.computed ?? '{}'))
    void recomputeBlueprint(def.identifier).catch((err) => console.error(`[computed] ${def.identifier}: ${(err as Error).message}`));
  return { blueprint: await getBlueprint(def.identifier), created: !existing };
}

/**
 * The relation index (`entity_relations`) denormalises each relation's target blueprint. When a blueprint changes,
 * retarget the rows of relations whose target changed and drop those of relations that no longer exist.
 */
async function syncRelationIndex(id: string, relations: Record<string, { target: string }>) {
  const names = Object.keys(relations);
  for (const [name, rel] of Object.entries(relations))
    await run(
      'UPDATE entity_relations SET target_blueprint = ? WHERE blueprint = ? AND relation = ? AND target_blueprint != ?',
      rel.target,
      id,
      name,
      rel.target,
    );
  if (names.length) await run(`DELETE FROM entity_relations WHERE blueprint = ? AND relation NOT IN (${names.map(() => '?').join(',')})`, id, ...names);
  else await run('DELETE FROM entity_relations WHERE blueprint = ?', id);
}

/** Rebuild the relation index of a blueprint from the entities' own relation documents (repairs any drift). */
export async function repairRelationIndex(id: string): Promise<{ entities: number; references: number }> {
  const bp = await getBlueprint(id);
  let references = 0;
  const rows = await all<{ identifier: string; relations: string }>('SELECT identifier, relations FROM entities WHERE blueprint = ?', id);
  await tx(async (d) => {
    await d.query('DELETE FROM entity_relations WHERE blueprint = ?', [id]);
    for (const r of rows)
      for (const [name, value] of Object.entries(json<Record<string, string | string[] | null>>(r.relations, {}))) {
        const rel = bp.relations[name];
        if (!rel) continue;
        for (const target of Array.isArray(value) ? value : value ? [value] : []) {
          await d.query('INSERT INTO entity_relations (blueprint, identifier, relation, target_blueprint, target_identifier) VALUES (?, ?, ?, ?, ?)', [
            id,
            r.identifier,
            name,
            rel.target,
            target,
          ]);
          references++;
        }
      }
  });
  return { entities: rows.length, references };
}

export async function deleteBlueprint(id: string, opts: { managed?: boolean } = {}) {
  const bp = await getBlueprint(id);
  if (bp.managed && !opts.managed) throw managedError('Blueprint', id);
  const n = await one<{ n: number }>('SELECT count(*) AS n FROM entities WHERE blueprint = ?', id);
  if (Number(n?.n) > 0) throw conflict(`Blueprint "${id}" still has ${n!.n} entities; delete them first`);
  const actions = await all<{ identifier: string }>('SELECT identifier FROM actions WHERE blueprint = ?', id);
  if (actions.length) throw conflict(`Actions use blueprint "${id}": ${actions.map((a) => a.identifier).join(', ')}`);
  const cards = await all<{ identifier: string }>('SELECT identifier FROM scorecards WHERE blueprint = ?', id);
  if (cards.length) throw conflict(`Scorecards use blueprint "${id}": ${cards.map((c) => c.identifier).join(', ')}`);
  for (const other of await listBlueprints())
    if (other.identifier !== id && Object.values(other.relations).some((r) => r.target === id))
      throw conflict(`Blueprint "${other.identifier}" has a relation to "${id}"`);
  await run('DELETE FROM entity_tombstones WHERE blueprint = ?', id);
  await run('DELETE FROM blueprints WHERE identifier = ?', id);
  await bumpConfigVersion();
  invalidateComputed();
}
