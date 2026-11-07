import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { client, register, testApp } from './helpers.js';

/** The MCP server at its documented address (/api/mcp), with API tokens of two organizations. */

let app: FastifyInstance;
let apiToken: string;
let otherToken: string;

async function rpc(token: string | undefined, method: string, params: unknown = {}, id = 1) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/mcp',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    payload: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : undefined };
}

const call = async (token: string, name: string, args: Record<string, unknown> = {}) => {
  const r = await rpc(token, 'tools/call', { name, arguments: args });
  const text = r.body.result.content[0].text as string;
  let data: unknown = text;
  try {
    data = JSON.parse(text);
  } catch {
    // plain-text answer (e.g. "No entity matches")
  }
  return { isError: !!r.body.result.isError, data: data as any }; // eslint-disable-line @typescript-eslint/no-explicit-any
};

beforeAll(async () => {
  app = await testApp();
  const admin = (await register(app, 'admin@example.com', 'Admin')).token;
  const api = client(app, admin);
  await api.put('/api/v1/blueprints/service', { title: 'Service', schema: { properties: { tier: { type: 'integer' } } } });
  await api.post('/api/v1/blueprints/service/entities', { identifier: 'billing', title: 'Billing', properties: { tier: 1 } });
  await api.put('/api/v1/actions/scaffold', {
    title: 'Scaffold a service',
    trigger: { type: 'form', on: 'create', blueprint: 'service', inputs: { properties: { name: { type: 'string' } }, required: ['name'] } },
    steps: [{ id: 'create', type: 'invoke', invoker: { type: 'catalog', operation: 'upsert', blueprint: 'service', identifier: '{{ inputs.name }}' } }],
  });
  apiToken = (await api.post('/api/v1/tokens', { name: 'mcp' })).data.token;
  // Another organization: its token must not see the default organization's catalog or runs.
  const carol = (await register(app, 'carol@example.com', 'Carol')).token;
  expect((await client(app, carol).post('/api/orgs', { slug: 'other', name: 'Other' })).status).toBe(201);
  otherToken = (await client(app, carol, 'other').post('/api/v1/tokens', { name: 'mcp' })).data.token;
});
afterAll(() => app.close());

describe('MCP server and organizations', () => {
  it('requires a token and lists the tools, without any approval decision', async () => {
    expect((await rpc(undefined, 'tools/list')).status).toBe(401);
    const tools = (await rpc(apiToken, 'tools/list')).body.result.tools as { name: string }[];
    expect(tools.map((t) => t.name)).toEqual(
      expect.arrayContaining(['whoami', 'search_catalog', 'get_entity', 'list_actions', 'trigger_action', 'list_approvals']),
    );
    expect(tools.map((t) => t.name).filter((n) => /approve|decide|reject/.test(n))).toEqual([]);
  });

  it('works in the organization of the token', async () => {
    expect((await call(apiToken, 'whoami')).data.organization.slug).toBe('default');
    expect((await call(otherToken, 'whoami')).data.organization.slug).toBe('other');
    const found = await call(apiToken, 'search_catalog', { query: 'bill' });
    expect(JSON.stringify(found.data)).toContain('billing');
    expect(JSON.stringify((await call(otherToken, 'search_catalog', { query: 'bill' })).data)).not.toContain('billing');
    expect(JSON.stringify((await call(otherToken, 'get_entity', { blueprint: 'service', identifier: 'billing' })).data)).not.toContain('Billing');
  });

  it('starts runs in the token organization only', async () => {
    const run = await call(apiToken, 'trigger_action', { action: 'scaffold', inputs: { name: 'ledger' } });
    expect(run.isError).toBe(false);
    expect((await call(apiToken, 'get_run', { id: run.data.runId })).data.id).toBe(run.data.runId);
    expect((await call(otherToken, 'get_run', { id: run.data.runId })).isError).toBe(true);
    expect((await call(otherToken, 'trigger_action', { action: 'scaffold', inputs: { name: 'x' } })).isError).toBe(true);
  });
});
