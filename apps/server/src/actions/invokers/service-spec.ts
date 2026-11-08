import { z } from 'zod';
import type { PluginField } from '@asterius/shared';
import { config as platform } from '../../config.js';
import { http } from '../../lib/http.js';
import { findEntity } from '../../catalog/entities.js';
import { checkSchema, evaluatePolicy, renderResources, type PolicyResult, type RenderResult, type SchemaResult } from '../../v2/checks.js';
import type { XrdFormSource } from '../../schemas.js';
import { commitOperation, previewState, serviceOpConfig, type OpContext } from '../../v2/service-ops.js';
import { OPERATIONS, type ServiceManifest } from '../../v2/spec.js';
import { requireFields, str, type InvokeResult, type Invoker, type RunContext } from '../types.js';
import { catalogInvoker } from './catalog.js';

/**
 * V2 write side (docs/V2-WRITE-SIDE.md):
 *  - `service-spec` writes the Service spec of a service to the Portal repo (create, update, pause / resume,
 *    golden-path upgrade, decommission) through the serialized commit queue;
 *  - `service-precheck` computes the same spec without writing it and evaluates it with OPA (and renders it with the
 *    render service): the run fails when a policy denies it, or when OPA cannot answer (fail closed).
 */

const opCtx = (ctx: RunContext): OpContext => ({ runId: ctx.run.id, user: ctx.trigger.user.email });

const isTemplate = (v: unknown) => typeof v === 'string' && (v.includes('{{') || v.includes('${'));

function staticChecks(c: Record<string, unknown>, type: string) {
  requireFields(c, ['repository', 'team', 'service'], type);
  if (c.operation !== undefined && !isTemplate(c.operation) && !OPERATIONS.includes(str(c.operation) as never))
    throw new Error(`${type} invoker: operation is one of ${OPERATIONS.join(', ')}`);
  if (c.operation === 'pause' && !c.pause) throw new Error(`${type} invoker: pause needs "pause: { until, reason }"`);
  if (c.operation === 'upgrade' && !c.goldenPath) throw new Error(`${type} invoker: upgrade needs "goldenPath: { version }"`);
}

const parseErr = (type: string, e: z.ZodError) => new Error(`${type}: ${e.issues.map((i) => `${i.path.join('.') || 'config'}: ${i.message}`).join('; ')}`);

const REPO_FIELDS: PluginField[] = [
  { key: 'repository', label: 'Portal repo URL', kind: 'text', required: true, placeholder: 'https://dev.azure.com/<org>/<project>/_git/<repo>' },
  { key: 'branch', label: 'Branch', kind: 'text', placeholder: 'main' },
  { key: 'token', label: 'Token (PAT or Bearer …)', kind: 'secret' },
  { key: 'operation', label: 'Operation', kind: 'select', options: OPERATIONS },
  { key: 'team', label: 'Team', kind: 'text', required: true, placeholder: '{{ inputs.team }}' },
  { key: 'service', label: 'Service', kind: 'text', required: true, placeholder: '{{ inputs.name }}' },
  { key: 'inputs', label: 'Spec inputs (create / update)', kind: 'json', help: '"{{ inputs }}": form values mapped to the spec' },
  { key: 'fields', label: 'Input → spec path mapping', kind: 'keyvalue', advanced: true },
  { key: 'pause', label: 'Pause ({ until, reason })', kind: 'json', advanced: true },
  { key: 'goldenPath', label: 'Upgrade target ({ name?, version })', kind: 'json', advanced: true },
  { key: 'requestedBy', label: 'On behalf of (email)', kind: 'text', advanced: true, placeholder: '{{ trigger.user.email }}' },
];

/** After a commit: ask Argo CD to refresh (it polls the repo every 30 s otherwise). Best effort. */
const argocdRefresh = z
  .object({ url: z.string().min(1), token: z.string().default(''), applications: z.array(z.string().min(1)).max(10).default([]) })
  .optional();

