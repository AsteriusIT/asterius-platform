import { checkTimezone, nextCron, parseCron } from '../lib/cron.js';
import type { BlackoutWindowDef } from '../schemas.js';

/**
 * Blackout windows of a workflow: recurring (`cron` start + `duration`) or fixed (`from`/`to`). During one,
 * automated triggers skip or defer their starts (triggers.ts) and form/API submissions are refused (runs.ts).
 */

const MAX_DURATION_MS = 31 * 86_400_000;
const UNITS: Record<string, number> = { d: 86_400_000, h: 3_600_000, m: 60_000 };

/** `30m`, `2h`, `1d`, `1h30m` → milliseconds. */
export function parseDuration(s: string): number {
  const src = s.trim();
  if (!/^(?:\d{1,6}[dhm]){1,3}$/.test(src)) throw new Error(`Invalid duration "${s}" (e.g. 30m, 2h, 1d, 1h30m)`);
  let ms = 0;
  for (const [, n, u] of src.matchAll(/(\d+)([dhm])/g)) ms += Number(n) * UNITS[u];
  if (ms <= 0 || ms > MAX_DURATION_MS) throw new Error(`Duration "${s}" must be between 1 minute and 31 days`);
  return ms;
}

function checkWindow(w: BlackoutWindowDef) {
  checkTimezone(w.timezone);
  if (w.cron) {
    if (w.from || w.to) throw new Error('use either cron + duration or from/to, not both');
    parseCron(w.cron);
    if (!w.duration) throw new Error('a recurring window (cron) needs a duration');
    parseDuration(w.duration);
    return;
  }
  if (!w.from || !w.to) throw new Error('set cron + duration (recurring) or from + to (fixed)');
  if (w.duration) throw new Error('duration only applies to recurring (cron) windows');
  if (Date.parse(w.to) <= Date.parse(w.from)) throw new Error('"to" must be after "from"');
}

export function validateBlackouts(list: BlackoutWindowDef[] | undefined) {
  for (const [i, w] of (list ?? []).entries()) {
    try {
      checkWindow(w);
    } catch (err) {
      throw new Error(`Blackout ${w.name ? `"${w.name}"` : `#${i + 1}`}: ${(err as Error).message}`, { cause: err });
    }
  }
}

export interface BlackoutSpan {
  name: string;
  /** ISO start of the window. */
  from: string;
  /** ISO end of the window. */
  until: string;
}

const nameOf = (w: BlackoutWindowDef, i: number) => w.name || `blackout #${i + 1}`;

/** The window of `w` containing `t`, overlapping occurrences merged (bounded), or null. */
function windowAt(w: BlackoutWindowDef, t: number): { from: number; to: number } | null {
  if (!w.cron) {
    const from = Date.parse(w.from!);
    const to = Date.parse(w.to!);
    return from <= t && t < to ? { from, to } : null;
  }
  const d = parseDuration(w.duration!);
  const spec = parseCron(w.cron);
  // Earliest start in (t - d, t]: the window it opens covers t.
  const start = nextCron(spec, t - d, w.timezone);
  if (start === undefined || start > t) return null;
  let to = start + d;
  // Later starts before the end extend the window (e.g. "every hour for 2h"); bounded for dense crons.
  let n = nextCron(spec, start, w.timezone);
  for (let i = 0; n !== undefined && n < to && i < 500; i++) {
    to = Math.max(to, n + d);
    n = nextCron(spec, n, w.timezone);
  }
  return { from: start, to };
}

/** The blackout in effect at `t` (chained across windows that overlap), or null. */
export function activeBlackout(list: BlackoutWindowDef[] | undefined, t = Date.now()): BlackoutSpan | null {
  if (!list?.length) return null;
  const first = list.map((w, i) => ({ name: nameOf(w, i), win: windowAt(w, t) })).find((x) => x.win);
  if (!first?.win) return null;
  const { from } = first.win;
  let to = first.win.to;
  // Windows open at `t`, or opening right when the current one ends, keep the blackout going (bounded).
  for (let round = 0, at = t; round < 10; round++) {
    const end = Math.max(to, ...list.map((w) => windowAt(w, at)?.to ?? 0));
    if (end <= to && round > 0) break;
    to = end;
    at = to;
  }
  return { name: first.name, from: new Date(from).toISOString(), until: new Date(to).toISOString() };
}

/** The next blackout starting after `t`, or null. */
export function nextBlackout(list: BlackoutWindowDef[] | undefined, t = Date.now()): BlackoutSpan | null {
  let best: BlackoutSpan | null = null;
  for (const [i, w] of (list ?? []).entries()) {
    let from: number | undefined;
    let to: number | undefined;
    if (w.cron) {
      from = nextCron(parseCron(w.cron), t, w.timezone);
      if (from !== undefined) to = from + parseDuration(w.duration!);
    } else if (Date.parse(w.from!) > t) {
      from = Date.parse(w.from!);
      to = Date.parse(w.to!);
    }
    if (from === undefined || to === undefined) continue;
    if (!best || from < Date.parse(best.from)) best = { name: nameOf(w, i), from: new Date(from).toISOString(), until: new Date(to).toISOString() };
  }
  return best;
}

/** Shown with the action: the window in effect now, and the next one. Invalid stored windows are ignored. */
export function blackoutStatus(list: BlackoutWindowDef[] | undefined, t = Date.now()) {
  try {
    return { active: activeBlackout(list, t), next: nextBlackout(list, t) };
  } catch {
    return { active: null, next: null };
  }
}
