import type { PlanResourceEstimate } from '@asterius/shared';
import type { PriceCatalogDef, PriceEntry } from '../schemas.js';
import { getPath, type Plan, type PlanResource } from './plan.js';

/**
 * Cost and carbon estimates of a plan from a price catalog chain (price-catalogs.ts).
 *
 * Cost: each resource is priced twice, before (current state) and after (planned values); `delta` = after - before,
 * so creates add, deletes subtract, updates and replacements count the difference. The price of a resource is the
 * most specific matching entry (most `match` keys) of the first catalog of the chain that has one:
 * (`monthly` + `hourly` × hoursPerMonth + Σ perUnit units × unit price) × quantity. Resources without a matching entry
 * are reported as `unmatched` and not counted (never silently ignored); `usageBased` entries count 0 and are listed.
 *
 * Carbon (Cloud Carbon Footprint style, an estimate): average watts (`watts`, or vCPUs × wattsPerVcpu + memory ×
 * wattsPerGbMemory, plus per-unit watts) × hours × PUE of the provider × grid emission factor of the region
 * (kgCO2e/kWh). Operational emissions only: embodied emissions and networking are not included.
 */

export const CARBON_METHOD =
  'Estimate (Cloud Carbon Footprint method): average power × hours × PUE × regional grid factor; operational emissions only, embodied emissions and networking excluded.';

interface Price {
  monthly: number;
  watts: number;
  entry: PriceEntry | null;
  kind: PlanResourceEstimate['pricing'];
}

const round = (n: number, d = 2) => Math.round(n * 10 ** d) / 10 ** d;

/** `*` is a wildcard; comparisons ignore case. */
function globMatch(pattern: string, value: string): boolean {
  if (pattern === '*') return true;
  if (!pattern.includes('*')) return pattern.toLowerCase() === value.toLowerCase();
  const re = new RegExp(
    `^${pattern
      .split('*')
      .map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
      .join('.*')}$`,
    'i',
  );
  return re.test(value);
}

function valueMatches(expected: PriceEntry['match'][string], actual: unknown): boolean {
  if (Array.isArray(expected)) return expected.some((x) => valueMatches(x, actual));
  if (actual === undefined || actual === null) return expected === '*';
  if (typeof expected === 'string') return globMatch(expected, String(actual));
  return expected === actual || String(expected) === String(actual);
}

const specificity = (e: PriceEntry) => Object.values(e.match).filter((v) => v !== '*').length;

function findEntry(catalog: PriceCatalogDef, r: PlanResource, attrs: Record<string, unknown>): PriceEntry | null {
  let best: PriceEntry | null = null;
  for (const e of catalog.prices) {
    if (!globMatch(e.provider, r.provider) || !globMatch(e.type, r.type)) continue;
    const ok = Object.entries(e.match).every(([k, v]) => valueMatches(v, k === 'region' ? r.region : getPath(attrs, k)));
    if (ok && (!best || specificity(e) > specificity(best))) best = e;
  }
  return best;
}

const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() && Number.isFinite(Number(v)) ? Number(v) : undefined;

function priceOf(chain: PriceCatalogDef[], r: PlanResource, attrs: Record<string, unknown>): Price {
  const top = chain[0]!;
  if (chain.some((c) => c.freeProviders?.includes(r.provider))) return { monthly: 0, watts: 0, entry: null, kind: 'free' };
  for (const c of chain) {
    const e = findEntry(c, r, attrs);
    if (!e) continue;
    if (e.free) return { monthly: 0, watts: 0, entry: e, kind: 'free' };
    const hours = top.hoursPerMonth;
    const wattsPerVcpu = chain.map((x) => x.carbon.wattsPerVcpu?.[r.provider]).find((x) => x !== undefined) ?? 2.2;
    const wattsPerGb = chain.map((x) => x.carbon.wattsPerGbMemory).find((x) => x !== undefined) ?? 0.392;
    let monthly = (e.monthly ?? 0) + (e.hourly ?? 0) * hours;
    let watts = e.watts ?? (e.vcpu ?? 0) * wattsPerVcpu + (e.memoryGb ?? 0) * wattsPerGb;
    for (const u of e.perUnit ?? []) {
      const units = (num(getPath(attrs, u.attribute)) ?? u.default) * u.scale;
      monthly += units * ((u.monthly ?? 0) + (u.hourly ?? 0) * hours);
      watts += units * (u.watts ?? 0);
    }
    const q = e.quantity ? (num(getPath(attrs, e.quantity.attribute)) ?? e.quantity.default) : 1;
    return { monthly: monthly * q, watts: watts * q, entry: e, kind: e.usageBased ? 'usage-based' : 'priced' };
  }
  return { monthly: 0, watts: 0, entry: null, kind: 'unmatched' };
}

/** kgCO2e per month of an average power draw in a region. */
function co2eKg(chain: PriceCatalogDef[], provider: string, region: string | null, watts: number): number {
  if (!watts) return 0;
  const pue = chain.map((c) => c.carbon.pue?.[provider]).find((x) => x !== undefined) ?? 1.2;
  const grid =
    (region ? chain.map((c) => c.carbon.gridIntensity?.[region]).find((x) => x !== undefined) : undefined) ??
    chain.map((c) => c.carbon.defaultGridIntensity).find((x) => x !== undefined) ??
    0.475;
  return ((watts * chain[0]!.hoursPerMonth) / 1000) * pue * grid;
}

export interface Estimate {
  currency: string;
  catalog: string;
  monthly: number;
  before: number;
  delta: number;
  carbon: { monthlyKg: number; beforeKg: number; deltaKg: number };
  resources: PlanResourceEstimate[];
  unmatched: string[];
  usageBased: string[];
}

export function estimate(plan: Plan, chain: PriceCatalogDef[]): Estimate {
  const resources: PlanResourceEstimate[] = [];
  let monthly = 0;
  let before = 0;
  let kg = 0;
  let kgBefore = 0;
  for (const r of plan.resources) {
    const b = r.before ? priceOf(chain, r, r.before) : null;
    // A forgotten resource leaves the state but keeps running (and billing): same cost after.
    const a = r.action === 'forget' ? b : r.after ? priceOf(chain, r, r.after) : null;
    const kind = (a ?? b)?.kind ?? 'unmatched';
    const after$ = a?.monthly ?? 0;
    const before$ = b?.monthly ?? 0;
    const afterKg = a ? co2eKg(chain, r.provider, r.region, a.watts) : 0;
    const beforeKg = b ? co2eKg(chain, r.provider, r.region, b.watts) : 0;
    monthly += after$;
    before += before$;
    kg += afterKg;
    kgBefore += beforeKg;
    const note = (a ?? b)?.entry?.note;
    resources.push({
      address: r.address,
      type: r.type,
      provider: r.provider,
      action: r.action,
      region: r.region,
      pricing: kind,
      monthly: round(after$),
      before: round(before$),
      delta: round(after$ - before$),
      co2eKg: round(afterKg, 3),
      co2eDeltaKg: round(afterKg - beforeKg, 3),
      ...(note ? { note } : {}),
    });
  }
  return {
    currency: chain[0]!.currency,
    catalog: chain[0]!.identifier,
    monthly: round(monthly),
    before: round(before),
    delta: round(monthly - before),
    carbon: { monthlyKg: round(kg, 2), beforeKg: round(kgBefore, 2), deltaKg: round(kg - kgBefore, 2) },
    resources,
    unmatched: resources.filter((r) => r.pricing === 'unmatched').map((r) => r.address),
    usageBased: resources.filter((r) => r.pricing === 'usage-based').map((r) => r.address),
  };
}
