import type { Dashboard, DashboardWidget, WidgetData } from '@asterius/shared';
import { all, bool, json, now, one, run } from '../db.js';
import { errorMessage, managedError, notFound } from '../lib/errors.js';
import { dashboardDef, type DashboardDef } from '../schemas.js';
import { listRuns, pendingApprovals } from '../actions/runs.js';
import type { Principal } from '../auth/users.js';
import { countEntities, searchEntities } from './entities.js';
import { getScorecard, scorecardSummary } from './scorecards.js';

/**
 * Dashboards: a set of widgets (entity counts, scorecard levels, recent runs, pending approvals, saved table
 * views, markdown) declared in YAML or the admin UI. One can be the home page of a team, of everyone, or the
 * header of a blueprint's catalog page. Data is computed on the server for the viewer.
 */

interface Row {
  identifier: string;
  title: string;
  description: string;
  team: string | null;
  blueprint: string | null;
  is_default: number;
  widgets: string;
  managed: number;
}

const toDashboard = (r: Row): Dashboard => ({
  identifier: r.identifier,
  title: r.title,
  description: r.description,
  team: r.team,
  blueprint: r.blueprint,
  default: bool(r.is_default),
  widgets: json(r.widgets, []),
  managed: bool(r.managed),
});

export async function listDashboards(): Promise<Dashboard[]> {
  return (await all<Row>('SELECT * FROM dashboards ORDER BY title')).map(toDashboard);
}

export async function getDashboard(id: string): Promise<Dashboard> {
  const r = await one<Row>('SELECT * FROM dashboards WHERE identifier = ?', id);
  if (!r) throw notFound(`Dashboard ${id}`);
  return toDashboard(r);
}

export async function upsertDashboard(input: unknown, opts: { managed?: boolean } = {}) {
  const def: DashboardDef = dashboardDef.parse(input);
  const existing = await one<Row>('SELECT * FROM dashboards WHERE identifier = ?', def.identifier);
  if (existing && bool(existing.managed) && !opts.managed) throw managedError('Dashboard', def.identifier);
  const t = now();
  const vals = [def.title, def.description, def.team ?? null, def.blueprint ?? null, def.default ? 1 : 0, JSON.stringify(def.widgets), opts.managed ? 1 : 0, t];
  if (existing)
    await run(
      'UPDATE dashboards SET title = ?, description = ?, team = ?, blueprint = ?, is_default = ?, widgets = ?, managed = ?, updated_at = ? WHERE identifier = ?',
      ...vals,
      def.identifier,
    );
  else
    await run(
      'INSERT INTO dashboards (title, description, team, blueprint, is_default, widgets, managed, updated_at, created_at, identifier) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ...vals,
      t,
      def.identifier,
    );
  return { dashboard: await getDashboard(def.identifier), created: !existing };
}

export async function deleteDashboard(id: string, opts: { managed?: boolean } = {}) {
  const d = await getDashboard(id);
  if (d.managed && !opts.managed) throw managedError('Dashboard', id);
  await run('DELETE FROM dashboards WHERE identifier = ?', id);
}

/**
 * The dashboard to show: for a blueprint page, the dashboard of that blueprint (the viewer's team first); for the
 * home page, the dashboard of one of the viewer's teams, else the default one. Null: the built-in page.
 */
export async function resolveDashboard(p: Principal, blueprint?: string): Promise<Dashboard | null> {
  const all_ = await listDashboards();
  const mine = (d: Dashboard) => !!d.team && p.teams.includes(d.team);
  if (blueprint) {
    const forBlueprint = all_.filter((d) => d.blueprint === blueprint);
    return forBlueprint.find(mine) ?? forBlueprint.find((d) => !d.team) ?? null;
  }
  const home = all_.filter((d) => !d.blueprint);
  return home.find(mine) ?? home.find((d) => d.default && !d.team) ?? null;
}

async function widgetData(w: DashboardWidget, p: Principal): Promise<WidgetData> {
  switch (w.type) {
    case 'count':
      return { type: 'count', ...(await countEntities(w.blueprint, w.filters, w.groupBy)) };
    case 'scorecard': {
      const sc = await getScorecard(w.scorecard);
      const s = await scorecardSummary(w.scorecard, 1);
      return { type: 'scorecard', scorecard: sc.identifier, title: sc.title, levels: sc.levels, distribution: s.distribution, total: s.total };
    }
    case 'runs': {
      const r = await listRuns({ mine: w.mine ? p.id : undefined, status: w.status, action: w.action, limit: w.limit, offset: 0 });
      return { type: 'runs', items: r.items, total: r.total };
    }
    case 'approvals': {
      const items = await pendingApprovals(p);
      return { type: 'approvals', items: items.slice(0, w.limit), total: items.length };
    }
    case 'table': {
      const r = await searchEntities({ blueprint: w.blueprint, search: w.search, filters: w.filters, sort: w.sort, limit: w.limit, offset: 0 });
      return { type: 'table', blueprint: w.blueprint, items: r.items, total: r.total };
    }
    case 'markdown':
      return { type: 'markdown' };
  }
}

/** Data of every widget; a failing widget reports its error instead of breaking the dashboard. */
export async function dashboardData(d: Dashboard, p: Principal): Promise<WidgetData[]> {
  return Promise.all(d.widgets.map((w) => widgetData(w, p).catch((err): WidgetData => ({ error: errorMessage(err) }))));
}
