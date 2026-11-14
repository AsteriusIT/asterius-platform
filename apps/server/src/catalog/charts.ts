import type { ChartData, ChartSeriesData } from '@asterius/shared';
import { all, type SqlValue } from '../db.js';
import type { Principal } from '../auth/users.js';
import { visibleBlueprints } from '../auth/access.js';
import { runVisibility } from '../actions/runs.js';
import { orgId } from '../orgs/context.js';
import type { ChartSeriesDef, DashboardWidgetDef } from '../schemas.js';
import { getBlueprintCached } from './blueprints.js';
import { entityCreationCounts } from './entities.js';
import { getScorecard } from './scorecards.js';
import { doraEvents, leadTimes, median, round } from './insights.js';

/**
 * Time series of the `chart` dashboard widget, computed for the viewer. Every series is bucketed by day, week (starting
 * Monday) or month, in UTC, over a window of `days` ending now; the first bucket is the one holding the window start.
 * SQL aggregates per day (one indexed range scan per series: runs_org, entities_blueprint_created, scorecard_history_at)
 * and the days are folded into buckets here, so the cost is bounded by the window, not by the size of the tables.
 */

export type ChartWidget = Extract<DashboardWidgetDef, { type: 'chart' }>;
export type Interval = ChartWidget['interval'];

/** The entity a dashboard of `scope: entity` is shown for. */
export interface EntityContext {
  blueprint: string;
  identifier: string;
}

const DAY = 86_400_000;
/** Series beyond this many fold into "Other" (the categorical palette has eight colours). */
const MAX_SERIES = 8;
/** Duration samples read per chart (newest windows are small; a cap keeps a year of a busy action cheap). */
const DURATION_SAMPLES = 50_000;

const RUN_STATUSES = ['SUCCESS', 'FAILURE', 'IN_PROGRESS', 'QUEUED', 'PENDING_APPROVAL', 'REJECTED', 'CANCELLED'] as const;
const STATUS_LABELS: Record<string, string> = {
  SUCCESS: 'Succeeded',
  FAILURE: 'Failed',
  IN_PROGRESS: 'In progress',
  QUEUED: 'Queued',
  PENDING_APPROVAL: 'Waiting for approval',
  REJECTED: 'Rejected',
  CANCELLED: 'Cancelled',
};

/** Start (UTC midnight) of the bucket holding `t`. */
export function bucketStart(interval: Interval, t: number): number {
  const d = new Date(t);
  d.setUTCHours(0, 0, 0, 0);
  if (interval === 'week') d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  if (interval === 'month') d.setUTCDate(1);
  return d.getTime();
}

function nextBucket(interval: Interval, t: number): number {
  const d = new Date(t);
  if (interval === 'day') d.setUTCDate(d.getUTCDate() + 1);
  else if (interval === 'week') d.setUTCDate(d.getUTCDate() + 7);
  else d.setUTCMonth(d.getUTCMonth() + 1);
  return d.getTime();
}

export interface Buckets {
  interval: Interval;
  /** Bucket starts (ms), ascending; `ends[i]` is the start of the next one. */
  starts: number[];
  ends: number[];
  /** ISO start of the first bucket: the lower bound of every query. */
  since: string;
  labels: string[];
  /** Index of the bucket holding this time (ISO string or ms), -1 outside. */
  indexOf(t: string | number): number;
}

export function buckets(interval: Interval, days: number, nowMs = Date.now()): Buckets {
  const starts: number[] = [];
  for (let t = bucketStart(interval, nowMs - (days - 1) * DAY); t <= nowMs; t = nextBucket(interval, t)) starts.push(t);
  const ends = starts.map((t) => nextBucket(interval, t));
  return {
    interval,
    starts,
    ends,
    since: new Date(starts[0]!).toISOString(),
    labels: starts.map((t) => new Date(t).toISOString().slice(0, 10)),
    indexOf(t) {
      const ms = typeof t === 'number' ? t : Date.parse(t.length === 10 ? `${t}T00:00:00Z` : t);
      if (!Number.isFinite(ms) || ms < starts[0]! || ms >= ends[ends.length - 1]!) return -1;
      let lo = 0;
      let hi = starts.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (starts[mid]! <= ms) lo = mid;
        else hi = mid - 1;
      }
      return lo;
    },
  };
}

const zeros = (n: number) => Array.from({ length: n }, () => 0);

