import { emitJobLog, type LogFn } from '../../lib/ci-logs.js';
import { http, UpstreamError } from '../../lib/http.js';
import { adoAuth, adoBase } from './ado.js';
import { str, stringValues, type InvokeResult, type Invoker } from '../types.js';

/** Azure DevOps Pipelines: queue a run (Pipelines REST API 7.1) and follow it. */
const base = adoBase;
const auth = adoAuth;

interface PipelineRun {
  id: number;
  state: 'unknown' | 'inProgress' | 'canceling' | 'completed';
  result?: 'succeeded' | 'failed' | 'canceled' | 'unknown';
  _links?: { web?: { href?: string } };
}

// ---------- pipeline reference: id, or name (resolved and cached) ----------

/** `pipelineId: 42`, `pipelineId: "42"`, or a name in `pipeline` (or a non-numeric `pipelineId`), optionally `\folder\name`. */
export function pipelineRef(c: Record<string, unknown>): { id: number } | { name: string } {
  const raw = c.pipelineId !== undefined && c.pipelineId !== '' && c.pipelineId !== null ? c.pipelineId : c.pipeline;
  const s = str(raw).trim();
  if (/^\d+$/.test(s) && Number(s) > 0) return { id: Number(s) };
  if (!s) throw new Error('azure-pipeline invoker: set pipelineId (number) or pipeline (name)');
  return { name: s };
}

const NAME_TTL_MS = 10 * 60_000;
const nameCache = new Map<string, { id: number; at: number }>();
/** Drop cached name → id lookups (tests; a pipeline recreated under the same name). */
export const clearPipelineCache = () => nameCache.clear();

interface Definition {
  id: number;
  name: string;
  path?: string;
}

/**
 * The pipeline (= build definition) id of a name: `GET _apis/build/definitions?name=<name>`, cached 10 minutes per
 * organization / project / name. A `\folder\name` reference also matches the folder; a bare name must be unique.
 */
export async function resolvePipelineId(c: Record<string, unknown>, opts: { refresh?: boolean } = {}): Promise<number> {
  const ref = pipelineRef(c);
  if ('id' in ref) return ref.id;
  const key = `${base(c)}|${ref.name.toLowerCase()}`;
  const hit = nameCache.get(key);
  if (hit && !opts.refresh && Date.now() - hit.at < NAME_TTL_MS) return hit.id;
  const slash = ref.name.lastIndexOf('\\');
  const name = slash >= 0 ? ref.name.slice(slash + 1) : ref.name;
  const folder = slash > 0 ? ref.name.slice(0, slash) : slash === 0 ? '\\' : undefined;
  const res = await http<{ value?: Definition[] }>(`${base(c)}/_apis/build/definitions?name=${encodeURIComponent(name)}&api-version=7.1`, {
    headers: auth(c),
  });
  const norm = (p?: string) => (p ?? '\\').replace(/\\+$/, '').toLowerCase() || '\\';
  const found = (res.data.value ?? []).filter((d) => d.name.toLowerCase() === name.toLowerCase() && (folder === undefined || norm(d.path) === norm(folder)));
  if (!found.length) throw new Error(`azure-pipeline: no pipeline named "${ref.name}" in project ${str(c.project)}`);
  if (found.length > 1)
    throw new Error(
      `azure-pipeline: ${found.length} pipelines are named "${name}" in project ${str(c.project)} (${found.map((d) => `${d.path ?? '\\'}\\${d.name}`).join(', ')}): use "\\folder\\name" or pipelineId`,
    );
  nameCache.set(key, { id: found[0]!.id, at: Date.now() });
  return found[0]!.id;
}

/** The pipeline id of a started run: kept in the step state (older states only hold `runId`). */
const idOf = async (c: Record<string, unknown>, state: Record<string, unknown>) =>
  typeof state.pipelineId === 'number' ? state.pipelineId : resolvePipelineId(c);

