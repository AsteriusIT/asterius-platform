import type { Blueprint, Entity, EntityPage, RelatedEntities, RelationValue } from '@asterius/shared';
import { all, dialect, json, likeEscape, now, one, tx, type Driver, type SqlValue } from '../db.js';
import { badRequest, notFound } from '../lib/errors.js';
import { emit } from '../events.js';
import { entityInput, type EntityInput } from '../schemas.js';
import { getBlueprintCached } from './blueprints.js';
import { compact, validate } from './validation.js';
import type { Actor } from '../audit.js';

interface Row {
  blueprint: string;
  identifier: string;
  title: string;
  team: string | null;
  properties: string;
  relations: string;
  source: string;
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
  source: r.source,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export async function getEntity(blueprint: string, identifier: string): Promise<Entity> {
  const r = await one<Row>('SELECT * FROM entities WHERE blueprint = ? AND identifier = ?', blueprint, identifier);
  if (!r) throw notFound(`Entity ${blueprint}/${identifier}`);
  return toEntity(r);
}

export async function findEntity(blueprint: string, identifier: string): Promise<Entity | undefined> {
  const r = await one<Row>('SELECT * FROM entities WHERE blueprint = ? AND identifier = ?', blueprint, identifier);
  return r && toEntity(r);
}

const PROP = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const jsonText = (prop: string) => (dialect === 'postgres' ? `(properties::jsonb ->> '${prop}')` : `CAST(json_extract(properties, '$.${prop}') AS TEXT)`);

export interface EntityQuery {
  blueprint?: string;
  search?: string;
  team?: string;
  source?: string;
  /** Exact match on top-level properties (string comparison). */
  filters?: Record<string, string>;
  /** title | updated | identifier | team | prop.<name>. */
  sort?: string;
  order?: 'asc' | 'desc';
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
    add(`${jsonText(k)} = ?`, dialect === 'sqlite' && (v === 'true' || v === 'false') ? (v === 'true' ? '1' : '0') : v);
  }
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const sortCol = (): [string, 'asc' | 'desc'] => {
    if (q.sort === 'updated') return ['updated_at', 'desc'];
    if (q.sort === 'identifier') return ['identifier', 'asc'];
    if (q.sort === 'team') return ['team', 'asc'];
    if (q.sort?.startsWith('prop.')) {
      const prop = q.sort.slice(5);
      if (!PROP.test(prop)) throw badRequest(`Invalid sort property "${prop}"`);
      return [jsonText(prop), 'asc'];
    }
    return ['title', 'asc'];
  };
  const [col, defaultDir] = sortCol();
  const dir = (q.order ?? defaultDir).toUpperCase();
  const order = `${col} ${dir}, identifier ${dir}`;
  const [total] = await all<{ n: number }>(`SELECT count(*) AS n FROM entities ${w}`, ...params);
  const rows = await all<Row>(`SELECT * FROM entities ${w} ORDER BY ${order} LIMIT ? OFFSET ?`, ...params, q.limit, q.offset);
  return { items: rows.map(toEntity), total: Number(total?.n ?? 0) };
}

export interface EntityGraph {
  nodes: { id: string; blueprint: string; identifier: string; title: string; depth: number }[];
  edges: { from: string; to: string; relation: string }[];
  truncated: boolean;
}

const MAX_GRAPH_NODES = 80;

/** Entities reachable from one entity through relations, in both directions, up to `depth` hops (breadth-first). */
export async function graph(blueprint: string, identifier: string, depth: number): Promise<EntityGraph> {
  const root = await getEntity(blueprint, identifier);
  const key = (b: string, i: string) => `${b}/${i}`;
  const titles = new Map<string, string>([[key(root.blueprint, root.identifier), root.title]]);
  const depthOf = new Map<string, number>([[key(root.blueprint, root.identifier), 0]]);
  const edges = new Map<string, { from: string; to: string; relation: string }>();
  let frontier = [{ b: root.blueprint, i: root.identifier }];
  let truncated = false;
  for (let d = 1; d <= depth && frontier.length && !truncated; d++) {
    const next: typeof frontier = [];
    for (const n of frontier) {
      const rels = [
        ...(
          await all<{ relation: string; b: string; i: string }>(
            'SELECT relation, target_blueprint AS b, target_identifier AS i FROM entity_relations WHERE blueprint = ? AND identifier = ?',
            n.b,
            n.i,
          )
        ).map((r) => ({ from: key(n.b, n.i), to: key(r.b, r.i), relation: r.relation, other: { b: r.b, i: r.i } })),
        ...(
          await all<{ relation: string; b: string; i: string }>(
            'SELECT relation, blueprint AS b, identifier AS i FROM entity_relations WHERE target_blueprint = ? AND target_identifier = ?',
            n.b,
            n.i,
          )
        ).map((r) => ({ from: key(r.b, r.i), to: key(n.b, n.i), relation: r.relation, other: { b: r.b, i: r.i } })),
      ];
      for (const r of rels) {
        const otherKey = key(r.other.b, r.other.i);
        if (!depthOf.has(otherKey)) {
          if (depthOf.size >= MAX_GRAPH_NODES) {
            truncated = true;
            continue;
          }
          depthOf.set(otherKey, d);
          next.push(r.other);
        }
        edges.set(`${r.from}|${r.relation}|${r.to}`, { from: r.from, to: r.to, relation: r.relation });
      }
    }
    frontier = next;
  }
  // Titles for the nodes found (dangling references fall back to their identifier).
  for (const [k] of depthOf) {
    if (titles.has(k)) continue;
    const [b, ...rest] = k.split('/');
    const e = await findEntity(b, rest.join('/'));
    titles.set(k, e?.title ?? rest.join('/'));
  }
  return {
    nodes: [...depthOf].map(([k, d]) => {
      const [b, ...rest] = k.split('/');
      return { id: k, blueprint: b, identifier: rest.join('/'), title: titles.get(k) ?? k, depth: d };
    }),
    edges: [...edges.values()].filter((e) => depthOf.has(e.from) && depthOf.has(e.to)),
    truncated,
  };
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
  const relations = checkRelations(bp, opts.merge && existing ? { ...existing.relations, ...input.relations } : input.relations);
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
  });
  const entity = await getEntity(blueprint, input.identifier);
  await emit({ type: existing ? 'entity.updated' : 'entity.created', blueprint, data: { entity, before: existing ?? null }, actor: opts.actor });
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

export async function deleteEntity(blueprint: string, identifier: string, actor?: Actor) {
  const entity = await getEntity(blueprint, identifier);
  await tx((d) => d.query('DELETE FROM entities WHERE blueprint = ? AND identifier = ?', [blueprint, identifier]));
  await emit({ type: 'entity.deleted', blueprint, data: { entity }, actor });
  return entity;
}
