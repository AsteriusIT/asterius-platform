import { z } from 'zod';
import type { SavedCatalogView, UserPreferences } from '@asterius/shared';
import { all, json, newId, now, one, run, tx } from './db.js';
import { orgId } from './orgs/context.js';
import { isAdmin, type Principal } from './auth/users.js';
import { badRequest, conflict, forbidden, notFound } from './lib/errors.js';
import { slug } from './schemas.js';

/**
 * Per-user preferences (one row per user, organization and key) and saved catalog views.
 * Form drafts are not stored here: they stay in the browser (per device, may hold half-typed data).
 */

const ident = z.string().min(1).max(200);
const MAX_FAVOURITES = 200;
const MAX_RECENT = 20;
const MAX_COLUMNS = 100;
/** Bound on the number of `catalog.columns.<blueprint>` keys a user can store. */
const MAX_KEYS = 300;

/** Allowed keys: fixed names, or a prefix followed by a blueprint identifier. */
const FIXED: Record<string, z.ZodType> = {
  favourites: z.array(ident).max(MAX_FAVOURITES),
  recentActions: z.array(ident).max(MAX_RECENT),
};
const PREFIXED: Record<string, z.ZodType> = {
  'catalog.columns.': z.array(z.string().min(1).max(64)).max(MAX_COLUMNS),
};

function schemaOf(key: string): z.ZodType {
  if (FIXED[key]) return FIXED[key];
  for (const [prefix, schema] of Object.entries(PREFIXED)) if (key.startsWith(prefix) && slug.safeParse(key.slice(prefix.length)).success) return schema;
  throw badRequest(`Unknown preference "${key}"`);
}

export async function getPreferences(userId: string): Promise<UserPreferences> {
  const rows = await all<{ pref_key: string; value: string }>(
    'SELECT pref_key, value FROM user_preferences WHERE org_id = ? AND user_id = ? ORDER BY pref_key',
    orgId(),
    userId,
  );
  return Object.fromEntries(rows.map((r) => [r.pref_key, json<unknown>(r.value, null)])) as UserPreferences;
}

/** Merge `patch` into the user's preferences: each key is replaced, `null` removes it. Returns the full set. */
export async function setPreferences(userId: string, input: unknown): Promise<UserPreferences> {
  const patch = z.record(z.string().max(100), z.unknown()).parse(input);
  const entries = Object.entries(patch);
  if (entries.length > 50) throw badRequest('At most 50 preferences per request');
  const parsed = entries.map(([k, v]) => {
    const schema = schemaOf(k);
    if (v === null) return [k, null] as const;
    const r = schema.safeParse(v);
    if (!r.success) throw badRequest(`Preference "${k}": ${r.error.issues[0]?.message ?? 'invalid value'}`);
    return [k, JSON.stringify(r.data)] as const;
  });
  const org = orgId();
  await tx(async (d) => {
    for (const [k, v] of parsed) {
      if (v === null) await d.query('DELETE FROM user_preferences WHERE org_id = ? AND user_id = ? AND pref_key = ?', [org, userId, k]);
      else
        await d.query(
          'INSERT INTO user_preferences (org_id, user_id, pref_key, value, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (org_id, user_id, pref_key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
          [org, userId, k, v, now()],
        );
    }
    const { rows } = await d.query<{ n: number }>('SELECT count(*) AS n FROM user_preferences WHERE org_id = ? AND user_id = ?', [org, userId]);
    if (Number(rows[0]?.n ?? 0) > MAX_KEYS) throw badRequest(`At most ${MAX_KEYS} preferences per user`);
  });
  return getPreferences(userId);
}

// ---------- saved catalog views ----------

const MAX_VIEWS_PER_USER = 200;

export const viewInput = z.object({
  name: z.string().trim().min(1).max(100),
  blueprint: slug,
  /** The catalog URL query string (search, team, sort, filters, …); `page` is dropped. */
  query: z.string().max(2000).default(''),
  /** Team the view is shared with (null: private). */
  team: slug.nullish(),
});
const viewPatch = viewInput
  .omit({ blueprint: true })
  .extend({ query: z.string().max(2000) })
  .partial();

interface ViewRow {
  id: string;
  owner_id: string;
  owner_name: string | null;
  blueprint: string;
  name: string;
  query: string;
  team: string | null;
  team_title: string | null;
  created_at: string;
  updated_at: string;
}

const SELECT = `SELECT v.id, v.owner_id, u.name AS owner_name, v.blueprint, v.name, v.query, v.team, t.title AS team_title, v.created_at, v.updated_at
  FROM saved_views v
  LEFT JOIN users u ON u.id = v.owner_id
  LEFT JOIN teams t ON t.org_id = v.org_id AND t.identifier = v.team`;

const canEdit = (p: Principal, ownerId: string) => ownerId === p.id || isAdmin(p);

