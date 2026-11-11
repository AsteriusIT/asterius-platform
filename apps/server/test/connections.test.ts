import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { client, fakeServer, inDefaultOrg, register, silentLog, testApp, waitFor, type Api } from './helpers.js';
import { runSync } from '../src/integrations/sync.js';
import { startRunWorker } from '../src/actions/worker.js';
import { applyConfig, readConfigDir } from '../src/config-loader.js';
import { builtinConnectors, parseDefinition } from '../src/integrations/connectors/definitions.js';
import {
  authBlock,
  inlineAuth,
  isReadOnlyOperation,
  kindRequest,
  operationOutput,
  operationRequest,
  pollOutcome,
  pollRequest,
  renderRequest,
} from '../src/integrations/connectors/request.js';
import { assertConnectionUse, assertRawCall } from '../src/integrations/connectors/connections.js';
import { configForValidation } from '../src/integrations/connectors/bindings.js';
import { connectorDef } from '../src/schemas.js';

let app: FastifyInstance;
let admin: Api;
let member: Api;
let integ: Api; // integration-admin
let srv: Awaited<ReturnType<typeof fakeServer>>;
const stops: (() => unknown)[] = [];

const INV_KEY = 'inv-key-123456';
const PAT = 'ado-pat-value-1';
const basicPat = `Basic ${Buffer.from(`:${PAT}`).toString('base64')}`;
let pipelinePolls = 0;

/** An in-house application ("inventory"), plus the parts of Azure DevOps and Entra the tests need. */
beforeAll(async () => {
  srv = await fakeServer((r) => {
    const u = new URL(r.url, 'http://x');
    const p = u.pathname;
    if (p.startsWith('/inv/')) {
      if (r.headers['x-api-key'] !== INV_KEY) return { status: 401, body: { error: `denied for ${String(r.headers['x-api-key'])}` } };
      if (p === '/inv/api/health') return { body: { status: 'ok' } };
      if (p === '/inv/api/apps')
        return {
          body: u.searchParams.get('cursor') ? { items: [{ code: 'b', env: u.searchParams.get('env') }], next: null } : { items: [{ code: 'a' }], next: 'p2' },
        };
      return { status: 404, body: {} };
    }
    if (p === '/tenant-1/oauth2/v2.0/token') {
      const body = new URLSearchParams(r.body);
      if (body.get('client_assertion') !== 'federated-jwt' || body.get('scope') !== '499b84ac-1321-427f-aa17-267ca6975798/.default')
        return { status: 400, body: { error: 'invalid_client' } };
      return { body: { access_token: 'wi-token-abcdef', expires_in: 3600 } };
    }
    if (p.startsWith('/myorg/')) {
      const auth = r.headers.authorization;
      if (auth !== basicPat && auth !== 'Bearer wi-token-abcdef') return { status: 401, body: { message: 'unauthorized' } };
      if (p === '/myorg/_apis/projects') return { body: { value: [{ name: 'Platform' }] } };
      if (p === '/myorg/Platform/_apis/git/repositories')
        return u.searchParams.get('continuationToken')
          ? { body: { value: [{ name: 'r2', webUrl: 'https://ado/r2' }] } }
          : { body: { value: [{ name: 'r1', webUrl: 'https://ado/r1' }] }, headers: { 'x-ms-continuationtoken': 'tok2' } };
      if (p === '/myorg/Platform/_apis/pipelines/3/runs' && r.method === 'POST') return { body: { id: 9, state: 'inProgress' } };
      if (p === '/myorg/Platform/_apis/pipelines/3/runs/9')
        return {
          body: pipelinePolls++
            ? { id: 9, state: 'completed', result: 'succeeded', _links: { web: { href: 'https://ado/run/9' } } }
            : { id: 9, state: 'inProgress' },
        };
      return { body: {} };
    }
    return { status: 404, body: {} };
  });
  app = await testApp();
  admin = client(app, (await register(app, 'admin@example.com')).token);
  member = client(app, (await register(app, 'member@example.com')).token);
  const i = await register(app, 'integ@example.com');
  integ = client(app, i.token);
  await admin.patch(`/api/v1/users/${i.user.id}`, { roles: ['integration-admin'] });
  await admin.put('/api/v1/secrets/INV_KEY', { value: INV_KEY });
  await admin.put('/api/v1/secrets/ADO_PAT', { value: PAT });
  await admin.put('/api/v1/blueprints/app', { title: 'App', schema: { properties: { env: { type: 'string' } } } });
  await admin.put('/api/v1/blueprints/repository', { title: 'Repository', schema: { properties: { url: { type: 'string' } } } });
  stops.push(startRunWorker(silentLog));
});
afterAll(async () => {
  for (const s of stops) await s();
  await app.close();
  await srv.close();
});

