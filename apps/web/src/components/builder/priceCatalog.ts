import { identityProblems } from './FormBuilder';

/**
 * Form model of a price catalog (`priceCatalogDef` in apps/server/src/schemas.ts, priced by apps/server/src/plan/pricing.ts):
 * the document is turned into rows with stable ids (entries, matchers, units, carbon tables) so the form can hold
 * half-typed values, and turned back into the API document by `priceCatalogBody`.
 */

let seq = 0;
const nextId = () => `p${seq++}`;

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const text = (v: unknown) => (v === undefined || v === null ? '' : String(v));
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const omit = (o: Record<string, unknown>, keys: readonly string[]) => Object.fromEntries(Object.entries(o).filter(([k]) => !keys.includes(k)));

// ---------- matchers ----------

export type MatchKind = 'text' | 'number' | 'boolean' | 'list';
export interface MatchRow {
  id: string;
  /** Attribute path in the planned values (`size`, `default_node_pool.0.vm_size`); `region` is the resource's region. */
  key: string;
  kind: MatchKind;
  /** Value of text (glob), number and boolean ("true" / "false") matchers. */
  text: string;
  /** Values of a "one of" matcher. */
  list: string[];
}

export const newMatch = (key = '', value = ''): MatchRow => ({ id: nextId(), key, kind: 'text', text: value, list: [] });

const toMatchRow = (key: string, v: unknown): MatchRow => {
  if (Array.isArray(v)) return { ...newMatch(key), kind: 'list', list: v.map(String) };
  if (typeof v === 'number') return { ...newMatch(key, String(v)), kind: 'number' };
  if (typeof v === 'boolean') return { ...newMatch(key, String(v)), kind: 'boolean' };
  return newMatch(key, text(v));
};

const matchValue = (m: MatchRow): unknown => {
  if (m.kind === 'list') return m.list;
  if (m.kind === 'boolean') return m.text === 'true';
  if (m.kind === 'number') return m.text.trim() && Number.isFinite(Number(m.text)) ? Number(m.text) : m.text;
  return m.text;
};

// ---------- entries ----------

export type PricingMode = 'monthly' | 'hourly' | 'perUnit' | 'free' | 'usageBased';

export interface UnitRow {
  id: string;
  attribute: string;
  scale?: number;
  default?: number;
  monthly?: number;
  hourly?: number;
  watts?: number;
  extra: Record<string, unknown>;
}

export interface EntryRow {
  id: string;
  provider: string;
  type: string;
  match: MatchRow[];
  mode: PricingMode;
  /** Monthly price (monthly mode) or fixed monthly fee added to the hourly / per-unit price. */
  monthly?: number;
  hourly?: number;
  perUnit: UnitRow[];
  /** Multiplies the whole entry (node count). */
  quantity: { attribute: string; default?: number } | null;
  watts?: number;
  vcpu?: number;
  memoryGb?: number;
  note: string;
  /** Keys the form does not know, kept as they are. */
  extra: Record<string, unknown>;
}

const ENTRY_KEYS = [
  'provider',
  'type',
  'match',
  'monthly',
  'hourly',
  'perUnit',
  'quantity',
  'free',
  'usageBased',
  'watts',
  'vcpu',
  'memoryGb',
  'note',
] as const;
const UNIT_KEYS = ['attribute', 'scale', 'default', 'monthly', 'hourly', 'watts'] as const;

export const newUnit = (): UnitRow => ({ id: nextId(), attribute: '', scale: 1, default: 0, extra: {} });

export const newEntry = (): EntryRow => ({
  id: nextId(),
  provider: '',
  type: '',
  match: [],
  mode: 'monthly',
  perUnit: [],
  quantity: null,
  note: '',
  extra: {},
});

/** A copy with fresh ids (duplicate). */
export const copyEntry = (e: EntryRow): EntryRow => {
  const c = structuredClone(e);
  return { ...c, id: nextId(), match: c.match.map((m) => ({ ...m, id: nextId() })), perUnit: c.perUnit.map((u) => ({ ...u, id: nextId() })) };
};

