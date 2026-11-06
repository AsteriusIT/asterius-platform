import { validateAuth } from '../../lib/auth.js';
import { http, UpstreamError } from '../../lib/http.js';
import { requireFields, str, type InvokeResult, type Invoker } from '../types.js';

/** Cloud and ticketing services: Jira, AWS Lambda, AWS Step Functions. */

const trim = (u: unknown) => str(u).replace(/\/$/, '');

// ---------- Jira ----------
/** Atlassian Document Format paragraph(s) from plain text. */
const adf = (text: string) => ({
  type: 'doc',
  version: 1,
  content: text.split(/\n{2,}/).map((p) => ({ type: 'paragraph', content: [{ type: 'text', text: p || ' ' }] })),
});

export const jiraInvoker: Invoker = {
  info: {
    type: 'jira-issue',
    title: 'Jira issue',
    description: 'Create a Jira issue and link it to the run.',
    fields: [
      { key: 'baseUrl', label: 'Jira URL', kind: 'text', required: true, placeholder: 'https://acme.atlassian.net' },
      { key: 'email', label: 'Account email', kind: 'text', required: true },
      { key: 'token', label: 'API token', kind: 'secret', required: true },
      { key: 'project', label: 'Project key', kind: 'text', required: true },
      { key: 'issueType', label: 'Issue type', kind: 'text', placeholder: 'Task' },
      { key: 'summary', label: 'Summary', kind: 'text', required: true },
      { key: 'description', label: 'Description', kind: 'textarea' },
      { key: 'labels', label: 'Labels', kind: 'list' },
    ],
    example: {
      type: 'jira-issue',
      baseUrl: 'https://acme.atlassian.net',
      email: 'bot@acme.com',
      token: '${secret:JIRA_TOKEN}',
      project: 'PLAT',
      issueType: 'Task',
      summary: 'Provision {{ inputs.name }}',
      description: 'Requested by {{ trigger.user.email }}\n\nRun: {{ run.url }}',
    },
  },
  validate: (c) => requireFields(c, ['baseUrl', 'email', 'token', 'project', 'summary'], 'jira-issue'),
  async start({ config, log, ctx }) {
    const res = await http<{ key: string }>(`${trim(config.baseUrl)}/rest/api/3/issue`, {
      method: 'POST',
      headers: { authorization: `Basic ${Buffer.from(`${str(config.email)}:${str(config.token)}`).toString('base64')}` },
      body: {
        fields: {
          project: { key: str(config.project) },
          summary: str(config.summary).slice(0, 255),
          issuetype: { name: str(config.issueType || 'Task') },
          description: adf(str(config.description || `Created by Asterius run ${ctx.run.url}`)),
          ...(Array.isArray(config.labels) ? { labels: config.labels.map(String) } : {}),
        },
      },
    });
    const link = `${trim(config.baseUrl)}/browse/${res.data.key}`;
    await log(`Issue ${res.data.key} created`);
    return { status: 'SUCCESS', link, result: { key: res.data.key, url: link } };
  },
};

// ---------- AWS (SigV4 through the shared auth block) ----------
const awsAuth = (c: Record<string, unknown>, service: string) =>
  c.auth ?? { type: 'aws-sigv4', region: str(c.region), service, accessKeyId: c.accessKeyId, secretAccessKey: c.secretAccessKey, sessionToken: c.sessionToken };

const AWS_FIELDS = [
  { key: 'region', label: 'Region', kind: 'text' as const, required: true, placeholder: 'eu-west-1' },
  { key: 'accessKeyId', label: 'Access key id', kind: 'secret' as const, help: 'Empty: IRSA / web identity of the pod', advanced: true },
  { key: 'secretAccessKey', label: 'Secret access key', kind: 'secret' as const, advanced: true },
];

