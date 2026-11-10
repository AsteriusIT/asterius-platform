import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import type { HomeSummary, Run } from '@asterius/shared';
import { Todo } from '../src/pages/Todo';
import { Home } from '../src/pages/Home';
import { NotificationCenter } from '../src/components/NotificationCenter';
import { api } from '../src/lib/api';
import { AuthProvider } from '../src/lib/auth';
import { tourSteps } from '../src/components/tourSteps';
import { renderUi } from './render';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const run = (id: string, extra: Partial<Run> = {}) =>
  ({
    id,
    actionTitle: `Action ${id}`,
    blueprint: null,
    entity: null,
    status: 'PENDING_APPROVAL',
    triggeredBy: { id: 'u', name: 'Alice', email: 'a@x' },
    createdAt: '2026-01-01T00:00:00Z',
    startedAt: null,
    endedAt: null,
    approvals: [],
    pendingStep: null,
    ...extra,
  }) as unknown as Run;

describe('To do', () => {
  it('shows decisions, requests waiting on others with who they wait on, and opens notifications', async () => {
    vi.spyOn(api, 'approvals').mockResolvedValue([run('d1')]);
    vi.spyOn(api, 'runsWaiting').mockResolvedValue([
      run('w1', { waitingOn: { teams: ['payments'], users: ['carol@example.com'], roles: [] } }),
      run('w2', {
        status: 'IN_PROGRESS',
        pendingStep: { id: 'ask', name: 'Pick a cluster', message: null, kind: 'input' },
        waitingOn: { teams: [], users: [], roles: ['sre'] },
      }),
    ]);
    vi.spyOn(api, 'notifications').mockResolvedValue({ items: [], unread: 3 });
    renderUi(
      <>
        <NotificationCenter />
        <Todo />
      </>,
    );
    const decisions = screen.getByRole('region', { name: 'Waiting for your decision' });
    expect(await within(decisions).findByText('Action d1')).toBeTruthy();
    const waiting = screen.getByRole('region', { name: 'Your requests waiting on others' });
    expect(await within(waiting).findByText('Action w1')).toBeTruthy();
    expect(within(waiting).getByText('team payments')).toBeTruthy();
    expect(within(waiting).getByText('carol@example.com')).toBeTruthy();
    expect(within(waiting).getByText('Input: Pick a cluster')).toBeTruthy();
    expect(within(waiting).getByText('role sre')).toBeTruthy();
    expect(await screen.findByText(/3 unread notifications/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Open notifications' }));
    expect(await screen.findByText('Mark all as read')).toBeTruthy(); // the header drawer opened
  });
});

describe('Home personal strip', () => {
  const home: HomeSummary = {
    blueprints: [],
    pendingApprovals: 2,
    myRuns: [run('m1', { status: 'SUCCESS' })],
    recentEntities: [],
    waitingOnOthers: [run('w1', { waitingOn: { teams: ['payments'], users: [], roles: [] } })],
    teamEntities: [
      {
        blueprint: 'service',
        identifier: 'pay-api',
        title: 'Pay API',
        team: 'payments',
        properties: {},
        relations: {},
        updatedAt: '2026-01-01T00:00:00Z',
      } as unknown as HomeSummary['teamEntities'][number],
    ],
  };

  it('is shown above a resolved dashboard', async () => {
    vi.spyOn(api, 'home').mockResolvedValue(home);
    vi.spyOn(api, 'resolveDashboard').mockResolvedValue({ identifier: 'd', title: 'Team board', widgets: [] } as never);
    vi.spyOn(api, 'me').mockResolvedValue({ id: 'u', name: 'Ada Lovelace', email: 'ada@x', role: 'member', teams: [] } as never);
    localStorage.setItem('asterius.token', 't');
    renderUi(
      <AuthProvider>
        <Home />
      </AuthProvider>,
    );
    const decisions = await screen.findByRole('region', { name: 'Waiting for your decision' });
    expect(decisions.textContent).toContain('2');
    expect(within(decisions).getByRole('link', { name: 'Open to do' }).getAttribute('href')).toBe('/todo');
    expect(screen.getByText('Action w1')).toBeTruthy();
    expect(screen.getByText(/waiting on team payments/)).toBeTruthy();
    expect(screen.getByText('Action m1')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Pay API' }).getAttribute('href')).toBe('/catalog/service/pay-api');
  });
});

describe('tour', () => {
  it('points at the sidebar entries for To do and Runs', () => {
    const targets = tourSteps({ name: 'Ada', isAdmin: false }).map((s) => s.target);
    expect(targets).toContain('todo');
    expect(targets).toContain('runs');
    expect(targets).not.toContain('approvals');
  });
});