function fromRun(r: PipelineRun, c: Record<string, unknown>, pipelineId: number): InvokeResult {
  const link = r._links?.web?.href;
  const label = r.result ? `${r.state} · ${r.result}` : r.state;
  const state = { runId: r.id, pipelineId };
  if (r.state !== 'completed') return { status: 'IN_PROGRESS', state, link, statusLabel: label };
  // Output for later steps, e.g. {{ steps.<id>.output.organization }} to build URLs in a catalog step.
  const result = { runId: r.id, result: r.result, url: link, organization: str(c.organization).replace(/\/$/, ''), project: str(c.project), pipelineId };
  return { status: r.result === 'succeeded' ? 'SUCCESS' : 'FAILURE', state, link, statusLabel: label, result };
}

/** Copy the log files of a finished run (the last ones hold the failing steps) into the run log. */
async function copyRunLogs(config: Record<string, unknown>, pipelineId: number, runId: unknown, log: LogFn, failed: boolean) {
  try {
    const url = `${base(config)}/_apis/pipelines/${pipelineId}/runs/${runId}/logs`;
    const list = await http<{ logs: Array<{ id: number; lineCount?: number }> }>(`${url}?api-version=7.1`, { headers: auth(config) });
    for (const l of [...(list.data.logs ?? [])].filter((x) => (x.lineCount ?? 1) > 0).slice(-10)) {
      const meta = await http<{ signedContent?: { url: string } }>(`${url}/${l.id}?$expand=signedContent&api-version=7.1`, { headers: auth(config) });
      if (!meta.data.signedContent?.url) continue;
      const text = await http<string>(meta.data.signedContent.url, { headers: { accept: 'text/plain' } }); // pre-signed: no credentials
      await emitJobLog(log, `log ${l.id}`, text.text, failed, failed ? 100 : 20);
    }
  } catch (err) {
    await log(`Could not fetch the run logs: ${(err as Error).message}`, 'warn');
  }
}

/**
 * `outputs: { artifact, file }`: a JSON file published as a build artifact by the run (e.g. the V2 apply pipeline's
 * `outputs.json`), read once the run succeeded and exposed as `output.outputs`. Best effort: a missing artifact is a
 * warning, never a failure.
 */
async function readOutputs(config: Record<string, unknown>, runId: unknown, log: LogFn): Promise<unknown> {
  const o = config.outputs as { artifact?: string; file?: string } | undefined;
  if (!o?.artifact) return undefined;
  const file = (o.file || 'outputs.json').replace(/^\/+/, '');
  try {
    const meta = await http<{ resource?: { downloadUrl?: string } }>(
      `${base(config)}/_apis/build/builds/${runId}/artifacts?artifactName=${encodeURIComponent(o.artifact)}&api-version=7.1`,
      { headers: auth(config) },
    );
    const download = meta.data.resource?.downloadUrl;
    if (!download) throw new Error(`artifact "${o.artifact}" has no download URL`);
    // Same URL as the zip download, asking for one file of the artifact instead.
    const u = new URL(download);
    u.searchParams.set('$format', 'file');
    u.searchParams.set('subPath', `/${file}`);
    // The credential only goes to the organization's own host or Azure DevOps' artifact hosts.
    const trusted = u.origin === new URL(base(config)).origin || /(^|\.)(dev\.azure\.com|visualstudio\.com)$/i.test(u.hostname);
    const res = await http<unknown>(u.toString(), { headers: { ...(trusted ? auth(config) : {}), accept: 'application/json, application/octet-stream' } });
    const value = typeof res.data === 'string' ? JSON.parse(res.data) : res.data;
    await log(`Outputs read from artifact ${o.artifact}/${file}`);
    return value;
  } catch (err) {
    await log(`Could not read the run outputs (${o.artifact}/${file}): ${(err as Error).message}`, 'warn');
    return undefined;
  }
}

