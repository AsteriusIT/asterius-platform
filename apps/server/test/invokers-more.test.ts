import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { getInvoker } from '../src/actions/invokers/index.js';
import type { InvokeEnv } from '../src/actions/types.js';

type Handler = (req: IncomingMessage, body: string, res: ServerResponse) => void;
async function server(handler: Handler) {
  const seen: Array<{ method: string; url: string; headers: IncomingMessage['headers']; body: string }> = [];
  const s = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body });
      handler(req, body, res);
    });
  });
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(s.address() as AddressInfo).port}`, seen, close: () => new Promise((r) => s.close(r)) };
}
const json = (res: ServerResponse, body: unknown, status = 200, headers: Record<string, string> = {}) =>
  res.writeHead(status, { 'content-type': 'application/json', ...headers }).end(JSON.stringify(body));

const ctx = {
  run: { id: 'r1', url: 'https://portal/runs/r1', callback: { url: '', token: '' } },
  action: { identifier: 'a', title: 'A', blueprint: null },
  inputs: {},
  entity: null,
  trigger: { user: { id: 'u', email: 'e', name: 'n' }, at: '' },
  steps: {},
};
const env = (config: Record<string, unknown>): InvokeEnv => ({ ctx, config, log: async () => undefined });

describe('jenkins', () => {
  it('queues, finds the build and reports the result', async () => {
    let polls = 0;
    const s = await server((req, _b, res) => {
      if (req.method === 'POST') return void res.writeHead(201, { location: `${s.url}/queue/item/7/` }).end();
      if (req.url?.startsWith('/queue/item/7')) return json(res, ++polls < 2 ? {} : { executable: { url: `${s.url}/job/deploy/12/` } });
      json(res, { building: false, result: 'FAILURE' });
    });
    const inv = getInvoker('jenkins');
    const cfg = { baseUrl: s.url, job: 'platform/deploy', user: 'u', token: 't', parameters: { SERVICE: 'api' } };
    const started = await inv.start(env(cfg));
    expect(s.seen[0]).toMatchObject({ method: 'POST', url: '/job/platform/job/deploy/buildWithParameters', body: 'SERVICE=api' });
    expect(s.seen[0]!.headers.authorization).toMatch(/^Basic /);
    const p1 = await inv.poll!(env(cfg), started.state!);
    expect(p1.status).toBe('IN_PROGRESS');
    const p2 = await inv.poll!(env(cfg), p1.state!);
    expect(p2).toMatchObject({ status: 'FAILURE', statusLabel: 'FAILURE' });
    await s.close();
  });
});

describe('argo workflows', () => {
  it('submits a template and maps phases', async () => {
    let phase = 'Running';
    const s = await server((req, _b, res) => (req.method === 'POST' ? json(res, { metadata: { name: 'wf-abc' } }) : json(res, { status: { phase } })));
    const inv = getInvoker('argo-workflows');
    const cfg = { baseUrl: s.url, template: 'provision', token: 'tok', parameters: { name: 'db1' } };
    const st = await inv.start(env(cfg));
    expect(JSON.parse(s.seen[0]!.body)).toMatchObject({
      resourceKind: 'WorkflowTemplate',
      resourceName: 'provision',
      submitOptions: { parameters: ['name=db1'] },
    });
    expect(s.seen[0]!.headers.authorization).toBe('Bearer tok');
    expect((await inv.poll!(env(cfg), st.state!)).status).toBe('IN_PROGRESS');
    phase = 'Succeeded';
    expect((await inv.poll!(env(cfg), st.state!)).status).toBe('SUCCESS');
    await s.close();
  });
});

describe('terraform cloud', () => {
  it('queues an apply run and follows its status', async () => {
    let status = 'planning';
    const s = await server((req, _b, res) => (req.method === 'POST' ? json(res, { data: { id: 'run-1' } }) : json(res, { data: { attributes: { status } } })));
    const inv = getInvoker('terraform-cloud');
    const cfg = { baseUrl: s.url, workspaceId: 'ws-1', token: 't', mode: 'apply' };
    const st = await inv.start(env(cfg));
    const body = JSON.parse(s.seen[0]!.body);
    expect(body.data.attributes).toMatchObject({ 'auto-apply': true, 'plan-only': false });
    expect(body.data.relationships.workspace.data.id).toBe('ws-1');
    expect((await inv.poll!(env(cfg), st.state!)).status).toBe('IN_PROGRESS');
    status = 'applied';
    expect((await inv.poll!(env(cfg), st.state!)).status).toBe('SUCCESS');
    status = 'errored';
    expect((await inv.poll!(env(cfg), st.state!)).status).toBe('FAILURE');
    await s.close();
  });
});

describe('jira', () => {
  it('creates an issue and returns its link', async () => {
    const s = await server((_r, _b, res) => json(res, { key: 'PLAT-42' }, 201));
    const out = await getInvoker('jira-issue').start(env({ baseUrl: s.url, email: 'b@x', token: 't', project: 'PLAT', summary: 'Do it', labels: ['a'] }));
    expect(out).toMatchObject({ status: 'SUCCESS', result: { key: 'PLAT-42' } });
    const sent = JSON.parse(s.seen[0]!.body);
    expect(sent.fields).toMatchObject({ project: { key: 'PLAT' }, summary: 'Do it', issuetype: { name: 'Task' }, labels: ['a'] });
    expect(sent.fields.description.type).toBe('doc');
    await s.close();
  });
});

describe('aws lambda and step functions', () => {
  const aws = { region: 'eu-west-1', accessKeyId: 'AKIA', secretAccessKey: 'secret' };
  it('invokes a function with SigV4 and maps function errors', async () => {
    let fail = false;
    const s = await server((_r, _b, res) =>
      json(res, fail ? { errorMessage: 'boom' } : { ok: true }, 200, fail ? { 'x-amz-function-error': 'Unhandled' } : {}),
    );
    const inv = getInvoker('aws-lambda');
    const cfg = { ...aws, endpoint: s.url, function: 'f', payload: { a: 1 } };
    expect(await inv.start(env(cfg))).toMatchObject({ status: 'SUCCESS', result: { ok: true } });
    expect(s.seen[0]!.url).toBe('/2015-03-31/functions/f/invocations');
    expect(s.seen[0]!.headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIA\//);
    fail = true;
    expect((await inv.start(env(cfg))).status).toBe('FAILURE');
    await s.close();
  });

  it('starts and polls an execution', async () => {
    let status = 'RUNNING';
    const s = await server((req, _b, res) =>
      req.headers['x-amz-target'] === 'AWSStepFunctions.StartExecution' ? json(res, { executionArn: 'arn:x' }) : json(res, { status, output: '{"done":1}' }),
    );
    const inv = getInvoker('aws-step-functions');
    const cfg = { ...aws, endpoint: s.url, stateMachineArn: 'arn:sm' };
    const st = await inv.start(env(cfg));
    expect(st.state).toEqual({ executionArn: 'arn:x' });
    expect((await inv.poll!(env(cfg), st.state!)).status).toBe('IN_PROGRESS');
    status = 'SUCCEEDED';
    expect(await inv.poll!(env(cfg), st.state!)).toMatchObject({ status: 'SUCCESS', result: { done: 1 } });
    await s.close();
  });
});
