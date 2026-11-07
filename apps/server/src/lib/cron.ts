/**
 * Minimal cron: five fields (minute hour day-of-month month day-of-week), each `*`, a number, a range `a-b`,
 * a list `a,b` or a step (`star slash n`, `a-b/n`). Evaluated in an IANA time zone.
 */

interface Field {
  values: Set<number>;
  any: boolean;
}

const RANGES: [number, number][] = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 7],
];
const NAMES = ['minute', 'hour', 'day of month', 'month', 'day of week'];

function parseField(src: string, i: number): Field {
  const [min, max] = RANGES[i];
  const values = new Set<number>();
  for (const part of src.split(',')) {
    const m = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(part);
    if (!m) throw new Error(`Invalid cron ${NAMES[i]} field "${src}"`);
    const step = m[2] ? Number(m[2]) : 1;
    if (step < 1) throw new Error(`Invalid cron step in "${src}"`);
    let lo = min;
    let hi = max;
    if (m[1] !== '*') {
      const [a, b] = m[1].split('-').map(Number);
      lo = a;
      hi = b ?? (m[2] ? max : a);
    }
    if (lo < min || hi > max || lo > hi) throw new Error(`Cron ${NAMES[i]} out of range (${min}-${max}): "${src}"`);
    for (let v = lo; v <= hi; v += step) values.add(i === 4 && v === 7 ? 0 : v);
  }
  return { values, any: src === '*' };
}

export interface CronSpec {
  fields: Field[];
}

export function parseCron(expr: string): CronSpec {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error('A cron expression has five fields: minute hour day-of-month month day-of-week');
  return { fields: parts.map(parseField) };
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(tz: string) {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      weekday: 'short',
    });
    formatters.set(tz, f);
  }
  return f;
}

export function checkTimezone(tz: string) {
  try {
    formatter(tz);
  } catch {
    throw new Error(`Unknown time zone "${tz}" (use an IANA name such as Europe/Paris)`);
  }
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function localParts(ms: number, tz: string) {
  const p: Record<string, string> = {};
  for (const x of formatter(tz).formatToParts(new Date(ms))) p[x.type] = x.value;
  return { minute: Number(p.minute), hour: Number(p.hour) % 24, day: Number(p.day), month: Number(p.month), weekday: WEEKDAYS.indexOf(p.weekday) };
}

/** First matching minute strictly after `from` (epoch ms), or undefined when none within about 5 years. */
export function nextCron(spec: CronSpec, from: number, tz = 'UTC'): number | undefined {
  const [minF, hourF, domF, monF, dowF] = spec.fields;
  let t = Math.floor(from / 60_000) * 60_000 + 60_000;
  const limit = from + 5 * 366 * 86_400_000;
  while (t < limit) {
    const l = localParts(t, tz);
    const dayOk =
      domF.any && dowF.any
        ? true
        : domF.any
          ? dowF.values.has(l.weekday)
          : dowF.any
            ? domF.values.has(l.day)
            : domF.values.has(l.day) || dowF.values.has(l.weekday); // standard cron: either matches when both are restricted
    if (!monF.values.has(l.month) || !dayOk) {
      t += (1440 - (l.hour * 60 + l.minute)) * 60_000; // next local midnight
      continue;
    }
    if (!hourF.values.has(l.hour)) {
      t += (60 - l.minute) * 60_000;
      continue;
    }
    if (!minF.values.has(l.minute)) {
      t += 60_000;
      continue;
    }
    return t;
  }
  return undefined;
}
