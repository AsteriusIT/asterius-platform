import type { EntityQueryBody, FilterOp, PropertyFilter, RelationFilter } from '@asterius/shared';
import { dialect, one, likeEscape, type SqlValue } from '../db.js';
import { badRequest } from '../lib/errors.js';
import { searchTerms } from './search.js';

/**
 * Entity query compiler, shared by GET /entities (query string), POST /entities/query (JSON body), the agent
 * `search_catalog` tool and the UI filter bar. One structure (`EntityQueryBody`), parameterized SQL for both dialects.
 */

const PROP = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
export const FILTER_OPS: readonly FilterOp[] = ['eq', 'neq', 'in', 'contains', 'gt', 'gte', 'lt', 'lte', 'between', 'exists'];
const MAX_IN = 100;

type Scalar = string | number | boolean;

// ---------- parsing the query string ----------
const csv = (v: string) =>
  v
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');

/**
 * `filter.tier=1` (eq) · `filter.tier[gt]=2` · `filter.lang[in]=go,rust` · `filter.tier[between]=1,3` ·
 * `filter.owner[exists]=true` · `relation.system=payments` (or `a,b`).
 */
export function parseFilterParams(query: Record<string, unknown>): { filters: PropertyFilter[]; relations: RelationFilter[] } {
  const filters: PropertyFilter[] = [];
  const relations: RelationFilter[] = [];
  for (const [key, raw] of Object.entries(query)) {
    if (typeof raw !== 'string') continue;
    const f = /^filter\.([^[]+?)(?:\[(\w+)\])?$/.exec(key);
    if (f) {
      const op = (f[2] ?? 'eq') as FilterOp;
      if (!FILTER_OPS.includes(op)) throw badRequest(`Unknown filter operator "${f[2]}" (use ${FILTER_OPS.join(', ')})`);
      const value: PropertyFilter['value'] = op === 'in' || op === 'between' ? csv(raw) : op === 'exists' ? raw !== 'false' : raw;
      filters.push({ property: f[1]!, op, value });
      continue;
    }
    const r = /^relation\.(.+)$/.exec(key);
    if (r) relations.push({ relation: r[1]!, target: csv(raw) });
  }
  return { filters, relations };
}

// ---------- compilation ----------
// Materialised computed values (mirrors, aggregations) are filterable and sortable like properties.
const jsonText = (k: string) =>
  dialect === 'postgres'
    ? `COALESCE(properties::jsonb ->> '${k}', computed::jsonb ->> '${k}')`
    : `CAST(COALESCE(json_extract(properties, '$.${k}'), json_extract(computed, '$.${k}')) AS TEXT)`;
const jsonRaw = (k: string) =>
  dialect === 'postgres'
    ? `COALESCE(properties::jsonb -> '${k}', computed::jsonb -> '${k}')`
    : `COALESCE(json_extract(properties, '$.${k}'), json_extract(computed, '$.${k}'))`;

const isNumeric = (v: Scalar) => (typeof v === 'number' ? Number.isFinite(v) : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)));

/** Equality compares by string value ("1" matches 1, "true" matches true), like the original `filter.x=` behaviour. */
function eq(k: string, v: Scalar, params: SqlValue[]): string {
  const s = String(v);
  if (dialect === 'sqlite') {
    params.push(s === 'true' ? '1' : s === 'false' ? '0' : s);
    return `${jsonText(k)} = ?`;
  }
  const candidates: Scalar[] = [s];
  if (isNumeric(s)) candidates.push(Number(s));
  if (s === 'true' || s === 'false') candidates.push(s === 'true');
  const parts = candidates.map((c) => {
    params.push(JSON.stringify({ [k]: c }), JSON.stringify({ [k]: c }));
    return '(properties::jsonb @> ?::jsonb OR computed::jsonb @> ?::jsonb)'; // properties: served by the GIN index
  });
  return `(${parts.join(' OR ')})`;
}