/** The mode an entry is priced with (pricing.ts: free first; usage-based counts 0). */
const modeOf = (v: Record<string, unknown>): PricingMode => {
  if (v.free === true) return 'free';
  if (v.usageBased === true) return 'usageBased';
  if (Array.isArray(v.perUnit) && v.perUnit.length) return 'perUnit';
  if (num(v.hourly) !== undefined) return 'hourly';
  return 'monthly';
};

const toUnit = (u: unknown): UnitRow => {
  const v = isObject(u) ? u : {};
  return {
    id: nextId(),
    attribute: text(v.attribute),
    scale: num(v.scale),
    default: num(v.default),
    monthly: num(v.monthly),
    hourly: num(v.hourly),
    watts: num(v.watts),
    extra: omit(v, UNIT_KEYS),
  };
};

export const toEntry = (raw: unknown): EntryRow => {
  const v = isObject(raw) ? raw : {};
  const q = isObject(v.quantity) ? v.quantity : null;
  return {
    id: nextId(),
    provider: text(v.provider),
    type: text(v.type),
    match: Object.entries(isObject(v.match) ? v.match : {}).map(([k, x]) => toMatchRow(k, x)),
    mode: modeOf(v),
    monthly: num(v.monthly),
    hourly: num(v.hourly),
    perUnit: Array.isArray(v.perUnit) ? v.perUnit.map(toUnit) : [],
    quantity: q ? { attribute: text(q.attribute), default: num(q.default) } : null,
    watts: num(v.watts),
    vcpu: num(v.vcpu),
    memoryGb: num(v.memoryGb),
    note: text(v.note),
    extra: omit(v, ENTRY_KEYS),
  };
};

const defined = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([, x]) => x !== undefined));

/** The API entry: only the fields of its pricing mode. */
export const entryBody = (e: EntryRow): Record<string, unknown> => {
  const out: Record<string, unknown> = {
    ...e.extra,
    provider: e.provider.trim(),
    type: e.type.trim(),
    match: Object.fromEntries(e.match.filter((m) => m.key.trim()).map((m) => [m.key.trim(), matchValue(m)])),
  };
  const priced = e.mode === 'monthly' || e.mode === 'hourly' || e.mode === 'perUnit';
  if (e.mode === 'monthly') out.monthly = e.monthly;
  if (e.mode === 'hourly' || e.mode === 'perUnit') Object.assign(out, defined({ monthly: e.monthly, hourly: e.hourly }));
  if (e.mode === 'perUnit')
    out.perUnit = e.perUnit.map((u) =>
      defined({ ...u.extra, attribute: u.attribute.trim(), scale: u.scale, default: u.default, monthly: u.monthly, hourly: u.hourly, watts: u.watts }),
    );
  if (priced && e.quantity) out.quantity = defined({ attribute: e.quantity.attribute.trim(), default: e.quantity.default });
  if (e.mode === 'free') out.free = true;
  if (e.mode === 'usageBased') out.usageBased = true;
  if (e.mode !== 'free') Object.assign(out, defined({ watts: e.watts, vcpu: e.vcpu, memoryGb: e.memoryGb }));
  if (e.note.trim()) out.note = e.note.trim();
  return defined(out);
};

// ---------- carbon tables ----------

export interface NumRow {
  id: string;
  key: string;
  value?: number;
}
export const newNumRow = (): NumRow => ({ id: nextId(), key: '', value: undefined });
const toNumRows = (v: unknown): NumRow[] => Object.entries(isObject(v) ? v : {}).map(([key, x]) => ({ id: nextId(), key, value: num(x) }));
const numRecord = (rows: NumRow[]) => {
  const list = rows.filter((r) => r.key.trim());
  return list.length ? Object.fromEntries(list.map((r) => [r.key.trim(), r.value])) : undefined;
};

// ---------- catalog ----------

