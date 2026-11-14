import type { InitiativeDetail, InitiativeStatus, InitiativeTodo } from '@asterius/shared';

/** Label and color of an initiative status (always shown as a labelled badge, never color alone). */
export const STATUS_LOOK: Record<InitiativeStatus, { label: string; color: string }> = {
  on_track: { label: 'On track', color: 'blue' },
  at_risk: { label: 'At risk', color: 'orange' },
  overdue: { label: 'Overdue', color: 'red' },
  done: { label: 'Done', color: 'teal' },
};

export const pct = (ratio: number) => `${Math.round(ratio * 100)} %`;

/** "12 days left", "Due today", "3 days overdue". */
export function deadlineLabel(daysLeft: number) {
  if (daysLeft > 1) return `${daysLeft} days left`;
  if (daysLeft === 1) return 'Due today';
  const late = 1 - daysLeft;
  return `${late} day${late > 1 ? 's' : ''} overdue`;
}

/** Ratio per day of the trend, overall or for one team (`-`: entities without a team); days without data are skipped. */
export function trendSeries(trend: InitiativeDetail['trend'], team?: string): { day: string; ratio: number; passing: number; total: number }[] {
  return trend.flatMap((p) => {
    const c = team === undefined ? p : p.teams[team];
    if (!c) return [];
    return [{ day: p.day, passing: c.passing, total: c.total, ratio: c.total ? c.passing / c.total : 1 }];
  });
}

/** Straight-line expectation (0 → 1) between the start and the deadline, for one day. */
export function expectedOn(day: string, startDate: string, deadline: string) {
  const s = Date.parse(`${startDate}T00:00:00Z`);
  const e = Date.parse(`${deadline}T00:00:00Z`) + 86_400_000;
  const t = Date.parse(`${day}T00:00:00Z`) + 86_400_000; // end of that day
  return Math.min(1, Math.max(0, (t - s) / Math.max(1, e - s)));
}

/** To do items grouped by initiative, the closest deadline first. */
export function groupTodo(items: InitiativeTodo[]) {
  const groups = new Map<string, { initiative: InitiativeTodo['initiative']; items: InitiativeTodo[] }>();
  for (const it of items) {
    const g = groups.get(it.initiative.identifier) ?? { initiative: it.initiative, items: [] };
    g.items.push(it);
    groups.set(it.initiative.identifier, g);
  }
  return [...groups.values()].sort((a, b) => a.initiative.deadline.localeCompare(b.initiative.deadline));
}

export const teamLabel = (team: string | null) => (team === null || team === '-' ? 'No team' : team);