/** Keeps the largest series (by sum) and folds the rest into "Other". Order of the kept ones is preserved. */
function foldSeries(series: ChartSeriesData[], max = MAX_SERIES): ChartSeriesData[] {
  if (series.length <= max) return series;
  const sum = (s: ChartSeriesData) => s.values.reduce<number>((a, v) => a + (v ?? 0), 0);
  const keep = new Set([...series].sort((a, b) => sum(b) - sum(a)).slice(0, max - 1));
  const rest = series.filter((s) => !keep.has(s));
  const other: ChartSeriesData = {
    key: '__other',
    label: `Other (${rest.length})`,
    values: rest[0]!.values.map((_, i) => rest.reduce((a, s) => a + (s.values[i] ?? 0), 0)),
  };
  return [...series.filter((s) => keep.has(s)), other];
}

async function readable(blueprint: string, p: Principal): Promise<boolean> {
  try {
    return (await visibleBlueprints(p, [await getBlueprintCached(blueprint)])).length > 0;
  } catch {
    return false;
  }
}

export async function chartData(w: ChartWidget, p: Principal, ctx?: EntityContext, nowMs = Date.now()): Promise<ChartData> {
  const b = buckets(w.interval, w.days, nowMs);
  const s = w.series;
  switch (s.kind) {
    case 'scorecard':
      return scorecardSeries(s, b, p, ctx);
    case 'runs':
      return runsSeries(s, b, p, ctx);
    case 'dora':
      return doraSeries(s, b, p, ctx, nowMs);
    case 'entities':
      return entitySeries(s, b, p);
  }
}

// ---------- scorecard levels ----------

async function scorecardSeries(s: Extract<ChartSeriesDef, { kind: 'scorecard' }>, b: Buckets, p: Principal, ctx?: EntityContext): Promise<ChartData> {
  const sc = await getScorecard(s.scorecard);
  // Aggregates of a blueprint the viewer cannot read are as private as its rows.
  if (!(await readable(sc.blueprint, p))) throw new Error('You cannot see this scorecard');
  const org = orgId();
  const one = ctx && ctx.blueprint === sc.blueprint ? ctx.identifier : undefined;
  const scope = one ? ' AND h.blueprint = ? AND h.entity = ?' : '';
  const scopeParams: SqlValue[] = one ? [sc.blueprint, one] : [];
  // Level of each entity at the window start (its last change before it), then the changes inside the window.
  const state = new Map<string, string>();
  for (const r of await all<{ entity: string; level: string | null }>(
    `SELECT h.entity, h.level FROM scorecard_history h WHERE h.org_id = ? AND h.scorecard = ? AND h.at < ?${scope}
       AND h.id = (SELECT max(h2.id) FROM scorecard_history h2 WHERE h2.org_id = h.org_id AND h2.scorecard = h.scorecard AND h2.blueprint = h.blueprint AND h2.entity = h.entity AND h2.at < ?)`,
    org,
    s.scorecard,
    b.since,
    ...scopeParams,
    b.since,
  ))
    state.set(r.entity, r.level ?? 'none');
  const events = await all<{ entity: string; level: string | null; at: string }>(
    `SELECT h.entity, h.level, h.at FROM scorecard_history h WHERE h.org_id = ? AND h.scorecard = ? AND h.at >= ?${scope} ORDER BY h.at, h.id`,
    org,
    s.scorecard,
    b.since,
    ...scopeParams,
  );
  const names = ['none', ...sc.levels.map((l) => l.name)];
  const values: Record<string, number[]> = Object.fromEntries(names.map((n) => [n, zeros(b.starts.length)]));
  let i = 0;
  for (let k = 0; k < b.starts.length; k++) {
    const end = new Date(b.ends[k]!).toISOString();
    while (i < events.length && events[i]!.at < end) {
      state.set(events[i]!.entity, events[i]!.level ?? 'none');
      i++;
    }
    // Distribution at the end of the bucket (now, for the current one).
    for (const l of state.values()) if (values[l]) values[l][k]!++;
  }
  return {
    type: 'chart',
    interval: b.interval,
    buckets: b.labels,
    unit: 'count',
    drill: { kind: 'catalog', blueprint: sc.blueprint },
    series: names.map((n) => ({
      key: n,
      label: n === 'none' ? 'Below first level' : n,
      color: n === 'none' ? 'gray' : (sc.levels.find((l) => l.name === n)?.color ?? undefined),
      values: values[n]!,
      filter: { level: [`${sc.identifier}:${n}`] },
    })),
  };
}

