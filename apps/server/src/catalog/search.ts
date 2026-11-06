/** Pure helpers shared by writes (search text) and the migration that backfills it. */

const MAX_SEARCH_CHARS = 8000;

function collect(v: unknown, out: string[], depth = 0) {
  if (typeof v === 'string') out.push(v);
  else if (typeof v === 'number' || typeof v === 'boolean') out.push(String(v));
  else if (depth < 3 && Array.isArray(v)) for (const x of v) collect(x, out, depth + 1);
  else if (depth < 3 && v && typeof v === 'object') for (const x of Object.values(v)) collect(x, out, depth + 1);
}

/** Lower-cased identifier + title + string/number property values (descriptions included), capped in length. */
export function entitySearchText(identifier: string, title: string, properties: Record<string, unknown>): string {
  const parts = [identifier, title];
  collect(properties, parts);
  return parts.join(' ').toLowerCase().slice(0, MAX_SEARCH_CHARS);
}

/** Split a user query into at most 8 lower-cased terms. */
export const searchTerms = (q: string): string[] => q.toLowerCase().split(/\s+/).filter(Boolean).slice(0, 8);

/** JSON.stringify with sorted object keys: stable change detection regardless of key order. */
export function canonicalJson(v: unknown): string {
  return JSON.stringify(v, (_k, val: unknown) =>
    val && typeof val === 'object' && !Array.isArray(val)
      ? Object.fromEntries(Object.entries(val as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : val,
  );
}
