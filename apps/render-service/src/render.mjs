// Pure helpers of the render service: load the composition bundle, select the Composition and its Functions,
// and turn `crossplane render` output into the preview contract (docs/V2-KIND.md "Render service").
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import YAML from 'yaml';

export const DEV_RUNTIME = 'render.crossplane.io/runtime';
export const DEV_TARGET = 'render.crossplane.io/runtime-development-target';
export const RESOURCE_NAME = 'crossplane.io/composition-resource-name';
export const EXTERNAL_NAME = 'crossplane.io/external-name';

/** Every YAML document of the bundle directory (a mounted ConfigMap: `..data` symlinks are skipped, keys are files). */
export async function loadBundle(dir) {
  const docs = [];
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (e) {
    if (e.code === 'ENOENT') return { docs, files: [] };
    throw e;
  }
  const files = [];
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (e.name.startsWith('.') || !/\.(ya?ml|json)$/i.test(e.name)) continue;
    const file = path.join(dir, e.name);
    const stat = await fs.stat(file).catch(() => null);
    if (!stat?.isFile()) continue;
    files.push(e.name);
    for (const d of YAML.parseAllDocuments(await fs.readFile(file, 'utf8'))) {
      const o = d.toJS();
      if (o && typeof o === 'object' && o.kind) docs.push({ ...o, __file: e.name });
    }
  }
  return { docs, files };
}

const strip = ({ __file: _file, ...o }) => o;

export const compositions = (docs) => docs.filter((d) => d.kind === 'Composition');
export const functions = (docs) => docs.filter((d) => d.kind === 'Function' && String(d.apiVersion ?? '').startsWith('pkg.crossplane.io/'));
export const xrds = (docs) => docs.filter((d) => d.kind === 'CompositeResourceDefinition');

/** `xpkg.crossplane.io/crossplane-contrib/function-go-templating:v0.13.2` → `function-go-templating`. */
export const packageName = (f) =>
  String(f?.spec?.package ?? '')
    .split('/')
    .pop()
    .split(/[@:]/)[0];

/**
 * Development targets of the function sidecars: an explicit `FUNCTION_TARGETS` entry (`key=host:port,…`, the key
 * being the Function name or its package name, so `function-go-templating` matches a Function named
 * `crossplane-contrib-function-go-templating`), else the annotation already on the Function, else
 * `localhost:<basePort + index>` in the order of the bundle's Functions (sorted by name).
 */
export function functionTargets(fns, env = process.env) {
  const explicit = Object.fromEntries(
    String(env.FUNCTION_TARGETS ?? '')
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean)
      .map((p) => p.split('=').map((x) => x.trim())),
  );
  const base = Number(env.FUNCTION_BASE_PORT ?? 9443);
  const names = [...new Set(fns.map((f) => f.metadata?.name))].filter(Boolean).sort();
  return Object.fromEntries(
    names.map((n, i) => {
      const f = fns.find((x) => x.metadata?.name === n);
      return [n, explicit[n] ?? explicit[packageName(f)] ?? f?.metadata?.annotations?.[DEV_TARGET] ?? `localhost:${base + i}`];
    }),
  );
}

export class RenderError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

/** Validate the XR and pick its Composition, the Functions of its pipeline and the XRD of its kind. */
export function selectInputs(bundle, service, env = process.env) {
  if (!service || typeof service !== 'object' || !service.kind || !service.apiVersion || !service.metadata?.name)
    throw new RenderError(400, 'body.service must be a manifest (apiVersion, kind, metadata.name)');
  const ref = service.spec?.crossplane?.compositionRef?.name;
  if (!ref) throw new RenderError(400, 'spec.crossplane.compositionRef.name is required');
  const all = compositions(bundle.docs);
  if (!all.length) throw new RenderError(503, 'no Composition loaded yet (ConfigMap portal-compositions empty or not mounted)');
  const composition = all.find((c) => c.metadata?.name === ref);
  if (!composition) throw new RenderError(422, `Composition "${ref}" not found (available: ${all.map((c) => c.metadata?.name).join(', ')})`);
  if ((composition.spec?.mode ?? 'Pipeline') !== 'Pipeline') throw new RenderError(422, `Composition "${ref}" is not mode: Pipeline`);
  const needed = [...new Set((composition.spec?.pipeline ?? []).map((s) => s.functionRef?.name).filter(Boolean))];
  const fns = functions(bundle.docs);
  const missing = needed.filter((n) => !fns.some((f) => f.metadata?.name === n));
  if (missing.length) throw new RenderError(422, `Function(s) ${missing.join(', ')} used by "${ref}" are not in the bundle`);
  const targets = functionTargets(fns, env);
  const selected = needed.map((n) => {
    const f = strip(fns.find((x) => x.metadata?.name === n));
    return { ...f, metadata: { ...f.metadata, annotations: { ...f.metadata?.annotations, [DEV_RUNTIME]: 'Development', [DEV_TARGET]: targets[n] } } };
  });
  const [group] = String(service.apiVersion).split('/');
  const xrd = xrds(bundle.docs).find((x) => x.spec?.group === group && x.spec?.names?.kind === service.kind);
  return { composition: strip(composition), functions: selected, xrd: xrd ? strip(xrd) : null };
}

/** `crossplane render` stdout → `{resources, raw, results}`. The first document of the kind of the XR is the XR. */
export function parseRenderOutput(stdout, xr) {
  const raw = YAML.parseAllDocuments(stdout)
    .map((d) => d.toJS())
    .filter((o) => o && typeof o === 'object');
  const isXr = (o) => o.kind === xr.kind && o.apiVersion === xr.apiVersion && (o.metadata?.name ?? xr.metadata.name) === xr.metadata.name;
  const results = raw.filter((o) => o.kind === 'Result' && String(o.apiVersion ?? '').startsWith('render.crossplane.io'));
  const resources = raw
    .filter((o) => !isXr(o) && !results.includes(o) && o.kind !== 'Context')
    .map((o) => {
      const ann = o.metadata?.annotations ?? {};
      return {
        apiVersion: o.apiVersion,
        kind: o.kind,
        name: o.metadata?.name ?? ann[RESOURCE_NAME] ?? o.metadata?.generateName ?? '',
        externalName: ann[EXTERNAL_NAME] ?? null,
        ...(ann[RESOURCE_NAME] ? { resourceName: ann[RESOURCE_NAME] } : {}),
      };
    });
  return { resources, raw, results };
}

export const toYamlStream = (docs) => docs.map((d) => YAML.stringify(d, { lineWidth: 0 })).join('---\n');