// ---------- runs ----------

async function runsSeries(s: Extract<ChartSeriesDef, { kind: 'runs' }>, b: Buckets, p: Principal, ctx?: EntityContext): Promise<ChartData> {
  const { where, params } = await runVisibility(p);
  const add = (clause: string, ...v: SqlValue[]) => {
    where.push(clause);
    params.push(...v);
  };
  add('r.created_at >= ?', b.since);
  if (s.action) add('r.action = ?', s.action);
  if (s.team) add('r.team = ?', s.team);
  if (ctx) add('r.blueprint = ? AND r.entity = ?', ctx.blueprint, ctx.identifier);
  const base: Record<string, string[]> = { scope: ['all'] };
  if (s.action) base.action = [s.action];
  if (s.team) base.team = [s.team];
  if (ctx) Object.assign(base, { blueprint: [ctx.blueprint], entity: [ctx.identifier] });
  const out = (unit: ChartData['unit'], series: ChartSeriesData[]): ChartData => ({
    type: 'chart',
    interval: b.interval,
    buckets: b.labels,
    unit,
    drill: { kind: 'runs' },
    series,
  });

  if (s.metric === 'duration') {
    add("r.status IN ('SUCCESS', 'FAILURE')");
    add('r.ended_at IS NOT NULL');
    if (s.status?.length) add(`r.status IN (${s.status.map(() => '?').join(',')})`, ...s.status);
    const rows = await all<{ created_at: string; started_at: string | null; ended_at: string }>(
      `SELECT r.created_at, r.started_at, r.ended_at FROM runs r WHERE ${where.join(' AND ')} ORDER BY r.created_at DESC LIMIT ?`,
      ...params,
      DURATION_SAMPLES,
    );
    const per: number[][] = b.starts.map(() => []);
    for (const r of rows) {
      const k = b.indexOf(r.created_at);
      const minutes = (Date.parse(r.ended_at) - Date.parse(r.started_at ?? r.created_at)) / 60_000;
      if (k >= 0 && Number.isFinite(minutes) && minutes >= 0) per[k]!.push(minutes);
    }
    const pct = (q: number) => per.map((xs) => (xs.length ? round(quantile(xs, q)) : null));
    const filter = { ...base, status: s.status?.length ? s.status : ['SUCCESS', 'FAILURE'] };
    return out('minutes', [
      { key: 'p50', label: 'Median (p50)', values: pct(0.5), filter },
      { key: 'p90', label: 'p90', values: pct(0.9), filter },
    ]);
  }

  if (s.metric === 'count' && s.status?.length) add(`r.status IN (${s.status.map(() => '?').join(',')})`, ...s.status);
  const rows = await all<{ d: string; s: string; n: number }>(
    `SELECT substr(r.created_at, 1, 10) AS d, r.status AS s, count(*) AS n FROM runs r WHERE ${where.join(' AND ')} GROUP BY substr(r.created_at, 1, 10), r.status`,
    ...params,
  );
  const byStatus = new Map<string, number[]>();
  for (const r of rows) {
    const k = b.indexOf(r.d);
    if (k < 0) continue;
    if (!byStatus.has(r.s)) byStatus.set(r.s, zeros(b.starts.length));
    byStatus.get(r.s)![k]! += Number(r.n);
  }
  if (s.metric === 'failureRate') {
    const ok = byStatus.get('SUCCESS') ?? zeros(b.starts.length);
    const ko = byStatus.get('FAILURE') ?? zeros(b.starts.length);
    return out('ratio', [
      {
        key: 'failureRate',
        label: 'Failure rate',
        values: ok.map((n, k) => (n + ko[k]! ? round(ko[k]! / (n + ko[k]!), 4) : null)),
        filter: { ...base, status: ['FAILURE'] },
      },
    ]);
  }
  // Fixed status order, so a status keeps its place (and colour) whatever the others do.
  return out(
    'count',
    RUN_STATUSES.filter((st) => byStatus.has(st)).map((st) => ({
      key: st,
      label: STATUS_LABELS[st]!,
      values: byStatus.get(st)!,
      filter: { ...base, status: [st] },
    })),
  );
}

/** Linear-interpolated quantile (q in 0..1). */
export function quantile(xs: number[], q: number): number {
  const s = [...xs].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo]! + (s[hi]! - s[lo]!) * (pos - lo);
}

// ---------- DORA ----------