export interface PriceCatalogDoc {
  identifier: string;
  title: string;
  description: string;
  currency: string;
  extends: string | null;
  hoursPerMonth?: number;
  freeProviders: string[];
  pue: NumRow[];
  gridIntensity: NumRow[];
  defaultGridIntensity?: number;
  wattsPerVcpu: NumRow[];
  wattsPerGbMemory?: number;
  /** Carbon keys the form does not know. */
  carbonExtra: Record<string, unknown>;
  prices: EntryRow[];
  [k: string]: unknown;
}

const FORM_KEYS = ['pue', 'gridIntensity', 'defaultGridIntensity', 'wattsPerVcpu', 'wattsPerGbMemory', 'carbonExtra'] as const;
const CARBON_KEYS = ['pue', 'gridIntensity', 'defaultGridIntensity', 'wattsPerVcpu', 'wattsPerGbMemory'] as const;

export const toPriceCatalogDoc = (v: Record<string, unknown>): PriceCatalogDoc => {
  const carbon = isObject(v.carbon) ? v.carbon : {};
  const { carbon: _carbon, prices, ...rest } = v;
  return {
    ...rest,
    identifier: text(v.identifier),
    title: text(v.title),
    description: text(v.description),
    currency: v.currency === undefined ? 'USD' : text(v.currency),
    extends: typeof v.extends === 'string' && v.extends ? v.extends : null,
    hoursPerMonth: v.hoursPerMonth === undefined ? 730 : num(v.hoursPerMonth),
    freeProviders: Array.isArray(v.freeProviders) ? v.freeProviders.map(String) : [],
    pue: toNumRows(carbon.pue),
    gridIntensity: toNumRows(carbon.gridIntensity),
    defaultGridIntensity: num(carbon.defaultGridIntensity),
    wattsPerVcpu: toNumRows(carbon.wattsPerVcpu),
    wattsPerGbMemory: num(carbon.wattsPerGbMemory),
    carbonExtra: omit(carbon, CARBON_KEYS),
    prices: Array.isArray(prices) ? prices.map(toEntry) : [],
  };
};

export const priceCatalogBody = (d: PriceCatalogDoc): Record<string, unknown> => {
  const rest = omit(d, FORM_KEYS);
  const carbon = defined({
    ...d.carbonExtra,
    pue: numRecord(d.pue),
    gridIntensity: numRecord(d.gridIntensity),
    defaultGridIntensity: d.defaultGridIntensity,
    wattsPerVcpu: numRecord(d.wattsPerVcpu),
    wattsPerGbMemory: d.wattsPerGbMemory,
  });
  return defined({
    ...rest,
    identifier: d.identifier,
    title: d.title,
    description: d.description,
    currency: d.currency.trim(),
    extends: d.extends ?? undefined,
    hoursPerMonth: d.hoursPerMonth,
    freeProviders: d.freeProviders.length ? d.freeProviders : undefined,
    carbon,
    prices: d.prices.map(entryBody),
  });
};

// ---------- validation (mirrors priceCatalogDef) ----------

const range = (out: string[], label: string, v: number | undefined, min: number, max = Infinity, exclusiveMin = false) => {
  if (v === undefined) return;
  if (Number.isFinite(v) && (exclusiveMin ? v > min : v >= min) && v <= max) return;
  let expected = `between ${min} and ${max}`;
  if (max === Infinity) expected = exclusiveMin ? `greater than ${min}` : `${min} or more`;
  out.push(`${label}: ${expected}`);
};

const tableProblems = (out: string[], label: string, rows: NumRow[], min: number, max = Infinity) => {
  const keys = rows.map((r) => r.key.trim());
  if (keys.some((k, i) => !k && rows[i]!.value !== undefined)) out.push(`${label}: every row needs a name`);
  if (keys.some((k) => k.length > 64)) out.push(`${label}: names are at most 64 characters`);
  const named = keys.filter(Boolean);
  if (new Set(named).size !== named.length) out.push(`${label}: names must be unique`);
  for (const r of rows) {
    if (!r.key.trim()) continue;
    if (r.value === undefined) out.push(`${label} ${r.key}: a value is required`);
    else range(out, `${label} ${r.key}`, r.value, min, max);
  }
};

