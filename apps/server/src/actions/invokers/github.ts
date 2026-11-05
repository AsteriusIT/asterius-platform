import { http } from '../../lib/http.js';
import { requireFields, str, stringValues, type InvokeResult, type Invoker } from '../types.js';

/**
 * GitHub Actions `workflow_dispatch`. The dispatch asks for run details (`return_run_details`), so the run is
 * tracked by id; on GitHub servers that do not return it, the latest dispatched run of the workflow is looked up.
 * Workflows may also report richer status through the callback API (`run.callback` input).
 */
const api = (c: Record<string, unknown>) => str(c.apiUrl || 'https://api.github.com').replace(/\/$/, '');
const headers = (c: Record<string, unknown>) => ({
  authorization: `Bearer ${str(c.token)}`,
  accept: 'application/vnd.github+json',
  'x-github-api-version': '2022-11-28',
});
const repoPath = (c: Record<string, unknown>) => `${api(c)}/repos/${encodeURIComponent(str(c.owner))}/${encodeURIComponent(str(c.repo))}`;

interface WorkflowRun {
  id: number;
  status: string;
  conclusion: string | null;
  html_url: string;
  created_at: string;
}

function fromRun(r: WorkflowRun): InvokeResult {
  const label = r.conclusion ? `${r.status} · ${r.conclusion}` : r.status;
  if (r.status !== 'completed') return { status: 'IN_PROGRESS', state: { runId: r.id }, link: r.html_url, statusLabel: label };
  return { status: r.conclusion === 'success' ? 'SUCCESS' : 'FAILURE', state: { runId: r.id }, link: r.html_url, statusLabel: label };
}

export const githubInvoker: Invoker = {
  info: {
    type: 'github-workflow',
    title: 'GitHub Actions workflow',
    description: 'Dispatch a workflow (workflow_dispatch) and follow its run.',
    fields: [
      { key: 'owner', label: 'Owner', kind: 'text', required: true, placeholder: 'my-org' },
      { key: 'repo', label: 'Repository', kind: 'text', required: true },
      { key: 'workflow', label: 'Workflow file', kind: 'text', required: true, placeholder: 'scaffold.yml' },
      { key: 'ref', label: 'Branch / ref', kind: 'text', placeholder: 'main' },
      { key: 'token', label: 'Token', kind: 'secret', required: true, help: 'Actions: write on the repository' },
      { key: 'inputs', label: 'Workflow inputs', kind: 'keyvalue', help: 'Must match the on.workflow_dispatch.inputs of the workflow' },
      { key: 'apiUrl', label: 'API URL', kind: 'text', placeholder: 'https://api.github.com', help: 'GitHub Enterprise Server', advanced: true },
    ],
    example: {
      type: 'github-workflow',
      owner: 'my-org',
      repo: 'platform-automation',
      workflow: 'scaffold-service.yml',
      ref: 'main',
      token: '${secret:GITHUB_TOKEN}',
      inputs: { name: '{{ inputs.name }}', language: '{{ inputs.language }}', asterius_run: '{{ $string(run) }}' },
    },
  },
  validate: (c) => requireFields(c, ['owner', 'repo', 'workflow', 'token'], 'github-workflow'),
  async start({ config, log }) {
    const ref = str(config.ref || 'main');
    const startedAt = new Date(Date.now() - 5_000).toISOString();
    await log(`Dispatching ${config.owner}/${config.repo} ${config.workflow} on ${ref}`);
    const res = await http<{ workflow_run_id?: number; html_url?: string }>(
      `${repoPath(config)}/actions/workflows/${encodeURIComponent(str(config.workflow))}/dispatches`,
      { method: 'POST', headers: headers(config), body: { ref, inputs: stringValues(config.inputs), return_run_details: true } },
    );
    if (res.data && typeof res.data === 'object' && res.data.workflow_run_id) {
      await log(`Workflow run ${res.data.workflow_run_id} created`);
      return { status: 'IN_PROGRESS', state: { runId: res.data.workflow_run_id }, link: res.data.html_url, statusLabel: 'queued' };
    }
    return { status: 'IN_PROGRESS', state: { since: startedAt, ref }, statusLabel: 'dispatched' };
  },
  async poll({ config, log }, state) {
    if (!state.runId) {
      const q = new URLSearchParams({ event: 'workflow_dispatch', branch: str(state.ref), created: `>=${str(state.since)}`, per_page: '1' });
      const list = await http<{ workflow_runs: WorkflowRun[] }>(`${repoPath(config)}/actions/workflows/${encodeURIComponent(str(config.workflow))}/runs?${q}`, {
        headers: headers(config),
      });
      const found = list.data.workflow_runs?.[0];
      if (!found) return { status: 'IN_PROGRESS', state, statusLabel: 'waiting for the workflow run' };
      await log(`Workflow run ${found.id} found`);
      return fromRun(found);
    }
    const r = await http<WorkflowRun>(`${repoPath(config)}/actions/runs/${state.runId}`, { headers: headers(config) });
    const out = fromRun(r.data);
    if (out.status !== 'IN_PROGRESS') await log(`Workflow run finished: ${r.data.conclusion}`, out.status === 'SUCCESS' ? 'info' : 'error');
    return out;
  },
  async cancel({ config }, state) {
    if (state.runId) await http(`${repoPath(config)}/actions/runs/${state.runId}/cancel`, { method: 'POST', headers: headers(config) });
  },
};
