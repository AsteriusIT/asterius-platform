import type { Blueprint } from '@asterius/shared';
import { all, bool, json, now, one, run } from '../db.js';
import { badRequest, conflict, managedError, notFound } from '../lib/errors.js';
import { blueprintDef, type BlueprintDef } from '../schemas.js';
import { validator } from './validation.js';

interface Row {
  identifier: string;
  title: string;
  description: string;
  icon: string | null;
  schema: string;
  relations: string;
  permissions: string | null;
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
  ...(r.permissions ? { permissions: json(r.permissions, {}) } : {}),
  managed: bool(r.managed),
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  ...(r.n !== undefined ? { entityCount: Number(r.n) } : {}),
});

export async function listBlueprints(): Promise<Blueprint[]> {
  const rows = await all<Row>(`SELECT b.*, (SELECT count(*) FROM entities e WHERE e.blueprint = b.identifier) AS n FROM blueprints b ORDER BY b.title`);
  return rows.map(toBlueprint);
}

export async function getBlueprint(id: string): Promise<Blueprint> {
  const r = await one<Row>('SELECT * FROM blueprints WHERE identifier = ?', id);
  if (!r) throw notFound(`Blueprint ${id}`);
  return toBlueprint(r);
}

// Entity writes look the blueprint up on every call (integration syncs write thousands): cache briefly.
const cache = new Map<string, { at: number; bp: Blueprint }>();
export async function getBlueprintCached(id: string): Promise<Blueprint> {
  const c = cache.get(id);
  if (c && Date.now() - c.at < 5_000) return c.bp;
  const bp = await getBlueprint(id);
  cache.set(id, { at: Date.now(), bp });
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
  const existing = await one<Row>('SELECT * FROM blueprints WHERE identifier = ?', def.identifier);
  if (existing && bool(existing.managed) && !opts.managed) throw managedError('Blueprint', def.identifier);
  const t = now();
  const values = [
    def.title,
    def.description,
    def.icon ?? null,
    JSON.stringify(def.schema),
    JSON.stringify(def.relations),
    def.permissions ? JSON.stringify(def.permissions) : null,
    opts.managed ? 1 : 0,
  ];
  if (existing)
    await run(
      'UPDATE blueprints SET title = ?, description = ?, icon = ?, schema = ?, relations = ?, permissions = ?, managed = ?, updated_at = ? WHERE identifier = ?',
      ...values,
      t,
      def.identifier,
    );
  else
    await run(
      'INSERT INTO blueprints (title, description, icon, schema, relations, permissions, managed, created_at, updated_at, identifier) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ...values,
      t,
      t,
      def.identifier,
    );
  cache.delete(def.identifier);
  return { blueprint: await getBlueprint(def.identifier), created: !existing };
}

export async function deleteBlueprint(id: string, opts: { managed?: boolean } = {}) {
  const bp = await getBlueprint(id);
  if (bp.managed && !opts.managed) throw managedError('Blueprint', id);
  const n = await one<{ n: number }>('SELECT count(*) AS n FROM entities WHERE blueprint = ?', id);
  if (Number(n?.n) > 0) throw conflict(`Blueprint "${id}" still has ${n!.n} entities; delete them first`);
  const actions = await all<{ identifier: string }>('SELECT identifier FROM actions WHERE blueprint = ?', id);
  if (actions.length) throw conflict(`Actions use blueprint "${id}": ${actions.map((a) => a.identifier).join(', ')}`);
  for (const other of await listBlueprints())
    if (other.identifier !== id && Object.values(other.relations).some((r) => r.target === id))
      throw conflict(`Blueprint "${other.identifier}" has a relation to "${id}"`);
  await run('DELETE FROM blueprints WHERE identifier = ?', id);
  cache.delete(id);
}