async function refreshArgo(cfg: z.infer<typeof argocdRefresh>, log: (m: string, l?: 'info' | 'warn' | 'error') => Promise<void>) {
  if (!cfg?.url || !cfg.applications.length) return;
  for (const app of cfg.applications) {
    try {
      await http(`${cfg.url.replace(/\/+$/, '')}/api/v1/applications/${encodeURIComponent(app)}?refresh=normal`, {
        headers: cfg.token ? { authorization: `Bearer ${cfg.token}` } : {},
        timeoutMs: 5000,
        retry: false,
      });
      await log(`Argo CD: refresh requested for ${app}`);
    } catch (e) {
      await log(`Argo CD refresh of ${app} failed (it polls the repo anyway): ${(e as Error).message}`, 'warn');
    }
  }
}

export const serviceSpecInvoker: Invoker = {
  info: {
    type: 'service-spec',
    title: 'Service spec (Portal repo)',
    description:
      'Commit the Service spec of a service to the Portal repo (Azure DevOps): create, update, pause / resume, golden-path upgrade, decommission. Serialized per branch, retried on push races.',
    fields: [...REPO_FIELDS, { key: 'argocd', label: 'Argo CD refresh ({ url, token, applications })', kind: 'json', advanced: true }],
    example: {
      type: 'service-spec',
      repository: 'https://dev.azure.com/AsteriusIT/Platform/_git/portal-resources',
      branch: 'main',
      token: '${env:ADO_PAT}',
      operation: 'create',
      team: '{{ inputs.team }}',
      service: '{{ inputs.name }}',
      inputs: '{{ inputs }}',
    },
  },
  validate(c) {
    staticChecks(c, 'service-spec');
  },
  async start({ ctx, config, log }): Promise<InvokeResult> {
    const parsed = serviceOpConfig.safeParse(config);
    if (!parsed.success) throw parseErr('service-spec', parsed.error);
    const c = parsed.data;
    const out = await commitOperation(c, opCtx(ctx), (m) => log(m, 'warn'));
    const argo = argocdRefresh.safeParse(config.argocd);
    if (!out.noop && argo.success) await refreshArgo(argo.data, log);
    await log(
      out.noop
        ? `${c.operation} ${c.team}/${c.service}: the Portal repo is already up to date (${out.commitId.slice(0, 8)})`
        : `${c.operation} ${c.team}/${c.service}: committed ${out.commitId.slice(0, 8)} (${out.specPath}${out.teamFileCreated ? ', with the team folder' : ''})`,
    );
    return { status: 'SUCCESS', link: out.commitUrl, statusLabel: out.noop ? 'Up to date' : `Committed ${out.commitId.slice(0, 8)}`, result: out };
  },
};

// ---------- pre-check ----------

export const precheckConfig = serviceOpConfig.extend({
  /** OPA base URL (`${env:OPA_URL}`). */
  opaUrl: z.string().default(''),
  /** Render service base URL (`${env:RENDER_URL}`); empty: no rendering. */
  renderUrl: z.string().default(''),
  /** Fail when the render service cannot render (default: the render is informative only). */
  requireRender: z.boolean().default(false),
  /** On a denied create, mark this entity `lifecycle: Rejected` (never a service that already exists in the catalog). */
  rejectEntity: z.object({ blueprint: z.string().min(1), identifier: z.string().min(1), team: z.string().optional() }).optional(),
  /**
   * Validate the spec against the Service schema (XRD or plain schema file, `openAPIV3Schema.properties.spec`):
   * `path` in the Portal repo (same repository, branch and token), or `url` / `file`. Violations deny the request
   * (policy `service-schema`); an unreadable schema is only a warning (OPA still decides).
   */
  schema: z
    .object({
      source: z.enum(['ado', 'url', 'file']).default('ado'),
      path: z.string().min(1).max(500).default('schema/service-xrd.yaml'),
      url: z.string().url().optional(),
      file: z.string().min(1).max(1000).optional(),
      kind: z.string().min(1).max(100).default('Service'),
      version: z.string().max(100).optional(),
      ttlSeconds: z.number().int().min(10).max(86_400).default(300),
    })
    .optional(),
});
export type PrecheckConfig = z.infer<typeof precheckConfig>;

