import type { Blueprint, Entity, EntityPage, EntityQueryBody, RelatedEntities, RelationValue } from '@asterius/shared';
import { all, json, now, one, tx, type Driver, type SqlValue } from '../db.js';
import { badRequest, conflict, notFound, preconditionFailed } from '../lib/errors.js';
import { LRU } from '../lib/lru.js';
import { onConfigChange, syncCaches } from '../lib/config-version.js';
import { decodeCursor, encodeCursor } from '../lib/cursor.js';
import { prepareEvents, type DomainEvent } from '../events.js';
import { entityInput, type EntityInput } from '../schemas.js';
import { getBlueprintCached } from './blueprints.js';
import { compact, validate } from './validation.js';
import { compileEntityQuery } from './query.js';
import { canonicalJson, entitySearchText } from './search.js';
import type { Actor } from '../audit.js';

interface Row {
  blueprint: string;
  identifier: string;
  title: string;
  team: string | null;
  properties: string;
  relations: string;
  source: string;
  version: number;
  created_at: string;
  updated_at: string;
}

const COLS = 'blueprint, identifier, title, team, properties, relations, source, version, created_at, updated_at';

export const toEntity = (r: Row): Entity => ({
  blueprint: r.blueprint,
  identifier: r.identifier,
  title: r.title,
  team: r.team,
  properties: json(r.properties, {}),
  relations: json(r.relations, {}),
  source: r.source,
  version: Number(r.version),
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export async function getEntity(blueprint: string, identifier: string): Promise<Entity> {
  const r = await one<Row>(`SELECT ${COLS} FROM entities WHERE blueprint = ? AND identifier = ?`, blueprint, identifier);
  if (!r) throw notFound(`Entity ${blueprint}/${identifier}`);
  return toEntity(r);
}

export async function findEntity(blueprint: string, identifier: string): Promise<Entity | undefined> {
  const r = await one<Row>(`SELECT ${COLS} FROM entities WHERE blueprint = ? AND identifier = ?`, blueprint, identifier);
  return r && toEntity(r);
}

export interface EntityQuery extends EntityQueryBody {
  limit: number;
  offset: number;
}

export async function searchEntities(q: EntityQuery): Promise<EntityPage> {
  const c = await compileEntityQuery(q);
  let where = c.where;
  const params = [...c.params];
  if (q.cursor) {
    if (!c.keyset) throw badRequest(`Cursor pagination is not available when sorting by ${c.sort}; use offset`);
    const cur = decodeCursor(q.cursor, { s: c.sort, d: c.dir, n: c.keyset.length });
    const cmp = `(${c.keyset.join(', ')}) ${c.dir === 'asc' ? '>' : '<'} (${c.keyset.map(() => '?').join(', ')})`;
    where = where ? `${where} AND ${cmp}` : `WHERE ${cmp}`;
    params.push(...cur);
  }
  const rows = await all<Row>(
    `SELECT ${COLS} FROM entities ${where} ORDER BY ${c.orderBy} LIMIT ? OFFSET ?`,
    ...params,
    ...c.orderParams,
    q.limit + 1,
    q.cursor ? 0 : q.offset,
  );
  const more = rows.length > q.limit;
  if (more) rows.pop();
  const page: EntityPage = { items: rows.map(toEntity) };
  const last = rows.at(-1);
  if (more && last && c.keyset) {
    const col = last as unknown as Record<string, string>;
    page.nextCursor = encodeCursor({ s: c.sort, d: c.dir, v: c.keyset.map((k) => String(col[k])) });
  }
  // The total costs a second scan: skip it on cursor pages unless asked, or when the client opts out (count=false).
  if (q.count ?? !q.cursor) {
    const [total] = await all<{ n: number }>(`SELECT count(*) AS n FROM entities ${c.where}`, ...c.params);
    page.total = Number(total?.n ?? 0);
  }
  return page;
}

export async function related(blueprint: string, identifier: string): Promise<RelatedEntities> {
  const e = await getEntity(blueprint, identifier);
  const bp = await getBlueprintCached(blueprint);
  const outgoing: RelatedEntities['outgoing'] = {};
  for (const [name, rel] of Object.entries(bp.relations)) {
    const ids = relationIds(e.relations[name]);
    if (!ids.length) continue;
    const rows = await all<Row>(`SELECT ${COLS} FROM entities WHERE blueprint = ? AND identifier IN (${ids.map(() => '?').join(',')})`, rel.target, ...ids);
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
          version: 0,
          createdAt: '',
          updatedAt: '',
        },
    );
  }
  const incoming: RelatedEntities['incoming'] = {};
  const refs = await all<Row & { relation: string }>(
    `SELECT ${COLS.split(', ')
      .map((c) => `e.${c}`)
      .join(', ')}, r.relation FROM entity_relations r JOIN entities e ON e.blueprint = r.blueprint AND e.identifier = r.identifier
     WHERE r.target_blueprint = ? AND r.target_identifier = ? ORDER BY e.title LIMIT 500`,
    blueprint,
    identifier,
  );
  for (const r of refs) (incoming[`${r.blueprint}.${r.relation}`] ??= []).push(toEntity(r));
  return { outgoing, incoming };
}