export const azurePipelinesInvoker: Invoker = {
  info: {
    type: 'azure-pipeline',
    title: 'Azure DevOps pipeline',
    description:
      'Queue an Azure Pipelines run with template parameters and follow it. The pipeline is referenced by id or by name. Output: { runId, result, url, organization, project, pipelineId, outputs? }.',
    fields: [
      { key: 'organization', label: 'Organization URL', kind: 'text', required: true, placeholder: 'https://dev.azure.com/my-org' },
      { key: 'project', label: 'Project', kind: 'text', required: true },
      { key: 'pipelineId', label: 'Pipeline id', kind: 'number', help: 'Or set the pipeline name below' },
      { key: 'pipeline', label: 'Pipeline name', kind: 'text', placeholder: 'deploy or \\folder\\deploy', help: 'Resolved to its id (cached 10 minutes)' },
      { key: 'branch', label: 'Branch', kind: 'text', placeholder: 'main' },
      { key: 'token', label: 'Token', kind: 'secret', required: true, help: 'PAT (Build: read & execute) or "Bearer <Entra token>"' },
      { key: 'templateParameters', label: 'Template parameters', kind: 'keyvalue' },
      { key: 'variables', label: 'Variables', kind: 'keyvalue', advanced: true },
      { key: 'logs', label: 'Copy run logs when finished', kind: 'boolean', advanced: true },
      {
        key: 'outputs',
        label: 'Outputs artifact ({ artifact, file })',
        kind: 'json',
        advanced: true,
        help: 'A JSON file of a build artifact, exposed as output.outputs',
      },
    ],
    example: {
      type: 'azure-pipeline',
      organization: 'https://dev.azure.com/my-org',
      project: 'Platform',
      pipeline: 'deploy-service',
      branch: 'main',
      token: '${secret:ADO_PAT}',
      templateParameters: { environment: '{{ inputs.environment }}', service: '{{ entity.identifier }}' },
      variables: { ASTERIUS_CALLBACK_URL: '{{ run.callback.url }}' },
    },
  },
  validate(c) {
    const missing = ['organization', 'project', 'token'].filter((f) => c[f] === undefined || c[f] === '');
    const noPipeline = (c.pipelineId === undefined || c.pipelineId === '') && (c.pipeline === undefined || c.pipeline === '');
    if (noPipeline) missing.push('pipelineId (or pipeline)');
    if (missing.length) throw new Error(`azure-pipeline invoker: missing ${missing.join(', ')}`);
  },
  async start({ config, log }) {
    const branch = str(config.branch || 'main');
    const ref = pipelineRef(config);
    const variables = Object.fromEntries(Object.entries(stringValues(config.variables)).map(([k, v]) => [k, { value: v, isSecret: false }]));
    const body = {
      resources: { repositories: { self: { refName: branch.startsWith('refs/') ? branch : `refs/heads/${branch}` } } },
      templateParameters: stringValues(config.templateParameters),
      variables,
    };
    const queue = async (id: number) =>
      http<PipelineRun>(`${base(config)}/_apis/pipelines/${id}/runs?api-version=7.1`, { method: 'POST', headers: auth(config), body, retry: false });
    let pipelineId = await resolvePipelineId(config);
    await log(`Queuing pipeline ${'name' in ref ? `${ref.name} (${pipelineId})` : pipelineId} in ${config.project} on ${branch}`);
    let res;
    try {
      res = await queue(pipelineId);
    } catch (err) {
      // A pipeline recreated under the same name has a new id: look it up again once.
      if (!('name' in ref) || !(err instanceof UpstreamError) || err.status !== 404) throw err;
      pipelineId = await resolvePipelineId(config, { refresh: true });
      res = await queue(pipelineId);
    }
    await log(`Pipeline run ${res.data.id} queued`);
    return fromRun(res.data, config, pipelineId);
  },
  async poll({ config, log }, state) {
    const pipelineId = await idOf(config, state);
    const r = await http<PipelineRun>(`${base(config)}/_apis/pipelines/${pipelineId}/runs/${state.runId}?api-version=7.1`, { headers: auth(config) });
    const out = fromRun(r.data, config, pipelineId);
    if (out.status !== 'IN_PROGRESS') {
      await log(`Pipeline run finished: ${r.data.result}`, out.status === 'SUCCESS' ? 'info' : 'error');
      if (config.logs !== false) await copyRunLogs(config, pipelineId, state.runId, log, out.status === 'FAILURE');
      if (out.status === 'SUCCESS') {
        const outputs = await readOutputs(config, state.runId, log);
        if (outputs !== undefined) out.result = { ...(out.result as object), outputs };
      }
    }
    return out;
  },
  async cancel({ config }, state) {
    await http(`${base(config)}/_apis/build/builds/${state.runId}?api-version=7.1`, { method: 'PATCH', headers: auth(config), body: { status: 'cancelling' } });
  },
};
