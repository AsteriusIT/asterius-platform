import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router';
import type { Blueprint, Entity } from '@asterius/shared';
import { theme } from '../src/theme';
import { EntityPage } from '../src/pages/EntityPage';
import { TimelineView } from '../src/components/RunTimeline';
import { api, type RunTimeline } from '../src/lib/api';
import { renderUi } from './render';

vi.mock('../src/lib/auth', () => ({ useAuth: () => ({ user: null, isAdmin: false }) }));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const timeline: RunTimeline = {
  runId: 'r-8f2c',
  entity: { blueprint: 'platform-service', identifier: 'payments/api', lifecycle: 'Degraded' },
  terminal: false,
  cached: false,
  sources: [
    { name: 'portal', status: 'ok', count: 2 },
    { name: 'catalog', status: 'ok', count: 2 },
    { name: 'loki', status: 'unconfigured', count: 0 },
    { name: 'tempo', status: 'error', count: 0, error: 'tempo answered 503' },
  ],
  events: [
    { time: '2026-11-08T09:41:02.000Z', step: 'Committed', status: 'info', symbol: '·', source: 'catalog' },
    { time: '2026-11-08T09:41:48.000Z', step: 'ADO project', status: 'success', symbol: '✓', source: 'k8s_events' },
    {
      time: '2026-11-08T09:42:31.000Z',
      step: 'SonarQube project',
      status: 'failure',
      symbol: '✗',
      source: 'k8s_events',
      message: "quality gate 'acme-default' not found → retrying",
    },
  ],
};

describe('run timeline', () => {
  it('lists the events in order with their status, message and source, and the state of each source', () => {
    renderUi(<TimelineView t={timeline} />);
    expect(screen.getByText('ADO project')).toBeTruthy();
    expect(screen.getByText("quality gate 'acme-default' not found → retrying")).toBeTruthy();
    expect(screen.getByLabelText('failure').textContent).toBe('✗');
    expect(screen.getByText('loki · off')).toBeTruthy();
    expect(screen.getByText('tempo · error')).toBeTruthy();
    const steps = screen.getAllByText(/^(Committed|ADO project|SonarQube project)$/).map((n) => n.textContent);
    expect(steps).toEqual(['Committed', 'ADO project', 'SonarQube project']);
  });

  it('keeps the latest events when limited', () => {
    renderUi(<TimelineView t={timeline} limit={1} />);
    expect(screen.queryByText('Committed')).toBeNull();
    expect(screen.getByText('SonarQube project')).toBeTruthy();
    expect(screen.getByText('2 earlier event(s) on the run page')).toBeTruthy();
  });
});

describe('platform-service entity page', () => {
  const bp = {
    identifier: 'platform-service',
    title: 'Platform service',
    description: '',
    icon: null,
    schema: {
      properties: {
        lifecycle: { type: 'string', enum: ['Ready'] },
        lastRunId: { type: 'string', title: 'Last run' },
        resources: { type: 'array', title: 'Managed resources', items: { type: 'object' } },
        violations: { type: 'array', title: 'Policy violations', items: { type: 'object' } },
      },
    },
    relations: {},
  } as unknown as Blueprint;
  const entity = {
    blueprint: 'platform-service',
    identifier: 'payments/api',
    title: 'api',
    team: 'payments',
    properties: {
      lifecycle: 'Ready',
      lastRunId: 'r-8f2c',
      resources: [{ kind: 'Project', name: 'payments-api', externalName: '6f1c', ready: true }],
      violations: [],
    },
    relations: {},
    source: 'integration:crossplane-watcher',
    version: 1,
    createdAt: '',
    updatedAt: '',
  } as Entity;

  it('shows managed resources and violations as tables, and the timeline of the latest run', async () => {
    vi.spyOn(api, 'blueprint').mockResolvedValue(bp);
    vi.spyOn(api, 'entity').mockResolvedValue(entity);
    vi.spyOn(api, 'related').mockResolvedValue({ outgoing: {}, incoming: {} });
    vi.spyOn(api, 'entityActions').mockResolvedValue([]);
    vi.spyOn(api, 'runs').mockResolvedValue({ items: [], total: 0 });
    const tl = vi.spyOn(api, 'runTimeline').mockResolvedValue(timeline);
    render(
      <MantineProvider theme={theme} env="test">
        <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
          <MemoryRouter initialEntries={['/catalog/platform-service/payments%2Fapi']}>
            <Routes>
              <Route path="/catalog/:bp/:id" element={<EntityPage />} />
            </Routes>
          </MemoryRouter>
        </QueryClientProvider>
      </MantineProvider>,
    );
    expect(await screen.findByText('Managed resources')).toBeTruthy();
    const card = screen.getByText('Managed resources').closest('.mantine-Card-root') as HTMLElement;
    expect(within(card).getByText('externalName')).toBeTruthy();
    expect(within(card).getByText('6f1c')).toBeTruthy();
    const violations = screen.getByText('Policy violations').closest('.mantine-Card-root') as HTMLElement;
    expect(within(violations).getByText('None')).toBeTruthy();
    expect(await screen.findByText('Latest run')).toBeTruthy();
    expect(await screen.findByText('SonarQube project')).toBeTruthy();
    expect(tl).toHaveBeenCalledWith('r-8f2c');
    expect(screen.getByRole('link', { name: 'Open the run' }).getAttribute('href')).toBe('/runs/r-8f2c');
  });
});
