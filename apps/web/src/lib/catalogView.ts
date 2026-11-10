import type { Blueprint, Entity } from '@asterius/shared';

/** URL/state helpers for the catalog table: sort, property filters, CSV. Columns and saved views live on the server. */

export interface Sort {
  key: string;
  dir: 'asc' | 'desc';
}

/** Table column key -> API `sort` value. Property columns are `prop.<name>`. */
export const SORT_KEYS: Record<string, string> = { title: 'title', team: 'team', updated: 'updated' };
export const toApiSort = (key: string, props: string[]) => (key in SORT_KEYS ? SORT_KEYS[key] : props.includes(key) ? `prop.${key}` : 'title');

/** `sort=name` ascending, `sort=-name` descending (URL form). */
export function parseSort(raw: string | null): Sort | null {
  if (!raw) return null;
  return raw.startsWith('-') ? { key: raw.slice(1), dir: 'desc' } : { key: raw, dir: 'asc' };
}
export const formatSort = (s: Sort | null) => (s ? (s.dir === 'desc' ? `-${s.key}` : s.key) : null);

/** Click on a header: asc, then desc, then back to the default order. */
export function nextSort(current: Sort | null, key: string): Sort | null {
  if (current?.key !== key) return { key, dir: 'asc' };
  return current.dir === 'asc' ? { key, dir: 'desc' } : null;
}

/** Filters are repeated `f=prop:value` URL parameters. */
export function parseFilters(values: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const v of values) {
    const i = v.indexOf(':');
    if (i > 0) out[v.slice(0, i)] = v.slice(i + 1);
  }
  return out;
}
export const formatFilters = (f: Record<string, string>) => Object.entries(f).map(([k, v]) => `${k}:${v}`);

/** Properties usable as columns and filters. */
export const listableProps = (bp: Blueprint) =>
  Object.keys(bp.schema.properties).filter((k) => !bp.schema.properties[k].hidden && bp.schema.properties[k].format !== 'markdown');

/** `team=@mine`: entities owned by any of the viewer's teams (resolved by the server, so the link works for anyone). */
export const MY_TEAMS = '@mine';

const csvCell = (v: unknown): string => {
  const s = v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
  // Neutralise spreadsheet formula injection.
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

/** CSV of entities: identifier, title, team, then the chosen properties. */
export function toCsv(entities: Entity[], props: string[]): string {
  const head = ['identifier', 'title', 'team', ...props];
  const rows = entities.map((e) => [e.identifier, e.title, e.team, ...props.map((p) => e.properties[p])]);
  return [head, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

export { downloadText } from './download';
