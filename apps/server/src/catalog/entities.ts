import type { Blueprint, Entity, EntityPage, RelatedEntities, RelationValue, Tombstone } from '@asterius/shared';
import { config } from '../config.js';
import { all, dialect, json, later, likeEscape, now, one, run, tx, type Driver, type SqlValue } from '../db.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { emit } from '../events.js';
import { entityInput, type EntityInput } from '../schemas.js';
import { getBlueprintCached } from './blueprints.js';
import { compact, validate } from './validation.js';
import type { Actor } from '../audit.js';
import { recordVersion, snapshotOf } from './history.js';
import { refreshAfterWrite, withCalculated } from './computed.js';
import { evaluateEntity, removeEntityResults } from './scorecards.js';

interface Row {
  blueprint: string;
  identifier: string;
  title: string;
  team: string | null;
  properties: string;
  relations: string;
  source: string;
  computed?: string;
  created_at: string;
  updated_at: string;
}

export const toEntity = (r: Row): Entity => ({
  blueprint: r.blueprint,
  identifier: r.identifier,
  title: r.title,
  team: r.team,
  properties: json(r.properties, {}),
  relations: json(r.relations, {}),
  computed: json(r.computed, {}),
  source: r.source,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export async function getEntity(blueprint: string, identifier: string): Promise<Entity> {
  const r = await one<Row>('SELECT * FROM entities WHERE blueprint = ? AND identifier = ?', blueprint, identifier);
  if (!r) throw notFound(`Entity ${blueprint}/${identifier}`);
  return (await withCalculated([toEntity(r)]))[0];
}

export async function findEntity(blueprint: string, identifier: string): Promise<Entity | undefined> {
  const r = await one<Row>('SELECT * FROM entities WHERE blueprint = ? AND identifier = ?', blueprint, identifier);
  return r && toEntity(r);
}

const PROP = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const jsonText = (prop: string) => (dialect === 'postgres' ? `(properties::jsonb ->> '${prop}')` : `CAST(json_extract(properties, '$.${prop}') AS TEXT)`);
/** Materialised (mirror, aggregation) values are filterable like properties. */
const computedText = (prop: string) => (dialect === 'postgres' ? `(computed::jsonb ->> '${prop}')` : `CAST(json_extract(computed, '$.${prop}') AS TEXT)`);

export interface EntityQuery {
  blueprint?: string;
  search?: string;
  team?: string;
  source?: string;
  /** Exact match on top-level properties (string comparison). */
  filters?: Record<string, string>;
  sort?: 'title' | 'updated' | 'identifier';
  limit: number;
  offset: number;
}

export async function searchEntities(q: EntityQuery): Promise<EntityPage> {
  const where: string[] = [];
  const params: SqlValue[] = [];
  const add = (clause: string, value: SqlValue) => {
    where.push(clause);
    params.push(value);
  };
  if (q.blueprint) add('blueprint = ?', q.blueprint);
  if (q.team) add('team = ?', q.team);
  if (q.source) add('source = ?', q.source);
  if (q.search) add("search LIKE ? ESCAPE '\\'", `%${likeEscape(q.search.toLowerCase())}%`);
  for (const [k, v] of Object.entries(q.filters ?? {})) {
    if (!PROP.test(k)) throw badRequest(`Invalid filter property "${k}"`);
    add(`COALESCE(${jsonText(k)}, ${computedText(k)}) = ?`, dialect === 'sqlite' && (v === 'true' || v === 'false') ? (v === 'true' ? '1' : '0') : v);
  }
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const order = q.sort === 'updated' ? 'updated_at DESC' : q.sort === 'identifier' ? 'identifier' : 'title, identifier';
  const [total] = await all<{ n: number }>(`SELECT count(*) AS n FROM entities ${w}`, ...params);
  const rows = await all<Row>(`SELECT * FROM entities ${w} ORDER BY ${order} LIMIT ? OFFSET ?`, ...params, q.limit, q.offset);
  return { items: await withCalculated(rows.map(toEntity)), total: Number(total?.n ?? 0) };
}

export async function related(blueprint: string, identifier: string): Promise<RelatedEntities> {
  const e = await getEntity(blueprint, identifier);
  const bp = await getBlueprintCached(blueprint);
  const outgoing: RelatedEntities['outgoing'] = {};
  for (const [name, rel] of Object.entries(bp.relations)) {
    const ids = relationIds(e.relations[name]);
    if (!ids.length) continue;
    const rows = await all<Row>(`SELECT * FROM entities WHERE blueprint = ? AND identifier IN (${ids.map(() => '?').join(',')})`, rel.target, ...ids);
    // Keep dangling references visible (targets not ingested yet).
    const found = new Map(rows.map((r) => [r.identifier, toEntity(r)]));
    outgoing[name] = ids.map(
      (id) =>
        found.get(id) ?? {
          blueprint: rel.target,
          identifier: id,
          title: id,
          team: null,
          properties: {},
          relations: {},
          source: 'missing',
          createdAt: '',
          updatedAt: '',
        },
    );
  }
  const incoming: RelatedEntities['incoming'] = {};
  const refs = await all<Row & { relation: string }>(
    `SELECT e.*, r.relation FROM entity_relations r JOIN entities e ON e.blueprint = r.blueprint AND e.identifier = r.identifier
     WHERE r.target_blueprint = ? AND r.target_identifier = ? ORDER BY e.title LIMIT 500`,
    blueprint,
    identifier,
  );
  const incomingTitles: Record<string, string> = {};
  for (const r of refs) {
    const key = `${r.blueprint}.${r.relation}`;
    (incoming[key] ??= []).push(toEntity(r));
    if (!incomingTitles[key]) {
      const sbp = await getBlueprintCached(r.blueprint).catch(() => undefined);
      const rel = sbp?.relations[r.relation];
      incomingTitles[key] = rel?.inverseTitle ?? `${sbp?.title ?? r.blueprint} · ${rel?.title ?? r.relation}`;
    }
  }
  return { outgoing, incoming, incomingTitles };
}

export const relationIds = (v: RelationValue | undefined): string[] => (v == null ? [] : Array.isArray(v) ? v : [v]);

async function checkRelations(bp: Blueprint, relations: Record<string, RelationValue>, source: string) {
  const out: Record<string, RelationValue> = {};
  for (const [name, value] of Object.entries(relations)) {
    const rel = bp.relations[name];
    if (!rel) throw badRequest(`Blueprint "${bp.identifier}" has no relation "${name}"`);
    if (value == null || (Array.isArray(value) && !value.length)) continue;
    if (rel.many) out[name] = Array.isArray(value) ? [...new Set(value.map(String))] : [String(value)];
    else if (Array.isArray(value)) {
      if (value.length > 1) throw badRequest(`Relation "${name}" takes a single entity`);
      out[name] = String(value[0]);
    } else out[name] = String(value);
  }
  for (const [name, rel] of Object.entries(bp.relations)) if (rel.required && !out[name]) throw badRequest(`Relation "${name}" is required`);
  // Hand-written entities may not point at nothing when the relation says so (ingestion may point ahead).
  if (source === 'ui' || source === 'api')
    for (const [name, value] of Object.entries(out)) {
      const rel = bp.relations[name];
      if (!rel.requireExisting) continue;
      const ids = relationIds(value);
      const found = await all<{ identifier: string }>(
        `SELECT identifier FROM entities WHERE blueprint = ? AND identifier IN (${ids.map(() => '?').join(',')})`,
        rel.target,
        ...ids,
      );
      const missing = ids.filter((id) => !found.some((f) => f.identifier === id));
      if (missing.length) throw badRequest(`Relation "${name}": ${rel.target} ${missing.join(', ')} does not exist`);
    }
  return out;
}

const teamCache = new Map<string, number>();
async function assertTeam(team: string | null) {
  if (!team) return;
  if ((teamCache.get(team) ?? 0) > Date.now() - 30_000) return;
  if (!(await one('SELECT identifier FROM teams WHERE identifier = ?', team))) throw badRequest(`Team "${team}" does not exist`);
  teamCache.set(team, Date.now());
}

export interface UpsertOpts {
  source: string;
  actor?: Actor;
  /** Merge properties/relations into the existing entity instead of replacing them. */
  merge?: boolean;
  /** Fail when the entity already exists (POST). */
  createOnly?: boolean;
  /** Seed entities: never touch an existing entity. */
  skipExisting?: boolean;
  /** With `merge`: relations replace the existing ones instead of being merged key by key (detaching removes keys). */
  replaceRelations?: boolean;
  /** History label of the change (a revert is recorded as such). */
  op?: 'revert' | 'restore';
}

/**
 * Create or replace an entity. Properties are validated against the blueprint (defaults applied), relations
 * against its relation definitions. Targets may not exist yet (ingestion order); they show as missing in the UI.
 * Returns whether anything changed: unchanged writes from syncs emit no event.
 */
export async function upsertEntity(blueprint: string, raw: unknown, opts: UpsertOpts): Promise<{ entity: Entity; created: boolean; changed: boolean }> {
  const input: EntityInput = entityInput.parse(raw);
  const bp = await getBlueprintCached(blueprint);
  const existing = await findEntity(blueprint, input.identifier);
  if (existing && opts.createOnly) throw badRequest(`Entity ${blueprint}/${input.identifier} already exists`);
  if (existing && opts.skipExisting) return { entity: existing, created: false, changed: false };

  const properties = compact(opts.merge && existing ? { ...existing.properties, ...input.properties } : input.properties);
  validate(bp.schema, properties, `properties of ${blueprint}/${input.identifier}`);
  const relations = await checkRelations(
    bp,
    opts.merge && existing && !opts.replaceRelations ? { ...existing.relations, ...input.relations } : input.relations,
    opts.source,
  );
  const team = input.team === undefined ? (existing?.team ?? null) : input.team;
  await assertTeam(team);
  const title = input.title?.trim() || existing?.title || input.identifier;

  const next = { title, team, properties, relations };
  const changed =
    !existing ||
    JSON.stringify({ title: existing.title, team: existing.team, properties: existing.properties, relations: existing.relations }) !== JSON.stringify(next) ||
    existing.source !== opts.source;
  if (!changed) return { entity: existing!, created: false, changed: false };

  const t = now();
  await tx(async (d) => {
    const vals = [title, team, JSON.stringify(properties), JSON.stringify(relations), opts.source, `${input.identifier} ${title}`.toLowerCase(), t];
    if (existing)
      await d.query(
        'UPDATE entities SET title = ?, team = ?, properties = ?, relations = ?, source = ?, search = ?, updated_at = ? WHERE blueprint = ? AND identifier = ?',
        [...vals, blueprint, input.identifier],
      );
    else
      await d.query(
        'INSERT INTO entities (title, team, properties, relations, source, search, updated_at, created_at, blueprint, identifier) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [...vals, t, blueprint, input.identifier],
      );
    await writeRelations(d, bp, input.identifier, relations);
    if (!existing) await d.query('DELETE FROM entity_tombstones WHERE blueprint = ? AND identifier = ?', [blueprint, input.identifier]);
    await recordVersion(d, {
      blueprint,
      entity: input.identifier,
      op: opts.op ?? (existing ? 'update' : 'create'),
      actor: opts.actor,
      source: opts.source,
      before: existing ? snapshotOf(existing) : null,
      after: snapshotOf({ ...next }),
    });
  });
  await refreshAfterWrite(blueprint, input.identifier, existing?.relations ?? null, relations, bp.relations);
  const entity = await getEntity(blueprint, input.identifier);
  await emit({ type: existing ? 'entity.updated' : 'entity.created', blueprint, data: { entity, before: existing ?? null }, actor: opts.actor });
  await evaluateEntity(entity);
  return { entity, created: !existing, changed: true };
}

async function writeRelations(d: Driver, bp: Blueprint, identifier: string, relations: Record<string, RelationValue>) {
  await d.query('DELETE FROM entity_relations WHERE blueprint = ? AND identifier = ?', [bp.identifier, identifier]);
  for (const [name, value] of Object.entries(relations))
    for (const target of relationIds(value))
      await d.query('INSERT INTO entity_relations (blueprint, identifier, relation, target_blueprint, target_identifier) VALUES (?, ?, ?, ?, ?)', [
        bp.identifier,
        identifier,
        name,
        bp.relations[name].target,
        target,
      ]);
}

interface Referrer {
  blueprint: string;
  identifier: string;
  relation: string;
}

const referrersOf = (blueprint: string, identifier: string) =>
  all<Referrer>(
    'SELECT DISTINCT blueprint, identifier, relation FROM entity_relations WHERE target_blueprint = ? AND target_identifier = ? AND NOT (blueprint = ? AND identifier = ?)',
    blueprint,
    identifier,
    blueprint,
    identifier,
  );

interface DeletePlan {
  remove: Entity[];
  detach: Map<string, { entity: Entity; relation: string; target: string }[]>;
}

/** Work out what deleting an entity does to its referrers (restrict / cascade / detach) before touching anything. */
async function planDelete(entity: Entity, plan: DeletePlan, seen: Set<string>) {
  const key = `${entity.blueprint}/${entity.identifier}`;
  if (seen.has(key)) return;
  seen.add(key);
  plan.remove.push(entity);
  for (const ref of await referrersOf(entity.blueprint, entity.identifier)) {
    if (seen.has(`${ref.blueprint}/${ref.identifier}`)) continue;
    const rel = (await getBlueprintCached(ref.blueprint)).relations[ref.relation];
    const policy = rel?.onDelete ?? 'ignore';
    if (policy === 'restrict') throw conflict(`${ref.blueprint}/${ref.identifier} still points to ${key} (relation "${ref.relation}" restricts deletion)`);
    if (policy === 'ignore') continue;
    const referrer = await findEntity(ref.blueprint, ref.identifier);
    if (!referrer) continue;
    if (policy === 'cascade') await planDelete(referrer, plan, seen);
    else {
      if (rel?.required && !rel.many)
        throw conflict(`${ref.blueprint}/${ref.identifier} requires relation "${ref.relation}": it cannot be detached from ${key}`);
      const list = plan.detach.get(`${ref.blueprint}/${ref.identifier}`) ?? [];
      list.push({ entity: referrer, relation: ref.relation, target: entity.identifier });
      plan.detach.set(`${ref.blueprint}/${ref.identifier}`, list);
    }
  }
}

/**
 * Delete an entity, honouring the `onDelete` policy of the relations pointing to it: `restrict` refuses (409),
 * `cascade` deletes the referrers too, `detach` removes the reference from them. Returns the entity.
 */
export async function deleteEntity(blueprint: string, identifier: string, actor?: Actor) {
  const entity = await getEntity(blueprint, identifier);
  const plan: DeletePlan = { remove: [], detach: new Map() };
  await planDelete(entity, plan, new Set());
  const removing = new Set(plan.remove.map((e) => `${e.blueprint}/${e.identifier}`));
  for (const [key, edits] of plan.detach) {
    if (removing.has(key)) continue;
    const { entity: ref } = edits[0];
    const relations = { ...ref.relations };
    for (const { relation, target } of edits) {
      const left = relationIds(relations[relation]).filter((id) => id !== target);
      if (left.length) relations[relation] = Array.isArray(relations[relation]) ? left : left[0];
      else delete relations[relation];
    }
    await upsertEntity(ref.blueprint, { identifier: ref.identifier, relations }, { source: ref.source, actor, merge: true, replaceRelations: true });
  }
  // Referrers first, then the entity itself.
  for (const e of [...plan.remove].reverse()) await deleteOne(e, actor);
  return entity;
}

async function deleteOne(entity: Entity, actor?: Actor) {
  const { blueprint, identifier } = entity;
  await tx(async (d) => {
    await d.query('DELETE FROM entities WHERE blueprint = ? AND identifier = ?', [blueprint, identifier]);
    if (config.TOMBSTONE_DAYS > 0)
      await d.query(
        `INSERT INTO entity_tombstones (blueprint, identifier, snapshot, deleted_by, deleted_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (blueprint, identifier) DO UPDATE SET snapshot = excluded.snapshot, deleted_by = excluded.deleted_by, deleted_at = excluded.deleted_at, expires_at = excluded.expires_at`,
        [
          blueprint,
          identifier,
          JSON.stringify({ ...snapshotOf(entity), source: entity.source }),
          actor?.email ?? null,
          now(),
          later(config.TOMBSTONE_DAYS * 86400_000),
        ],
      );
    await recordVersion(d, { blueprint, entity: identifier, op: 'delete', actor, source: actor ? 'user' : 'system', before: snapshotOf(entity), after: null });
  });
  await removeEntityResults(blueprint, identifier);
  await refreshAfterWrite(blueprint, identifier, entity.relations, null, (await getBlueprintCached(blueprint)).relations);
  await emit({ type: 'entity.deleted', blueprint, data: { entity }, actor });
}

// ---------- tombstones ----------
interface TombstoneRow {
  blueprint: string;
  identifier: string;
  snapshot: string;
  deleted_by: string | null;
  deleted_at: string;
  expires_at: string;
}

const toTombstone = (r: TombstoneRow): Tombstone => {
  const s = json<{ title?: string; team?: string | null; source?: string }>(r.snapshot, {});
  return {
    blueprint: r.blueprint,
    identifier: r.identifier,
    title: s.title ?? r.identifier,
    team: s.team ?? null,
    source: s.source ?? 'ui',
    deletedBy: r.deleted_by,
    deletedAt: r.deleted_at,
    expiresAt: r.expires_at,
  };
};

export async function listTombstones(q: { blueprint?: string; limit: number; offset: number }): Promise<{ items: Tombstone[]; total: number }> {
  const w = q.blueprint ? 'WHERE blueprint = ?' : '';
  const p: SqlValue[] = q.blueprint ? [q.blueprint] : [];
  const rows = await all<TombstoneRow>(`SELECT * FROM entity_tombstones ${w} ORDER BY deleted_at DESC LIMIT ? OFFSET ?`, ...p, q.limit, q.offset);
  const total = await one<{ n: number }>(`SELECT count(*) AS n FROM entity_tombstones ${w}`, ...p);
  return { items: rows.map(toTombstone), total: Number(total?.n ?? 0) };
}

/** Put a deleted entity back (with the state it had when it was deleted). */
export async function restoreEntity(blueprint: string, identifier: string, actor?: Actor): Promise<Entity> {
  const r = await one<TombstoneRow>('SELECT * FROM entity_tombstones WHERE blueprint = ? AND identifier = ?', blueprint, identifier);
  if (!r) throw notFound(`Deleted entity ${blueprint}/${identifier}`);
  const snap = json<{ title: string; team: string | null; properties: Record<string, unknown>; relations: Record<string, string | string[]>; source?: string }>(
    r.snapshot,
    {
      title: identifier,
      team: null,
      properties: {},
      relations: {},
    },
  );
  const { source, ...state } = snap;
  const { entity } = await upsertEntity(blueprint, { identifier, ...state }, { source: source ?? 'ui', actor, createOnly: true, op: 'restore' });
  return entity;
}

export async function purgeTombstone(blueprint: string, identifier: string) {
  if (!(await run('DELETE FROM entity_tombstones WHERE blueprint = ? AND identifier = ?', blueprint, identifier)).changes)
    throw notFound(`Deleted entity ${blueprint}/${identifier}`);
}

/** Maintenance: tombstones past their period are gone for good. */
export const purgeExpiredTombstones = () => run('DELETE FROM entity_tombstones WHERE expires_at < ?', now());

/** Number of entities of a blueprint (exact-match filters on properties), or their distribution by `groupBy`. */
export async function countEntities(blueprint: string, filters: Record<string, string> = {}, groupBy?: string) {
  const where = ['blueprint = ?'];
  const params: SqlValue[] = [blueprint];
  for (const [k, v] of Object.entries(filters)) {
    if (!PROP.test(k)) throw badRequest(`Invalid filter property "${k}"`);
    where.push(`COALESCE(${jsonText(k)}, ${computedText(k)}) = ?`);
    params.push(dialect === 'sqlite' && (v === 'true' || v === 'false') ? (v === 'true' ? '1' : '0') : v);
  }
  const w = where.join(' AND ');
  if (!groupBy) return { value: Number((await one<{ n: number }>(`SELECT count(*) AS n FROM entities WHERE ${w}`, ...params))?.n ?? 0) };
  if (!PROP.test(groupBy)) throw badRequest(`Invalid property "${groupBy}"`);
  const col = groupBy === 'team' || groupBy === 'source' ? groupBy : `COALESCE(${jsonText(groupBy)}, ${computedText(groupBy)})`;
  const rows = await all<{ k: string | null; n: number }>(
    `SELECT ${col} AS k, count(*) AS n FROM entities WHERE ${w} GROUP BY ${col} ORDER BY n DESC LIMIT 50`,
    ...params,
  );
  const groups = rows.map((r) => ({ key: r.k ?? '—', count: Number(r.n) }));
  return { value: groups.reduce((a, g) => a + g.count, 0), groups };
}
