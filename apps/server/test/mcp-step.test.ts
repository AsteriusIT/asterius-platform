import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { client, fakeServer, register, silentLog, testApp, waitFor, type Api } from './helpers.js';
import { startRunWorker } from '../src/actions/worker.js';
import { rpcAnswer } from '../src/ai/mcp-client.js';
import { mcpToolName } from '../src/ai/mcp-tools.js';

let app: FastifyInstance;
let admin: Api;
let claude: Awaited<ReturnType<typeof fakeServer>>;
let mcp: Awaited<ReturnType<typeof fakeServer>>;
let stop: () => unknown;

type Body = { model: string; messages: { role: string; content: unknown }[]; tools?: { name?: string }[] };
interface Reply {
  content: Record<string, unknown>[];
  stop_reason?: string;
}
let script: (body: Body) => Reply = () => ({ content: [{ type: 'text', text: 'ok' }] });
let claudeCalls: Body[] = [];
/** JSON-RPC calls received by the fake MCP server. */
let mcpCalls: { method: string; url?: string; params?: { name?: string; arguments?: unknown }; session?: string; auth?: string }[] = [];

const toolTurn = (name: string, input: object): Reply => ({ content: [{ type: 'tool_use', id: 'tu_1', name, input }], stop_reason: 'tool_use' });
type RunView = { id: string; status: string; logs: { message: string }[]; steps: { output: unknown }[] };
const runIt = async (id: string) => {
  const res = await admin.post(`/api/v1/actions/${id}/runs`, { inputs: {} });
  expect(res.status, JSON.stringify(res.data)).toBe(201);
  return waitFor(async () => {
    const r = (await admin.get(`/api/v1/runs/${res.data.id}`)).data as RunView;
    return ['SUCCESS', 'FAILURE', 'CANCELLED'].includes(r.status) && r;
  }, 25_000);
};

/** A connection of the built-in `mcp` connector: the organization's MCP gateway. */
const gateway = {
  title: 'MCP gateway',
  connector: 'mcp',
  fields: { baseUrl: '' },
  auth: { type: 'bearer', token: '${secret:mcp-token}' },
  access: 'read-write',
};
const agentStep = (tools: string[], connection = 'gateway', extra: object = {}) => ({
  id: 'think',
  type: 'agent',
  prompt: 'x',
  tools: ['mcp'],
  mcp: { connection },
  guardrails: { mcpTools: tools, ...extra },
});
const save = (id: string, step: object) => admin.put(`/api/v1/actions/${id}`, { trigger: 'create', title: id, steps: [step] });

beforeAll(async () => {
  mcp = await fakeServer((r) => {
    const m = JSON.parse(r.body) as { id?: number; method: string; params?: { name?: string; arguments?: { text?: string } } };
    mcpCalls.push({ method: m.method, url: r.url, params: m.params, session: r.headers['mcp-session-id'] as string, auth: r.headers.authorization });
    if (m.id === undefined) return { status: 202, body: {} };
    const ok = (result: object) => ({ body: { jsonrpc: '2.0', id: m.id, result } });
    if (m.method === 'initialize')
      return {
        ...ok({ protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'tickets', version: '2' } }),
        headers: { 'mcp-session-id': 'sess-1' },
      };
    if (m.method === 'tools/list')
      return ok({
        tools: [
          { name: 'echo', description: 'Echo text', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } },
          { name: 'delete_all', description: 'Delete everything', inputSchema: { type: 'object', properties: {} } },
        ],
      });
    if (m.method === 'tools/call') return ok({ content: [{ type: 'text', text: `echo: ${m.params?.arguments?.text ?? ''}` }] });
    return { body: { jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'no' } } };
  });
  gateway.fields.baseUrl = `${mcp.url}/mcp`;
  claude = await fakeServer((r) => {
    const body = JSON.parse(r.body) as Body;
    claudeCalls.push(body);
    const out = script(body);
    return {
      body: {
        id: `msg_${claudeCalls.length}`,
        type: 'message',
        role: 'assistant',
        model: body.model,
        stop_sequence: null,
        stop_reason: out.stop_reason ?? 'end_turn',
        content: out.content,
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    };
  });
  process.env.ANTHROPIC_BASE_URL = claude.url;
  process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
  app = await testApp();
  admin = client(app, (await register(app, 'admin@example.com')).token);
  await admin.put('/api/v1/secrets/mcp-token', { value: 'tok-123456789012345678901234567890' });
  stop = startRunWorker(silentLog);
});
afterAll(async () => {
  await stop();
  await app.close();
  await claude.close();
  await mcp.close();
});
beforeEach(() => {
  claudeCalls = [];
  mcpCalls = [];
  script = () => ({ content: [{ type: 'text', text: 'ok' }] });
});

