import { AreaChart, BarChart, LineChart } from '@mantine/charts';
import '@mantine/charts/styles.css';
import type { ChartData } from '@asterius/shared';
import { bucketLabel, chartRows, formatValue } from '../../lib/charts';

/**
 * The plot of a `chart` widget (@mantine/charts on Recharts). Loaded lazily by ChartWidget, in its own chunk, so pages
 * without charts never download the library. Legend, title and table view are ChartWidget's.
 */

/** Height of the plot area (geometry, not rhythm). */
const PLOT_HEIGHT = 240;

export interface TrendChartProps {
  data: ChartData;
  chart: 'line' | 'bar' | 'area';
  stacked: boolean;
  colors: string[];
  /** A click on a point or a bar: the series (null: not one in particular) and the bucket index. */
  onPoint?: (key: string | null, index: number) => void;
}

interface ClickState {
  activeTooltipIndex?: number | string | null;
  activeDataKey?: unknown;
}

export default function TrendChart({ data, chart, stacked, colors, onPoint }: TrendChartProps) {
  const rows = chartRows(data).map((r) => ({ ...r, label: bucketLabel(data.interval, String(r.bucket)) }));
  const series = data.series.map((s, i) => ({ name: s.key, label: s.label, color: colors[i] }));
  const single = data.series.length === 1 ? data.series[0].key : null;
  const onChartClick = (state: ClickState | null) => {
    const index = Number(state?.activeTooltipIndex);
    if (!onPoint || !Number.isInteger(index) || index < 0) return;
    onPoint(typeof state?.activeDataKey === 'string' ? state.activeDataKey : single, index);
  };
  const common = {
    h: PLOT_HEIGHT,
    data: rows,
    dataKey: 'label',
    series,
    valueFormatter: (v: number) => formatValue(data.unit, v),
    gridColor: 'var(--chart-grid)',
    textColor: 'var(--chart-axis)',
    tickLine: 'none' as const,
    gridAxis: 'y' as const,
    tooltipAnimationDuration: 0,
    yAxisProps: { width: 56, ...(data.unit === 'ratio' ? { domain: [0, 1] } : {}), allowDecimals: data.unit !== 'count' },
    className: onPoint ? 'clickable' : undefined,
  };
  if (chart === 'bar')
    return (
      <BarChart
        {...common}
        type={stacked ? 'stacked' : 'default'}
        maxBarWidth={32}
        barProps={(s) => ({ radius: stacked ? 0 : [4, 4, 0, 0], onClick: (_: unknown, index: number) => onPoint?.(s.name, index) })}
      />
    );
  if (chart === 'area')
    return (
      <AreaChart {...common} type={stacked ? 'stacked' : 'default'} curveType="monotone" connectNulls={false} areaChartProps={{ onClick: onChartClick }} />
    );
  return <LineChart {...common} curveType="monotone" strokeWidth={2} connectNulls={false} lineChartProps={{ onClick: onChartClick }} />;
}
