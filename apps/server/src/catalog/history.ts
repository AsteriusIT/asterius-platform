import type { Entity, EntityVersion, EntityVersionDiff } from '@asterius/shared';
import { all, json, now, one, run, type Driver, type SqlValue } from '../db.js';
import { notFound } from '../lib/errors.js';
import { orgId } from '../orgs/context.js';

/**
 * Entity history: every change is recorded in `entity_versions` in the same transaction as the change itself
 * (so a version exists if and only if the change was committed). Snapshots are complete: reverting means
 * writing an old snapshot back, which creates a new version.
 */

export type VersionOp = 'create' | 'update' | 'delete' | 'revert' | 'restore';

export interface Snapshot {
  title: string;
  team: string | null;
  properties: Record<string, unknown>;
  relations: Record<string, unknown>;
}

export const snapshotOf = (e: Pick<Entity, 'title' | 'team' | 'properties' | 'relations'>): Snapshot => ({
  title: e.title,
  team: e.team,
  properties: e.properties,
  relations: e.relations,
});

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** Field-level differences between two snapshots (`null` before: created; `null` after: removed). */
export function diffSnapshots(before: Snapshot | null, after: Snapshot | null): EntityVersionDiff[] {
  const out: EntityVersionDiff[] = [];
  const push = (path: string, b: unknown, a: unknown) => {
    if (!same(b, a)) out.push({ path, before: b ?? null, after: a ?? null });
  };
  push('title', before?.title, after?.title);
  push('team', before?.team, after?.team);
  for (const group of ['properties', 'relations'] as const) {
    const b = before?.[group] ?? {};
    const a = after?.[group] ?? {};
    for (const k of new Set([...Object.keys(b), ...Object.keys(a)])) push(`${group}.${k}`, b[k], a[k]);
  }
  return out;
}

export interface VersionInput {
  blueprint: string;
  entity: string;
  op: VersionOp;
  actor?: { id: string | null; email: string | null };
  source: string;
  before: Snapshot | null;
  after: Snapshot | null;
}

/** Append a version using the caller's transaction. */
export async function recordVersion(d: Driver, v: VersionInput) {
  const org = orgId();
  const last = await d.query<{ v: number | null }>('SELECT max(version) AS v FROM entity_versions WHERE org_id = ? AND blueprint = ? AND entity = ?', [
    org,
    v.blueprint,
    v.entity,
  ]);
  const version = Number(last.rows[0]?.v ?? 0) + 1;
  // A delete keeps the last state so it can be restored; other ops store the new state.
  const snapshot = v.op === 'delete' ? v.before : v.after;
  const params: SqlValue[] = [
    org,
    v.blueprint,
    v.entity,
    version,
    v.op,
    v.actor?.id ?? null,
    v.actor?.email ?? null,
    v.source,
    JSON.stringify(snapshot),
    JSON.stringify(diffSnapshots(v.before, v.after)),
    now(),
  ];
  await d.query(
    'INSERT INTO entity_versions (org_id, blueprint, entity, version, op, actor_id, actor_email, source, snapshot, diff, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    params,
  );
  return version;
}

interface Row {
  version: number;
  op: VersionOp;
  actor_id: string | null;
  actor_email: string | null;
  source: string;
  snapshot: string;
  diff: string;
  at: string;
}

const toVersion = (r: Row): EntityVersion => ({
  version: Number(r.version),
  op: r.op,
  actor: r.actor_email,
  source: r.source,
  snapshot: json(r.snapshot, { title: '', team: null, properties: {}, relations: {} } as EntityVersion['snapshot']),
  diff: json(r.diff, []),
  at: r.at,
});

export async function listVersions(blueprint: string, entity: string, limit = 50, offset = 0): Promise<{ items: EntityVersion[]; total: number }> {
  const rows = await all<Row>(
    'SELECT * FROM entity_versions WHERE org_id = ? AND blueprint = ? AND entity = ? ORDER BY version DESC LIMIT ? OFFSET ?',
    orgId(),
    blueprint,
    entity,
    limit,
    offset,
  );
  const total = await one<{ n: number }>(
    'SELECT count(*) AS n FROM entity_versions WHERE org_id = ? AND blueprint = ? AND entity = ?',
    orgId(),
    blueprint,
    entity,
  );
  return { items: rows.map(toVersion), total: Number(total?.n ?? 0) };
}

export async function getVersion(blueprint: string, entity: string, version: number): Promise<EntityVersion> {
  const r = await one<Row>(
    'SELECT * FROM entity_versions WHERE org_id = ? AND blueprint = ? AND entity = ? AND version = ?',
    orgId(),
    blueprint,
    entity,
    version,
  );
  if (!r) throw notFound(`Version ${version} of ${blueprint}/${entity}`);
  return toVersion(r);
}

/** Retention (every organization), separate from runs: keeps the latest version of every entity whatever its age. */
export async function purgeVersions(olderThan: string) {
  return run('DELETE FROM entity_versions WHERE at < ? AND id NOT IN (SELECT max(id) FROM entity_versions GROUP BY org_id, blueprint, entity)', olderThan);
}