export interface PrecheckOutput {
  allowed: boolean | null;
  operation: string;
  specPath: string;
  service: ServiceManifest | null;
  policy: PolicyResult;
  render: RenderResult;
  schema: SchemaResult;
  /** Set when the spec could not be computed (e.g. create over an existing service, decommission without the mark). */
  error?: string;
}

/** Compute the next spec and evaluate it; shared by the in-run step and the form preview. Never throws. */
export async function runPrecheck(c: PrecheckConfig, ctx: OpContext, opts: { render?: boolean } = {}): Promise<PrecheckOutput> {
  const base = { operation: c.operation, specPath: `services/team-${c.team}/${c.service}.yaml` };
  let manifest: ServiceManifest | null;
  try {
    manifest = (await previewState(c, ctx)).manifest;
  } catch (e) {
    const error = (e as Error).message;
    return {
      ...base,
      allowed: false,
      service: null,
      error,
      policy: { status: 'denied', allowed: false, violations: [{ policy: 'portal-spec', msg: error }] },
      render: { status: 'skipped', resources: [] },
      schema: { status: 'skipped', violations: [] },
    };
  }
  if (!manifest) {
    // Decommission of a file that is already gone: nothing to evaluate.
    return {
      ...base,
      allowed: true,
      service: null,
      policy: { status: 'allowed', allowed: true, violations: [] },
      render: { status: 'skipped', resources: [] },
      schema: { status: 'skipped', violations: [] },
    };
  }
  const doRender = (opts.render ?? true) && !!c.renderUrl && c.operation !== 'decommission' && c.operation !== 'mark-decommission';
  const [opa, render, schema] = await Promise.all([
    evaluatePolicy(c.opaUrl, manifest),
    doRender ? renderResources(c.renderUrl, manifest) : Promise.resolve<RenderResult>({ status: 'skipped', resources: [] }),
    checkSchema(schemaSourceOf(c), manifest),
  ]);
  // Schema violations deny the request like a policy (the API server / CI would refuse the spec anyway).
  const policy: PolicyResult =
    schema.violations.length > 0
      ? { status: 'denied', allowed: false, violations: [...schema.violations, ...(opa.status === 'unavailable' ? [] : opa.violations)] }
      : opa;
  return { ...base, allowed: policy.allowed, service: manifest, policy, render, schema };
}

/** The schema source of a pre-check: a file of the Portal repo read with the step's own repository, branch and token. */
export function schemaSourceOf(c: PrecheckConfig): XrdFormSource | null {
  const s = c.schema;
  if (!s) return null;
  return {
    source: s.source,
    repository: s.source === 'ado' ? c.repository : undefined,
    branch: c.branch,
    path: s.path,
    token: s.source === 'ado' ? c.token : undefined, // already resolved by the step rendering
    url: s.url,
    file: s.file,
    kind: s.kind,
    version: s.version,
    others: true,
    exclude: [],
    ttlSeconds: s.ttlSeconds,
  };
}

async function markRejected(ctx: RunContext, c: PrecheckConfig, log: (m: string, l?: 'info' | 'warn' | 'error') => Promise<void>) {
  const r = c.rejectEntity;
  if (!r || c.operation !== 'create') return;
  const existing = await findEntity(r.blueprint, r.identifier);
  const lifecycle = (existing?.properties as Record<string, unknown> | undefined)?.lifecycle;
  if (existing && lifecycle !== undefined && lifecycle !== 'Requested' && lifecycle !== 'Rejected') {
    await log(`${r.blueprint}/${r.identifier} already exists (${String(lifecycle)}): its lifecycle is left unchanged`, 'warn');
    return;
  }
  await catalogInvoker.start({
    ctx,
    log,
    config: {
      operation: 'upsert',
      blueprint: r.blueprint,
      identifier: r.identifier,
      ...(existing ? {} : { title: c.service, team: r.team }),
      properties: { lifecycle: 'Rejected', lastRunId: ctx.run.id },
      merge: true,
    },
  });
}

