import type { Blueprint, Entity, EntityPage, EntityQueryBody, RelatedEntities, RelationValue, Tombstone } from '@asterius/shared';
import { config } from '../config.js';
import { all, dialect, json, later, now, one, run, tx, type Driver, type SqlValue } from '../db.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { staleVersion } from '../lib/conflict.js';
import { LRU } from '../lib/lru.js';
import { onConfigChange, syncCaches } from '../lib/config-version.js';
import { decodeCursor, encodeCursor } from '../lib/cursor.js';
import { notifyListeners, prepareEvents, type DomainEvent } from '../events.js';
import { entityInput, type EntityInput } from '../schemas.js';
import { lastChange, recordVersion, snapshotOf } from './history.js';
import { refreshAfterWrite, withCalculated } from './computed.js';
import { evaluateEntity, removeEntityResults } from './scorecards.js';
import { getBlueprintCached } from './blueprints.js';
import { compact, validate } from './validation.js';
import { compileEntityQuery } from './query.js';
import { canonicalJson, entitySearchText } from './search.js';
import type { Actor } from '../audit.js';
import { can, readFilter } from '../auth/access.js';
import type { Principal } from '../auth/users.js';
import { orgId } from '../orgs/context.js';

interface Row {
  blueprint: string;
  identifier: string;
  title: string;
  team: string | null;
  properties: string;
  relations: string;
  source: string;
  version: number;
  computed?: string;
  created_at: string;
  updated_at: string;
}

const COLS = 'blueprint, identifier, title, team, properties, relations, source, version, computed, created_at, updated_at';

