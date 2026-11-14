import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, within } from '@testing-library/react';
import type { InitiativeTodo, InitiativeView } from '@asterius/shared';
import { Todo } from '../src/pages/Todo';
import { Initiatives } from '../src/pages/Initiatives';
import { api } from '../src/lib/api';
import { deadlineLabel, expectedOn, groupTodo, trendSeries } from '../src/lib/initiatives';
import { dashboardProblems } from '../src/components/builder/DashboardBuilder';
import { renderUi } from './render';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const todo = (initiative: string, deadline: string, entity: string): InitiativeTodo => ({
  initiative: { identifier: initiative, title: `Initiative ${initiative}`, deadline, targetLevel: 'Silver', daysLeft: 5 },
  entity: { blueprint: 'service', identifier: entity, title: `Entity ${entity}`, team: 'core' },
  failing: [{ rule: 'has_url', title: 'Has a URL', level: 'Silver' }],
});

describe('initiative helpers', () => {
  it('labels deadlines, builds trend series and the expected line', () => {
    expect(deadlineLabel(12)).toBe('12 days left');
    expect(deadlineLabel(1)).toBe('Due today');
    expect(deadlineLabel(0)).toBe('1 day overdue');
    expect(deadlineLabel(-2)).toBe('3 days overdue');
    const trend = [
      { day: '2026-01-01', passing: 1, total: 4, teams: { core: { passing: 1, total: 2 } } },
      { day: '2026-01-02', passing: 2, total: 4, teams: {} },
      { day: '2026-01-03', passing: 0, total: 0, teams: { core: { passing: 2, total: 2 } } },
    ];
    expect(trendSeries(trend).map((p) => p.ratio)).toEqual([0.25, 0.5, 1]);
    expect(trendSeries(trend, 'core').map((p) => [p.day, p.ratio])).toEqual([
      ['2026-01-01', 0.5],
      ['2026-01-03', 1],
    ]);
    expect(expectedOn('2026-01-05', '2026-01-01', '2026-01-10')).toBe(0.5);
    expect(expectedOn('2025-12-01', '2026-01-01', '2026-01-10')).toBe(0);
    expect(expectedOn('2026-02-01', '2026-01-01', '2026-01-10')).toBe(1);
  });

  it('groups To do items by initiative, closest deadline first', () => {
    const g = groupTodo([todo('b', '2026-06-01', 'x'), todo('a', '2026-03-01', 'y'), todo('b', '2026-06-01', 'z')]);
    expect(g.map((x) => [x.initiative.identifier, x.items.map((i) => i.entity.identifier)])).toEqual([
      ['a', ['y']],
      ['b', ['x', 'z']],
    ]);
  });

  it('requires an initiative in the dashboard widget', () => {
    const doc = { identifier: 'd', title: 'D', description: '', default: false, team: null, blueprint: null, widgets: [{ type: 'initiative', width: 6 }] };
    expect(dashboardProblems(doc as never)).toContain('Widget 1 (initiative): initiative is required');
  });
});

describe('initiative pages', () => {
  it('shows the failing entities of my teams in To do, with the rules to fix', async () => {
    vi.spyOn(api, 'approvals').mockResolvedValue([]);
    vi.spyOn(api, 'runsWaiting').mockResolvedValue([]);
    vi.spyOn(api, 'notifications').mockResolvedValue({ items: [], unread: 0 });
    vi.spyOn(api, 'myInitiatives').mockResolvedValue([todo('silver', '2026-06-01', 'pay-api')]);
    renderUi(<Todo />);
    const section = await screen.findByRole('region', { name: 'Initiatives: entities of your teams to fix' });
    expect(within(section).getByText('Initiative silver')).toBeTruthy();
    expect(within(section).getByText('Entity pay-api')).toBeTruthy();
    expect(within(section).getByText('Has a URL')).toBeTruthy();
    expect(within(section).getByText(/target Silver · 5 days left/)).toBeTruthy();
  });

  it('lists initiatives with status and progress', async () => {
    const v = {
      identifier: 'silver',
      title: 'Everything at Silver',
      description: '',
      scorecard: 'ready',
      scorecardTitle: 'Readiness',
      blueprint: 'service',
      targetLevel: 'Silver',
      rules: [],
      startDate: '2026-01-01',
      deadline: '2026-06-30',
      teams: [],
      owner: null,
      enabled: true,
      reminderDays: 7,
      managed: false,
      status: 'at_risk',
      progress: { passing: 3, total: 4, exempted: 1, ratio: 0.75 },
      expected: 0.9,
      daysLeft: 10,
    } satisfies InitiativeView;
    vi.spyOn(api, 'initiatives').mockResolvedValue([v]);
    renderUi(<Initiatives />);
    expect(await screen.findByText('Everything at Silver')).toBeTruthy();
    expect(screen.getByText('At risk')).toBeTruthy();
    expect(screen.getByText('75 %')).toBeTruthy();
    expect(screen.getByText('3 / 4')).toBeTruthy();
    expect(screen.getByText('10 days left')).toBeTruthy();
    expect(screen.getByText('Readiness: Silver or above')).toBeTruthy();
  });
});