/** Definition of the in-house application. */
const inventory = () => ({
  title: 'Inventory',
  category: 'internal',
  fields: { properties: { baseUrl: { type: 'string' }, env: { type: 'string', default: 'prod' } }, required: ['baseUrl'] },
  auth: [{ type: 'header', title: 'API key', headers: { 'X-Api-Key': '{apiKey}' } }],
  test: { path: '/api/health', expect: { condition: 'body.status = "ok"' } },
  kinds: {
    app: {
      path: '/api/apps',
      query: { env: '{{ connection.env }}' },
      itemsPath: 'items',
      pagination: { type: 'cursor', param: 'cursor', cursorPath: 'next' },
    },
  },
  operations: {
    'restart-app': {
      title: 'Restart an app',
      kind: 'app',
      inputs: { properties: { code: { type: 'string' }, force: { type: 'boolean', default: false } }, required: ['code'] },
      method: 'POST',
      path: '/api/apps/{{ inputs.code }}/restart',
      body: { force: '{{ inputs.force }}' },
      output: { accepted: 'status = 202' },
    },
  },
});

const ado = () => builtinConnectors().get('azure-devops')!;

describe('connector engine (pure functions)', () => {
  const def = connectorDef.parse({ identifier: 'inv', ...inventory() });
  const fields = { baseUrl: 'https://inv.example.com/base/', env: 'prod' };

  it('renders requests: encoded segments, collapsed empty segments, empty query values left out', async () => {
    const r = await renderRequest(
      def,
      { path: '/a/{{ inputs.x }}/{{ connection.missing }}/b', query: { q: '{{ inputs.q }}', none: '{{ inputs.nothing }}', list: '{{ ["1", "2"] }}' } },
      { connection: fields, inputs: { x: 'a/b c?', q: 'v' } },
    );
    expect(r.url).toBe('https://inv.example.com/base/a/a%2Fb%20c%3F/b?q=v&list=1&list=2');
    expect(r.method).toBe('GET');
    await expect(renderRequest(def, { path: '/a/{{ inputs.x }}' }, { connection: fields, inputs: { x: '..' } })).rejects.toThrow(/cannot be/);
    await expect(renderRequest(def, { path: '/a', headers: { 'x-h': '{{ inputs.h }}' } }, { connection: fields, inputs: { h: 'a\r\nb: c' } })).rejects.toThrow(
      /line breaks/,
    );
    await expect(renderRequest(def, { path: '/a' }, { connection: { baseUrl: 'ftp://x' } })).rejects.toThrow(/http/);
    // Template values are data: a `{{ }}` inside an input is never evaluated.
    const t = await renderRequest(def, { path: '/a', body: { v: '{{ inputs.v }}' } }, { connection: fields, inputs: { v: '{{ $now() }}' } });
    expect(t.body).toEqual({ v: '{{ $now() }}' });
  });

  it('builds the request of an operation with validated inputs and defaults', async () => {
    const { request, inputs } = await operationRequest(def, 'restart-app', fields, { code: 'billing' });
    expect(inputs).toEqual({ code: 'billing', force: false });
    expect(request).toMatchObject({ method: 'POST', url: 'https://inv.example.com/base/api/apps/billing/restart', body: { force: false } });
    await expect(operationRequest(def, 'restart-app', fields, {})).rejects.toThrow(/code/);
    await expect(operationRequest(def, 'nope', fields, {})).rejects.toThrow(/unknown operation/);
    expect(await operationOutput(def.operations['restart-app']!, { connection: fields, inputs, status: 202, body: {} })).toEqual({ accepted: true });
    expect(isReadOnlyOperation(def.operations['restart-app']!)).toBe(false);
    expect(isReadOnlyOperation({ method: 'POST', readOnly: true })).toBe(true);
  });

  it('Azure DevOps: queue a pipeline run, poll it until completed', async () => {
    const f = { baseUrl: 'https://dev.azure.com', organization: 'my org', project: 'Platform' };
    const { request, operation } = await operationRequest(ado(), 'queue-pipeline-run', f, {
      pipelineId: 42,
      templateParameters: { env: 'prod' },
      variables: { A: 'x', N: 3 },
    });
    expect(request.url).toBe('https://dev.azure.com/my%20org/Platform/_apis/pipelines/42/runs?api-version=7.1');
    expect(request.body).toEqual({
      resources: { repositories: { self: { refName: 'refs/heads/main' } } },
      templateParameters: { env: 'prod' },
      variables: { A: { value: 'x', isSecret: false }, N: { value: '3', isSecret: false } },
    });
    const output = await operationOutput(operation, {
      connection: f,
      inputs: { pipelineId: 42 },
      status: 200,
      body: { id: 7, state: 'inProgress', _links: { web: { href: 'u' } } },
    });
    expect(output).toEqual({ runId: 7, url: 'u', state: 'inProgress' });
    const poll = await pollRequest(ado(), operation, f, { inputs: { pipelineId: 42 }, output });
    expect(poll.url).toBe('https://dev.azure.com/my%20org/Platform/_apis/pipelines/42/runs/7?api-version=7.1');
    const ctx = (body: unknown) => ({ connection: f, inputs: { pipelineId: 42 }, output: output as Record<string, unknown>, status: 200, body });
    expect((await pollOutcome(operation, ctx({ state: 'inProgress' }))).status).toBe('running');
    expect(await pollOutcome(operation, ctx({ state: 'completed', result: 'succeeded' }))).toEqual({
      status: 'success',
      output: { runId: 7, url: 'u', state: 'completed', result: 'succeeded' },
    });
    expect((await pollOutcome(operation, ctx({ state: 'completed', result: 'failed' }))).status).toBe('failure');
    // A branch given as a full ref is kept; another project overrides the connection's.
    const other = await operationRequest(ado(), 'queue-pipeline-run', f, { pipelineId: 1, branch: 'refs/tags/v1', project: 'Other' });
    expect(other.request.url).toContain('/my%20org/Other/_apis/pipelines/1/runs');
    expect((other.request.body as { resources: { repositories: { self: { refName: string } } } }).resources.repositories.self.refName).toBe('refs/tags/v1');
  });

  it('Azure DevOps: create a repository, open a pull request; kinds need their fields', async () => {
    const f = { baseUrl: 'https://dev.azure.com', organization: 'o', project: 'P' };
    const repo = await operationRequest(ado(), 'create-repository', f, { name: 'svc' });
    expect(repo.request).toMatchObject({ method: 'POST', url: 'https://dev.azure.com/o/P/_apis/git/repositories?api-version=7.1', body: { name: 'svc' } });
    const pr = await operationRequest(ado(), 'create-pull-request', f, { repository: 'svc', sourceBranch: 'feat', title: 'T' });
    expect(pr.request.body).toEqual({ sourceRefName: 'refs/heads/feat', targetRefName: 'refs/heads/main', title: 'T', isDraft: false });
    const out = await operationOutput(pr.operation, {
      connection: f,
      inputs: pr.inputs,
      status: 201,
      body: { pullRequestId: 5, status: 'active', repository: { webUrl: 'https://w' } },
    });
    expect(out).toEqual({ id: 5, status: 'active', url: 'https://w/pullrequest/5' });
    // Without a project the repository listing is organization-wide; pipelines need one.
    expect((await kindRequest(ado(), 'repository', { baseUrl: 'https://dev.azure.com', organization: 'o' })).request.url).toBe(
      'https://dev.azure.com/o/_apis/git/repositories?api-version=7.1',
    );
    await expect(kindRequest(ado(), 'pipeline', { baseUrl: 'https://dev.azure.com', organization: 'o' })).rejects.toThrow(/project/);
  });

  it('merges a connection auth block with the definition method', async () => {
    expect(await authBlock(def, { type: 'header', apiKey: '${secret:K}' }, fields)).toEqual({ type: 'header', headers: { 'X-Api-Key': '${secret:K}' } });
    expect(await authBlock(ado(), { type: 'basic', password: '${secret:PAT}' }, {})).toEqual({ type: 'basic', username: '', password: '${secret:PAT}' });
    await expect(authBlock(ado(), { type: 'basic', username: 'me', password: 'x' }, {})).rejects.toThrow(/set by the connector/);
    await expect(authBlock(ado(), { type: 'bearer', token: 'x' }, {})).rejects.toThrow(/does not support/);
    await expect(authBlock(def, { type: 'header', apiKey: 'k', other: 1 }, fields)).rejects.toThrow(/unknown field "other"/);
    await expect(authBlock(def, { type: 'header' }, fields)).rejects.toThrow(/missing "apiKey"/);
    const wi = await authBlock(ado(), { type: 'azure-workload-identity', clientId: 'c' }, {});
    expect(wi).toEqual({ type: 'azure-workload-identity', clientId: 'c', scope: '499b84ac-1321-427f-aa17-267ca6975798/.default' });
    // Legacy inline configs of the former presets.
    const jira = builtinConnectors().get('jira')!;
    expect(await inlineAuth(jira, { email: 'e@x', token: 't' }, {})).toEqual({ type: 'basic', username: 'e@x', password: 't' });
    expect(await inlineAuth(builtinConnectors().get('sonarqube')!, { token: 't' }, {})).toEqual({ type: 'basic', username: 't', password: '' });
    expect(await inlineAuth(jira, {}, {})).toBeUndefined();
  });

  it('validates definitions: references, credentials, kinds', () => {
    const base = { identifier: 'x', ...inventory() };
    expect(() => parseDefinition(base)).not.toThrow();
    expect(() => parseDefinition({ ...base, kinds: { app: { path: '/{{ connection.nope }}' } } })).toThrow(/connection\.nope is used but not declared/);
    expect(() => parseDefinition({ ...base, operations: { o: { title: 'O', inputs: { properties: {} }, path: '/{{ inputs.ghost }}' } } })).toThrow(
      /inputs\.ghost/,
    );
    expect(() => parseDefinition({ ...base, headers: { authorization: 'Bearer ${secret:X}' } })).toThrow(/credentials belong to connections/);
    expect(() => parseDefinition({ ...base, fields: { properties: { url: { type: 'string' } } } })).toThrow(/baseUrl/);
    expect(() => parseDefinition({ ...base, operations: { o: { title: 'O', inputs: {}, path: '/x', kind: 'ghost' } } })).toThrow(/kind "ghost"/);
    expect(() => parseDefinition({ ...base, auth: [{ type: 'bearer', set: { token: 'literal' } }] })).toThrow(/credential/);
    expect(() => parseDefinition({ ...base, kinds: { app: { path: '/x?y=1' } } })).toThrow(/query string/);
    expect(() => parseDefinition({ ...base, kinds: { app: { path: '/x', pagination: { type: 'cursor', param: 'c' } } } })).toThrow(/cursorPath/);
  });

  it('access helpers: read-only connections, automation allow-lists, raw call allow-lists', () => {
    const c = { identifier: 'c', access: 'read' as const, allowed: {}, api: { methods: ['GET' as const, 'POST' as const], paths: ['/api/apps'] } };
    expect(() => assertConnectionUse(c, { write: false })).not.toThrow();
    expect(() => assertConnectionUse(c, { write: true })).toThrow(/read-only/);
    const rw = { ...c, access: 'read-write' as const, allowed: { workflows: ['deploy'], teams: ['ops'] } };
    expect(() => assertConnectionUse(rw, { write: true, workflow: 'deploy' })).not.toThrow();
    expect(() => assertConnectionUse(rw, { write: true, workflow: 'other', team: 'ops' })).not.toThrow();
    expect(() => assertConnectionUse(rw, { write: true, workflow: 'other', team: 'dev' })).toThrow(/not allowed/);
    expect(() => assertRawCall(c, 'GET', '/api/apps/a')).not.toThrow();
    expect(() => assertRawCall(c, 'GET', '/api/apps')).not.toThrow();
    expect(() => assertRawCall(c, 'GET', '/api/appsx')).toThrow(/outside/);
    expect(() => assertRawCall(c, 'GET', '/api/apps/../admin')).toThrow(/not allowed/);
    expect(() => assertRawCall(c, 'GET', '/api/apps/%2e%2e/admin')).toThrow(/not allowed/);
    expect(() => assertRawCall(c, 'POST', '/api/apps/a')).toThrow(/read-only/);
    expect(() => assertRawCall(c, 'DELETE', '/api/apps/a')).toThrow(/DELETE/);
    expect(() => assertRawCall({ ...c, api: undefined }, 'GET', '/api/apps')).toThrow(/raw API/);
  });

  it('code integrations validate with what the connection provides', () => {
    expect(configForValidation('source', 'azure-devops', { connection: 'ado' })).toMatchObject({ organization: expect.any(String), token: expect.any(String) });
    expect(() => configForValidation('source', 'http', { connection: 'ado' })).toThrow(/does not accept a connection/);
    expect(() => configForValidation('invoker', 'azure-pipeline', { connection: 'ado', token: 'x' })).toThrow(/token comes from the connection/);
    expect(() => configForValidation('invoker', 'azure-pipeline', { connection: 'Bad Id' })).toThrow(/identifier/);
    expect(configForValidation('invoker', 'webhook', { url: 'x' })).toEqual({ url: 'x' });
  });
});

