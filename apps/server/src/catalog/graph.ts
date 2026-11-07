import type { EntityGraph, GraphEdge, GraphNode } from '@asterius/shared';
import { all, type SqlValue } from '../db.js';
import { getEntity } from './entities.js';
import { orgId } from '../orgs/context.js';

export const MAX_DEPTH = 6;
export const MAX_NODES = 1000;
const MAX_EDGES = 5000;

interface EdgeRow {
  sb: string;
  si: string;
  rel: string;
  tb: string;
  ti: string;
  depth: number;
}

/**
 * Multi-hop walk over entity_relations with a recursive CTE (one per direction; the dedup in UNION bounds cycles).
 * `out`: what this entity depends on, transitively. `in`: what depends on it (impact analysis).
 */
async function walk(bp: string, id: string, dir: 'out' | 'in', depth: number): Promise<EdgeRow[]> {
  const from = dir === 'out' ? ['blueprint', 'identifier'] : ['target_blueprint', 'target_identifier'];
  const next = dir === 'out' ? ['tb', 'ti'] : ['sb', 'si'];
  const org = orgId();
  const params: SqlValue[] = [org, bp, id, org, depth];
  return all<EdgeRow>(
    `WITH RECURSIVE walk(sb, si, rel, tb, ti, depth) AS (
       SELECT r.blueprint, r.identifier, r.relation, r.target_blueprint, r.target_identifier, 1
       FROM entity_relations r WHERE r.org_id = ? AND r.${from[0]} = ? AND r.${from[1]} = ?
       UNION
       SELECT r.blueprint, r.identifier, r.relation, r.target_blueprint, r.target_identifier, w.depth + 1
       FROM walk w JOIN entity_relations r ON r.org_id = ? AND r.${from[0]} = w.${next[0]} AND r.${from[1]} = w.${next[1]}
       WHERE w.depth < ?
     )
     SELECT sb, si, rel, tb, ti, min(depth) AS depth FROM walk GROUP BY sb, si, rel, tb, ti ORDER BY min(depth), sb, si, rel, tb, ti LIMIT ${MAX_EDGES + 1}`,
    ...params,
  );
}

export async function entityGraph(bp: string, id: string, opts: { depth: number; direction: 'out' | 'in' | 'both'; maxNodes?: number }): Promise<EntityGraph> {
  await getEntity(bp, id); // 404 when unknown
  const depth = Math.min(Math.max(opts.depth, 1), MAX_DEPTH);
  const maxNodes = Math.min(opts.maxNodes ?? MAX_NODES, MAX_NODES);
  const dirs = opts.direction === 'both' ? (['out', 'in'] as const) : ([opts.direction] as const);

  const key = (b: string, i: string) => `${b}/${i}`;
  const depths = new Map<string, number>([[key(bp, id), 0]]);
  const edges = new Map<string, GraphEdge & { depth: number }>();
  let truncated = false;
  for (const dir of dirs) {
    const rows = await walk(bp, id, dir, depth);
    if (rows.length > MAX_EDGES) truncated = true;
    for (const r of rows.slice(0, MAX_EDGES)) {
      const other = dir === 'out' ? key(r.tb, r.ti) : key(r.sb, r.si);
      const d = Number(r.depth);
      depths.set(other, Math.min(depths.get(other) ?? Infinity, d));
      edges.set(`${key(r.sb, r.si)}|${r.rel}|${key(r.tb, r.ti)}`, {
        from: { blueprint: r.sb, identifier: r.si },
        relation: r.rel,
        to: { blueprint: r.tb, identifier: r.ti },
        depth: d,
      });
    }
  }
  // Node cap: keep the nodes closest to the root.
  let ordered = [...depths.entries()].sort((a, b) => a[1] - b[1]);
  if (ordered.length > maxNodes) {
    truncated = true;
    ordered = ordered.slice(0, maxNodes);
  }
  const keep = new Set(ordered.map(([k]) => k));

  // Titles/teams for the kept nodes: one query per blueprint. Unknown targets (not ingested yet) are flagged missing.
  const byBp = new Map<string, string[]>();
  for (const [k] of ordered) {
    const i = k.indexOf('/');
    byBp.set(k.slice(0, i), [...(byBp.get(k.slice(0, i)) ?? []), k.slice(i + 1)]);
  }
  const found = new Map<string, { title: string; team: string | null }>();
  for (const [b, ids] of byBp)
    for (let o = 0; o < ids.length; o += 200) {
      const part = ids.slice(o, o + 200);
      const rows = await all<{ identifier: string; title: string; team: string | null }>(
        `SELECT identifier, title, team FROM entities WHERE org_id = ? AND blueprint = ? AND identifier IN (${part.map(() => '?').join(',')})`,
        orgId(),
        b,
        ...part,
      );
      for (const r of rows) found.set(key(b, r.identifier), { title: r.title, team: r.team });
    }
  const nodes: GraphNode[] = ordered.map(([k, d]) => {
    const i = k.indexOf('/');
    const f = found.get(k);
    return { blueprint: k.slice(0, i), identifier: k.slice(i + 1), title: f?.title ?? k.slice(i + 1), team: f?.team ?? null, depth: d, missing: !f };
  });
  return {
    root: { blueprint: bp, identifier: id },
    nodes,
    edges: [...edges.values()]
      .filter((e) => keep.has(key(e.from.blueprint, e.from.identifier)) && keep.has(key(e.to.blueprint, e.to.identifier)))
      .map(({ from, relation, to }) => ({ from, relation, to })),
    truncated,
  };
}
