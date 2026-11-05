import { http } from '../../lib/http.js';
import { requireFields, str, stringValues, type InvokeResult, type Invoker } from '../types.js';

/** GitLab CI: create a pipeline with variables and follow it. */
const project = (c: Record<string, unknown>) =>
  `${str(c.baseUrl || 'https://gitlab.com').replace(/\/$/, '')}/api/v4/projects/${encodeURIComponent(str(c.project))}`;
const headers = (c: Record<string, unknown>) => ({ 'private-token': str(c.token) });

interface Pipeline {
  id: number;
  status: string;
  web_url: string;
}

const RUNNING = new Set(['created', 'waiting_for_resource', 'preparing', 'pending', 'running', 'scheduled', 'manual']);

function fromPipeline(p: Pipeline): InvokeResult {
  const base = { state: { pipelineId: p.id }, link: p.web_url, statusLabel: p.status };
  if (RUNNING.has(p.status)) return { status: 'IN_PROGRESS', ...base };
  return { status: p.status === 'success' ? 'SUCCESS' : 'FAILURE', ...base };
}

export const gitlabInvoker: Invoker = {
  info: {
    type: 'gitlab-pipeline',
    title: 'GitLab CI pipeline',
    description: 'Create a GitLab pipeline with variables and follow it.',
    fields: [
      { key: 'project', label: 'Project', kind: 'text', required: true, placeholder: 'group/project or numeric id' },
      { key: 'ref', label: 'Branch / ref', kind: 'text', placeholder: 'main' },
      { key: 'token', label: 'Token', kind: 'secret', required: true, help: 'api scope' },
      { key: 'variables', label: 'Variables', kind: 'keyvalue' },
      { key: 'baseUrl', label: 'GitLab URL', kind: 'text', placeholder: 'https://gitlab.com', advanced: true },
    ],
    example: {
      type: 'gitlab-pipeline',
      baseUrl: 'https://gitlab.com',
      project: 'my-group/infrastructure',
      ref: 'main',
      token: '${secret:GITLAB_TOKEN}',
      variables: { SERVICE: '{{ entity.identifier }}', ENVIRONMENT: '{{ inputs.environment }}' },
    },
  },
  validate: (c) => requireFields(c, ['project', 'token'], 'gitlab-pipeline'),
  async start({ config, log }) {
    const ref = str(config.ref || 'main');
    await log(`Creating pipeline for ${config.project} on ${ref}`);
    const variables = Object.entries(stringValues(config.variables)).map(([key, value]) => ({ key, value }));
    const res = await http<Pipeline>(`${project(config)}/pipeline`, { method: 'POST', headers: headers(config), body: { ref, variables } });
    await log(`Pipeline ${res.data.id} created`);
    return fromPipeline(res.data);
  },
  async poll({ config, log }, state) {
    const r = await http<Pipeline>(`${project(config)}/pipelines/${state.pipelineId}`, { headers: headers(config) });
    const out = fromPipeline(r.data);
    if (out.status !== 'IN_PROGRESS') await log(`Pipeline finished: ${r.data.status}`, out.status === 'SUCCESS' ? 'info' : 'error');
    return out;
  },
  async cancel({ config }, state) {
    await http(`${project(config)}/pipelines/${state.pipelineId}/cancel`, { method: 'POST', headers: headers(config) });
  },
};