export const servicePrecheckInvoker: Invoker = {
  info: {
    type: 'service-precheck',
    title: 'Service pre-check (OPA + render)',
    description:
      'Compute the Service spec the run will commit, validate it against the Service schema, evaluate it with the shared Rego (OPA, fails closed) and preview it with the plan / render service. Also powers the form preview.',
    fields: [
      ...REPO_FIELDS,
      { key: 'opaUrl', label: 'OPA URL', kind: 'text', required: true, placeholder: '${env:OPA_URL}' },
      { key: 'renderUrl', label: 'Render service URL', kind: 'text', placeholder: '${env:RENDER_URL}' },
      { key: 'requireRender', label: 'Fail when the render fails', kind: 'boolean', advanced: true },
      { key: 'rejectEntity', label: 'Entity to mark Rejected ({ blueprint, identifier, team })', kind: 'json', advanced: true },
      { key: 'schema', label: 'Service schema ({ path } in the Portal repo, or { source: url, url })', kind: 'json', advanced: true },
    ],
    example: {
      type: 'service-precheck',
      repository: 'https://dev.azure.com/AsteriusIT/Platform/_git/portal-resources',
      token: '${env:ADO_PAT}',
      operation: 'create',
      team: '{{ inputs.team }}',
      service: '{{ inputs.name }}',
      inputs: '{{ inputs }}',
      opaUrl: '${env:OPA_URL}',
      renderUrl: '${env:RENDER_URL}',
      schema: { path: 'schema/service-xrd.yaml' },
      rejectEntity: { blueprint: 'platform-service', identifier: '{{ inputs.team }}/{{ inputs.name }}', team: '{{ inputs.team }}' },
    },
  },
  validate(c) {
    staticChecks(c, 'service-precheck');
    requireFields(c, ['opaUrl'], 'service-precheck');
  },
  async start({ ctx, config, log }): Promise<InvokeResult> {
    const parsed = precheckConfig.safeParse(config);
    if (!parsed.success) throw parseErr('service-precheck', parsed.error);
    const c = parsed.data;
    const out = await runPrecheck(c, opCtx(ctx));
    const link = `${platform.PUBLIC_URL}/runs/${ctx.run.id}`;
    if (out.render.status === 'ok')
      await log(
        `Preview: ${out.render.resources.length} resource(s): ${out.render.resources.map((r) => `${r.action ? `${r.action} ` : ''}${r.kind}/${r.name}`).join(', ')}`,
      );
    else if (out.render.status !== 'skipped') await log(`Preview ${out.render.status}: ${out.render.error}`, c.requireRender ? 'error' : 'warn');
    if (out.schema.status === 'unavailable') await log(`Schema check skipped: ${out.schema.error}`, 'warn');
    if (out.policy.status === 'unavailable' && out.schema.status !== 'invalid') {
      await log(`Policy check unavailable, failing closed: ${out.policy.error}`, 'error');
      return { status: 'FAILURE', statusLabel: 'Policy check unavailable', result: out, link };
    }
    if (!out.allowed) {
      for (const v of out.policy.violations) await log(`Denied by ${v.policy}: ${v.msg}`, 'error');
      await markRejected(ctx, c, log);
      return { status: 'FAILURE', statusLabel: `Rejected (${out.policy.violations.length} violation(s))`, result: out, link };
    }
    if (c.requireRender && out.render.status !== 'ok' && out.render.status !== 'skipped')
      return { status: 'FAILURE', statusLabel: 'Render failed', result: out, link };
    await log('Policies passed');
    return { status: 'SUCCESS', statusLabel: 'Allowed', result: out };
  },
};