export const relationIds = (v: RelationValue | undefined): string[] => (v == null ? [] : Array.isArray(v) ? v : [v]);

function checkRelations(bp: Blueprint, relations: Record<string, RelationValue>) {
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
  return out;
}

const teamCache = new LRU<string, true>(1000, 30_000);
onConfigChange(() => teamCache.clear());
async function assertTeam(team: string | null) {
  if (!team) return;
  await syncCaches(); // a team deleted on another replica must stop validating
  if (teamCache.get(team)) return;
  if (!(await one('SELECT identifier FROM teams WHERE identifier = ?', team))) throw badRequest(`Team "${team}" does not exist`);
  teamCache.set(team, true);
}

export interface UpsertOpts {
  source: string;
  actor?: Actor;
  /** Merge properties/relations into the existing entity instead of replacing them. */
  merge?: boolean;
  /** Fail (409) when the entity already exists (POST). */
  createOnly?: boolean;
  /** Seed entities: never touch an existing entity. */
  skipExisting?: boolean;
  /** Optimistic concurrency: the write only applies when the stored version equals this (412 otherwise). */
  ifMatch?: number;
  /** Per-entity authorization, called with the stored entity (if any) before anything is written. */
  authorize?: (input: EntityInput, existing: Entity | undefined) => void | Promise<void>;
}

interface Prepared {
  input: EntityInput;
  existing?: Entity;
  title: string;
  team: string | null;
  properties: Record<string, unknown>;
  relations: Record<string, RelationValue>;
  changed: boolean;
}

/** Validate an input against the blueprint and decide whether it changes anything. Pure apart from the team lookup. */
async function prepare(bp: Blueprint, input: EntityInput, existing: Entity | undefined, opts: UpsertOpts): Promise<Prepared> {
  const blueprint = bp.identifier;
  const properties = compact(opts.merge && existing ? { ...existing.properties, ...input.properties } : input.properties);
  validate(bp.schema, properties, `properties of ${blueprint}/${input.identifier}`);
  const relations = checkRelations(bp, opts.merge && existing ? { ...existing.relations, ...input.relations } : input.relations);
  const team = input.team === undefined ? (existing?.team ?? null) : input.team;
  await assertTeam(team);
  const title = input.title?.trim() || existing?.title || input.identifier;
  const changed =
    !existing ||
    canonicalJson({ title: existing.title, team: existing.team, properties: existing.properties, relations: existing.relations }) !==
      canonicalJson({ title, team, properties, relations }) ||
    existing.source !== opts.source;
  return { input, existing, title, team, properties, relations, changed };
}

