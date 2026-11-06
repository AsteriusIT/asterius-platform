import { emitJobLog, type LogFn } from '../../lib/ci-logs.js';
import { http } from '../../lib/http.js';
import { requireFields, str, stringValues, type InvokeResult, type Invoker } from '../types.js';

/** Azure DevOps Pipelines: queue a run (Pipelines REST API 7.1) and follow it. */
const base = (c: Record<string, unknown>) => `${str(c.organization).replace(/\/$/, '')}/${encodeURIComponent(str(c.project))}`;
const auth = (c: Record<string, unknown>) => {
  const t = str(c.token);
  // A PAT (Basic) or an Entra access token for a service principal / managed identity (Bearer).
  return { authorization: t.startsWith('Bearer ') ? t : `Basic ${Buffer.from(`:${t}`).toString('base64')}` };
};

interface PipelineRun {
  id: number;
  state: 'unknown' | 'inProgress' | 'canceling' | 'completed';
  result?: 'succeeded' | 'failed' | 'canceled' | 'unknown';
  _links?: { web?: { href?: string } };
}

function fromRun(r: PipelineRun, c: Record<string, unknown>): InvokeResult {
  const link = r._links?.web?.href;
  const label = r.result ? `${r.state} · ${r.result}` : r.state;
  if (r.state !== 'completed') return { status: 'IN_PROGRESS', state: { runId: r.id }, link, statusLabel: label };
  // Output for later steps, e.g. {{ steps.<id>.output.organization }} to build URLs in a catalog step.
  const result = { runId: r.id, result: r.result, url: link, organization: str(c.organization).replace(/\/$/, ''), project: str(c.project) };
  return { status: r.result === 'succeeded' ? 'SUCCESS' : 'FAILURE', state: { runId: r.id }, link, statusLabel: label, result };
}

/** Copy the log files of a finished run (the last ones hold the failing steps) into the run log. */
async function copyRunLogs(config: Record<string, unknown>, runId: unknown, log: LogFn, failed: boolean) {
  try {
    const url = `${base(config)}/_apis/pipelines/${config.pipelineId}/runs/${runId}/logs`;
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

export const azurePipelinesInvoker: Invoker = {
  info: {
    type: 'azure-pipeline',
    title: 'Azure DevOps pipeline',
    description: 'Queue an Azure Pipelines run with template parameters and follow it. Output: { runId, result, url, organization, project }.',
    fields: [
      { key: 'organization', label: 'Organization URL', kind: 'text', required: true, placeholder: 'https://dev.azure.com/my-org' },
      { key: 'project', label: 'Project', kind: 'text', required: true },
      { key: 'pipelineId', label: 'Pipeline id', kind: 'number', required: true },
      { key: 'branch', label: 'Branch', kind: 'text', placeholder: 'main' },
      { key: 'token', label: 'Token', kind: 'secret', required: true, help: 'PAT (Build: read & execute) or "Bearer <Entra token>"' },
      { key: 'templateParameters', label: 'Template parameters', kind: 'keyvalue' },
      { key: 'variables', label: 'Variables', kind: 'keyvalue', advanced: true },
      { key: 'logs', label: 'Copy run logs when finished', kind: 'boolean', advanced: true },
    ],
    example: {
      type: 'azure-pipeline',
      organization: 'https://dev.azure.com/my-org',
      project: 'Platform',
      pipelineId: 42,
      branch: 'main',
      token: '${secret:ADO_PAT}',
      templateParameters: { environment: '{{ inputs.environment }}', service: '{{ entity.identifier }}' },
      variables: { ASTERIUS_CALLBACK_URL: '{{ run.callback.url }}' },
    },
  },
  validate: (c) => requireFields(c, ['organization', 'project', 'pipelineId', 'token'], 'azure-pipeline'),
  async start({ config, log }) {
    const branch = str(config.branch || 'main');
    await log(`Queuing pipeline ${config.pipelineId} in ${config.project} on ${branch}`);
    const variables = Object.fromEntries(Object.entries(stringValues(config.variables)).map(([k, v]) => [k, { value: v, isSecret: false }]));
    const res = await http<PipelineRun>(`${base(config)}/_apis/pipelines/${config.pipelineId}/runs?api-version=7.1`, {
      method: 'POST',
      headers: auth(config),
      body: {
        resources: { repositories: { self: { refName: branch.startsWith('refs/') ? branch : `refs/heads/${branch}` } } },
        templateParameters: stringValues(config.templateParameters),
        variables,
      },
    });
    await log(`Pipeline run ${res.data.id} queued`);
    return fromRun(res.data, config);
  },
  async poll({ config, log }, state) {
    const r = await http<PipelineRun>(`${base(config)}/_apis/pipelines/${config.pipelineId}/runs/${state.runId}?api-version=7.1`, { headers: auth(config) });
    const out = fromRun(r.data, config);
    if (out.status !== 'IN_PROGRESS') {
      await log(`Pipeline run finished: ${r.data.result}`, out.status === 'SUCCESS' ? 'info' : 'error');
      if (config.logs !== false) await copyRunLogs(config, state.runId, log, out.status === 'FAILURE');
    }
    return out;
  },
  async cancel({ config }, state) {
    await http(`${base(config)}/_apis/build/builds/${state.runId}?api-version=7.1`, { method: 'PATCH', headers: auth(config), body: { status: 'cancelling' } });
  },
};