export const entryLabel = (e: EntryRow, i: number) => `Price ${i + 1} (${[e.provider, e.type].filter(Boolean).join(' ') || 'new'})`;

export function entryProblems(e: EntryRow, i: number): string[] {
  const out: string[] = [];
  const at = entryLabel(e, i);
  if (!e.provider.trim()) out.push(`${at}: provider is required (* for any)`);
  if (!e.type.trim()) out.push(`${at}: resource type is required (* for any)`);
  if (e.provider.length > 200 || e.type.length > 200) out.push(`${at}: provider and type are at most 200 characters`);
  const keys = e.match.map((m) => m.key.trim());
  if (keys.some((k) => !k)) out.push(`${at}: every matcher needs an attribute path`);
  if (new Set(keys.filter(Boolean)).size !== keys.filter(Boolean).length) out.push(`${at}: matcher attributes must be unique`);
  for (const m of e.match) {
    const name = m.key.trim() || '?';
    if (m.key.length > 200 || m.text.length > 200 || m.list.some((x) => x.length > 200)) out.push(`${at}: matcher ${name} is too long (200 characters)`);
    if (m.kind === 'number' && !(m.text.trim() && Number.isFinite(Number(m.text)))) out.push(`${at}: matcher ${name} must be a number`);
    if (m.kind === 'list' && !m.list.length) out.push(`${at}: matcher ${name} needs at least one value`);
    if (m.kind === 'list' && m.list.length > 50) out.push(`${at}: matcher ${name} has more than 50 values`);
  }
  if (e.mode === 'monthly') {
    if (e.monthly === undefined) out.push(`${at}: monthly price is required`);
    range(out, `${at} monthly price`, e.monthly, 0);
  }
  if (e.mode === 'hourly') {
    if (e.hourly === undefined) out.push(`${at}: hourly price is required`);
    range(out, `${at} hourly price`, e.hourly, 0);
    range(out, `${at} monthly fee`, e.monthly, 0);
  }
  if (e.mode === 'perUnit') {
    range(out, `${at} monthly fee`, e.monthly, 0);
    range(out, `${at} hourly price`, e.hourly, 0);
    if (!e.perUnit.length) out.push(`${at}: add at least one unit`);
    if (e.perUnit.length > 10) out.push(`${at}: at most 10 units`);
    e.perUnit.forEach((u, j) => {
      const ua = `${at} unit ${j + 1}`;
      if (!u.attribute.trim()) out.push(`${ua}: attribute is required`);
      if (u.attribute.length > 200) out.push(`${ua}: attribute is at most 200 characters`);
      range(out, `${ua} scale`, u.scale, 0, Infinity, true);
      range(out, `${ua} default`, u.default, 0);
      range(out, `${ua} monthly price`, u.monthly, 0);
      range(out, `${ua} hourly price`, u.hourly, 0);
      range(out, `${ua} watts`, u.watts, 0);
    });
  }
  const priced = e.mode === 'monthly' || e.mode === 'hourly' || e.mode === 'perUnit';
  if (priced && e.quantity) {
    if (!e.quantity.attribute.trim()) out.push(`${at}: quantity attribute is required`);
    if (e.quantity.attribute.length > 200) out.push(`${at}: quantity attribute is at most 200 characters`);
    range(out, `${at} quantity default`, e.quantity.default, 0);
  }
  if (e.mode !== 'free') {
    range(out, `${at} watts`, e.watts, 0);
    range(out, `${at} vCPUs`, e.vcpu, 0);
    range(out, `${at} memory`, e.memoryGb, 0);
  }
  if (e.note.length > 300) out.push(`${at}: note is at most 300 characters`);
  return out;
}

export interface CatalogRef {
  identifier: string;
  currency: string;
  extends?: string;
}

/** Catalogs whose `extends` chain reaches `id` (choosing one of them as the parent would loop). */
export function extendersOf(id: string, catalogs: CatalogRef[]): Set<string> {
  const byId = new Map(catalogs.map((c) => [c.identifier, c]));
  const out = new Set<string>();
  for (const c of catalogs) {
    const seen = new Set<string>();
    for (let x: CatalogRef | undefined = c; x && !seen.has(x.identifier); x = x.extends ? byId.get(x.extends) : undefined) {
      seen.add(x.identifier);
      if (x.extends === id) {
        out.add(c.identifier);
        break;
      }
    }
  }
  return out;
}