describe('connector definitions API', () => {
  it('lists the built-in definitions; only admins write the organization definitions, versioned', async () => {
    const list = await integ.get('/api/v1/connectors');
    expect(list.status).toBe(200);
    expect(list.data.find((c: { identifier: string }) => c.identifier === 'azure-devops')).toMatchObject({ builtin: true, version: 0 });
    expect((await member.get('/api/v1/connectors')).status).toBe(403);
    expect((await integ.put('/api/v1/connectors/inventory', inventory())).status).toBe(403);
    expect((await admin.put('/api/v1/connectors/pagerduty', inventory())).status).toBe(409);
    const created = await admin.put('/api/v1/connectors/inventory', inventory());
    expect(created.status, JSON.stringify(created.data)).toBe(200);
    expect(created.data).toMatchObject({ identifier: 'inventory', builtin: false, version: 1 });
    const updated = await admin.put('/api/v1/connectors/inventory', { ...inventory(), description: 'Our CMDB' }, { 'if-match': '1' });
    expect(updated.data.version).toBe(2);
    expect((await admin.put('/api/v1/connectors/inventory', inventory(), { 'if-match': '1' })).status).toBe(412);
    expect((await admin.get('/api/v1/connectors/inventory/versions')).data.map((v: { version: number }) => v.version)).toEqual([2, 1]);
    expect((await admin.put('/api/v1/connectors/broken', { ...inventory(), kinds: { app: { path: '/{{ connection.x }}' } } })).status).toBe(400);
    const preview = await integ.post('/api/v1/connectors/inventory/operations/restart-app/render', {
      fields: { baseUrl: 'https://inv' },
      inputs: { code: 'a' },
    });
    expect(preview.data).toMatchObject({ method: 'POST', url: 'https://inv/api/apps/a/restart', inputs: { code: 'a', force: false } });
  });
});