const DORA_LABELS = {
  deploymentFrequency: 'Deployments',
  leadTime: 'Lead time (median)',
  changeFailureRate: 'Change failure rate',
  mttr: 'Time to restore (median)',
} as const;

async function doraSeries(
  s: Extract<ChartSeriesDef, { kind: 'dora' }>,
  b: Buckets,
  p: Principal,
  ctx: EntityContext | undefined,
  nowMs: number,
): Promise<ChartData> {
  // On an entity page the entity is the service.
  const cfg = ctx ? { ...s, service: ctx.identifier } : s;
  const ev = await doraEvents(cfg, p, b.starts[0]!, nowMs);
  const per = <T>(items: T[], at: (x: T) => number) => {
    const out: T[][] = b.starts.map(() => []);
    for (const x of items) {
      const k = b.indexOf(at(x));
      if (k >= 0) out[k]!.push(x);
    }
    return out;
  };
  const deploys = per(ev.deploys, (d) => d.at);
  let values: (number | null)[];
  let unit: ChartData['unit'];
  let source = s.deployments.blueprint;
  switch (s.metric) {
    case 'deploymentFrequency':
      unit = 'count';
      values = ev.haveDeploySource ? deploys.map((ds) => ds.filter((d) => !d.failed).length) : b.starts.map(() => null);
      break;
    case 'leadTime':
      unit = 'hours';
      values = deploys.map((ds) => {
        const m = median(leadTimes(ds.filter((d) => !d.failed)));
        return m === null ? null : round(m);
      });
      break;
    case 'changeFailureRate':
      unit = 'ratio';
      values = deploys.map((ds) => (ds.length ? round(ds.filter((d) => d.failed).length / ds.length, 4) : null));
      break;
    case 'mttr':
      unit = 'hours';
      source = s.incidents.blueprint;
      values = per(ev.incidents, (i) => i.at).map((is) => {
        const m = median(is.map((i) => i.hours));
        return m === null ? null : round(m);
      });
      break;
  }
  // Drill into the source entities, else into the runs of the deployment actions.
  const drill: ChartData['drill'] = (await readable(source, p))
    ? { kind: 'catalog', blueprint: source }
    : s.deploymentActions.length && s.metric !== 'mttr'
      ? { kind: 'runs' }
      : null;
  const filter: Record<string, string[]> | undefined =
    drill?.kind === 'runs' ? { scope: ['all'], action: s.deploymentActions, ...(ctx ? { entity: [ctx.identifier] } : {}) } : undefined;
  return {
    type: 'chart',
    interval: b.interval,
    buckets: b.labels,
    unit,
    drill,
    series: [{ key: s.metric, label: DORA_LABELS[s.metric], values, filter }],
  };
}

// ---------- entity counts ----------

async function entitySeries(s: Extract<ChartSeriesDef, { kind: 'entities' }>, b: Buckets, p: Principal): Promise<ChartData> {
  if (!(await readable(s.blueprint, p))) throw new Error('You cannot see this blueprint');
  const { before, days } = await entityCreationCounts(s.blueprint, s.filters, s.groupBy, b.since, p);
  const keys = [...new Set([...before.map((r) => r.k), ...days.map((r) => r.k)])].sort();
  const created = new Map(keys.map((k) => [k, zeros(b.starts.length)]));
  for (const r of days) {
    const k = b.indexOf(r.d);
    if (k >= 0) created.get(r.k)![k]! += r.n;
  }
  const baseFilter = Object.entries(s.filters).map(([k, v]) => `${k}:${v}`);
  const series = keys.map((key): ChartSeriesData => {
    let values = created.get(key)!;
    if (s.mode === 'total') {
      let total = before.find((r) => r.k === key)?.n ?? 0;
      values = values.map((n) => (total += n));
    }
    const filter: Record<string, string[]> = {};
    if (s.groupBy === 'team') {
      if (key !== '—') filter.team = [key];
    } else if (s.groupBy && s.groupBy !== 'source' && key !== '—') filter.f = [...baseFilter, `${s.groupBy}:${key}`];
    if (!filter.f && baseFilter.length) filter.f = baseFilter;
    return { key: key || 'total', label: s.groupBy ? key : 'Entities', values, filter };
  });
  return {
    type: 'chart',
    interval: b.interval,
    buckets: b.labels,
    unit: 'count',
    drill: { kind: 'catalog', blueprint: s.blueprint },
    series: foldSeries(series.length ? series : [{ key: 'total', label: 'Entities', values: zeros(b.starts.length) }]),
  };
}
