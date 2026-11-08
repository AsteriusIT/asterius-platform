import { Ajv, type ValidateFunction } from 'ajv';
import { http, UpstreamError } from '../lib/http.js';
import type { XrdFormSource } from '../schemas.js';
import type { ServiceManifest } from './spec.js';
import { describeSource, loadXrd, type JsonSchema } from './xrd.js';

/**
 * Adapters for the pre-check (docs/V2-KIND.md): the shared Rego through OPA (`platform.portal` entry point) and the
 * render service (`crossplane render` of the golden path). Both take the Service manifest.
 */

export interface Violation {
  policy: string;
  msg: string;
}

export type PolicyResult =
  { status: 'allowed' | 'denied'; allowed: boolean; violations: Violation[] } | { status: 'unavailable'; allowed: null; violations: []; error: string };

const trim = (u: string) => u.replace(/\/+$/, '');

function violationsOf(v: unknown): Violation[] {
  const list = Array.isArray(v) ? v : v && typeof v === 'object' ? Object.values(v) : [];
  return list.map((x) =>
    x && typeof x === 'object'
      ? { policy: String((x as Violation).policy ?? 'unknown'), msg: String((x as Violation).msg ?? (x as { message?: string }).message ?? '') }
      : { policy: 'unknown', msg: String(x) },
  );
}

/**
 * `POST <opa>/v1/data/platform/portal/result` with `{input: {service}}`. Never throws: an unreachable OPA, an error
 * status or an undefined/malformed result is `unavailable`, and callers decide (the in-run check fails closed, the
 * preview shows a warning). An empty `result` (package not loaded yet) is unavailable too, not "allowed".
 */
export async function evaluatePolicy(opaUrl: string, service: ServiceManifest, timeoutMs = 5000): Promise<PolicyResult> {
  if (!opaUrl) return { status: 'unavailable', allowed: null, violations: [], error: 'OPA_URL is not configured' };
  try {
    const res = await http<{ result?: { allowed?: unknown; violations?: unknown } }>(`${trim(opaUrl)}/v1/data/platform/portal/result`, {
      method: 'POST',
      body: { input: { service } },
      timeoutMs,
      retry: { retries: 1 },
    });
    const r = res.data?.result;
    if (!r || typeof r !== 'object' || typeof r.allowed !== 'boolean')
      return { status: 'unavailable', allowed: null, violations: [], error: 'OPA returned no platform.portal result (policies not loaded?)' };
    const violations = violationsOf(r.violations);
    const allowed = r.allowed && violations.length === 0;
    return { status: allowed ? 'allowed' : 'denied', allowed, violations };
  } catch (e) {
    const msg = e instanceof UpstreamError ? `OPA answered ${e.status}` : `OPA unreachable: ${(e as Error).message}`;
    return { status: 'unavailable', allowed: null, violations: [], error: msg };
  }
}

export interface RenderedResource {
  /** Crossplane render: the managed resource's API version (absent in a `tofu plan`). */
  apiVersion?: string;
  /** Resource kind (Crossplane) or resource type (OpenTofu, e.g. `azuredevops_project`). */
  kind: string;
  /** Resource name (Crossplane) or address (OpenTofu). */
  name: string;
  externalName?: string | null;
  /** Plan service: `create | import | update | delete | no-op` (import: exists already, will be adopted). */
  action?: string;
}

export type RenderResult =
  | { status: 'ok'; resources: RenderedResource[]; raw?: unknown[] }
  | { status: 'unavailable' | 'error'; resources: []; error: string }
  | { status: 'skipped'; resources: [] };

/** `POST <render>/render` with `{service}` → `{resources, raw}`. Never throws. */
export async function renderResources(renderUrl: string, service: ServiceManifest, timeoutMs = 60_000): Promise<RenderResult> {
  if (!renderUrl) return { status: 'unavailable', resources: [], error: 'RENDER_URL is not configured' };
  try {
    const res = await http<{ resources?: RenderedResource[]; raw?: unknown[]; error?: string }>(`${trim(renderUrl)}/render`, {
      method: 'POST',
      body: { service },
      timeoutMs,
      retry: false,
    });
    const resources = Array.isArray(res.data?.resources) ? res.data.resources : [];
    return { status: 'ok', resources, raw: res.data?.raw };
  } catch (e) {
    if (e instanceof UpstreamError && e.status < 500 && e.status !== 404) {
      let msg = e.body ?? e.message;
      try {
        msg = (JSON.parse(e.body ?? '') as { error?: string }).error ?? msg;
      } catch {
        /* text */
      }
      return { status: 'error', resources: [], error: `render failed: ${String(msg).slice(0, 2000)}` };
    }
    const msg = e instanceof UpstreamError ? `render service answered ${e.status}` : `render service unreachable: ${(e as Error).message}`;
    return { status: 'unavailable', resources: [], error: msg };
  }
}

// ---------- schema (the Service API of the Portal repo) ----------

export type SchemaResult =
  | { status: 'valid' | 'invalid'; violations: Violation[]; version: string; source: string }
  | { status: 'unavailable'; violations: []; source: string; error: string }
  | { status: 'skipped'; violations: [] };

const schemaAjv = new Ajv({ allErrors: true, strict: false, useDefaults: false, coerceTypes: false, validateFormats: false });
const compiled = new WeakMap<object, ValidateFunction>();

/** The policy id of schema violations (they deny the request like a Rego rule). */
export const SCHEMA_POLICY = 'service-schema';

/**
 * `spec` of a Service manifest against the `openAPIV3Schema.properties.spec` of the Service schema (XRD or plain schema
 * file): the limits the API server / CI would enforce (owner ≤ 20 characters, enums, patterns…), reported before the
 * commit. Kubernetes extensions (`x-kubernetes-*`) are ignored; defaults are not applied.
 */
export function schemaViolations(spec: JsonSchema, manifest: ServiceManifest): Violation[] {
  let validate = compiled.get(spec);
  if (!validate) {
    validate = schemaAjv.compile(spec as object);
    compiled.set(spec, validate);
  }
  if (validate(manifest.spec ?? {})) return [];
  return (validate.errors ?? []).map((e) => {
    const missing = (e.params as { missingProperty?: string }).missingProperty;
    const where = `spec${e.instancePath.replaceAll('/', '.')}${missing ? `.${missing}` : ''}`;
    const allowed = (e.params as { allowedValues?: unknown[] }).allowedValues;
    return { policy: SCHEMA_POLICY, msg: `${where}: ${e.message}${allowed ? ` (${allowed.map(String).join(', ')})` : ''}` };
  });
}

/** Load the schema (cached like the form's, see xrd.ts) and validate the manifest. Never throws. */
export async function checkSchema(source: XrdFormSource | null, manifest: ServiceManifest, waitMs = 5000): Promise<SchemaResult> {
  if (!source) return { status: 'skipped', violations: [] };
  const where = describeSource(source);
  try {
    const e = await loadXrd(source, waitMs);
    if (!e.schema) return { status: 'unavailable', violations: [], source: where, error: e.error ?? 'schema not loaded yet' };
    const violations = schemaViolations(e.schema.spec, manifest);
    return { status: violations.length ? 'invalid' : 'valid', violations, version: e.schema.version, source: where };
  } catch (err) {
    return { status: 'unavailable', violations: [], source: where, error: (err as Error).message };
  }
}