describe('connections API', () => {
  it('validates connections: credentials are references, fields and auth match the definition', async () => {
    const put = (id: string, body: object, api: Api = integ) => api.put(`/api/v1/connections/${id}`, body);
    const ok = { title: 'Inventory', connector: 'inventory', fields: { baseUrl: `${srv.url}/inv` }, auth: { type: 'header', apiKey: '${secret:INV_KEY}' } };
    expect((await put('inv', { ...ok, auth: { type: 'header', apiKey: INV_KEY } })).data.error).toMatch(/references/);
    expect((await put('inv', { ...ok, fields: { ...ok.fields, nope: 1 } })).data.error).toMatch(/not a field/);
    expect((await put('inv', { ...ok, fields: { baseUrl: '${secret:INV_KEY}' } })).data.error).toMatch(/credentials do not belong/);
    expect((await put('inv', { ...ok, auth: null })).data.error).toMatch(/needs one of/);
    expect((await put('inv', { ...ok, auth: { type: 'bearer', token: '${secret:X}' } })).data.error).toMatch(/does not support/);
    expect((await put('inv', { ...ok, connector: 'ghost' })).data.error).toMatch(/Unknown connector/);
    expect((await put('inv', ok, member)).status).toBe(403);
    const created = await put('inv', ok);
    expect(created.status, JSON.stringify(created.data)).toBe(200);
    expect(created.data).toMatchObject({ identifier: 'inv', access: 'read', version: 1, managed: false, allowed: {} });
    expect((await put('inv', { ...ok, access: 'read-write' })).data.version).toBe(2);
    expect((await put('inv', ok, admin)).status).toBe(200);
    expect((await integ.get('/api/v1/connections')).data.map((c: { identifier: string }) => c.identifier)).toContain('inv');
  });

  it('tests a connection with its credentials (never echoed back)', async () => {
    const ok = await integ.post('/api/v1/connections/inv/test');
    expect(ok.data).toMatchObject({ ok: true, status: 200 });
    expect(ok.data.latencyMs).toBeGreaterThanOrEqual(0);
    await admin.put('/api/v1/secrets/BAD_KEY', { value: 'wrong-key-987654' });
    await integ.put('/api/v1/connections/inv-bad', {
      title: 'Bad',
      connector: 'inventory',
      fields: { baseUrl: `${srv.url}/inv` },
      auth: { type: 'header', apiKey: '${secret:BAD_KEY}' },
    });
    const bad = await integ.post('/api/v1/connections/inv-bad/test');
    expect(bad.data).toMatchObject({ ok: false, status: 401 });
    expect(bad.data.error).toMatch(/Unexpected status 401/);
    expect(JSON.stringify(bad.data)).not.toContain('wrong-key-987654');
    expect((await integ.post('/api/v1/connections/ghost/test')).status).toBe(404);
    await integ.del('/api/v1/connections/inv-bad');
  });

  it('ingests an in-house application through a connector integration; usage blocks deletion', async () => {
    const saved = await integ.put('/api/v1/integrations/inventory-apps', {
      title: 'Inventory apps',
      type: 'connector',
      config: { connection: 'inv' },
      mappings: [{ kind: 'app', entity: { blueprint: 'app', identifier: 'code', properties: { env: 'env' } } }],
    });
    expect(saved.status, JSON.stringify(saved.data)).toBe(200);
    expect(
      (
        await integ.put('/api/v1/integrations/x', {
          title: 'X',
          type: 'connector',
          config: { connection: 'inv' },
          mappings: [{ kind: 'ghost', entity: { blueprint: 'app', identifier: 'code' } }],
        })
      ).data.error,
    ).toMatch(/unknown kind "ghost"/);
    expect((await integ.put('/api/v1/integrations/x', { title: 'X', type: 'connector', config: { connection: 'ghost' } })).data.error).toMatch(
      /Unknown connection/,
    );
    expect((await integ.put('/api/v1/integrations/x', { title: 'X', type: 'http', config: { connection: 'inv' } })).data.error).toMatch(/does not accept/);
    expect((await integ.put('/api/v1/integrations/x', { title: 'X', type: 'pagerduty', config: { connection: 'inv' } })).data.error).toMatch(
      /pagerduty connection/,
    );
    const sync = await inDefaultOrg(() => runSync('inventory-apps', 'manual'));
    expect(sync?.status, JSON.stringify(sync?.logs)).toBe('success');
    expect(sync!.stats.upserted).toBe(2);
    expect((await admin.get('/api/v1/blueprints/app/entities/b')).data.properties.env).toBe('prod'); // field default in the query
    expect(JSON.stringify(sync!.logs)).not.toContain(INV_KEY);

    expect((await integ.get('/api/v1/connections/inv/usage')).data).toEqual({ integrations: ['inventory-apps'], actions: [], fragments: [] });
    const del = await integ.del('/api/v1/connections/inv');
    expect(del.status).toBe(409);
    expect(del.data.error).toMatch(/integration inventory-apps/);
    expect((await admin.del('/api/v1/connectors/inventory')).status).toBe(409);
    // A definition change that would break the connection is refused.
    const { auth: _a, ...noAuth } = inventory();
    void _a;
    const broke = await admin.put('/api/v1/connectors/inventory', { ...noAuth, auth: [{ type: 'bearer' }] });
    expect(broke.status).toBe(400);
    expect(broke.data.error).toMatch(/breaks connection\(s\): inv/);
  });

  it('former presets: a pagerduty integration can name a connection', async () => {
    const pd = await fakeServer((r) => ({ body: { services: [{ id: 'S1', name: 'Billing', auth: r.headers.authorization, accept: r.headers.accept }] } }));
    await admin.put('/api/v1/secrets/PD_TOKEN', { value: 'pd-token-abcdef' });
    await admin.put('/api/v1/blueprints/service', { title: 'Service', schema: { properties: { auth: { type: 'string' }, accept: { type: 'string' } } } });
    expect(
      (
        await integ.put('/api/v1/connections/pd', {
          title: 'PD',
          connector: 'pagerduty',
          fields: { baseUrl: pd.url },
          auth: { type: 'header', token: '${secret:PD_TOKEN}' },
        })
      ).status,
    ).toBe(200);
    const saved = await integ.put('/api/v1/integrations/pd-services', {
      title: 'PD',
      type: 'pagerduty',
      config: { connection: 'pd' },
      mappings: [{ kind: 'service', entity: { blueprint: 'service', identifier: '$lowercase(name)', properties: { auth: 'auth', accept: 'accept' } } }],
    });
    expect(saved.status, JSON.stringify(saved.data)).toBe(200);
    expect((await inDefaultOrg(() => runSync('pd-services', 'manual')))?.status).toBe('success');
    const e = (await admin.get('/api/v1/blueprints/service/entities/billing')).data;
    expect(e.properties).toEqual({ auth: 'Token token=pd-token-abcdef', accept: 'application/vnd.pagerduty+json;version=2' });
    await pd.close();
  });
});