const toWritten = (p: Prepared, blueprint: string, source: string, t: string): Entity => ({
  blueprint,
  identifier: p.input.identifier,
  title: p.title,
  team: p.team,
  properties: p.properties,
  relations: p.relations,
  source,
  version: (p.existing?.version ?? 0) + 1,
  createdAt: p.existing?.createdAt ?? t,
  updatedAt: t,
});

/**
 * Create or replace an entity. Properties are validated against the blueprint (defaults applied), relations
 * against its relation definitions. Targets may not exist yet (ingestion order); they show as missing in the UI.
 * Returns whether anything changed: unchanged writes from syncs emit no event.
 *
 * Concurrency: every write bumps `version`; updates are conditional on the version that was read (retried on a
 * lost race, or 412 when the caller pinned a version with `ifMatch`), creates use INSERT ... ON CONFLICT DO NOTHING
 * (409 when createOnly, otherwise retried as an update).
 */
export async function upsertEntity(blueprint: string, raw: unknown, opts: UpsertOpts): Promise<{ entity: Entity; created: boolean; changed: boolean }> {
  const input: EntityInput = entityInput.parse(raw);
  const bp = await getBlueprintCached(blueprint);
  for (let attempt = 0; attempt < 5; attempt++) {
    const existing = await findEntity(blueprint, input.identifier);
    await opts.authorize?.(input, existing);
    if (existing && opts.createOnly) throw conflict(`Entity ${blueprint}/${input.identifier} already exists`);
    if (existing && opts.skipExisting) return { entity: existing, created: false, changed: false };
    if (opts.ifMatch !== undefined && existing?.version !== opts.ifMatch)
      throw preconditionFailed(`Entity ${blueprint}/${input.identifier} is at version ${existing?.version ?? 'none'}, not ${opts.ifMatch}; reload and retry`);

    const p = await prepare(bp, input, existing, opts);
    if (!p.changed) return { entity: existing!, created: false, changed: false };

    const t = now();
    const entity = toWritten(p, blueprint, opts.source, t);
    // The entity write and its outbox events commit together: a crash or a failing outbox insert never loses an event.
    const outbox = await prepareEvents([
      { type: existing ? 'entity.updated' : 'entity.created', blueprint, data: { entity, before: existing ?? null }, actor: opts.actor },
    ]);
    const written = await tx(async (d) => {
      const search = entitySearchText(input.identifier, p.title, p.properties);
      const vals = [p.title, p.team, JSON.stringify(p.properties), JSON.stringify(p.relations), opts.source, search, t];
      if (existing) {
        const r = await d.query(
          'UPDATE entities SET title = ?, team = ?, properties = ?, relations = ?, source = ?, search = ?, updated_at = ?, version = version + 1 WHERE blueprint = ? AND identifier = ? AND version = ?',
          [...vals, blueprint, input.identifier, existing.version],
        );
        if (!r.changes) return false;
      } else {
        const r = await d.query(
          'INSERT INTO entities (title, team, properties, relations, source, search, updated_at, created_at, blueprint, identifier, version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1) ON CONFLICT (blueprint, identifier) DO NOTHING',
          [...vals, t, blueprint, input.identifier],
        );
        if (!r.changes) return false;
      }
      await d.query('DELETE FROM entity_relations WHERE blueprint = ? AND identifier = ?', [blueprint, input.identifier]);
      await insertRelations(d, bp, [{ identifier: input.identifier, relations: p.relations }]);
      await outbox(d);
      return true;
    });
    if (!written) {
      // Lost a race. A pinned version can never succeed; a create that must be new is a conflict; otherwise re-read and retry.
      if (opts.ifMatch !== undefined) throw preconditionFailed(`Entity ${blueprint}/${input.identifier} was modified concurrently; reload and retry`);
      if (!existing && opts.createOnly) throw conflict(`Entity ${blueprint}/${input.identifier} already exists`);
      continue;
    }
    return { entity, created: !existing, changed: true };
  }
  throw conflict(`Entity ${blueprint}/${input.identifier} is being modified concurrently; retry`);
}

