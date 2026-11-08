import { validateAuth } from '../../lib/auth.js';
import { http } from '../../lib/http.js';
import { requireFields, str, stringValues, type InvokeResult, type Invoker } from '../types.js';

/** Workflow engines and CI servers: Jenkins, Argo Workflows, Terraform Cloud. */

const trim = (u: unknown) => str(u).replace(/\/$/, '');
const basic = (user: unknown, token: unknown) => `Basic ${Buffer.from(`${str(user)}:${str(token)}`).toString('base64')}`;

// ---------- Jenkins ----------
const jenkinsHeaders = (c: Record<string, unknown>): Record<string, string> => (c.auth ? {} : { authorization: basic(c.user, c.token) });
const jobPath = (job: string) =>
  job
    .split('/')
    .filter(Boolean)
    .map((p) => `job/${encodeURIComponent(p)}`)
    .join('/');

export const jenkinsInvoker: Invoker = {
  info: {
    type: 'jenkins',
    title: 'Jenkins job',
    description: 'Trigger a Jenkins job with parameters, follow the queue item and the build.',
    fields: [
      { key: 'baseUrl', label: 'Jenkins URL', kind: 'text', required: true, placeholder: 'https://jenkins.example.com' },
      { key: 'job', label: 'Job', kind: 'text', required: true, placeholder: 'folder/my-job' },
      { key: 'user', label: 'User', kind: 'text' },
      { key: 'token', label: 'API token', kind: 'secret' },
      { key: 'parameters', label: 'Parameters', kind: 'keyvalue' },
    ],
    example: {
      type: 'jenkins',
      baseUrl: 'https://jenkins.example.com',
      job: 'platform/deploy',
      user: 'asterius',
      token: '${secret:JENKINS_TOKEN}',
      parameters: { SERVICE: '{{ entity.identifier }}' },
    },
  },
  validate(c) {
    requireFields(c, c.auth ? ['baseUrl', 'job'] : ['baseUrl', 'job', 'user', 'token'], 'jenkins');
    validateAuth(c.auth);
  },
  async start({ config, log }) {
    const params = stringValues(config.parameters);
    const hasParams = Object.keys(params).length > 0;
    const res = await http(`${trim(config.baseUrl)}/${jobPath(str(config.job))}/${hasParams ? 'buildWithParameters' : 'build'}`, {
      method: 'POST',
      headers: { ...jenkinsHeaders(config), 'content-type': 'application/x-www-form-urlencoded' },
      auth: config.auth,
      body: new URLSearchParams(params).toString(),
    });
    const queueUrl = res.headers.get('location');
    if (!queueUrl) throw new Error('jenkins: no queue location returned');
    await log(`Queued ${queueUrl}`);
    return { status: 'IN_PROGRESS', state: { queueUrl }, statusLabel: 'Queued' };
  },
  async poll({ config, log }, state): Promise<InvokeResult> {
    let buildUrl = state.buildUrl as string | undefined;
    if (!buildUrl) {
      const q = await http<{ cancelled?: boolean; executable?: { url: string } }>(`${trim(state.queueUrl)}/api/json`, {
        headers: jenkinsHeaders(config),
        auth: config.auth,
      });
      if (q.data.cancelled) return { status: 'FAILURE', state, statusLabel: 'Cancelled in the queue' };
      buildUrl = q.data.executable?.url;
      if (!buildUrl) return { status: 'IN_PROGRESS', state, statusLabel: 'Queued' };
      await log(`Build started: ${buildUrl}`);
    }
    const b = await http<{ building: boolean; result: string | null; url: string }>(`${trim(buildUrl)}/api/json?tree=building,result,url`, {
      headers: jenkinsHeaders(config),
      auth: config.auth,
    });
    const next = { ...state, buildUrl };
    if (b.data.building || !b.data.result) return { status: 'IN_PROGRESS', state: next, link: buildUrl, statusLabel: 'Building' };
    return { status: b.data.result === 'SUCCESS' ? 'SUCCESS' : 'FAILURE', state: next, link: buildUrl, statusLabel: b.data.result };
  },
};

// ---------- Argo Workflows ----------
const argoBase = (c: Record<string, unknown>) => `${trim(c.baseUrl)}/api/v1/workflows/${encodeURIComponent(str(c.namespace || 'argo'))}`;
const argoHeaders = (c: Record<string, unknown>): Record<string, string> => (c.token ? { authorization: `Bearer ${str(c.token)}` } : {});