describe('Azure DevOps through one connection', () => {
  it('ingests with the connector (continuation tokens) and with the code source', async () => {
    const conn = await integ.put('/api/v1/connections/ado', {
      title: 'ADO',
      connector: 'azure-devops',
      fields: { baseUrl: srv.url, organization: 'myorg', project: 'Platform' },
      auth: { type: 'basic', password: '${secret:ADO_PAT}' },
    });
    expect(conn.status, JSON.stringify(conn.data)).toBe(200);
    expect((await integ.post('/api/v1/connections/ado/test')).data).toMatchObject({ ok: true, status: 200 });
    const mapping = { kind: 'repository', entity: { blueprint: 'repository', identifier: 'name', properties: { url: 'webUrl' } } };
    for (const [id, type] of [
      ['ado-decl', 'connector'],
      ['ado-code', 'azure-devops'],
    ] as const) {
      const saved = await integ.put(`/api/v1/integrations/${id}`, { title: id, type, config: { connection: 'ado' }, mappings: [mapping] });
      expect(saved.status, JSON.stringify(saved.data)).toBe(200);
      const sync = await inDefaultOrg(() => runSync(id, 'manual'));
      expect(sync?.status, JSON.stringify(sync?.logs)).toBe('success');
      expect(sync!.stats.upserted + sync!.stats.skipped, id).toBe(2);
    }
    expect(srv.received.filter((r) => r.url.includes('continuationToken=tok2')).length).toBe(2);
    expect((await admin.get('/api/v1/blueprints/repository/entities/r2')).data.properties.url).toBe('https://ado/r2');
  });

  it('runs a pipeline invoker through a read-write connection allowed for the workflow', async () => {
    const step = { id: 'run', type: 'invoke', invoker: { type: 'azure-pipeline', connection: 'ado', pipelineId: 3, logs: false } };
    const save = (id: string) => admin.put(`/api/v1/actions/${id}`, { title: id, trigger: { type: 'form' }, steps: [step] });
    expect((await save('deploy')).data.error).toMatch(/read-only/);
    const base = {
      title: 'ADO',
      connector: 'azure-devops',
      fields: { baseUrl: srv.url, organization: 'myorg', project: 'Platform' },
      auth: { type: 'basic', password: '${secret:ADO_PAT}' },
    };
    await integ.put('/api/v1/connections/ado', { ...base, access: 'read-write', allowed: { workflows: ['deploy'] } });
    expect((await save('other')).data.error).toMatch(/not allowed for workflow "other"/);
    const saved = await save('deploy');
    expect(saved.status, JSON.stringify(saved.data)).toBe(200);
    expect(
      (await admin.put('/api/v1/actions/bad', { title: 'b', trigger: { type: 'form' }, steps: [{ ...step, invoker: { ...step.invoker, connection: 'inv' } }] }))
        .data.error,
    ).toMatch(/cannot use connection "inv"/);
    expect((await integ.get('/api/v1/connections/ado/usage')).data.actions).toEqual(['deploy']);

    const runId = (await admin.post('/api/v1/actions/deploy/runs', { inputs: {} })).data.id as string;
    const done = await waitFor(async () => {
      const r = (await admin.get(`/api/v1/runs/${runId}`)).data as { status: string; result: Record<string, unknown>; logs: unknown };
      return ['SUCCESS', 'FAILURE'].includes(r.status) && r;
    }, 25_000);
    expect(done.status, JSON.stringify(done.logs)).toBe('SUCCESS');
    expect(done.result.run).toMatchObject({ runId: 9, result: 'succeeded', organization: `${srv.url}/myorg`, project: 'Platform' });
    const queued = srv.received.find((r) => r.method === 'POST' && r.url.includes('/pipelines/3/runs'))!;
    expect(queued.headers.authorization).toBe(basicPat);
    expect(JSON.stringify(done)).not.toContain(PAT);
  });

  it('authenticates with Entra workload identity (federated token file)', async () => {
    const file = path.join(process.env.DATA_DIR!, 'federated-token');
    fs.writeFileSync(file, 'federated-jwt\n');
    const saved = { file: process.env.AZURE_FEDERATED_TOKEN_FILE, host: process.env.AZURE_AUTHORITY_HOST };
    process.env.AZURE_FEDERATED_TOKEN_FILE = file;
    process.env.AZURE_AUTHORITY_HOST = `${srv.url}/`;
    try {
      const c = await integ.put('/api/v1/connections/ado-wi', {
        title: 'ADO (workload identity)',
        connector: 'azure-devops',
        fields: { baseUrl: srv.url, organization: 'myorg' },
        auth: { type: 'azure-workload-identity', clientId: 'client-1', tenantId: 'tenant-1' },
      });
      expect(c.status, JSON.stringify(c.data)).toBe(200);
      expect((await integ.post('/api/v1/connections/ado-wi/test')).data).toMatchObject({ ok: true, status: 200 });
      expect(srv.received.some((r) => r.url === '/tenant-1/oauth2/v2.0/token')).toBe(true);
    } finally {
      process.env.AZURE_FEDERATED_TOKEN_FILE = saved.file;
      process.env.AZURE_AUTHORITY_HOST = saved.host;
      if (saved.file === undefined) delete process.env.AZURE_FEDERATED_TOKEN_FILE;
      if (saved.host === undefined) delete process.env.AZURE_AUTHORITY_HOST;
    }
  });
});

