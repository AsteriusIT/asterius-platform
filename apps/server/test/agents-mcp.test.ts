import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { client, fakeServer, register, silentLog, testApp, waitFor, type Api } from './helpers.js';
import { startRunWorker } from '../src/actions/worker.js';
import { rpcAnswer } from '../src/agents/mcp-client.js';
import { mcpToolName } from '../src/agents/mcp-tools.js';

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
let mcpCalls: { method: string; params?: { name?: string; arguments?: unknown }; session?: string; auth?: string }[] = [];

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

const server = { title: 'Tickets', url: '', auth: { type: 'bearer', token: '${secret:mcp-token}' }, tools: ['echo', 'search'] };

beforeAll(async () => {
  mcp = await fakeServer((r) => {
    const m = JSON.parse(r.body) as { id?: number; method: string; params?: { name?: string; arguments?: { text?: string } } };
    mcpCalls.push({ method: m.method, params: m.params, session: r.headers['mcp-session-id'] as string, auth: r.headers.authorization });
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
  server.url = `${mcp.url}/mcp`;
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

describe('external MCP servers', () => {
  it('are admin-only and accept credentials as references only', async () => {
    const bob = client(app, (await register(app, 'bob@example.com')).token);
    expect((await bob.put('/api/v1/mcp-servers/tickets', server)).status).toBe(403);
    const plain = await admin.put('/api/v1/mcp-servers/tickets', { ...server, auth: { type: 'bearer', token: 'tok-in-clear' } });
    expect(plain.status).toBe(400);
    expect(JSON.stringify(plain.data)).toContain('references');
    expect((await admin.put('/api/v1/mcp-servers/tickets', { ...server, tools: [] })).status).toBe(400);
    expect((await admin.put('/api/v1/mcp-servers/tickets', { ...server, url: 'ftp://x' })).status).toBe(400);
    const res = await admin.put('/api/v1/mcp-servers/tickets', server);
    expect(res.status, JSON.stringify(res.data)).toBe(200);
    expect(res.data).toMatchObject({ identifier: 'tickets', tools: ['echo', 'search'], version: 1 });
  });

  it('test lists the server tools against the allow-list', async () => {
    const r = (await admin.post('/api/v1/mcp-servers/tickets/test', {})).data;
    expect(r).toMatchObject({ ok: true, server: { name: 'tickets', protocolVersion: '2025-06-18' }, missing: ['search'] });
    expect(r.tools).toEqual([
      { name: 'echo', description: 'Echo text', allowed: true },
      { name: 'delete_all', description: 'Delete everything', allowed: false },
    ]);
    expect(mcpCalls.find((c) => c.method === 'tools/list')).toMatchObject({ session: 'sess-1', auth: 'Bearer tok-123456789012345678901234567890' });
    expect(mcpCalls.some((c) => c.method === 'tools/call')).toBe(false);
  });

  it('an agent step needs an mcpTools allow-list', async () => {
    const res = await admin.put('/api/v1/actions/no-list', { trigger: 'create', title: 'x', steps: [{ id: 'a', type: 'agent', prompt: 'x', tools: ['mcp'] }] });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.data)).toContain('mcpTools');
    const bad = await admin.put('/api/v1/actions/no-list', {
      trigger: 'create',
      title: 'x',
      steps: [{ id: 'a', type: 'agent', prompt: 'x', tools: ['mcp'], guardrails: { mcpTools: ['not a ref'] } }],
    });
    expect(bad.status).toBe(400);
  });

  it('an AI step calls an allow-listed tool through the platform, audited', async () => {
    const echo = mcpToolName('tickets', 'echo');
    script = (b) => (b.messages.length === 1 ? toolTurn(echo, { text: 'hi' }) : { content: [{ type: 'text', text: 'done' }] });
    await admin.put('/api/v1/actions/mcp-ok', {
      trigger: 'create',
      title: 'mcp ok',
      steps: [{ id: 'think', type: 'agent', prompt: 'x', tools: ['mcp'], guardrails: { mcpTools: ['tickets/echo'] } }],
    });
    const done = await runIt('mcp-ok');
    expect(done.status, JSON.stringify(done.logs)).toBe('SUCCESS');
    // Only the allow-listed tool is offered to the model.
    expect(claudeCalls[0]!.tools?.map((t) => t.name)).toEqual([echo]);
    expect(mcpCalls.filter((c) => c.method === 'tools/call')).toEqual([
      expect.objectContaining({ params: { name: 'echo', arguments: { text: 'hi' } }, session: 'sess-1' }),
    ]);
    expect(JSON.stringify(claudeCalls[1]!.messages.at(-1)?.content)).toContain('echo: hi');
    const audit = (await admin.get('/api/v1/audit?action=agent.mcp_call')).data as { target: string; channel: string }[];
    expect(audit[0]).toMatchObject({ target: 'tickets/echo', channel: 'workflow' });
  });

  it('never calls a tool outside both allow-lists', async () => {
    // The model asks for a tool the step does not allow: refused without reaching the server.
    script = (b) => (b.messages.length === 1 ? toolTurn(mcpToolName('tickets', 'delete_all'), {}) : { content: [{ type: 'text', text: 'done' }] });
    await admin.put('/api/v1/actions/mcp-model', {
      trigger: 'create',
      title: 'mcp model',
      steps: [{ id: 'think', type: 'agent', prompt: 'x', tools: ['mcp'], guardrails: { mcpTools: ['tickets/echo'] } }],
    });
    expect((await runIt('mcp-model')).status).toBe('SUCCESS');
    expect(JSON.stringify(claudeCalls[1]!.messages.at(-1)?.content)).toContain('Unknown tool');
    expect(mcpCalls.some((c) => c.method === 'tools/call')).toBe(false);

    // The step allows a tool the server does not: the step fails before the model is called.
    await admin.put('/api/v1/actions/mcp-step', {
      trigger: 'create',
      title: 'mcp step',
      steps: [{ id: 'think', type: 'agent', prompt: 'x', tools: ['mcp'], guardrails: { mcpTools: ['tickets/delete_all'] } }],
    });
    claudeCalls = [];
    const failed = await runIt('mcp-step');
    expect(failed.status).toBe('FAILURE');
    expect(JSON.stringify(failed.logs)).toContain('does not allow');
    expect(claudeCalls.length).toBe(0);

    // Unknown and disabled servers fail closed too.
    await admin.put('/api/v1/actions/mcp-ghost', {
      trigger: 'create',
      title: 'ghost',
      steps: [{ id: 'think', type: 'agent', prompt: 'x', tools: ['mcp'], guardrails: { mcpTools: ['ghost/echo'] } }],
    });
    expect(JSON.stringify((await runIt('mcp-ghost')).logs)).toContain('not registered');
    await admin.put('/api/v1/mcp-servers/tickets', { ...server, enabled: false });
    expect(JSON.stringify((await runIt('mcp-ok')).logs)).toContain('disabled');
    await admin.put('/api/v1/mcp-servers/tickets', server);
    expect(mcpCalls.some((c) => c.method === 'tools/call')).toBe(false);
  });

  it('counts MCP calls against the write limit', async () => {
    const echo = mcpToolName('tickets', 'echo');
    script = (b) => (b.messages.length < 5 ? toolTurn(echo, { text: String(b.messages.length) }) : { content: [{ type: 'text', text: 'done' }] });
    await admin.put('/api/v1/actions/mcp-limit', {
      trigger: 'create',
      title: 'limit',
      steps: [{ id: 'think', type: 'agent', prompt: 'x', tools: ['mcp'], guardrails: { mcpTools: ['tickets/echo'], maxWrites: 1 } }],
    });
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
    expect(mcpToolName('tickets', 'echo')).toBe('mcp_tickets_echo');
    expect(mcpToolName('t', 'ns.tool:v1')).toBe('mcp_t_ns_tool_v1');
    const long = mcpToolName('a'.repeat(60), 'b'.repeat(60));
    expect(long.length).toBe(64);
    expect(long).not.toBe(mcpToolName('a'.repeat(60), `${'b'.repeat(59)}c`));
  });
});