export const lambdaInvoker: Invoker = {
  info: {
    type: 'aws-lambda',
    title: 'AWS Lambda',
    description: 'Invoke a Lambda function synchronously with a JSON payload.',
    fields: [
      ...AWS_FIELDS,
      { key: 'function', label: 'Function name or ARN', kind: 'text', required: true },
      { key: 'payload', label: 'Payload', kind: 'json' },
    ],
    example: { type: 'aws-lambda', region: 'eu-west-1', function: 'provision-bucket', payload: { name: '{{ inputs.name }}' } },
  },
  validate(c) {
    requireFields(c, ['region', 'function'], 'aws-lambda');
    validateAuth(c.auth);
  },
  async start({ config, log }) {
    const endpoint = trim(config.endpoint || `https://lambda.${str(config.region)}.amazonaws.com`);
    const res = await http(`${endpoint}/2015-03-31/functions/${encodeURIComponent(str(config.function))}/invocations`, {
      method: 'POST',
      headers: { 'x-amz-invocation-type': 'RequestResponse' },
      auth: awsAuth(config, 'lambda'),
      body: JSON.stringify(config.payload ?? {}),
      retry: false, // an invocation is not idempotent
    });
    if (res.headers.get('x-amz-function-error')) {
      await log(`Function error: ${res.text.slice(0, 500)}`, 'error');
      return { status: 'FAILURE', statusLabel: res.headers.get('x-amz-function-error') ?? 'error', result: res.data };
    }
    await log(`Invoked (${res.status})`);
    return { status: 'SUCCESS', result: res.data };
  },
};

const sfn = (c: Record<string, unknown>, target: string, body: unknown) =>
  http<Record<string, unknown>>(trim(c.endpoint || `https://states.${str(c.region)}.amazonaws.com`) + '/', {
    method: 'POST',
    headers: { 'content-type': 'application/x-amz-json-1.0', 'x-amz-target': `AWSStepFunctions.${target}` },
    auth: awsAuth(c, 'states'),
    body: JSON.stringify(body),
    retry: target === 'StartExecution' ? false : undefined,
  });

export const stepFunctionsInvoker: Invoker = {
  info: {
    type: 'aws-step-functions',
    title: 'AWS Step Functions',
    description: 'Start a state machine execution and follow it.',
    fields: [
      ...AWS_FIELDS,
      { key: 'stateMachineArn', label: 'State machine ARN', kind: 'text', required: true },
      { key: 'input', label: 'Input', kind: 'json' },
    ],
    example: {
      type: 'aws-step-functions',
      region: 'eu-west-1',
      stateMachineArn: 'arn:aws:states:eu-west-1:123456789012:stateMachine:Provision',
      input: { name: '{{ inputs.name }}' },
    },
  },
  validate(c) {
    requireFields(c, ['region', 'stateMachineArn'], 'aws-step-functions');
    validateAuth(c.auth);
  },
  async start({ config, log }) {
    const res = await sfn(config, 'StartExecution', { stateMachineArn: str(config.stateMachineArn), input: JSON.stringify(config.input ?? {}) });
    await log(`Execution ${str(res.data.executionArn)} started`);
    return { status: 'IN_PROGRESS', state: { executionArn: res.data.executionArn }, statusLabel: 'RUNNING' };
  },
  async poll({ config, log }, state): Promise<InvokeResult> {
    const res = await sfn(config, 'DescribeExecution', { executionArn: state.executionArn });
    const status = str(res.data.status);
    if (status === 'RUNNING') return { status: 'IN_PROGRESS', state, statusLabel: status };
    if (status === 'SUCCEEDED') {
      let result: unknown = res.data.output;
      try {
        result = JSON.parse(str(res.data.output));
      } catch {
        /* keep the raw string */
      }
      return { status: 'SUCCESS', state, statusLabel: status, result };
    }
    await log(`${status}: ${str(res.data.cause || res.data.error)}`.slice(0, 500), 'error');
    return { status: 'FAILURE', state, statusLabel: status };
  },
  async cancel({ config }, state) {
    await sfn(config, 'StopExecution', { executionArn: state.executionArn, cause: 'Cancelled from Asterius' }).catch((err) => {
      if (!(err instanceof UpstreamError)) throw err;
    });
  },
};
