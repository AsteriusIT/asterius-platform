import { afterEach, describe, expect, it } from 'vitest';
import { cleanup } from '@testing-library/react';
import type { ChartData } from '@asterius/shared';
import TrendChart from '../src/components/charts/TrendChart';
import { seriesColors } from '../src/lib/charts';
import { renderUi } from './render';

afterEach(cleanup);

const data: ChartData = {
  type: 'chart',
  interval: 'week',
  buckets: ['2026-11-02', '2026-11-09'],
  unit: 'ratio',
  drill: { kind: 'runs' },
  series: [{ key: 'failureRate', label: 'Failure rate', values: [0.25, null] }],
};

describe('TrendChart (Recharts)', () => {
  it.each(['line', 'bar', 'area'] as const)('mounts a %s chart with the brand colours', (chart) => {
    const { container } = renderUi(<TrendChart data={data} chart={chart} stacked={chart !== 'line'} colors={seriesColors(data)} onPoint={() => {}} />);
    expect(container.querySelector('.recharts-responsive-container')).toBeTruthy();
  });
});
