import type { Dashboard, DashboardWidget, Entity, WidgetData } from '@asterius/shared';
import { all, bool, json, now, one, run } from '../db.js';
import { errorMessage, managedError, notFound } from '../lib/errors.js';
import { dashboardDef, type DashboardDef } from '../schemas.js';
import { countPendingApprovals, listRuns, pendingApprovals } from '../actions/runs.js';
import type { Principal } from '../auth/users.js';
import { countEntities, searchEntities } from './entities.js';
import { getScorecard, scorecardSummary } from './scorecards.js';
import { getBlueprintCached } from './blueprints.js';
import { visibleBlueprints } from '../auth/access.js';
import { computeInsights } from './insights.js';
import { orgId } from '../orgs/context.js';
import { chartData, type EntityContext } from './charts.js';
import { render } from '../lib/expr.js';

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
  scope: string | null;
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
  scope: r.scope === 'entity' ? 'entity' : 'catalog',
  default: bool(r.is_default),
  widgets: json(r.widgets, []),
  managed: bool(r.managed),
});

export async function listDashboards(): Promise<Dashboard[]> {
  return (await all<Row>('SELECT * FROM dashboards WHERE org_id = ? ORDER BY title', orgId())).map(toDashboard);
}

export async function getDashboard(id: string): Promise<Dashboard> {
  const r = await one<Row>('SELECT * FROM dashboards WHERE org_id = ? AND identifier = ?', orgId(), id);
  if (!r) throw notFound(`Dashboard ${id}`);
  return toDashboard(r);
}

export async function upsertDashboard(input: unknown, opts: { managed?: boolean } = {}) {
  const def: DashboardDef = dashboardDef.parse(input);
  const org = orgId();
  const existing = await one<Row>('SELECT * FROM dashboards WHERE org_id = ? AND identifier = ?', org, def.identifier);
  if (existing && bool(existing.managed) && !opts.managed) throw managedError('Dashboard', def.identifier);
  const t = now();
  const vals = [
    def.title,
    def.description,
    def.team ?? null,
    def.blueprint ?? null,
    def.scope,
    def.default ? 1 : 0,
    JSON.stringify(def.widgets),
    opts.managed ? 1 : 0,
    t,
  ];
  if (existing)
    await run(
      'UPDATE dashboards SET title = ?, description = ?, team = ?, blueprint = ?, scope = ?, is_default = ?, widgets = ?, managed = ?, updated_at = ? WHERE org_id = ? AND identifier = ?',
      ...vals,
      org,
      def.identifier,
    );
  else
    await run(
      'INSERT INTO dashboards (title, description, team, blueprint, scope, is_default, widgets, managed, updated_at, created_at, org_id, identifier) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ...vals,
      t,
      org,
      def.identifier,
    );
  return { dashboard: await getDashboard(def.identifier), created: !existing };
}

export async function deleteDashboard(id: string, opts: { managed?: boolean } = {}) {
  const d = await getDashboard(id);
  if (d.managed && !opts.managed) throw managedError('Dashboard', id);
  await run('DELETE FROM dashboards WHERE org_id = ? AND identifier = ?', orgId(), id);
}

/**
 * The dashboard to show: for a blueprint page, the dashboard of that blueprint (the viewer's team first); for the
 * home page, the dashboard of one of the viewer's teams, else the default one; for an entity page (`scope: entity`), the
 * entity dashboard of its blueprint. Null: the built-in page.
 */
export async function resolveDashboard(p: Principal, blueprint?: string, scope: Dashboard['scope'] = 'catalog'): Promise<Dashboard | null> {
  const all_ = await listDashboards();
  const mine = (d: Dashboard) => !!d.team && p.teams.includes(d.team);
  if (blueprint) {
    const forBlueprint = all_.filter((d) => d.blueprint === blueprint && d.scope === scope);
    return forBlueprint.find(mine) ?? forBlueprint.find((d) => !d.team) ?? null;
  }
  if (scope === 'entity') return null;
  const home = all_.filter((d) => !d.blueprint);
  return home.find(mine) ?? home.find((d) => d.default && !d.team) ?? null;
}

/** Markdown values come from entity properties: neutralise what would make them links, images or HTML. */
const escapeMarkdown = (text: string) => text.replace(/[\\`*_[\]()<>!|#]/g, (c) => `\\${c}`);

async function widgetData(w: DashboardWidget, p: Principal, entity?: Entity): Promise<WidgetData> {
  const ctx: EntityContext | undefined = entity ? { blueprint: entity.blueprint, identifier: entity.identifier } : undefined;
  switch (w.type) {
    case 'count':
      return { type: 'count', ...(await countEntities(w.blueprint, w.filters, w.groupBy, p)) };
    case 'scorecard': {
      const sc = await getScorecard(w.scorecard);
      // Aggregates of a blueprint the viewer cannot read are as private as its rows.
      if (!(await visibleBlueprints(p, [await getBlueprintCached(sc.blueprint)])).length) return { error: 'You cannot see this scorecard' };
      const s = await scorecardSummary(w.scorecard, 1);
      return { type: 'scorecard', scorecard: sc.identifier, title: sc.title, levels: sc.levels, distribution: s.distribution, total: s.total };
    }
    case 'runs': {
      const r = await listRuns(
        { mine: w.mine ? p.id : undefined, status: w.status, action: w.action, blueprint: ctx?.blueprint, entity: ctx?.identifier, limit: w.limit, offset: 0 },
        p,
      );
      return { type: 'runs', items: r.items, total: r.total ?? r.items.length };
    }
    case 'approvals': {
      const { items } = await pendingApprovals(p, { limit: w.limit });
      return { type: 'approvals', items, total: await countPendingApprovals(p) };
    }
    case 'table': {
      const r = await searchEntities({
        blueprint: w.blueprint,
        search: w.search,
        filters: Object.entries(w.filters ?? {}).map(([property, value]) => ({ property, op: 'eq' as const, value })),
        sort: w.sort,
        limit: w.limit,
        offset: 0,
        viewer: p,
      });
      return { type: 'table', blueprint: w.blueprint, items: r.items, total: r.total ?? r.items.length };
    }
    case 'insights': {
      const { type: _t, title: _ti, width: _w, ...cfg } = w;
      return { type: 'insights', ...(await computeInsights(ctx ? { ...cfg, service: ctx.identifier } : cfg, p)) };
    }
    case 'markdown': {
      if (!entity || !w.content.includes('{{')) return { type: 'markdown' };
      // `{{ expression }}` over the entity (JSONata), as in action templates; no secret or environment references.
      const { value } = await render(w.content, { entity }, async () => '', { noRefs: true, wrap: escapeMarkdown });
      return { type: 'markdown', content: String(value ?? '') };
    }
    case 'chart':
      return chartData(w, p, ctx);
    case 'entity':
      return { type: 'entity' };
  }
}

/**
 * Data of every widget; a failing widget reports its error instead of breaking the dashboard. `entity`: the entity an
 * entity-page dashboard is shown for (already checked readable by the caller); its widgets are filtered to it.
 */
export async function dashboardData(d: Dashboard, p: Principal, entity?: Entity): Promise<WidgetData[]> {
  return Promise.all(d.widgets.map((w) => widgetData(w, p, entity).catch((err): WidgetData => ({ error: errorMessage(err) }))));
}
