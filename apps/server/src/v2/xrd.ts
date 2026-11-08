import fs from 'node:fs/promises';
import YAML from 'yaml';
import type { Action, ObjectSchema, PropertySchema } from '@asterius/shared';
import { http } from '../lib/http.js';
import { resolveValue } from '../secrets.js';
import type { XrdFormSource } from '../schemas.js';
import { readFile } from './ado-git.js';
import { autoFieldName, DEFAULT_FIELDS, DERIVED_FIELDS } from './spec.js';

/**
 * The self-service form generated from the Service XRD (docs/V2.md §5.1): the `openAPIV3Schema` of `spec` is mapped
 * to the action's input schema (types, enums, defaults, descriptions, bounds, required), so a field added to the XRD
 * shows up in the form without editing the action. A form trigger opts in with `inputs.fromXrd`; its static
 * `properties` stay the fallback while the XRD cannot be read, and keep the fields the XRD does not hold (team, name).
 */

type JsonSchema = {
  type?: string;
  title?: string;
  description?: string;
  enum?: unknown[];
  default?: unknown;
  format?: string;
  pattern?: string;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  uniqueItems?: boolean;
  items?: JsonSchema;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  'x-kubernetes-int-or-string'?: boolean;
  'x-portal-title'?: string;
  'x-portal-format'?: string;
  'x-portal-hidden'?: boolean;
  [k: string]: unknown;
};

export type { JsonSchema };

export interface XrdSpecSchema {
  /** XRD version the schema comes from. */
  version: string;
  spec: JsonSchema;
}

type VersionDef = { name: string; served?: boolean; referenceable?: boolean; schema?: { openAPIV3Schema?: JsonSchema } };

/**
 * The `spec` schema of the Service in a (multi-document) YAML file: a Crossplane XRD (`CompositeResourceDefinition`),
 * a `CustomResourceDefinition`, or a plain schema document (`openAPIV3Schema: {…}`, or a JSON schema of the manifest
 * with `properties.spec`), so the Portal repo can keep its schema outside Crossplane (lean path: `schema/service-xrd.yaml`).
 */
export function parseXrd(text: string, opts: { kind?: string; version?: string } = {}): XrdSpecSchema {
  const docs = YAML.parseAllDocuments(text).map((d) => d.toJS() as Record<string, unknown> | null);
  const kind = opts.kind ?? 'Service';
  const xrd = docs.find(
    (d) =>
      (d?.kind === 'CompositeResourceDefinition' || d?.kind === 'CustomResourceDefinition') &&
      ((d.spec as { names?: { kind?: string } } | undefined)?.names?.kind ?? kind) === kind,
  ) as { spec?: { versions?: VersionDef[] } } | undefined;
  if (!xrd) {
    // A plain schema document.
    for (const d of docs) {
      if (!d || typeof d !== 'object') continue;
      const root =
        (d.openAPIV3Schema as JsonSchema | undefined) ?? (d.schema as { openAPIV3Schema?: JsonSchema } | undefined)?.openAPIV3Schema ?? (d as JsonSchema);
      const spec = root?.properties?.spec;
      if (spec && typeof spec === 'object') {
        const version = String(d.version ?? (d as { 'x-version'?: string })['x-version'] ?? opts.version ?? 'v1alpha1');
        return { version, spec };
      }
    }
    throw new Error(`no CompositeResourceDefinition (or schema with properties.spec) for kind ${kind}`);
  }
  const versions = xrd.spec?.versions ?? [];
  const v = opts.version
    ? versions.find((x) => x.name === opts.version)
    : (versions.find((x) => x.referenceable) ?? versions.find((x) => x.served !== false) ?? versions[0]);
  if (!v) throw new Error(`XRD has no version${opts.version ? ` ${opts.version}` : ''}`);
  const spec = v.schema?.openAPIV3Schema?.properties?.spec;
  if (!spec) throw new Error(`XRD version ${v.name} has no openAPIV3Schema.properties.spec`);
  return { version: v.name, spec };
}

const humanize = (k: string) =>
  k
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[-_]+/g, ' ')
    .replace(/^./, (c) => c.toUpperCase());

const FORMATS: Record<string, string> = { 'date-time': 'date-time', date: 'date', email: 'email', uri: 'url', url: 'url' };
const SCALARS = new Set(['string', 'number', 'integer', 'boolean']);

