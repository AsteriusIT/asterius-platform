/** Minimal 5-field cron (minute hour day-of-month month day-of-week), evaluated in UTC. Supports `*`, lists, ranges and steps. */

const RANGES: Array<[number, number]> = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 6],
];

function parseField(field: string, [min, max]: [number, number]): Set<number> {
  const out = new Set<number>();
  for (const part of field.split(',')) {
    const m = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(part);
    if (!m) throw new Error(`invalid cron field "${field}"`);
    const step = m[2] ? Number(m[2]) : 1;
    if (step < 1) throw new Error(`invalid cron step in "${field}"`);
    let lo = min;
    let hi = max;
    if (m[1] !== '*') {
      const [a, b] = m[1]!.split('-');
      lo = Number(a);
      hi = b !== undefined ? Number(b) : m[2] ? max : lo;
    }
    if (lo < min || hi > max || lo > hi) throw new Error(`cron value out of range in "${field}"`);
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}

export function parseCron(expr: string) {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error('cron expression needs 5 fields: minute hour day-of-month month day-of-week');
  const [mi, h, dom, mo, dow] = parts.map((p, i) => parseField(p, RANGES[i]!));
  return { mi: mi!, h: h!, dom: dom!, mo: mo!, dow: dow!, domStar: parts[2] === '*', dowStar: parts[4] === '*' };
}

/** Next matching minute strictly after `from`. */
export function nextCron(expr: string, from: Date = new Date()): Date {
  const c = parseCron(expr);
  const d = new Date(from.getTime());
  d.setUTCSeconds(0, 0);
  d.setUTCMinutes(d.getUTCMinutes() + 1);
  for (let i = 0; i < 366 * 24 * 60; i++) {
    const dayOk =
      c.domStar && c.dowStar
        ? true
        : c.domStar
          ? c.dow.has(d.getUTCDay())
          : c.dowStar
            ? c.dom.has(d.getUTCDate())
            : c.dom.has(d.getUTCDate()) || c.dow.has(d.getUTCDay());
    if (c.mo.has(d.getUTCMonth() + 1) && dayOk && c.h.has(d.getUTCHours()) && c.mi.has(d.getUTCMinutes())) return d;
    d.setUTCMinutes(d.getUTCMinutes() + 1);
  }
  throw new Error(`cron expression "${expr}" never fires`);
}