describe('the mcp tool of AI agent steps, through a connection', () => {
  it('uses a connection of the built-in mcp connector: credentials are references, test sends initialize', async () => {
    const def = (await admin.get('/api/v1/connectors/mcp')).data;
    expect(def).toMatchObject({ identifier: 'mcp', category: 'ai', builtin: true });
    const plain = await admin.put('/api/v1/connections/gateway', { ...gateway, auth: { type: 'bearer', token: 'tok-in-clear' } });
    expect(plain.status).toBe(400);
    expect(JSON.stringify(plain.data)).toContain('references');
    const res = await admin.put('/api/v1/connections/gateway', gateway);
    expect(res.status, JSON.stringify(res.data)).toBe(200);
    expect((await admin.post('/api/v1/connections/gateway/test')).data).toMatchObject({ ok: true, status: 200 });
    // The endpoint itself (no trailing slash added), with the connection's credentials.
    expect(mcpCalls).toEqual([expect.objectContaining({ method: 'initialize', url: '/mcp', auth: 'Bearer tok-123456789012345678901234567890' })]);
  });

  it('rejects at save time a step without allow-list, without connection, or with a connection it may not use', async () => {
    const noList = await save('no-list', { id: 'a', type: 'agent', prompt: 'x', tools: ['mcp'], mcp: { connection: 'gateway' } });
    expect(noList.status).toBe(400);
    expect(JSON.stringify(noList.data)).toContain('mcpTools');
    const noConn = await save('no-conn', { id: 'a', type: 'agent', prompt: 'x', tools: ['mcp'], guardrails: { mcpTools: ['echo'] } });
    expect(noConn.status).toBe(400);
    expect(JSON.stringify(noConn.data)).toContain('mcp.connection');
    expect((await save('bad-name', agentStep(['not a tool']))).status).toBe(400);
    const ghost = await save('ghost', agentStep(['echo'], 'ghost'));
    expect(ghost.status).toBe(400);
    expect(JSON.stringify(ghost.data)).toContain('unknown connection');
    // Not an MCP connection.
    await admin.put('/api/v1/connections/graf', {
      title: 'Grafana',
      connector: 'grafana',
      fields: { baseUrl: mcp.url },
      auth: gateway.auth,
      access: 'read-write',
    });
    expect(((await save('wrong-kind', agentStep(['echo'], 'graf'))).data as { error: string }).error).toContain('of the "mcp" connector');
    // Read-only, or reserved to other workflows.
    await admin.put('/api/v1/connections/ro', { ...gateway, access: 'read' });
    expect(JSON.stringify((await save('read-only', agentStep(['echo'], 'ro'))).data)).toContain('read-only');
    await admin.put('/api/v1/connections/reserved', { ...gateway, allowed: { workflows: ['mcp-ok'] } });
    const denied = await save('mcp-denied', agentStep(['echo'], 'reserved'));
    expect(denied.status).toBe(400);
    expect(JSON.stringify(denied.data)).toContain('not allowed');
    expect((await save('mcp-ok', agentStep(['echo'], 'reserved'))).status).toBe(200);
    // The step counts as a use of the connection.
    expect((await admin.get('/api/v1/connections/reserved/usage')).data).toMatchObject({ actions: ['mcp-ok'] });
    expect((await admin.del('/api/v1/connections/reserved')).status).toBe(409);
  });

  it('an AI step calls an allow-listed tool through the platform, audited', async () => {
    const echo = mcpToolName('echo');
    script = (b) => (b.messages.length === 1 ? toolTurn(echo, { text: 'hi' }) : { content: [{ type: 'text', text: 'done' }] });
    const done = await runIt('mcp-ok');
    expect(done.status, JSON.stringify(done.logs)).toBe('SUCCESS');
    // Only the allow-listed tool is offered to the model.
    expect(claudeCalls[0]!.tools?.map((t) => t.name)).toEqual([echo]);
    expect(mcpCalls.filter((c) => c.method === 'tools/call')).toEqual([
      expect.objectContaining({ params: { name: 'echo', arguments: { text: 'hi' } }, session: 'sess-1', auth: 'Bearer tok-123456789012345678901234567890' }),
    ]);
    expect(JSON.stringify(claudeCalls[1]!.messages.at(-1)?.content)).toContain('echo: hi');
    const audit = (await admin.get('/api/v1/audit?action=agent.mcp_call')).data as { target: string; channel: string; detail: { runId: string } }[];
    expect(audit[0]).toMatchObject({ target: 'reserved/echo', channel: 'workflow', detail: { runId: done.id } });
  });

  it('never calls a tool outside the allow-list', async () => {
    // The model asks for a tool the step does not allow: refused without reaching the server.
    script = (b) => (b.messages.length === 1 ? toolTurn(mcpToolName('delete_all'), {}) : { content: [{ type: 'text', text: 'done' }] });
    expect((await runIt('mcp-ok')).status).toBe('SUCCESS');
    expect(JSON.stringify(claudeCalls[1]!.messages.at(-1)?.content)).toContain('Unknown tool');
    expect(mcpCalls.some((c) => c.method === 'tools/call')).toBe(false);

    // The step allows a tool the server does not offer: the step fails before the model is called.
    expect((await save('mcp-unknown', agentStep(['echo', 'search']))).status).toBe(200);
    claudeCalls = [];
    const failed = await runIt('mcp-unknown');
    expect(failed.status).toBe('FAILURE');
    expect(JSON.stringify(failed.logs)).toContain('does not offer the tool \\"search\\"');
    expect(claudeCalls.length).toBe(0);
  });

  it('fails the step before the model is called when the connection stops allowing the workflow', async () => {
    expect((await save('mcp-later', agentStep(['echo']))).status).toBe(200);
    // Narrowed after the workflow was saved: to other workflows, then to read-only, then removed from the MCP connector's reach.
    await admin.put('/api/v1/connections/gateway', { ...gateway, allowed: { workflows: ['someone-else'] } });
    let failed = await runIt('mcp-later');
    expect(failed.status).toBe('FAILURE');
    expect(JSON.stringify(failed.logs)).toContain('not allowed for workflow');
    await admin.put('/api/v1/connections/gateway', { ...gateway, access: 'read' });
    failed = await runIt('mcp-later');
    expect(JSON.stringify(failed.logs)).toContain('read-only');
    // Team allow-lists are checked against the run's team.
    await admin.put('/api/v1/connections/gateway', { ...gateway, allowed: { teams: ['payments'] } });
    failed = await runIt('mcp-later');
    expect(JSON.stringify(failed.logs)).toContain('not allowed for workflow');
    expect(claudeCalls.length).toBe(0);
    expect(mcpCalls.length).toBe(0);
    await admin.put('/api/v1/connections/gateway', gateway);
    expect((await runIt('mcp-later')).status).toBe('SUCCESS');
  });

  it('counts MCP calls against the write limit', async () => {
    const echo = mcpToolName('echo');
    script = (b) => (b.messages.length < 5 ? toolTurn(echo, { text: String(b.messages.length) }) : { content: [{ type: 'text', text: 'done' }] });
    expect((await save('mcp-limit', agentStep(['echo'], 'gateway', { maxWrites: 1 }))).status).toBe(200);
    expect((await runIt('mcp-limit')).status).toBe('SUCCESS');
    expect(mcpCalls.filter((c) => c.method === 'tools/call').length).toBe(1);
    expect(JSON.stringify(claudeCalls[2]!.messages.at(-1)?.content)).toContain('Write limit reached');
  });
});

describe('MCP client', () => {
  it('reads responses from an event stream', () => {
    const sse =
      'event: message\ndata: {"jsonrpc":"2.0","method":"notifications/progress"}\n\nevent: message\ndata: {"jsonrpc":"2.0","id":3,"result":{"ok":true}}\n\n';
    expect(rpcAnswer(undefined, sse, 'text/event-stream', 3).result).toEqual({ ok: true });
    expect(() => rpcAnswer(undefined, sse, 'text/event-stream', 4)).toThrow(/without the response/);
    expect(rpcAnswer({ jsonrpc: '2.0', id: 1, error: { message: 'x' } }, '', 'application/json', 1).error?.message).toBe('x');
  });

  it('names tools within the model limits', () => {
    expect(mcpToolName('echo')).toBe('mcp_echo');
    expect(mcpToolName('ns.tool:v1')).toBe('mcp_ns_tool_v1');
    const long = mcpToolName('b'.repeat(120));
    expect(long.length).toBe(64);
    expect(long).not.toBe(mcpToolName(`${'b'.repeat(119)}c`));
  });
});