function leaf(s: JsonSchema, name: string): PropertySchema | null {
  const type = s['x-kubernetes-int-or-string'] ? 'string' : (s.type ?? (s.enum ? 'string' : undefined));
  if (!type) return null;
  const out: Record<string, unknown> = { type, title: s['x-portal-title'] ?? s.title ?? humanize(name) };
  if (s.description) out.description = s.description;
  if (type === 'array') {
    const it = s.items ?? {};
    if (it.type && !SCALARS.has(it.type)) return null; // arrays of objects: not a form field
    out.items = { type: it.type ?? 'string', ...(it.enum ? { enum: it.enum } : {}) };
    for (const k of ['minItems', 'maxItems', 'uniqueItems'] as const) if (s[k] !== undefined) out[k] = s[k];
  } else if (!SCALARS.has(type)) return null;
  for (const k of ['enum', 'default', 'pattern', 'minimum', 'maximum', 'minLength', 'maxLength'] as const) if (s[k] !== undefined) out[k] = s[k];
  const format = s['x-portal-format'] ?? (s.format ? FORMATS[s.format] : undefined);
  if (format) out.format = format;
  return out as unknown as PropertySchema;
}

export interface MapOptions {
  /** Input name → spec path (default: the contract mapping). */
  fields?: Record<string, string>;
  /** Add the XRD fields that `fields` does not name, as `spec__<path>` inputs (default true). */
  others?: boolean;
  /** Spec paths (or prefixes) left out of the form; `owner` and `crossplane` are always derived by the portal. */
  exclude?: string[];
}

/** Map the XRD `spec` schema to an action input schema. */
export function xrdToInputs(spec: JsonSchema, o: MapOptions = {}): ObjectSchema {
  const fields = o.fields ?? DEFAULT_FIELDS;
  const byPath = new Map(Object.entries(fields).map(([name, path]) => [path, name]));
  const excluded = [...DERIVED_FIELDS, ...(o.exclude ?? [])];
  const isExcluded = (p: string) => excluded.some((x) => p === x || p.startsWith(`${x}.`));
  const properties: Record<string, PropertySchema> = {};
  const required: string[] = [];
  const walk = (s: JsonSchema, prefix: string, parentRequired: boolean) => {
    for (const [key, child] of Object.entries(s.properties ?? {})) {
      const path = prefix ? `${prefix}.${key}` : key;
      if (isExcluded(path) || child['x-portal-hidden']) continue;
      const req = parentRequired && (s.required ?? []).includes(key);
      if ((child.type === 'object' || (!child.type && child.properties)) && child.properties) {
        walk(child, path, req);
        continue;
      }
      const name = byPath.get(path) ?? (o.others === false ? undefined : autoFieldName(path));
      if (!name) continue;
      const p = leaf(child, key);
      if (!p) continue;
      properties[name] = p;
      if (req) required.push(name);
    }
  };
  walk(spec, '', true);
  const named = Object.keys(fields).filter((n) => n in properties);
  const order = [...named, ...Object.keys(properties).filter((n) => !named.includes(n))];
  return { properties, required, order };
}

/** Keys taken from the XRD; the others (title, format, enumColors, hidden…) stay as declared in the action. */
const XRD_KEYS = [
  'type',
  'enum',
  'default',
  'description',
  'pattern',
  'minimum',
  'maximum',
  'minLength',
  'maxLength',
  'items',
  'minItems',
  'maxItems',
  'uniqueItems',
];

/** Overlay the XRD-derived schema on the declared one (declared fields the XRD does not hold are kept). */
export function mergeInputs(declared: ObjectSchema, fromXrd: ObjectSchema): ObjectSchema {
  const properties: Record<string, PropertySchema> = { ...declared.properties };
  for (const [k, x] of Object.entries(fromXrd.properties)) {
    const d = (declared.properties[k] ?? {}) as unknown as Record<string, unknown>;
    const merged: Record<string, unknown> = { ...(x as unknown as Record<string, unknown>), ...d };
    for (const key of XRD_KEYS) {
      if (key in (x as object)) merged[key] = (x as unknown as Record<string, unknown>)[key];
      else if (key !== 'type' && key !== 'items') delete merged[key];
    }
    if (!d.title) merged.title = (x as { title?: string }).title;
    properties[k] = merged as unknown as PropertySchema;
  }
  const required = [...new Set([...(declared.required ?? []).filter((r) => !(r in fromXrd.properties)), ...(fromXrd.required ?? [])])];
  const order = [...new Set([...(declared.order ?? Object.keys(declared.properties)), ...(fromXrd.order ?? Object.keys(fromXrd.properties))])];
  return { properties, required, order };
}

