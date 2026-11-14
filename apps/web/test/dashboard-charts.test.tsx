import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import type { Blueprint, ChartData, Dashboard, Entity } from '@asterius/shared';
import { theme } from '@asterius/brand';
import { DashboardView } from '../src/components/DashboardView';
import { EntityPage } from '../src/pages/EntityPage';
import { api } from '../src/lib/api';
import { bucketTitle, drillHref, formatValue, nextBucket, seriesColors } from '../src/lib/charts';

vi.mock('../src/lib/auth', () => ({ useAuth: () => ({ user: null, isAdmin: false }) }));

// The plot itself (Recharts) is stubbed: one button per point, calling onPoint like a click on the chart.
vi.mock('../src/components/charts/TrendChart', () => ({
  default: ({ data, onPoint }: { data: ChartData; onPoint?: (key: string | null, index: number) => void }) => (
    <div data-testid="plot">
      {data.series.flatMap((s) =>
        s.values.map((v, i) => (
          <button key={`${s.key}-${i}`} type="button" onClick={() => onPoint?.(s.key, i)}>
            {`point ${s.key} ${i}`}
          </button>
        )),
      )}
    </div>
  ),
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const runsChart: ChartData = {
  type: 'chart',
  interval: 'week',
  buckets: ['2026-11-02', '2026-11-09'],
  unit: 'count',
  drill: { kind: 'runs' },
  series: [
    { key: 'SUCCESS', label: 'Succeeded', values: [3, 1], filter: { scope: ['all'], status: ['SUCCESS'], action: ['deploy'] } },
    { key: 'FAILURE', label: 'Failed', values: [0, 2], filter: { scope: ['all'], status: ['FAILURE'], action: ['deploy'] } },
  ],
};
const levelsChart: ChartData = {
  type: 'chart',
  interval: 'month',
  buckets: ['2026-10-01', '2026-11-01'],
  unit: 'count',
  drill: { kind: 'catalog', blueprint: 'service' },
  series: [
    { key: 'none', label: 'Below first level', color: 'gray', values: [2, 1], filter: { level: ['ready:none'] } },
    { key: 'Gold', label: 'Gold', values: [0, 1], filter: { level: ['ready:Gold'] } },
  ],
};

describe('chart helpers', () => {
  it('builds the runs drill-down of a point: series filters and the bucket range', () => {
    expect(drillHref(runsChart, 'FAILURE', 1)).toBe('/runs?scope=all&status=FAILURE&action=deploy&since=2026-11-09&until=2026-11-16');
    // Not on one series: every status of the chart
    expect(drillHref(runsChart, null, 0)).toBe('/runs?scope=all&status=SUCCESS%2CFAILURE&action=deploy&since=2026-11-02&until=2026-11-09');
    expect(drillHref(runsChart, 'SUCCESS', null)).toBe('/runs?scope=all&status=SUCCESS&action=deploy');
    expect(drillHref({ ...runsChart, drill: null }, 'SUCCESS', 0)).toBeNull();
  });

  it('builds the catalog drill-down of a series', () => {
    expect(drillHref(levelsChart, 'Gold', 1)).toBe('/catalog/service?level=ready%3AGold');
    expect(drillHref({ ...levelsChart, series: [{ key: 'go', label: 'go', values: [1], filter: { f: ['lang:go', 'tier:1'] } }] }, 'go', 0)).toBe(
      '/catalog/service?f=lang%3Ago&f=tier%3A1',
    );
    expect(drillHref(levelsChart, '__other', 0)).toBeNull();
  });

  it('formats values, buckets and colours', () => {
    expect(formatValue('ratio', 0.125)).toBe('12.5 %');
    expect(formatValue('minutes', 90)).toBe('90 min');
    expect(formatValue('hours', 72)).toBe('3 d');
    expect(formatValue('count', null)).toBe('—');
    expect(bucketTitle('week', '2026-11-09')).toBe('Week of Nov 9, 2026');
    expect(bucketTitle('month', '2026-11-01')).toBe('Nov 2026');
    expect(nextBucket('month', '2026-12-01')).toBe('2027-01-01');
    // Run statuses keep their colour; a server colour (scorecard level) wins; the others take the brand order.
    expect(seriesColors(runsChart)).toEqual(['var(--chart-3)', 'var(--chart-8)']);
    expect(seriesColors(levelsChart)).toEqual(['var(--mantine-color-gray-6)', 'var(--chart-1)']);
  });
});

const dashboard = (widgets: Dashboard['widgets'], o: Partial<Dashboard> = {}): Dashboard => ({
  identifier: 'trends',
  title: 'Trends',
  description: '',
  team: null,
  blueprint: null,
  scope: 'catalog',
  default: false,
  managed: false,
  widgets,
  ...o,
});
const chartWidget = (o: object = {}) =>
  ({
    type: 'chart',
    title: 'Deploy runs',
    width: 6,
    chart: 'bar',
    stacked: true,
    interval: 'week',
    days: 14,
    series: { kind: 'runs', metric: 'count' },
    ...o,
  }) as Dashboard['widgets'][number];

function Where() {
  const l = useLocation();
  return <div data-testid="where">{`${l.pathname}${l.search}`}</div>;
}

function mount(ui: React.ReactNode, path = '/') {
  render(
    <MantineProvider theme={theme} env="test">
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="/" element={ui} />
            <Route path="/catalog/:bp/:id" element={ui} />
            <Route path="*" element={<Where />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    </MantineProvider>,
  );
}

describe('chart widget', () => {
  it('renders the legend as drill-down links and the plot lazily', async () => {
    vi.spyOn(api, 'dashboardData').mockResolvedValue([runsChart]);
    mount(<DashboardView dashboard={dashboard([chartWidget()])} />);
    expect(await screen.findByText('Deploy runs')).toBeTruthy();
    const legend = screen.getByRole('list', { name: 'Series' });
    expect(within(legend).getByRole('link', { name: 'Failed' }).getAttribute('href')).toBe('/runs?scope=all&status=FAILURE&action=deploy');
    const img = await screen.findByRole('img', { name: /Deploy runs: bar chart of Succeeded, Failed over 2 weeks/ });
    expect(await within(img).findByTestId('plot')).toBeTruthy();
  });

  it('opens the filtered runs list when a point is clicked', async () => {
    vi.spyOn(api, 'dashboardData').mockResolvedValue([runsChart]);
    mount(<DashboardView dashboard={dashboard([chartWidget()])} />);
    fireEvent.click(await screen.findByRole('button', { name: 'point FAILURE 1' }));
    expect((await screen.findByTestId('where')).textContent).toBe('/runs?scope=all&status=FAILURE&action=deploy&since=2026-11-09&until=2026-11-16');
  });

  it('has a table view with every value', async () => {
    vi.spyOn(api, 'dashboardData').mockResolvedValue([levelsChart]);
    mount(<DashboardView dashboard={dashboard([chartWidget({ title: 'Readiness', interval: 'month' })])} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Show as table' }));
    const table = screen.getByRole('table');
    expect(within(table).getByText('Nov 2026')).toBeTruthy();
    expect(within(table).getByRole('columnheader', { name: 'Below first level' })).toBeTruthy();
    expect(within(table).getAllByRole('link', { name: '1' })[1].getAttribute('href')).toBe('/catalog/service?level=ready%3AGold');
    expect(screen.queryByRole('img')).toBeNull();
  });

  it('says when the window has no data', async () => {
    vi.spyOn(api, 'dashboardData').mockResolvedValue([{ ...runsChart, series: [] }]);
    mount(<DashboardView dashboard={dashboard([chartWidget()])} />);
    expect(await screen.findByText('No data in this window')).toBeTruthy();
  });
});

describe('entity-page dashboards', () => {
  const bp = {
    identifier: 'service',
    title: 'Services',
    description: '',
    icon: null,
    schema: { properties: { lang: { type: 'string', title: 'Language' }, tier: { type: 'string', title: 'Tier' } } },
    relations: {},
  } as unknown as Blueprint;
  const entity = {
    blueprint: 'service',
    identifier: 'api',
    title: 'API',
    team: null,
    properties: { lang: 'go', tier: 'gold' },
    relations: {},
    source: 'api',
    version: 1,
    createdAt: '',
    updatedAt: '',
  } as Entity;

  it('replaces the overview with the dashboard of the blueprint, for the entity', async () => {
    vi.spyOn(api, 'blueprint').mockResolvedValue(bp);
    vi.spyOn(api, 'entity').mockResolvedValue(entity);
    vi.spyOn(api, 'related').mockResolvedValue({ outgoing: {}, incoming: {} });
    vi.spyOn(api, 'entityActions').mockResolvedValue([]);
    vi.spyOn(api, 'entityScorecards').mockResolvedValue([]);
    vi.spyOn(api, 'runs').mockResolvedValue({ items: [], total: 0 });
    const resolve = vi
      .spyOn(api, 'resolveDashboard')
      .mockResolvedValue(
        dashboard(
          [
            { type: 'entity', show: 'properties', properties: ['tier'], width: 6 },
            { type: 'markdown', content: 'Written in {{ entity.properties.lang }}', width: 6 },
            chartWidget({ title: 'Runs of this service' }),
          ],
          { identifier: 'service-page', blueprint: 'service', scope: 'entity' },
        ),
      );
    const data = vi.spyOn(api, 'dashboardData').mockResolvedValue([{ type: 'entity' }, { type: 'markdown', content: 'Written in go' }, runsChart]);
    mount(<EntityPage />, '/catalog/service/api');
    expect(await screen.findByText('Written in go')).toBeTruthy();
    expect(resolve).toHaveBeenCalledWith('service', 'entity');
    expect(data).toHaveBeenCalledWith('service-page', 'api');
    expect(screen.getByText('Tier')).toBeTruthy();
    expect(screen.queryByText('Language')).toBeNull(); // only the listed properties
    expect(await screen.findByText('Runs of this service')).toBeTruthy();
  });

  it('keeps the built-in overview without an entity dashboard', async () => {
    vi.spyOn(api, 'blueprint').mockResolvedValue(bp);
    vi.spyOn(api, 'entity').mockResolvedValue(entity);
    vi.spyOn(api, 'related').mockResolvedValue({ outgoing: {}, incoming: {} });
    vi.spyOn(api, 'entityActions').mockResolvedValue([]);
    vi.spyOn(api, 'entityScorecards').mockResolvedValue([]);
    vi.spyOn(api, 'runs').mockResolvedValue({ items: [], total: 0 });
    vi.spyOn(api, 'resolveDashboard').mockResolvedValue(null);
    mount(<EntityPage />, '/catalog/service/api');
    expect(await screen.findByText('Language')).toBeTruthy();
    expect(await screen.findByText('Referenced by')).toBeTruthy();
  });
});
