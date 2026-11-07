import type { RelationValue } from '@asterius/shared';
import { checkExpression, evaluate } from '../lib/expr.js';
import type { MappingDef } from '../schemas.js';

/**
 * Turn third-party items into catalog entities. Every field of a mapping is a JSONata expression evaluated
 * against the item (or each element produced by `items`), with these variables:
 *   $parent       the original item when `items` fans out
 *   $integration  { identifier, config } of the integration (e.g. `$integration.config.cluster`)
 *   $headers      request headers (webhook integrations)
 * Constants are JSONata literals: `"service"`, `true`, `42`.
 */

export interface Mapped {
  blueprint: string;
  identifier: string;
  title?: string;
  team?: string | null;
  properties: Record<string, unknown>;
  relations: Record<string, RelationValue>;
  delete: boolean;
}

export type Bindings = Record<string, unknown>;

const asString = (v: unknown) => (v == null || v === '' ? undefined : typeof v === 'object' ? JSON.stringify(v) : String(v));

function asRelation(v: unknown): RelationValue {
  if (v == null || v === '') return null;
  if (Array.isArray(v)) return v.filter((x) => x != null && x !== '').map(String);
  return String(v);
}

/** What a delivery is the complete set of (see `MappingDef.prune`). */
export interface PruneScope {
  blueprint: string;
  relation: string;
  target: string;
}

export async function mapItem(m: MappingDef, item: unknown, bindings: Bindings = {}): Promise<{ mapped: Mapped[]; skipped: number; prune?: PruneScope }> {
  if (m.filter && !(await evaluate(m.filter, item, bindings))) return { mapped: [], skipped: 1 };
  let elements: { data: unknown; b: Bindings }[] = [{ data: item, b: bindings }];
  if (m.items) {
    const v = await evaluate(m.items, item, bindings);
    const list = v == null ? [] : Array.isArray(v) ? v : [v];
    elements = list.map((data) => ({ data, b: { ...bindings, parent: item } }));
  }
  const mapped: Mapped[] = [];
  let skipped = 0;
  for (const { data, b } of elements) {
    const e = m.entity;
    const identifier = asString(await evaluate(e.identifier, data, b));
    if (!identifier) {
      skipped++;
      continue;
    }
    const properties: Record<string, unknown> = {};
    for (const [k, expr] of Object.entries(e.properties ?? {})) {
      const v = await evaluate(expr, data, b);
      if (v !== undefined && v !== null) properties[k] = v;
    }
    const relations: Record<string, RelationValue> = {};
    for (const [k, expr] of Object.entries(e.relations ?? {})) relations[k] = asRelation(await evaluate(expr, data, b));
    mapped.push({
      blueprint: e.blueprint,
      identifier,
      title: e.title ? asString(await evaluate(e.title, data, b)) : undefined,
      team: e.team ? (asString(await evaluate(e.team, data, b)) ?? null) : undefined,
      properties,
      relations,
      delete: m.delete ? !!(await evaluate(m.delete, data, b)) : false,
    });
  }
  let prune: PruneScope | undefined;
  if (m.prune) {
    const target = asString(await evaluate(m.prune.value, item, bindings));
    if (target) prune = { blueprint: m.entity.blueprint, relation: m.prune.relation, target };
  }
  return { mapped, skipped, prune };
}

/** Validate every expression of a mapping (on save). */
export function checkMapping(m: MappingDef) {
  for (const expr of [
    m.filter,
    m.items,
    m.delete,
    m.prune?.value,
    m.entity.identifier,
    m.entity.title,
    m.entity.team,
    ...Object.values(m.entity.properties ?? {}),
    ...Object.values(m.entity.relations ?? {}),
  ])
    if (expr) checkExpression(expr);
}