export const toEntity = (r: Row): Entity => ({
  blueprint: r.blueprint,
  identifier: r.identifier,
  title: r.title,
  team: r.team,
  properties: json(r.properties, {}),
  relations: json(r.relations, {}),
  computed: json(r.computed, {}),
  source: r.source,
  version: Number(r.version),
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export async function getEntity(blueprint: string, identifier: string): Promise<Entity> {
  const r = await one<Row>(`SELECT ${COLS} FROM entities WHERE org_id = ? AND blueprint = ? AND identifier = ?`, orgId(), blueprint, identifier);
  if (!r) throw notFound(`Entity ${blueprint}/${identifier}`);
  return (await withCalculated([toEntity(r)]))[0];
}

export async function findEntity(blueprint: string, identifier: string): Promise<Entity | undefined> {
  const r = await one<Row>(`SELECT ${COLS} FROM entities WHERE org_id = ? AND blueprint = ? AND identifier = ?`, orgId(), blueprint, identifier);
  return r && toEntity(r);
}

export interface EntityQuery extends EntityQueryBody {
  /** Restrict results to what this principal may read (omit for internal callers such as syncs). */
  viewer?: Principal;
  /** Owned by one of these teams (internal callers, e.g. the home page; `team` is the single-team API filter). */
  teams?: string[];
  limit: number;
  offset: number;
}

export async function searchEntities(q: EntityQuery): Promise<EntityPage> {
  const c = await compileEntityQuery(q, q.viewer?.teams);
  let where = c.where;
  const params = [...c.params];
  const base = { where: c.where, params: [...c.params] };
  const extra = (sql: string, vals: SqlValue[]) => {
    const clause = where ? ` AND ${sql}` : `WHERE ${sql}`;
    where += clause;
    base.where += clause;
    params.push(...vals);
    base.params.push(...vals);
  };
  if (q.teams) extra(q.teams.length ? `team IN (${q.teams.map(() => '?').join(',')})` : '1 = 0', q.teams);
  const vf = q.viewer ? await readFilter(q.viewer) : undefined;
  if (vf) extra(vf.sql, vf.params);
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
  const page: EntityPage = { items: await withCalculated(rows.map(toEntity)) };
  const last = rows.at(-1);
  if (more && last && c.keyset) {
    const col = last as unknown as Record<string, string>;
    page.nextCursor = encodeCursor({ s: c.sort, d: c.dir, v: c.keyset.map((k) => String(col[k])) });
  }
  // The total costs a second scan: skip it on cursor pages unless asked, or when the client opts out (count=false).
  if (q.count ?? !q.cursor) {
    const [total] = await all<{ n: number }>(`SELECT count(*) AS n FROM entities ${base.where}`, ...base.params);
    page.total = Number(total?.n ?? 0);
  }
  return page;
}

/** Can the viewer read this entity (per-blueprint read rule, optionally limited to the owner team)? */
export async function canRead(viewer: Principal, e: Pick<Entity, 'blueprint' | 'team'>): Promise<boolean> {
  return can(viewer, await getBlueprintCached(e.blueprint), 'read', e.team);
}

export async function related(blueprint: string, identifier: string, viewer?: Principal): Promise<RelatedEntities> {
  const e = await getEntity(blueprint, identifier);
  const bp = await getBlueprintCached(blueprint);
  const outgoing: RelatedEntities['outgoing'] = {};
  for (const [name, rel] of Object.entries(bp.relations)) {
    const ids = relationIds(e.relations[name]);
    if (!ids.length) continue;
    const rows = await all<Row>(
      `SELECT ${COLS} FROM entities WHERE org_id = ? AND blueprint = ? AND identifier IN (${ids.map(() => '?').join(',')})`,
      orgId(),
      rel.target,
      ...ids,
    );
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
          computed: {},
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
      .join(', ')}, r.relation FROM entity_relations r JOIN entities e ON e.org_id = r.org_id AND e.blueprint = r.blueprint AND e.identifier = r.identifier
     WHERE r.org_id = ? AND r.target_blueprint = ? AND r.target_identifier = ? ORDER BY e.title LIMIT 500`,
    orgId(),
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
  if (viewer) {
    // Hide neighbours the viewer cannot read (missing placeholders carry no data and stay).
    const readable = async (list: Entity[]) => {
      const kept: Entity[] = [];
      for (const e of list) if (e.source === 'missing' || (await canRead(viewer, e))) kept.push(e);
      return kept;
    };
    for (const k of Object.keys(outgoing)) outgoing[k] = await readable(outgoing[k]!);
    for (const k of Object.keys(incoming)) incoming[k] = await readable(incoming[k]!);
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
        `SELECT identifier FROM entities WHERE org_id = ? AND blueprint = ? AND identifier IN (${ids.map(() => '?').join(',')})`,
        orgId(),
        rel.target,
        ...ids,
      );
      const missing = ids.filter((id) => !found.some((f) => f.identifier === id));
      if (missing.length) throw badRequest(`Relation "${name}": ${rel.target} ${missing.join(', ')} does not exist`);
    }
  return out;
}

const teamCache = new LRU<string, true>(1000, 30_000);
onConfigChange(() => teamCache.clear());
async function assertTeam(team: string | null) {
  if (!team) return;
  await syncCaches(); // a team deleted on another replica must stop validating
  const org = orgId();
  const key = `${org}/${team}`;
  if (teamCache.get(key)) return;
  if (!(await one('SELECT identifier FROM teams WHERE org_id = ? AND identifier = ?', org, team))) throw badRequest(`Team "${team}" does not exist`);
  teamCache.set(key, true);
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
  /** With `merge`: relations replace the existing ones instead of being merged key by key (detaching removes keys). */
  replaceRelations?: boolean;
  /** History label of the change (a revert is recorded as such). */
  op?: 'revert' | 'restore';
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
  const relations = await checkRelations(
    bp,
    opts.merge && existing && !opts.replaceRelations ? { ...existing.relations, ...input.relations } : input.relations,
    opts.source,
  );
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

/** The 412 of a stale `ifMatch`, saying who made the stored version and when. */
async function staleEntity(blueprint: string, identifier: string, current: Entity | undefined, expected: number) {
  return staleVersion(
    `Entity ${blueprint}/${identifier} is at version ${current?.version ?? 'none'}, not ${expected}; reload and retry`,
    current?.version ?? null,
    await lastChange(blueprint, identifier),
  );
}

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
    if (opts.ifMatch !== undefined && existing?.version !== opts.ifMatch) throw await staleEntity(blueprint, input.identifier, existing, opts.ifMatch);

    const p = await prepare(bp, input, existing, opts);
    if (!p.changed) return { entity: existing!, created: false, changed: false };

    const t = now();
    const entity = toWritten(p, blueprint, opts.source, t);
    // The entity write and its outbox events commit together: a crash or a failing outbox insert never loses an event.
    const outbox = await prepareEvents([
      { type: existing ? 'entity.updated' : 'entity.created', blueprint, data: { entity, before: existing ?? null }, actor: opts.actor },
    ]);
    const org = orgId();
    const written = await tx(async (d) => {
      const search = entitySearchText(input.identifier, p.title, p.properties);
      const vals = [p.title, p.team, JSON.stringify(p.properties), JSON.stringify(p.relations), opts.source, search, t];
      if (existing) {
        const r = await d.query(
          'UPDATE entities SET title = ?, team = ?, properties = ?, relations = ?, source = ?, search = ?, updated_at = ?, version = version + 1 WHERE org_id = ? AND blueprint = ? AND identifier = ? AND version = ?',
          [...vals, org, blueprint, input.identifier, existing.version],
        );
        if (!r.changes) return false;
      } else {
        const r = await d.query(
          'INSERT INTO entities (title, team, properties, relations, source, search, updated_at, created_at, org_id, blueprint, identifier, version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1) ON CONFLICT (org_id, blueprint, identifier) DO NOTHING',
          [...vals, t, org, blueprint, input.identifier],
        );
        if (!r.changes) return false;
      }
      await d.query('DELETE FROM entity_relations WHERE org_id = ? AND blueprint = ? AND identifier = ?', [org, blueprint, input.identifier]);
      await insertRelations(d, bp, [{ identifier: input.identifier, relations: p.relations }]);
      if (!existing) await d.query('DELETE FROM entity_tombstones WHERE org_id = ? AND blueprint = ? AND identifier = ?', [org, blueprint, input.identifier]);
      await recordVersion(d, {
        blueprint,
        entity: input.identifier,
        op: opts.op ?? (existing ? 'update' : 'create'),
        actor: opts.actor,
        source: opts.source,
        before: existing ? snapshotOf(existing) : null,
        after: snapshotOf(entity),
      });
      await outbox(d);
      return true;
    });
    if (!written) {
      // Lost a race. A pinned version can never succeed; a create that must be new is a conflict; otherwise re-read and retry.
      if (opts.ifMatch !== undefined) throw await staleEntity(blueprint, input.identifier, await findEntity(blueprint, input.identifier), opts.ifMatch);
      if (!existing && opts.createOnly) throw conflict(`Entity ${blueprint}/${input.identifier} already exists`);
      continue;
    }
    await notifyListeners([{ type: existing ? 'entity.updated' : 'entity.created', blueprint, data: { entity, before: existing ?? null }, actor: opts.actor }]);
    await refreshAfterWrite(blueprint, input.identifier, existing?.relations ?? null, p.relations, bp.relations);
    const fresh = await getEntity(blueprint, input.identifier); // with its computed values
    await evaluateEntity(fresh);
    return { entity: fresh, created: !existing, changed: true };
  }
  throw conflict(`Entity ${blueprint}/${input.identifier} is being modified concurrently; retry`);
}

const REL_CHUNK = 200;
async function insertRelations(d: Driver, bp: Blueprint, items: { identifier: string; relations: Record<string, RelationValue> }[]) {
  const org = orgId();
  const rows: SqlValue[][] = [];
  for (const it of items)
    for (const [name, value] of Object.entries(it.relations))
      for (const target of relationIds(value)) rows.push([org, bp.identifier, it.identifier, name, bp.relations[name]!.target, target]);
  for (let i = 0; i < rows.length; i += REL_CHUNK) {
    const chunk = rows.slice(i, i + REL_CHUNK);
    await d.query(
      `INSERT INTO entity_relations (org_id, blueprint, identifier, relation, target_blueprint, target_identifier) VALUES ${chunk.map(() => '(?, ?, ?, ?, ?, ?)').join(', ')} ON CONFLICT DO NOTHING`,
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
  const org = orgId();
  const ids = chunk.map((c) => c.input.identifier);
  const stored = new Map(
    (
      await all<Row>(
        `SELECT ${COLS} FROM entities WHERE org_id = ? AND blueprint = ? AND identifier IN (${ids.map(() => '?').join(',')})`,
        org,
        blueprint,
        ...ids,
      )
    ).map((r) => [r.identifier, toEntity(r)]),
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
        `INSERT INTO entities (org_id, blueprint, identifier, title, team, properties, relations, source, search, version, created_at, updated_at)
         VALUES ${toWrite.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)').join(', ')}
         ON CONFLICT (org_id, blueprint, identifier) DO UPDATE SET title = excluded.title, team = excluded.team, properties = excluded.properties,
           relations = excluded.relations, source = excluded.source, search = excluded.search, updated_at = excluded.updated_at, version = entities.version + 1`,
        toWrite.flatMap(({ p, entity }) => [
          org,
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
        await d.query(`DELETE FROM entity_relations WHERE org_id = ? AND blueprint = ? AND identifier IN (${replaced.map(() => '?').join(',')})`, [
          org,
          blueprint,
          ...replaced,
        ]);
      await insertRelations(
        d,
        bp,
        toWrite.map(({ p }) => ({ identifier: p.input.identifier, relations: p.relations })),
      );
      const created = toWrite.filter(({ p }) => !p.existing).map(({ p }) => p.input.identifier);
      if (created.length)
        await d.query(`DELETE FROM entity_tombstones WHERE org_id = ? AND blueprint = ? AND identifier IN (${created.map(() => '?').join(',')})`, [
          org,
          blueprint,
          ...created,
        ]);
      for (const { p, entity } of toWrite)
        await recordVersion(d, {
          blueprint,
          entity: p.input.identifier,
          op: p.existing ? 'update' : 'create',
          actor: opts.actor,
          source: opts.source,
          before: p.existing ? snapshotOf(p.existing) : null,
          after: snapshotOf(entity),
        });
      await outbox(d);
    });
  } catch (err) {
    for (const w of toWrite) fail(w.i, err);
    return;
  }
  await notifyListeners(events);
  for (const { i, p, entity } of toWrite) {
    await refreshAfterWrite(blueprint, p.input.identifier, p.existing?.relations ?? null, p.relations, bp.relations);
    const fresh = (await withCalculated([entity]))[0]!;
    await evaluateEntity(fresh);
    results[i] = { ok: true, entity: fresh, created: !p.existing, changed: true };
  }
}

interface Referrer {
  blueprint: string;
  identifier: string;
  relation: string;
}

const referrersOf = (blueprint: string, identifier: string) =>
  all<Referrer>(
    'SELECT DISTINCT blueprint, identifier, relation FROM entity_relations WHERE org_id = ? AND target_blueprint = ? AND target_identifier = ? AND NOT (blueprint = ? AND identifier = ?)',
    orgId(),
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
  // The delete and its outbox event commit together (see events.ts).
  const outbox = await prepareEvents([{ type: 'entity.deleted', blueprint, data: { entity }, actor }]);
  const org = orgId();
  await tx(async (d) => {
    await d.query('DELETE FROM entities WHERE org_id = ? AND blueprint = ? AND identifier = ?', [org, blueprint, identifier]);
    if (config.TOMBSTONE_DAYS > 0)
      await d.query(
        `INSERT INTO entity_tombstones (org_id, blueprint, identifier, snapshot, deleted_by, deleted_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (org_id, blueprint, identifier) DO UPDATE SET snapshot = excluded.snapshot, deleted_by = excluded.deleted_by, deleted_at = excluded.deleted_at, expires_at = excluded.expires_at`,
        [
          org,
          blueprint,
          identifier,
          JSON.stringify({ ...snapshotOf(entity), source: entity.source }),
          actor?.email ?? null,
          now(),
          later(config.TOMBSTONE_DAYS * 86400_000),
        ],
      );
    await recordVersion(d, { blueprint, entity: identifier, op: 'delete', actor, source: actor ? 'user' : 'system', before: snapshotOf(entity), after: null });
    await outbox(d);
  });
  await notifyListeners([{ type: 'entity.deleted', blueprint, data: { entity }, actor }]);
  await removeEntityResults(blueprint, identifier);
  await refreshAfterWrite(blueprint, identifier, entity.relations, null, (await getBlueprintCached(blueprint)).relations);
}

/**
 * Delete many entities (each honours the `onDelete` policies, tombstones and history). Returns how many were deleted and
 * which were refused (restrict) or absent.
 */
export async function deleteEntities(items: { blueprint: string; identifier: string }[], actor?: Actor) {
  let deleted = 0;
  let absent = 0;
  const refused: { blueprint: string; identifier: string; error: string }[] = [];
  for (const it of items) {
    try {
      await deleteEntity(it.blueprint, it.identifier, actor);
      deleted++;
    } catch (err) {
      if (err instanceof Error && 'statusCode' in err && (err as { statusCode: number }).statusCode === 404) absent++;
      else refused.push({ ...it, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return { deleted, absent, refused };
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
  const w = q.blueprint ? 'WHERE org_id = ? AND blueprint = ?' : 'WHERE org_id = ?';
  const p: SqlValue[] = q.blueprint ? [orgId(), q.blueprint] : [orgId()];
  const rows = await all<TombstoneRow>(`SELECT * FROM entity_tombstones ${w} ORDER BY deleted_at DESC LIMIT ? OFFSET ?`, ...p, q.limit, q.offset);
  const total = await one<{ n: number }>(`SELECT count(*) AS n FROM entity_tombstones ${w}`, ...p);
  return { items: rows.map(toTombstone), total: Number(total?.n ?? 0) };
}

/** Put a deleted entity back (with the state it had when it was deleted). */
export async function restoreEntity(blueprint: string, identifier: string, actor?: Actor): Promise<Entity> {
  const r = await one<TombstoneRow>('SELECT * FROM entity_tombstones WHERE org_id = ? AND blueprint = ? AND identifier = ?', orgId(), blueprint, identifier);
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
  if (!(await run('DELETE FROM entity_tombstones WHERE org_id = ? AND blueprint = ? AND identifier = ?', orgId(), blueprint, identifier)).changes)
    throw notFound(`Deleted entity ${blueprint}/${identifier}`);
}

/** Maintenance (every organization): tombstones past their period are gone for good. */
export const purgeExpiredTombstones = () => run('DELETE FROM entity_tombstones WHERE expires_at < ?', now());

const PROP = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const jsonText = (prop: string) => (dialect === 'postgres' ? `(properties::jsonb ->> '${prop}')` : `CAST(json_extract(properties, '$.${prop}') AS TEXT)`);
/** Materialised (mirror, aggregation) values are filterable like properties. */
const computedText = (prop: string) => (dialect === 'postgres' ? `(computed::jsonb ->> '${prop}')` : `CAST(json_extract(computed, '$.${prop}') AS TEXT)`);

/** Number of entities of a blueprint (exact-match filters on properties), or their distribution by `groupBy`. */
export async function countEntities(blueprint: string, filters: Record<string, string> = {}, groupBy?: string, viewer?: Principal) {
  const where = ['org_id = ?', 'blueprint = ?'];
  const params: SqlValue[] = [orgId(), blueprint];
  const vf = viewer ? await readFilter(viewer) : undefined; // blueprints with a read rule: only what the viewer may see
  if (vf) {
    where.push(vf.sql);
    params.push(...vf.params);
  }
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