export function priceCatalogProblems(d: PriceCatalogDoc, catalogs: CatalogRef[] = []): string[] {
  const out = identityProblems(d);
  if (d.title.length > 100) out.push('Title is at most 100 characters');
  if (d.description.length > 2000) out.push('Description is at most 2000 characters');
  if (d.identifier === 'builtin') out.push('"builtin" is the built-in catalog: choose another identifier (and extend builtin)');
  if (!/^[A-Z]{3}$/.test(d.currency.trim())) out.push('Currency: ISO 4217 code of 3 capital letters, e.g. EUR');
  if (d.extends) {
    if (d.extends === d.identifier) out.push('A price catalog cannot extend itself');
    else if (extendersOf(d.identifier, catalogs).has(d.extends)) out.push(`Extends: ${d.extends} already extends this catalog (loop)`);
    const parent = catalogs.find((c) => c.identifier === d.extends);
    if (parent && parent.currency !== d.currency.trim())
      out.push(`Currency: ${d.extends} is in ${parent.currency}, a catalog extends one in the same currency`);
  }
  if (d.hoursPerMonth !== undefined && !(d.hoursPerMonth > 0 && d.hoursPerMonth <= 744)) out.push('Hours per month: greater than 0, at most 744');
  if (d.freeProviders.length > 100) out.push('Free providers: at most 100');
  if (d.freeProviders.some((p) => p.length > 64)) out.push('Free providers: names are at most 64 characters');
  tableProblems(out, 'PUE', d.pue, 1, 3);
  tableProblems(out, 'Grid intensity', d.gridIntensity, 0, 2);
  range(out, 'Default grid intensity', d.defaultGridIntensity, 0, 2);
  tableProblems(out, 'Watts per vCPU', d.wattsPerVcpu, 0);
  range(out, 'Watts per GB of memory', d.wattsPerGbMemory, 0);
  if (d.prices.length > 5000) out.push('At most 5000 prices');
  d.prices.forEach((e, i) => out.push(...entryProblems(e, i)));
  return out;
}

// ---------- summaries (prices table) ----------

const fmt = (n: number) => String(Math.round(n * 1e6) / 1e6);

export function matchSummary(e: EntryRow): string {
  const list = e.match.filter((m) => m.key.trim());
  if (!list.length) return 'any';
  return list.map((m) => `${m.key}=${m.kind === 'list' ? `[${m.list.join(', ')}]` : m.text}`).join(', ');
}

export function priceSummary(e: EntryRow, currency: string): string {
  const qty = e.quantity?.attribute ? ` × ${e.quantity.attribute}` : '';
  const fee = e.monthly ? ` + ${fmt(e.monthly)} ${currency}/month` : '';
  switch (e.mode) {
    case 'free':
      return 'free';
    case 'usageBased':
      return 'usage-based';
    case 'monthly':
      return e.monthly === undefined ? '—' : `${fmt(e.monthly)} ${currency}/month${qty}`;
    case 'hourly':
      return e.hourly === undefined ? '—' : `${fmt(e.hourly)} ${currency}/h${fee}${qty}`;
    case 'perUnit': {
      const units = e.perUnit
        .map((u) => {
          const p = [u.monthly ? `${fmt(u.monthly)}/month` : '', u.hourly ? `${fmt(u.hourly)}/h` : ''].filter(Boolean).join(' + ') || '0';
          return `${p} per ${u.attribute || '?'}`;
        })
        .join(' + ');
      const base = [e.hourly ? `${fmt(e.hourly)}/h` : '', e.monthly ? `${fmt(e.monthly)}/month` : ''].filter(Boolean).join(' + ');
      return `${[base, units].filter(Boolean).join(' + ') || '—'} ${currency}${qty}`;
    }
  }
}