export const argoWorkflowsInvoker: Invoker = {
  info: {
    type: 'argo-workflows',
    title: 'Argo Workflows',
    description: 'Submit a WorkflowTemplate and follow the workflow.',
    fields: [
      { key: 'baseUrl', label: 'Argo server URL', kind: 'text', required: true },
      { key: 'namespace', label: 'Namespace', kind: 'text', placeholder: 'argo' },
      { key: 'template', label: 'WorkflowTemplate', kind: 'text', required: true },
      { key: 'token', label: 'Token', kind: 'secret' },
      { key: 'parameters', label: 'Parameters', kind: 'keyvalue' },
      { key: 'labels', label: 'Workflow labels', kind: 'keyvalue', advanced: true },
    ],
    example: {
      type: 'argo-workflows',
      baseUrl: 'https://argo.example.com',
      namespace: 'argo',
      template: 'provision-database',
      token: '${secret:ARGO_TOKEN}',
      parameters: { name: '{{ inputs.name }}' },
    },
  },
  validate(c) {
    requireFields(c, ['baseUrl', 'template'], 'argo-workflows');
    validateAuth(c.auth);
  },
  async start({ config, log }) {
    const parameters = Object.entries(stringValues(config.parameters)).map(([k, v]) => `${k}=${v}`);
    // Labels on the Workflow (e.g. portal.asterius.io/run-id), as the submit API takes them: "k1=v1,k2=v2".
    const labels = Object.entries(stringValues(config.labels))
      .map(([k, v]) => `${k}=${v}`)
      .join(',');
    const res = await http<{ metadata: { name: string } }>(`${argoBase(config)}/submit`, {
      method: 'POST',
      headers: argoHeaders(config),
      auth: config.auth,
      body: {
        namespace: str(config.namespace || 'argo'),
        resourceKind: 'WorkflowTemplate',
        resourceName: str(config.template),
        submitOptions: { parameters, ...(labels ? { labels } : {}) },
      },
    });
    const name = res.data.metadata.name;
    await log(`Workflow ${name} submitted`);
    return { status: 'IN_PROGRESS', state: { name }, link: `${trim(config.baseUrl)}/workflows/${str(config.namespace || 'argo')}/${name}` };
  },
  async poll({ config, log }, state): Promise<InvokeResult> {
    const w = await http<{ status?: { phase?: string; message?: string } }>(`${argoBase(config)}/${encodeURIComponent(str(state.name))}`, {
      headers: argoHeaders(config),
      auth: config.auth,
    });
    const phase = w.data.status?.phase ?? 'Pending';
    const link = `${trim(config.baseUrl)}/workflows/${str(config.namespace || 'argo')}/${str(state.name)}`;
    if (phase === 'Succeeded') return { status: 'SUCCESS', state, link, statusLabel: phase };
    if (phase === 'Failed' || phase === 'Error') {
      await log(w.data.status?.message ?? phase, 'error');
      return { status: 'FAILURE', state, link, statusLabel: phase };
    }
    return { status: 'IN_PROGRESS', state, link, statusLabel: phase };
  },
  async cancel({ config }, state) {
    await http(`${argoBase(config)}/${encodeURIComponent(str(state.name))}/stop`, { method: 'PUT', headers: argoHeaders(config), auth: config.auth, body: {} });
  },
};

// ---------- Terraform Cloud ----------
const tfcBase = (c: Record<string, unknown>) => `${trim(c.baseUrl || 'https://app.terraform.io')}/api/v2`;
const tfcHeaders = (c: Record<string, unknown>): Record<string, string> => ({
  authorization: `Bearer ${str(c.token)}`,
  'content-type': 'application/vnd.api+json',
  accept: 'application/vnd.api+json',
});

const TFC_OK = new Set(['applied', 'planned_and_finished', 'policy_checked']);
const TFC_FAIL = new Set(['errored', 'canceled', 'discarded', 'force_canceled']);

export const terraformCloudInvoker: Invoker = {
  info: {
    type: 'terraform-cloud',
    title: 'Terraform Cloud run',
    description: 'Queue a run on a workspace: plan only, or plan and apply (auto-apply or after confirmation).',
    fields: [
      { key: 'workspaceId', label: 'Workspace id', kind: 'text', required: true, placeholder: 'ws-…' },
      { key: 'token', label: 'API token', kind: 'secret', required: true },
      { key: 'mode', label: 'Mode', kind: 'select', options: ['plan', 'apply'], help: 'plan: succeeds once planned · apply: applies (auto)' },
      { key: 'message', label: 'Run message', kind: 'text' },
      { key: 'variables', label: 'Variables (workspace variables are not changed)', kind: 'keyvalue', advanced: true },
      { key: 'baseUrl', label: 'Terraform Enterprise URL', kind: 'text', advanced: true },
    ],
    example: {
      type: 'terraform-cloud',
      workspaceId: 'ws-abc123',
      token: '${secret:TFC_TOKEN}',
      mode: 'apply',
      message: 'Requested by {{ trigger.user.email }}',
    },
  },
  validate(c) {
    requireFields(c, ['workspaceId', 'token'], 'terraform-cloud');
    if (c.mode && !['plan', 'apply'].includes(str(c.mode))) throw new Error('terraform-cloud: mode is plan or apply');
  },
  async start({ config, log }) {
    const apply = str(config.mode || 'plan') === 'apply';
    const res = await http<{ data: { id: string } }>(`${tfcBase(config)}/runs`, {
      method: 'POST',
      headers: tfcHeaders(config),
      body: {
        data: {
          type: 'runs',
          attributes: { message: str(config.message || 'Triggered by Asterius'), 'auto-apply': apply, 'plan-only': !apply },
          relationships: { workspace: { data: { type: 'workspaces', id: str(config.workspaceId) } } },
        },
      },
    });
    await log(`Run ${res.data.data.id} queued (${apply ? 'plan and apply' : 'plan only'})`);
    return { status: 'IN_PROGRESS', state: { runId: res.data.data.id }, statusLabel: 'pending' };
  },
  async poll({ config, log }, state): Promise<InvokeResult> {
    const r = await http<{ data: { attributes: { status: string } } }>(`${tfcBase(config)}/runs/${encodeURIComponent(str(state.runId))}`, {
      headers: tfcHeaders(config),
    });
    const status = r.data.data.attributes.status;
    const link = `${trim(config.baseUrl || 'https://app.terraform.io')}/app/runs/${str(state.runId)}`;
    if (TFC_OK.has(status)) return { status: 'SUCCESS', state, link, statusLabel: status };
    if (TFC_FAIL.has(status)) {
      await log(`Run ${status}`, 'error');
      return { status: 'FAILURE', state, link, statusLabel: status };
    }
    return { status: 'IN_PROGRESS', state, link, statusLabel: status };
  },
  async cancel({ config }, state) {
    await http(`${tfcBase(config)}/runs/${encodeURIComponent(str(state.runId))}/actions/cancel`, { method: 'POST', headers: tfcHeaders(config), body: {} });
  },
};