function toView(r: ViewRow, p: Principal): SavedCatalogView {
  return {
    id: r.id,
    name: r.name,
    blueprint: r.blueprint,
    query: r.query,
    team: r.team ? { identifier: r.team, title: r.team_title ?? r.team } : null,
    owner: { id: r.owner_id, name: r.owner_name ?? '' },
    mine: r.owner_id === p.id,
    canEdit: canEdit(p, r.owner_id),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/** Normalize the stored query string: no leading `?`, no page number. */
function cleanQuery(q: string): string {
  const params = new URLSearchParams(q.replace(/^\?/, ''));
  params.delete('page');
  return params.toString();
}

/** A view can be shared with a team the owner belongs to (admins: any team of the organization). */
async function checkTeam(p: Principal, team: string | null | undefined) {
  if (!team) return;
  if (!(await one('SELECT 1 AS x FROM teams WHERE org_id = ? AND identifier = ?', orgId(), team))) throw badRequest(`Unknown team "${team}"`);
  if (!isAdmin(p) && !p.teams.includes(team)) throw forbidden('You can only share a view with one of your teams');
}

/**
 * Views the principal sees: their own and those shared with one of their teams (`all`: admins see every view).
 * Shared views of other owners come after the principal's own.
 */
export async function listViews(p: Principal, opts: { blueprint?: string; all?: boolean } = {}): Promise<SavedCatalogView[]> {
  const where = ['v.org_id = ?'];
  const params: string[] = [orgId()];
  if (opts.blueprint) {
    where.push('v.blueprint = ?');
    params.push(opts.blueprint);
  }
  if (!(opts.all && isAdmin(p))) {
    const teams = p.teams.slice(0, 200);
    where.push(teams.length ? `(v.owner_id = ? OR v.team IN (${teams.map(() => '?').join(',')}))` : 'v.owner_id = ?');
    params.push(p.id, ...teams);
  }
  const rows = await all<ViewRow>(`${SELECT} WHERE ${where.join(' AND ')} ORDER BY v.blueprint, v.name, v.created_at`, ...params);
  const views = rows.map((r) => toView(r, p));
  return [...views.filter((v) => v.mine), ...views.filter((v) => !v.mine)];
}

async function loadView(id: string): Promise<ViewRow> {
  const r = await one<ViewRow>(`${SELECT} WHERE v.org_id = ? AND v.id = ?`, orgId(), id);
  if (!r) throw notFound('View');
  return r;
}

/** Visible to its owner, to members of the team it is shared with, and to admins. */
export async function getView(p: Principal, id: string): Promise<SavedCatalogView> {
  const r = await loadView(id);
  if (!(r.owner_id === p.id || isAdmin(p) || (r.team && p.teams.includes(r.team)))) throw notFound('View');
  return toView(r, p);
}

const isUniqueViolation = (err: unknown) => /unique|duplicate/i.test(String((err as Error)?.message));

export async function createView(p: Principal, input: unknown): Promise<SavedCatalogView> {
  const v = viewInput.parse(input);
  await checkTeam(p, v.team);
  const n = await one<{ n: number }>('SELECT count(*) AS n FROM saved_views WHERE org_id = ? AND owner_id = ?', orgId(), p.id);
  if (Number(n?.n ?? 0) >= MAX_VIEWS_PER_USER) throw badRequest(`At most ${MAX_VIEWS_PER_USER} saved views per user`);
  const id = newId();
  const t = now();
  try {
    await run(
      'INSERT INTO saved_views (id, org_id, owner_id, blueprint, name, query, team, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      id,
      orgId(),
      p.id,
      v.blueprint,
      v.name,
      cleanQuery(v.query),
      v.team ?? null,
      t,
      t,
    );
  } catch (err) {
    if (isUniqueViolation(err)) throw conflict(`You already have a view named "${v.name}" for ${v.blueprint}`);
    throw err;
  }
  return getView(p, id);
}

/** Only its owner or an admin may change or delete a view. */
async function editable(p: Principal, id: string): Promise<ViewRow> {
  const r = await loadView(id);
  const visible = r.owner_id === p.id || isAdmin(p) || (r.team && p.teams.includes(r.team));
  if (!visible) throw notFound('View');
  if (!canEdit(p, r.owner_id)) throw forbidden('Only the owner of this view or an admin can change it');
  return r;
}

export async function updateView(p: Principal, id: string, input: unknown): Promise<SavedCatalogView> {
  const r = await editable(p, id);
  const v = viewPatch.parse(input);
  if (v.team !== undefined && v.team !== r.team) await checkTeam(p, v.team);
  try {
    await run(
      'UPDATE saved_views SET name = ?, query = ?, team = ?, updated_at = ? WHERE org_id = ? AND id = ?',
      v.name ?? r.name,
      v.query === undefined ? r.query : cleanQuery(v.query),
      v.team === undefined ? r.team : (v.team ?? null),
      now(),
      orgId(),
      id,
    );
  } catch (err) {
    if (isUniqueViolation(err)) throw conflict(`A view named "${v.name}" already exists for ${r.blueprint}`);
    throw err;
  }
  return getView(p, id);
}

export async function deleteView(p: Principal, id: string) {
  await editable(p, id);
  await run('DELETE FROM saved_views WHERE org_id = ? AND id = ?', orgId(), id);
}
