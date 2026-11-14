import type { ChartData, ChartSeriesData } from '@asterius/shared';

/**
 * Helpers of the `chart` dashboard widget that do not need the chart library (kept out of its lazy chunk): colours,
 * value and bucket formatting, drill-down links and the table view's rows.
 */

/** Categorical colours of `@asterius/brand` (`--chart-1`…`--chart-8`), in their fixed order. */
export const CHART_COLORS = Array.from({ length: 8 }, (_, i) => `var(--chart-${i + 1})`);

/** Run statuses keep one colour whatever else is plotted (good / critical / in-between states). */
const STATUS_CHART_COLORS: Record<string, string> = {
  SUCCESS: 'var(--chart-3)',
  FAILURE: 'var(--chart-8)',
  IN_PROGRESS: 'var(--chart-1)',
  QUEUED: 'var(--chart-7)',
  PENDING_APPROVAL: 'var(--chart-4)',
  REJECTED: 'var(--chart-2)',
  CANCELLED: 'var(--mantine-color-gray-5)',
};

/** Mantine colour names given by the server (a scorecard level's colour) become their CSS variable. */
export function cssColor(c: string): string {
  const m = /^([a-z]+)(?:\.(\d))?$/.exec(c);
  return m ? `var(--mantine-color-${m[1]}-${m[2] ?? '6'})` : c;
}

/** Colour of each series: the server's, a run status's, else the next categorical colour (by position, never cycled). */
export function seriesColors(data: ChartData): string[] {
  let next = 0;
  return data.series.map((s) => {
    if (s.key === '__other') return 'var(--mantine-color-gray-5)';
    if (s.color) return cssColor(s.color);
    if (data.drill?.kind === 'runs' && STATUS_CHART_COLORS[s.key]) return STATUS_CHART_COLORS[s.key];
    return CHART_COLORS[next++ % CHART_COLORS.length];
  });
}

export function formatValue(unit: ChartData['unit'], v: number | null | undefined): string {
  if (v === null || v === undefined) return '—';
  switch (unit) {
    case 'ratio':
      return `${+(v * 100).toFixed(1)} %`;
    case 'minutes':
      return v < 1 ? `${Math.round(v * 60)} s` : v < 120 ? `${+v.toFixed(1)} min` : `${+(v / 60).toFixed(1)} h`;
    case 'hours':
      return v < 1 ? `${Math.round(v * 60)} min` : v < 48 ? `${+v.toFixed(1)} h` : `${+(v / 24).toFixed(1)} d`;
    case 'per_day':
      return `${+v.toFixed(2)} / day`;
    default:
      return String(Math.round(v * 100) / 100);
  }
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Short axis label of a bucket (YYYY-MM-DD, UTC): "Nov 9", or "Nov 2026" for months. */
export function bucketLabel(interval: ChartData['interval'], day: string): string {
  const [y, m, d] = day.split('-').map(Number);
  return interval === 'month' ? `${MONTHS[m - 1]} ${y}` : `${MONTHS[m - 1]} ${d}`;
}

/** Long label (tooltip, table): "Week of Nov 9, 2026", "Nov 9, 2026", "November 2026". */
export function bucketTitle(interval: ChartData['interval'], day: string): string {
  const [y, m, d] = day.split('-').map(Number);
  if (interval === 'month') return `${MONTHS[m - 1]} ${y}`;
  return `${interval === 'week' ? 'Week of ' : ''}${MONTHS[m - 1]} ${d}, ${y}`;
}

/** Start of the bucket after `day` (YYYY-MM-DD). */
export function nextBucket(interval: ChartData['interval'], day: string): string {
  const t = new Date(`${day}T00:00:00Z`);
  if (interval === 'day') t.setUTCDate(t.getUTCDate() + 1);
  else if (interval === 'week') t.setUTCDate(t.getUTCDate() + 7);
  else t.setUTCMonth(t.getUTCMonth() + 1);
  return t.toISOString().slice(0, 10);
}

/** Filters common to every series (same values): what a click outside any one series means. */
function sharedFilter(series: ChartSeriesData[], union: string[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  const first = series[0]?.filter ?? {};
  for (const [k, v] of Object.entries(first)) {
    if (union.includes(k)) out[k] = [...new Set(series.flatMap((s) => s.filter?.[k] ?? []))];
    else if (series.every((s) => JSON.stringify(s.filter?.[k]) === JSON.stringify(v))) out[k] = v;
  }
  return out;
}

/**
 * The list a click opens: the catalog of the drilled blueprint or the runs page, filtered like the series (`key`;
 * null: every series) and, for runs, to the bucket (`index`; null: the whole chart). Catalog filters are the current
 * state of the entities, not the state at that date.
 */
export function drillHref(data: ChartData, key: string | null, index: number | null): string | null {
  if (!data.drill) return null;
  const s = key === null ? null : data.series.find((x) => x.key === key);
  if (key !== null && (!s || s.key === '__other')) return null;
  const filter = s ? (s.filter ?? {}) : sharedFilter(data.series, ['status']);
  const p = new URLSearchParams();
  if (data.drill.kind === 'catalog') {
    for (const [k, vs] of Object.entries(filter)) for (const v of k === 'f' ? vs : vs.slice(0, 1)) p.append(k, v);
    const q = p.toString();
    return `/catalog/${encodeURIComponent(data.drill.blueprint)}${q ? `?${q}` : ''}`;
  }
  for (const [k, vs] of Object.entries(filter)) if (vs.length) p.set(k, k === 'status' ? vs.join(',') : vs[0]);
  if (index !== null && data.buckets[index]) {
    p.set('since', data.buckets[index]);
    p.set('until', nextBucket(data.interval, data.buckets[index]));
  }
  const q = p.toString();
  return `/runs${q ? `?${q}` : ''}`;
}

/** Rows of the chart library and of the table view: one per bucket, one column per series key. */
export const chartRows = (data: ChartData) =>
  data.buckets.map(
    (day, i) => ({ bucket: day, ...Object.fromEntries(data.series.map((s) => [s.key, s.values[i]])) }) as Record<string, string | number | null>,
  );