const REL_CHUNK = 200;
async function insertRelations(d: Driver, bp: Blueprint, items: { identifier: string; relations: Record<string, RelationValue> }[]) {
  const rows: SqlValue[][] = [];
  for (const it of items)
    for (const [name, value] of Object.entries(it.relations))
      for (const target of relationIds(value)) rows.push([bp.identifier, it.identifier, name, bp.relations[name]!.target, target]);
  for (let i = 0; i < rows.length; i += REL_CHUNK) {
    const chunk = rows.slice(i, i + REL_CHUNK);
    await d.query(
      `INSERT INTO entity_relations (blueprint, identifier, relation, target_blueprint, target_identifier) VALUES ${chunk.map(() => '(?, ?, ?, ?, ?)').join(', ')} ON CONFLICT DO NOTHING`,
      chunk.flat(),
    );
  }
}

export type BatchResult = { ok: true; entity: Entity; created: boolean; changed: boolean } | { ok: false; error: string };

const BATCH_CHUNK = 200;

/**
 * Upsert many entities of one blueprint. Per chunk of 200: one query loads the existing rows, diffs are computed in
 * memory, then a single transaction writes entities (multi-row INSERT ... ON CONFLICT DO UPDATE), relations and one
 * batched outbox insert. Errors are reported per entity (index-aligned with `raws`) and never abort the batch.
 */
export async function upsertEntities(blueprint: string, raws: unknown[], opts: UpsertOpts): Promise<BatchResult[]> {
  const bp = await getBlueprintCached(blueprint);
  const results: BatchResult[] = new Array(raws.length);
  const fail = (i: number, err: unknown) => {
    results[i] = { ok: false, error: err instanceof Error ? err.message : String(err) };
  };

  let pending: { i: number; input: EntityInput }[] = [];
  const flush = async () => {
    const chunk = pending;
    pending = [];
    if (chunk.length) await writeChunk(bp, chunk, opts, results, fail);
  };
  for (const [i, raw] of raws.entries()) {
    const parsed = entityInput.safeParse(raw);
    if (!parsed.success) {
      fail(i, parsed.error.issues.map((x) => `${x.path.join('.') || 'body'}: ${x.message}`).join('; '));
      continue;
    }
    // The same entity twice in one batch: the later one applies on top of the earlier (separate chunks).
    if (pending.some((p) => p.input.identifier === parsed.data.identifier) || pending.length >= BATCH_CHUNK) await flush();
    pending.push({ i, input: parsed.data });
  }
  await flush();
  return results;
}