describe('configuration as code', () => {
  it('applies connectors and connections as managed resources', async () => {
    const dir = fs.mkdtempSync(path.join(process.env.DATA_DIR!, 'conn-'));
    const doc = {
      connectors: [{ identifier: 'cfg-inv', ...inventory() }],
      connections: [
        {
          identifier: 'cfg-conn',
          title: 'Cfg',
          connector: 'cfg-inv',
          fields: { baseUrl: `${srv.url}/inv` },
          auth: { type: 'header', apiKey: '${secret:INV_KEY}' },
        },
      ],
    };
    fs.writeFileSync(path.join(dir, 'connectors.json'), JSON.stringify(doc));
    const errors = await inDefaultOrg(() => applyConfig(readConfigDir(dir), silentLog));
    expect(errors).toEqual([]);
    expect((await admin.get('/api/v1/connections/cfg-conn')).data.managed).toBe(true);
    expect((await admin.get('/api/v1/connectors/cfg-inv')).data).toMatchObject({ managed: true, builtin: false });
    expect((await integ.put('/api/v1/connections/cfg-conn', { ...doc.connections[0], title: 'x' })).status).toBe(409);
    expect((await integ.del('/api/v1/connections/cfg-conn')).status).toBe(409);
    expect((await integ.post('/api/v1/connections/cfg-conn/test')).data.ok).toBe(true);
    const exported = await admin.get('/api/v1/config/export');
    expect(exported.data).toContain('cfg-conn');
    expect(exported.data).not.toContain(INV_KEY);
    // Removed from the files: removed from the platform.
    fs.writeFileSync(path.join(dir, 'connectors.json'), '{}');
    await inDefaultOrg(() => applyConfig(readConfigDir(dir), silentLog));
    expect((await admin.get('/api/v1/connections/cfg-conn')).status).toBe(404);
    expect((await admin.get('/api/v1/connectors/cfg-inv')).status).toBe(404);
  });
});
