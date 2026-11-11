import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { client, fakeServer, register, silentLog, testApp, waitFor, type Api } from './helpers.js';
import { startRunWorker } from '../src/actions/worker.js';
import { connectorInvoker } from '../src/actions/invokers/connector.js';
import { RESOLVED } from '../src/integrations/connectors/connections.js';
import { connectorDef } from '../src/schemas.js';

/** Workflow steps running connector operations and raw API calls through a connection (actions/invokers/connector.ts). */

let app: FastifyInstance;
let admin: Api;
let member: Api;
let srv: Awaited<ReturnType<typeof fakeServer>>;
const stops: (() => unknown)[] = [];
const KEY = 'deploy-key-987654';
let polls = 0;

const definition = {
  title: 'Deployer',
  category: 'internal',
  icon: 'rocket',
  fields: { properties: { baseUrl: { type: 'string' }, team: { type: 'string', default: 'core' } }, required: ['baseUrl'] },
  auth: [{ type: 'header', headers: { 'X-Api-Key': '{apiKey}' } }],
  kinds: { app: { path: '/api/apps', itemsPath: 'items' } },
  operations: {
    deploy: {
      title: 'Deploy an app',
      description: 'Starts a deployment and waits for it.',
      kind: 'app',
      inputs: {
        properties: { app: { type: 'string' }, version: { type: 'string' }, replicas: { type: 'integer', default: 1 } },
        required: ['app', 'version'],
      },
      method: 'POST',
      path: '/api/apps/{{ inputs.app }}/deploys',
      body: { version: '{{ inputs.version }}', replicas: '{{ inputs.replicas }}', team: '{{ connection.team }}' },
      output: { id: 'body.id', url: 'body.url' },
      poll: {
        path: '/api/deploys/{{ output.id }}',
        intervalSeconds: 2,
        timeoutMinutes: 5,
        done: 'body.state = "done"',
        failed: 'body.state = "error"',
        output: { state: 'body.state' },
      },
    },
    status: {
      title: 'App status',
      inputs: { properties: { app: { type: 'string' } }, required: ['app'] },
      method: 'GET',
      path: '/api/apps/{{ inputs.app }}',
      output: { version: 'body.version' },
    },
  },
};

beforeAll(async () => {
  srv = await fakeServer((r) => {
    const u = new URL(r.url, 'http://x');
    if (r.headers['x-api-key'] !== KEY) return { status: 401, body: { error: 'denied' } };
    if (u.pathname === '/api/apps') return { body: { items: [{ code: 'shop' }] } };
    if (u.pathname === '/api/apps/shop/deploys' && r.method === 'POST') return { status: 201, body: { id: 'd1', url: 'https://deployer.example.com/d/d1' } };
    if (u.pathname === '/api/deploys/d1') return { body: { state: polls++ ? 'done' : 'running' } };
    if (u.pathname === '/api/apps/shop') return { body: { version: '1.2.3', echo: KEY }, headers: { etag: '"v1"' } };
    return { status: 404, body: { error: 'not found' } };
  });
  app = await testApp();
  admin = client(app, (await register(app, 'admin@example.com')).token);
  member = client(app, (await register(app, 'member@example.com')).token);
  await admin.put('/api/v1/secrets/DEPLOY_KEY', { value: KEY });
  await admin.put('/api/v1/blueprints/service', { title: 'Service', schema: { properties: { app: { type: 'string' }, version: { type: 'string' } } } });
  expect((await admin.put('/api/v1/connectors/deployer', definition)).status).toBe(200);
  const conn = (access: string, extra: Record<string, unknown> = {}) => ({
    title: `Deployer (${access})`,
    connector: 'deployer',
    fields: { baseUrl: srv.url },
    auth: { type: 'header', apiKey: '${secret:DEPLOY_KEY}' },
    access,
    ...extra,
  });
  expect((await admin.put('/api/v1/connections/dep-ro', conn('read'))).status).toBe(200);
  expect((await admin.put('/api/v1/connections/dep-rw', conn('read-write', { api: { methods: ['GET'], paths: ['/api/apps'] } }))).status).toBe(200);
  await admin.put('/api/v1/integrations/dep-apps', {
    title: 'Apps',
    type: 'connector',
    config: { connection: 'dep-rw' },
    mappings: [{ kind: 'app', entity: { blueprint: 'service', identifier: 'code' } }],
    intervalMinutes: 0,
  });
  stops.push(startRunWorker(silentLog));
});
afterAll(async () => {
  for (const s of stops) await s();
  await app.close();
  await srv.close();
});