// ---------- loading (cached) ----------

export interface XrdStatus {
  status: 'loaded' | 'unavailable';
  source: string;
  version?: string;
  loadedAt?: string;
  error?: string;
}

interface Entry {
  at: number;
  schema?: XrdSpecSchema;
  error?: string;
  loadedAt?: string;
  pending?: Promise<void>;
}
const cache = new Map<string, Entry>();
const ERROR_TTL_MS = 30_000;

export const describeSource = (s: XrdFormSource) => (s.source === 'ado' ? `${s.repository}#${s.branch}:${s.path}` : s.source === 'url' ? s.url! : s.file!);

async function fetchXrdText(s: XrdFormSource): Promise<string> {
  if (s.source === 'file') return fs.readFile(s.file!, 'utf8');
  if (s.source === 'url') {
    const token = s.token ? await resolveValue(s.token) : undefined;
    const res = await http<unknown>(s.url!, {
      headers: { accept: 'application/yaml, text/yaml, */*', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    });
    return typeof res.data === 'string' ? res.data : res.text;
  }
  const token = (await resolveValue(s.token)) ?? '';
  const text = await readFile({ url: s.repository!, branch: s.branch, token }, s.path);
  if (text === null) throw new Error(`${s.path} not found in ${s.repository} (${s.branch})`);
  return text;
}

/** Drop cached XRDs (tests, admin refresh). */
export const clearXrdCache = () => cache.clear();

/**
 * The XRD `spec` schema for a source, from a cache refreshed every `ttlSeconds`. A stale entry is served while it
 * refreshes in the background; with nothing cached the caller waits at most `waitMs` and then gets the error.
 */
export async function loadXrd(s: XrdFormSource, waitMs = 3000): Promise<Entry> {
  // The token (a reference, or a resolved value for the pre-check) is not part of the key.
  const key = JSON.stringify({ ...s, token: undefined });
  let e = cache.get(key);
  const ttl = e?.error ? ERROR_TTL_MS : s.ttlSeconds * 1000;
  if (!e || (Date.now() - e.at > ttl && !e.pending)) {
    const entry: Entry = e ?? { at: 0 };
    entry.pending = (async () => {
      try {
        const schema = parseXrd(await fetchXrdText(s), { kind: s.kind, version: s.version });
        Object.assign(entry, { schema, error: undefined, loadedAt: new Date().toISOString() });
      } catch (err) {
        entry.error = (err as Error).message;
      } finally {
        entry.at = Date.now();
        entry.pending = undefined;
      }
    })();
    cache.set(key, entry);
    e = entry;
  }
  if (!e.schema && !e.error && e.pending) await Promise.race([e.pending, new Promise((r) => setTimeout(r, waitMs))]);
  return e;
}

/** Inputs of a form trigger with `fromXrd`, resolved; and the status of the XRD source. */
export async function resolveXrdInputs(inputs: ObjectSchema & { fromXrd?: XrdFormSource }): Promise<{ inputs: ObjectSchema; xrd?: XrdStatus }> {
  const from = inputs.fromXrd;
  if (!from) return { inputs };
  const source = describeSource(from);
  const e = await loadXrd(from);
  if (!e.schema) return { inputs, xrd: { status: 'unavailable', source, error: e.error ?? 'loading' } };
  const mapped = xrdToInputs(e.schema.spec, { fields: from.fields, others: from.others, exclude: from.exclude });
  return {
    inputs: { ...mergeInputs(inputs, mapped), fromXrd: from } as ObjectSchema,
    xrd: { status: 'loaded', source, version: e.schema.version, loadedAt: e.loadedAt, ...(e.error ? { error: `refresh failed: ${e.error}` } : {}) },
  };
}

/** The action with its form generated from the XRD (no-op for actions without `inputs.fromXrd`). */
export async function withXrdInputs(a: Action): Promise<Action> {
  const t = a.trigger;
  if (!t || (t.type !== 'form' && t.type !== 'api')) return a;
  const declared = t.inputs as ObjectSchema & { fromXrd?: XrdFormSource };
  if (!declared?.fromXrd) return a;
  const { inputs, xrd } = await resolveXrdInputs(declared);
  return { ...a, trigger: { ...t, inputs: { ...inputs, xrd } as ObjectSchema } };
}