function compare(k: string, op: 'gt' | 'gte' | 'lt' | 'lte', v: Scalar, params: SqlValue[]): string {
  const sym = { gt: '>', gte: '>=', lt: '<', lte: '<=' }[op];
  if (isNumeric(v)) {
    params.push(Number(v));
    return dialect === 'postgres'
      ? `(CASE WHEN jsonb_typeof(${jsonRaw(k)}) = 'number' THEN (${jsonText(k)})::numeric END) ${sym} ?`
      : `(typeof(${jsonRaw(k)}) IN ('integer', 'real') AND ${jsonRaw(k)} ${sym} ?)`;
  }
  params.push(String(v)); // ISO dates and other strings compare lexicographically
  return dialect === 'postgres' ? `${jsonText(k)} ${sym} ?` : `(typeof(${jsonRaw(k)}) = 'text' AND ${jsonRaw(k)} ${sym} ?)`;
}

function scalar(f: PropertyFilter): Scalar {
  const v = f.value;
  if (v === undefined || Array.isArray(v)) throw badRequest(`Filter "${f.property}" [${f.op}] needs a single value`);
  return v;
}
function list(f: PropertyFilter): Scalar[] {
  if (!Array.isArray(f.value) || !f.value.length) throw badRequest(`Filter "${f.property}" [${f.op}] needs a list of values`);
  return f.value;
}

function propertyClause(f: PropertyFilter, params: SqlValue[]): string {
  const k = f.property;
  if (!PROP.test(k)) throw badRequest(`Invalid filter property "${k}"`);
  switch (f.op) {
    case 'eq':
      return eq(k, scalar(f), params);
    case 'neq': {
      const inner = eq(k, scalar(f), params);
      return `(${jsonText(k)} IS NULL OR NOT ${inner})`;
    }
    case 'in': {
      const vs = list(f);
      if (vs.length > MAX_IN) throw badRequest(`Filter "${k}" [in] takes at most ${MAX_IN} values`);
      return `(${vs.map((v) => eq(k, v, params)).join(' OR ')})`;
    }
    case 'contains':
      params.push(`%${likeEscape(String(scalar(f)).toLowerCase())}%`);
      return `lower(${jsonText(k)}) LIKE ? ESCAPE '\\'`;
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte':
      return compare(k, f.op, scalar(f), params);
    case 'between': {
      const vs = list(f);
      if (vs.length !== 2) throw badRequest(`Filter "${k}" [between] takes exactly two values`);
      return `(${compare(k, 'gte', vs[0]!, params)} AND ${compare(k, 'lte', vs[1]!, params)})`;
    }
    case 'exists':
      return `${jsonText(k)} ${f.value === false ? 'IS NULL' : 'IS NOT NULL'}`;
  }
}

function relationClause(r: RelationFilter, params: SqlValue[]): string {
  if (!PROP.test(r.relation)) throw badRequest(`Invalid relation "${r.relation}"`);
  const targets = Array.isArray(r.target) ? r.target : [r.target];
  if (!targets.length || targets.length > MAX_IN) throw badRequest(`Relation filter "${r.relation}" takes 1 to ${MAX_IN} targets`);
  params.push(r.relation, ...targets);
  return `EXISTS (SELECT 1 FROM entity_relations r WHERE r.blueprint = entities.blueprint AND r.identifier = entities.identifier AND r.relation = ? AND r.target_identifier IN (${targets.map(() => '?').join(',')}))`;
}

// ---------- Postgres search capabilities ----------
let trgm: Promise<string | null> | undefined;
/** Schema holding pg_trgm (its operators are schema-qualified because the search_path may not include it). */
export function trigramSchema(): Promise<string | null> {
  if (dialect !== 'postgres') return Promise.resolve(null);
  trgm ??= one<{ nspname: string }>("SELECT n.nspname FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace WHERE e.extname = 'pg_trgm'")
    .then((r) => (r && /^[A-Za-z0-9_]+$/.test(r.nspname) ? r.nspname : null))
    .catch(() => null);
  return trgm;
}