const save = (id: string, invoker: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  admin.put(`/api/v1/actions/${id}`, {
    title: id,
    trigger: { type: 'form', inputs: { properties: { v: { type: 'string' } } } },
    steps: [{ id: 'op', type: 'invoke', invoker }],
    ...extra,
  });

async function finished(runId: string) {
  return waitFor(async () => {
    const r = (await admin.get(`/api/v1/runs/${runId}`)).data as {
      status: string;
      steps: { id: string; output: Record<string, unknown>; link: string | null; statusLabel: string; connector?: unknown }[];
      logs: { message: string }[];
    };
    return ['SUCCESS', 'FAILURE'].includes(r.status) && r;
  }, 25_000);
}

describe('saving workflows with connector steps', () => {
  it('checks the connection, the operation, the access and the literal inputs', async () => {
    const op = { type: 'connector', connection: 'dep-rw', operation: 'deploy', inputs: { app: 'shop', version: '{{ inputs.v }}' } };
    expect((await save('c1', { ...op, connection: 'nope' })).data.error).toMatch(/Unknown connection "nope"/);
    expect((await save('c1', { ...op, operation: 'nope' })).data.error).toMatch(/unknown operation "nope"/);
    expect((await save('c1', { ...op, connection: 'dep-ro' })).data.error).toMatch(/read-only/);
    expect((await save('c1', { ...op, inputs: { app: 'shop' } })).data.error).toMatch(/version/);
    expect((await save('c1', { ...op, inputs: { ...op.inputs, replicas: 'two' } })).data.error).toMatch(/replicas must be integer/);
    expect((await save('c1', { ...op, inputs: { ...op.inputs, color: 'red' } })).data.error).toMatch(/unknown color/);
    expect((await save('c1', { type: 'connector', connection: 'dep-rw' })).data.error).toMatch(/missing operation/);
    // A read-only operation is fine on a read-only connection; templated inputs are checked when the step runs.
    expect((await save('c1', { type: 'connector', connection: 'dep-ro', operation: 'status', inputs: { app: '{{ inputs.v }}' } })).status).toBe(200);
    expect((await save('c2', op)).status).toBe(200);
    expect((await admin.get('/api/v1/connections/dep-rw/usage')).data.actions).toContain('c2');
  });

  it('refuses raw calls a connection does not allow', async () => {
    const raw = { type: 'connector-api', connection: 'dep-rw', method: 'GET', path: '/api/apps/shop' };
    expect((await save('r1', { ...raw, connection: 'dep-ro' })).data.error).toMatch(/does not allow raw API calls/);
    expect((await save('r1', { ...raw, path: '/api/deploys/d1' })).data.error).toMatch(/outside the paths/);
    expect((await save('r1', { ...raw, method: 'POST' })).data.error).toMatch(/does not allow POST/);
    expect((await save('r1', raw)).status).toBe(200);
  });

  it('respects the allowed workflows of a connection', async () => {
    await admin.put('/api/v1/connections/dep-only', {
      title: 'Only',
      connector: 'deployer',
      fields: { baseUrl: srv.url },
      auth: { type: 'header', apiKey: '${secret:DEPLOY_KEY}' },
      access: 'read-write',
      allowed: { workflows: ['allowed-wf'] },
    });
    const inv = { type: 'connector', connection: 'dep-only', operation: 'status', inputs: { app: 'shop' } };
    expect((await save('other-wf', inv)).data.error).toMatch(/not allowed for workflow "other-wf"/);
    expect((await save('allowed-wf', inv)).status).toBe(200);
  });
});

describe('running connector steps', () => {
  it('runs a long operation: request, polls at the operation interval, mapped output, link, safe logs', async () => {
    polls = 0;
    expect(
      (await save('deploy-shop', { type: 'connector', connection: 'dep-rw', operation: 'deploy', inputs: { app: 'shop', version: '{{ inputs.v }}' } })).status,
    ).toBe(200);
    const runId = (await admin.post('/api/v1/actions/deploy-shop/runs', { inputs: { v: '2.0.0' } })).data.id as string;
    const done = await finished(runId);
    expect(done.status, JSON.stringify(done.logs)).toBe('SUCCESS');
    const step = done.steps.find((s) => s.id === 'op')!;
    expect(step.output).toEqual({ id: 'd1', url: 'https://deployer.example.com/d/d1', state: 'done', httpStatus: 201 });
    expect(step.link).toBe('https://deployer.example.com/d/d1');
    expect(step.statusLabel).toBe('Deploy an app · done');
    expect(step.connector).toMatchObject({ connection: 'dep-rw', connector: 'deployer', operation: 'deploy', operationTitle: 'Deploy an app', icon: 'rocket' });
    const sent = srv.received.find((r) => r.method === 'POST' && r.url === '/api/apps/shop/deploys')!;
    expect(JSON.parse(sent.body)).toEqual({ version: '2.0.0', replicas: 1, team: 'core' });
    const lines = done.logs.map((l) => l.message);
    expect(lines).toContain('POST /api/apps/shop/deploys → 201');
    expect(lines.filter((l) => l === 'GET /api/deploys/d1 → 200')).toHaveLength(2);
    expect(JSON.stringify(done)).not.toContain(KEY);
  });

  it('runs a raw call (output: status, body, headers) and masks echoed credentials', async () => {
    expect((await save('raw-call', { type: 'connector-api', connection: 'dep-rw', method: 'GET', path: '/api/apps/shop' })).status).toBe(200);
    const runId = (await admin.post('/api/v1/actions/raw-call/runs', { inputs: {} })).data.id as string;
    const done = await finished(runId);
    expect(done.status, JSON.stringify(done.logs)).toBe('SUCCESS');
    const out = done.steps[0]!.output as { status: number; body: { version: string; echo: string }; headers: Record<string, string> };
    expect(out.status).toBe(200);
    expect(out.body.version).toBe('1.2.3');
    expect(out.body.echo).not.toContain(KEY);
    expect(out.headers.etag).toBe('"v1"');
    expect(done.steps[0]!.connector).toMatchObject({ connection: 'dep-rw', method: 'GET' });
  });

  it('fails an operation whose connection became read-only, without sending anything', async () => {
    expect((await save('deploy-ro', { type: 'connector', connection: 'dep-rw', operation: 'deploy', inputs: { app: 'shop', version: '1' } })).status).toBe(200);
    const before = srv.received.length;
    await admin.put('/api/v1/connections/dep-rw', {
      ...(await admin.get('/api/v1/connections/dep-rw')).data,
      access: 'read',
    });
    try {
      const runId = (await admin.post('/api/v1/actions/deploy-ro/runs', { inputs: {} })).data.id as string;
      const done = await finished(runId);
      expect(done.status).toBe('FAILURE');
      expect(done.logs.map((l) => l.message).join('\n')).toMatch(/read-only/);
      expect(srv.received.slice(before).some((r) => r.method === 'POST')).toBe(false);
    } finally {
      await admin.put('/api/v1/connections/dep-rw', { ...(await admin.get('/api/v1/connections/dep-rw')).data, access: 'read-write' });
    }
  });

  it('fails a long operation after its timeout', async () => {
    const def = connectorDef.parse({ identifier: 'deployer', ...definition });
    const logs: string[] = [];
    const res = await connectorInvoker.poll!(
      {
        ctx: {} as never,
        config: { connection: 'x', operation: 'deploy', inputs: {}, [RESOLVED]: { connector: def, fields: { baseUrl: srv.url }, secrets: [] } },
        log: async (m) => void logs.push(m),
      },
      {
        kind: 'connector',
        operation: 'deploy',
        output: { id: 'd1' },
        httpStatus: 201,
        startedAt: '',
        deadline: new Date(Date.now() - 1000).toISOString(),
        polls: 3,
      },
    );
    expect(res).toMatchObject({ status: 'FAILURE', statusLabel: 'Deploy an app · timed out' });
    expect(logs.join()).toMatch(/not finished after 5 minute/);
  });
});

describe('dry runs, workflow tests and the editor', () => {
  it('renders the request of a connector step without sending it', async () => {
    const before = srv.received.length;
    const res = await admin.post('/api/v1/actions/dry-deploy/dry-run', {
      definition: {
        title: 'dry',
        trigger: { type: 'form', inputs: { properties: { v: { type: 'string' } } } },
        steps: [
          {
            id: 'op',
            type: 'invoke',
            invoker: { type: 'connector', connection: 'dep-rw', operation: 'deploy', inputs: { app: 'shop', version: '{{ inputs.v }}' } },
          },
          {
            id: 'raw',
            type: 'invoke',
            invoker: { type: 'connector-api', connection: 'dep-rw', path: '/api/apps/shop', query: { v: '{{ steps.op.output.id }}' } },
          },
        ],
      },
      inputs: { v: '3.0.0' },
    });
    expect(res.status, JSON.stringify(res.data)).toBe(200);
    const [op, raw] = res.data.steps as { rendered: Record<string, unknown>; output: unknown; errors: string[] }[];
    expect(op!.errors).toEqual([]);
    expect(op!.rendered).toMatchObject({
      connection: 'dep-rw',
      title: 'Deploy an app',
      polls: true,
      request: { method: 'POST', url: `${srv.url}/api/apps/shop/deploys`, body: { version: '3.0.0', replicas: 1, team: 'core' } },
    });
    expect(op!.output).toEqual({ id: '<id>', url: '<url>', httpStatus: 200 });
    expect((raw!.rendered as { request: { url: string } }).request.url).toBe(`${srv.url}/api/apps/shop?v=%3Cid%3E`);
    expect(JSON.stringify(res.data)).not.toContain(KEY);
    expect(srv.received.length).toBe(before);
  });

  it('mocks connector steps in workflow tests', async () => {
    const draft = {
      title: 'tested',
      trigger: { type: 'form', inputs: { properties: { v: { type: 'string' } } } },
      steps: [
        {
          id: 'op',
          type: 'invoke',
          invoker: { type: 'connector', connection: 'dep-rw', operation: 'deploy', inputs: { app: 'shop', version: '{{ inputs.v }}' } },
        },
        { id: 'after', type: 'transform', output: { id: 'steps.op.output.id' } },
      ],
      tests: [
        {
          name: 'mocked',
          inputs: { v: '1' },
          mocks: { op: { output: { id: 'd9' } } },
          expect: { status: 'SUCCESS', steps: { after: { output: { id: 'd9' } } } },
        },
      ],
    };
    const report = (await admin.post('/api/v1/actions/tested/tests/run', { definition: draft })).data;
    expect(report, JSON.stringify(report)).toMatchObject({ passed: 1, failed: 0 });
  });

  it('lists connections and operations for the editor (blueprints of the kind, usability), admins only', async () => {
    expect((await member.get('/api/v1/step-connections')).status).toBe(403);
    const list = (await admin.get('/api/v1/step-connections')).data as {
      identifier: string;
      connector: { title: string; icon: string };
      operations: { name: string; blueprints: string[]; usable: boolean; reason?: string; outputs: string[]; polls: boolean }[];
      fields: Record<string, unknown>;
      auth?: unknown;
    }[];
    const rw = list.find((c) => c.identifier === 'dep-rw')!;
    expect(rw.connector).toMatchObject({ title: 'Deployer', icon: 'rocket' });
    expect(rw.fields).toEqual({ baseUrl: srv.url, team: 'core' });
    expect(rw.auth).toBeUndefined();
    expect(rw.operations.find((o) => o.name === 'deploy')).toMatchObject({
      blueprints: ['service'],
      usable: true,
      polls: true,
      outputs: ['id', 'url', 'state', 'httpStatus'],
    });
    const ro = list.find((c) => c.identifier === 'dep-ro')!;
    expect(ro.operations.find((o) => o.name === 'deploy')).toMatchObject({ usable: false, reason: expect.stringMatching(/read-only/) });
    expect(ro.operations.find((o) => o.name === 'status')).toMatchObject({ usable: true, blueprints: [] });
  });
});
