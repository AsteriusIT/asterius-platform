import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { client, register, testApp, type Api } from './helpers.js';
import { makeClient } from '../src/ai/model.js';

let app: FastifyInstance;
let admin: Api;
let alice: Api;

const rpc = async (api: Api, method: string, params?: object, id: number | undefined = 1) =>
  api.post('/api/v1/mcp', { jsonrpc: '2.0', ...(id === undefined ? {} : { id }), method, params });
const call = async (api: Api, name: string, args: object = {}) => {
  const res = await rpc(api, 'tools/call', { name, arguments: args });
  return res.data.result as { isError?: boolean; content: { text: string }[] };
};

beforeAll(async () => {
  app = await testApp();
  admin = client(app, (await register(app, 'admin@example.com')).token);
  alice = client(app, (await register(app, 'alice@example.com')).token);
  await admin.put('/api/v1/blueprints/service', { title: 'Service', schema: { properties: { tier: { type: 'string' } } } });
  await admin.put('/api/v1/blueprints/service/entities/checkout', { properties: { tier: 'gold' } });
  await admin.put('/api/v1/actions/hello', {
    trigger: 'create',
    title: 'Say hello',
    inputs: { properties: { name: { type: 'string' } } },
    steps: [{ id: 't', type: 'transform', output: { greeting: '"hi " & inputs.name' } }],
  });
});
afterAll(() => app.close());

describe('platform MCP server', () => {
  it('requires authentication', async () => {
    const res = await rpc(client(app), 'ping');
    expect(res.status).toBe(401);
  });

  it('negotiates the protocol and lists tools', async () => {
    const init = await rpc(alice, 'initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } });
    expect(init.data.result.protocolVersion).toBe('2025-03-26');
    expect(init.data.result.serverInfo.name).toBe('asterius-platform');
    expect((await rpc(alice, 'notifications/initialized', undefined, undefined)).status).toBe(202);
    const tools = (await rpc(alice, 'tools/list')).data.result.tools as { name: string; inputSchema: unknown }[];
    expect(tools.map((t) => t.name)).toEqual(expect.arrayContaining(['search_catalog', 'get_entity', 'trigger_action', 'get_run', 'list_actions']));
    expect(tools.every((t) => t.inputSchema)).toBe(true);
    expect((await rpc(alice, 'nope')).data.error.code).toBe(-32601);
  });

  it('reads the catalog and starts actions with the caller permissions', async () => {
    const found = await call(alice, 'search_catalog', { query: 'check' });
    expect(found.content[0].text).toContain('checkout');
    const actions = JSON.parse((await call(alice, 'list_actions')).content[0].text) as { identifier: string }[];
    expect(actions.map((a) => a.identifier)).toContain('hello');

    const started = await call(alice, 'trigger_action', { action: 'hello', inputs: { name: 'mcp' } });
    expect(started.isError).toBeUndefined();
    const { runId } = JSON.parse(started.content[0].text) as { runId: string };
    const run = JSON.parse((await call(alice, 'get_run', { id: runId })).content[0].text) as { id: string };
    expect(run.id).toBe(runId);

    const bad = await call(alice, 'trigger_action', { action: 'does-not-exist' });
    expect(bad.isError).toBe(true);
    const unknownTool = await rpc(alice, 'tools/call', { name: 'rm_rf' });
    expect(unknownTool.data.error.code).toBe(-32602);
  });

  it('handles batches', async () => {
    const res = await alice.post('/api/v1/mcp', [
      { jsonrpc: '2.0', id: 1, method: 'ping' },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    ]);
    expect(res.data).toHaveLength(2);
  });
});

describe('model providers', () => {
  it('builds Bedrock and Vertex clients without an Anthropic key', async () => {
    const saved = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    expect((await makeClient({ provider: 'bedrock' })).provider).toBe('bedrock');
    await expect(makeClient({ provider: 'vertex' })).rejects.toThrow(/AI_VERTEX_PROJECT/);
    await expect(makeClient({ provider: 'anthropic' })).rejects.toThrow(/No Claude API key/);
    if (saved) process.env.ANTHROPIC_API_KEY = saved;
  });
});