// ---------- the compiled query ----------
export type SortKey = 'title' | 'updated' | 'identifier' | 'team' | 'relevance' | `prop:${string}`;

export interface Compiled {
  where: string;
  params: SqlValue[];
  sort: SortKey;
  dir: 'asc' | 'desc';
  /** Columns of the ORDER BY, usable for keyset pagination (absent for relevance and property sorts). */
  keyset?: string[];
  orderBy: string;
  orderParams: SqlValue[];
}

const KEYSETS: Record<'title' | 'updated' | 'identifier', string[]> = {
  title: ['title', 'blueprint', 'identifier'],
  identifier: ['identifier', 'blueprint'],
  updated: ['updated_at', 'blueprint', 'identifier'],
};

export async function compileEntityQuery(q: EntityQueryBody): Promise<Compiled> {
  const where: string[] = [];
  const params: SqlValue[] = [];
  if (q.blueprint) {
    where.push('blueprint = ?');
    params.push(q.blueprint);
  }
  if (q.team) {
    where.push('team = ?');
    params.push(q.team);
  }
  if (q.source) {
    where.push('source = ?');
    params.push(q.source);
  }
  const terms = q.search ? searchTerms(q.search) : [];
  const ns = terms.length ? await trigramSchema() : null;
  for (const t of terms) {
    params.push(`%${likeEscape(t)}%`);
    if (ns && t.length >= 4) {
      params.push(t);
      where.push(`(search LIKE ? ESCAPE '\\' OR search OPERATOR("${ns}".%>) ?)`);
    } else where.push("search LIKE ? ESCAPE '\\'");
  }
  for (const f of q.filters ?? []) where.push(propertyClause(f, params));
  for (const r of q.relations ?? []) where.push(relationClause(r, params));

  const sort = (q.sort ?? (terms.length ? 'relevance' : 'title')).replace(/^prop\./, 'prop:') as SortKey;
  const orderParams: SqlValue[] = [];
  let orderBy: string;
  let keyset: string[] | undefined;
  let dir: 'asc' | 'desc' = q.dir ?? (sort === 'updated' ? 'desc' : 'asc');
  const D = () => dir.toUpperCase();
  if (sort === 'relevance') {
    if (!terms.length) throw badRequest('sort=relevance needs a search term');
    const full = terms.join(' ');
    orderParams.push(full, full, `${likeEscape(full)}%`, `${likeEscape(full)}%`);
    orderBy =
      "CASE WHEN lower(identifier) = ? THEN 0 WHEN lower(title) = ? THEN 1 WHEN lower(title) LIKE ? ESCAPE '\\' THEN 2 WHEN lower(identifier) LIKE ? ESCAPE '\\' THEN 3 ELSE 4 END";
    if (dialect === 'postgres') {
      orderParams.push(full);
      orderBy += ", ts_rank(search_tsv, plainto_tsquery('simple', ?)) DESC";
      if (ns) {
        orderParams.push(full);
        orderBy += `, "${ns}".word_similarity(?, search) DESC`;
      }
    }
    orderBy += ', title, blueprint, identifier';
    dir = 'asc';
  } else if (sort === 'title' || sort === 'identifier' || sort === 'updated') {
    keyset = KEYSETS[sort];
    orderBy = keyset.map((c) => `${c} ${D()}`).join(', ');
  } else if (sort === 'team') {
    orderBy = `team IS NULL, team ${D()}, title, blueprint, identifier`;
  } else if (sort.startsWith('prop:')) {
    const k = sort.slice(5);
    if (!PROP.test(k)) throw badRequest(`Invalid sort property "${k}"`);
    orderBy = `${jsonRaw(k)} IS NULL, ${jsonRaw(k)} ${D()}, blueprint, identifier`;
  } else throw badRequest(`Unknown sort "${sort}"`);

  return { where: where.length ? `WHERE ${where.join(' AND ')}` : '', params, sort, dir, keyset, orderBy, orderParams };
}
