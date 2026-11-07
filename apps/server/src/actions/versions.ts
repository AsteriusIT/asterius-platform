import type { ActionVersion, ActionVersionDiff } from '@asterius/shared';
import { all, json, now, one, run } from '../db.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import type { Actor } from '../audit.js';
import type { ActionDef } from '../schemas.js';
import { orgId } from '../orgs/context.js';

/**
 * Action history: every change of an action's definition creates a numbered version (kept after the action is
 * deleted). Runs record the version they started from, an old version can be compared with another and restored.
 */

interface VersionRow {
  action: string;
  version: number;
  definition: string;
  actor_id: string | null;
  actor_email: string | null;
  note: string | null;
  created_at: string;
}

export const definitionDoc = (def: ActionDef) => JSON.stringify(def);

/** The version a definition will have once saved: unchanged → current, changed → next, new → after any deleted history. */
export async function nextVersion(id: string, current: number | undefined, doc: string): Promise<{ version: number; isNew: boolean }> {
  if (current !== undefined) {
    const row = await one<{ definition: string }>(
      'SELECT definition FROM action_versions WHERE org_id = ? AND action = ? AND version = ?',
      orgId(),
      id,
      current,
    );
    if (row?.definition === doc) return { version: current, isNew: false };
    return { version: current + 1, isNew: true };
  }
  const max = await one<{ v: number | null }>('SELECT max(version) AS v FROM action_versions WHERE org_id = ? AND action = ?', orgId(), id);
  return { version: Number(max?.v ?? 0) + 1, isNew: true };
}

export async function recordVersion(id: string, version: number, doc: string, actor: Actor, note?: string) {
  try {
    await run(
      'INSERT INTO action_versions (org_id, action, version, definition, actor_id, actor_email, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      orgId(),
      id,
      version,
      doc,
      actor.id,
      actor.email,
      note ?? null,
      now(),
    );
  } catch {
    throw conflict('The action was changed by someone else meanwhile; reload and try again');
  }
}

const toVersion = (r: VersionRow): ActionVersion => ({
  version: Number(r.version),
  actor: r.actor_email,
  note: r.note,
  at: r.created_at,
});

export async function listVersions(id: string): Promise<ActionVersion[]> {
  return (await all<VersionRow>('SELECT * FROM action_versions WHERE org_id = ? AND action = ? ORDER BY version DESC LIMIT 200', orgId(), id)).map(toVersion);
}

export async function getVersion(id: string, version: number): Promise<ActionVersion & { definition: Record<string, unknown> }> {
  const r = await one<VersionRow>('SELECT * FROM action_versions WHERE org_id = ? AND action = ? AND version = ?', orgId(), id, version);
  if (!r) throw notFound(`Version ${version} of action ${id}`);
  return { ...toVersion(r), definition: json(r.definition, {}) };
}

// ---------- diff ----------
type Obj = Record<string, unknown>;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);

/** Dotted paths whose values differ (arrays are compared as a whole). */
function changedPaths(a: unknown, b: unknown, prefix = ''): { path: string; before: unknown; after: unknown }[] {
  if (isObj(a) && isObj(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    return [...keys].flatMap((k) => changedPaths(a[k], b[k], prefix ? `${prefix}.${k}` : k));
  }
  return same(a, b) ? [] : [{ path: prefix, before: a, after: b }];
}

export function diffDefinitions(from: Obj, to: Obj): ActionVersionDiff {
  const { steps: s1 = [], ...rest1 } = from as { steps?: Obj[] };
  const { steps: s2 = [], ...rest2 } = to as { steps?: Obj[] };
  const byId = (l: Obj[]) => new Map(l.map((s) => [String(s.id), s]));
  const a = byId(s1);
  const b = byId(s2);
  return {
    fields: changedPaths(rest1, rest2),
    stepsAdded: [...b.keys()].filter((id) => !a.has(id)),
    stepsRemoved: [...a.keys()].filter((id) => !b.has(id)),
    stepsChanged: [...b.keys()].filter((id) => a.has(id) && !same(a.get(id), b.get(id))).map((id) => ({ id, changes: changedPaths(a.get(id), b.get(id)) })),
    stepsReordered: !same(
      [...a.keys()].filter((id) => b.has(id)),
      [...b.keys()].filter((id) => a.has(id)),
    ),
  };
}

export async function diffVersions(id: string, from: number, to: number): Promise<ActionVersionDiff> {
  if (!Number.isInteger(from) || !Number.isInteger(to)) throw badRequest('from and to are version numbers');
  return diffDefinitions((await getVersion(id, from)).definition, (await getVersion(id, to)).definition);
}
