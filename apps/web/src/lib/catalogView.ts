import type { Blueprint, Entity } from '@asterius/shared';

/** URL/state helpers for the catalog table: sort, property filters, column preferences, CSV. */

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

const colsKey = (bp: string) => `asterius.catalog.columns.${bp}`;
export function loadColumns(bp: string): string[] | null {
  try {
    const v = JSON.parse(localStorage.getItem(colsKey(bp)) ?? 'null');
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : null;
  } catch {
    return null;
  }
}
export function saveColumns(bp: string, cols: string[] | null) {
  try {
    if (cols) localStorage.setItem(colsKey(bp), JSON.stringify(cols));
    else localStorage.removeItem(colsKey(bp));
  } catch {
    /* private mode */
  }
}

export interface SavedView {
  name: string;
  /** Serialized URL search params (without page). */
  search: string;
}
const viewsKey = (bp: string) => `asterius.catalog.views.${bp}`;
export function loadViews(bp: string): SavedView[] {
  try {
    const v = JSON.parse(localStorage.getItem(viewsKey(bp)) ?? '[]');
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}
export function saveViews(bp: string, views: SavedView[]) {
  try {
    localStorage.setItem(viewsKey(bp), JSON.stringify(views));
  } catch {
    /* private mode */
  }
}

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

export function downloadText(filename: string, text: string, type = 'text/csv;charset=utf-8') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