async function writeChunk(
  bp: Blueprint,
  chunk: { i: number; input: EntityInput }[],
  opts: UpsertOpts,
  results: BatchResult[],
  fail: (i: number, err: unknown) => void,
) {
  const blueprint = bp.identifier;
  const ids = chunk.map((c) => c.input.identifier);
  const stored = new Map(
    (await all<Row>(`SELECT ${COLS} FROM entities WHERE blueprint = ? AND identifier IN (${ids.map(() => '?').join(',')})`, blueprint, ...ids)).map((r) => [
      r.identifier,
      toEntity(r),
    ]),
  );
  const toWrite: { i: number; p: Prepared; entity: Entity }[] = [];
  const t = now();
  for (const { i, input } of chunk) {
    try {
      const existing = stored.get(input.identifier);
      await opts.authorize?.(input, existing);
      if (existing && opts.createOnly) throw conflict(`Entity ${blueprint}/${input.identifier} already exists`);
      if (existing && opts.skipExisting) {
        results[i] = { ok: true, entity: existing, created: false, changed: false };
        continue;
      }
      const p = await prepare(bp, input, existing, opts);
      if (!p.changed) {
        results[i] = { ok: true, entity: existing!, created: false, changed: false };
        continue;
      }
      toWrite.push({ i, p, entity: toWritten(p, blueprint, opts.source, t) });
    } catch (err) {
      fail(i, err);
    }
  }
  if (!toWrite.length) return;
  const events: DomainEvent[] = toWrite.map(({ p, entity }) => ({
    type: p.existing ? 'entity.updated' : 'entity.created',
    blueprint,
    data: { entity, before: p.existing ?? null },
    actor: opts.actor,
  }));
  try {
    const outbox = await prepareEvents(events);
    await tx(async (d) => {
      await d.query(
        `INSERT INTO entities (blueprint, identifier, title, team, properties, relations, source, search, version, created_at, updated_at)
         VALUES ${toWrite.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)').join(', ')}
         ON CONFLICT (blueprint, identifier) DO UPDATE SET title = excluded.title, team = excluded.team, properties = excluded.properties,
           relations = excluded.relations, source = excluded.source, search = excluded.search, updated_at = excluded.updated_at, version = entities.version + 1`,
        toWrite.flatMap(({ p, entity }) => [
          blueprint,
          p.input.identifier,
          p.title,
          p.team,
          JSON.stringify(p.properties),
          JSON.stringify(p.relations),
          opts.source,
          entitySearchText(p.input.identifier, p.title, p.properties),
          entity.createdAt,
          t,
        ]),
      );
      const replaced = toWrite.filter(({ p }) => p.existing).map(({ p }) => p.input.identifier);
      if (replaced.length)
        await d.query(`DELETE FROM entity_relations WHERE blueprint = ? AND identifier IN (${replaced.map(() => '?').join(',')})`, [blueprint, ...replaced]);
      await insertRelations(
        d,
        bp,
        toWrite.map(({ p }) => ({ identifier: p.input.identifier, relations: p.relations })),
      );
      await outbox(d);
    });
  } catch (err) {
    for (const w of toWrite) fail(w.i, err);
    return;
  }
  for (const { i, p, entity } of toWrite) results[i] = { ok: true, entity, created: !p.existing, changed: true };
}

export async function deleteEntity(blueprint: string, identifier: string, actor?: Actor) {
  const entity = await getEntity(blueprint, identifier);
  const outbox = await prepareEvents([{ type: 'entity.deleted', blueprint, data: { entity }, actor }]);
  await tx(async (d) => {
    await d.query('DELETE FROM entities WHERE blueprint = ? AND identifier = ?', [blueprint, identifier]);
    await outbox(d);
  });
  return entity;
}

/** Delete many entities (relations cascade), in chunks of 200 with one batched outbox insert. Returns how many existed. */
export async function deleteEntities(items: { blueprint: string; identifier: string }[], actor?: Actor): Promise<number> {
  const byBlueprint = new Map<string, string[]>();
  for (const it of items) byBlueprint.set(it.blueprint, [...(byBlueprint.get(it.blueprint) ?? []), it.identifier]);
  let deleted = 0;
  for (const [blueprint, ids] of byBlueprint)
    for (let i = 0; i < ids.length; i += BATCH_CHUNK) {
      const part = ids.slice(i, i + BATCH_CHUNK);
      const marks = part.map(() => '?').join(',');
      const rows = await all<Row>(`SELECT ${COLS} FROM entities WHERE blueprint = ? AND identifier IN (${marks})`, blueprint, ...part);
      if (!rows.length) continue;
      const outbox = await prepareEvents(rows.map((r) => ({ type: 'entity.deleted' as const, blueprint, data: { entity: toEntity(r) }, actor })));
      await tx(async (d) => {
        await d.query(`DELETE FROM entities WHERE blueprint = ? AND identifier IN (${marks})`, [blueprint, ...part]);
        await outbox(d);
      });
      deleted += rows.length;
    }
  return deleted;
}
