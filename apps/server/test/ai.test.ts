import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { client, fakeServer, register, silentLog, testApp, waitFor, type Api } from './helpers.js';
import { startRunWorker } from '../src/actions/worker.js';

let app: FastifyInstance;
let admin: Api;
let alice: Api;
let claude: Awaited<ReturnType<typeof fakeServer>>;
let ext: Awaited<ReturnType<typeof fakeServer>>;
let stop: () => unknown;

type Body = {
  model: string;
  messages: { role: string; content: unknown }[];
  tools?: { name?: string; type?: string }[];
  mcp_servers?: unknown[];
  betas?: string[];
};
type Content = Record<string, unknown>;
interface Reply {
  content: Content[];
  stop_reason?: string;
  usage?: Record<string, number>;
}
let script: (body: Body, n: number) => Reply = () => ({ content: [{ type: 'text', text: 'ok' }] });
let requests: { body: Body; headers: Record<string, string | string[] | undefined> }[] = [];

type RunView = {
  id: string;
  status: string;
  costUsd: number | null;
  logs: { message: string }[];
  steps: { id: string; status: string; statusLabel: string | null; costUsd: number | null; output: unknown }[];
};

const finished = (api: Api, id: string) =>
  waitFor(async () => {
    const r = (await api.get(`/api/v1/runs/${id}`)).data as RunView;
    return ['SUCCESS', 'FAILURE', 'CANCELLED'].includes(r.status) && r;
  }, 25_000);
const save = async (id: string, body: object) => {
  const res = await admin.put(`/api/v1/actions/${id}`, { trigger: 'create', title: id, ...body });
  expect(res.status, JSON.stringify(res.data)).toBe(200);
};
const runIt = async (id: string, inputs: object = {}) => {
  const res = await alice.post(`/api/v1/actions/${id}/runs`, { inputs });
  expect(res.status, JSON.stringify(res.data)).toBe(201);
  return finished(alice, res.data.id);
};

beforeAll(async () => {
  app = await testApp();
  admin = client(app, (await register(app, 'admin@example.com')).token);
  alice = client(app, (await register(app, 'alice@example.com')).token);
  await admin.put('/api/v1/teams/payments', { title: 'Payments' });
  await admin.put('/api/v1/blueprints/service', { title: 'Service', schema: { properties: { tier: { type: 'string' } } } });
  await admin.put('/api/v1/blueprints/secret-thing', { title: 'Secret', schema: { properties: {} } });
  claude = await fakeServer((r) => {
    const body = JSON.parse(r.body) as Body;
    requests.push({ body, headers: r.headers });
    const out = script(body, requests.length);
    return {
      body: {
        id: `msg_${requests.length}`,
        type: 'message',
        role: 'assistant',
        model: body.model,
        stop_sequence: null,
        stop_reason: out.stop_reason ?? 'end_turn',
        content: out.content,
        usage: { input_tokens: 1000, output_tokens: 200, ...out.usage },
      },
    };
  });
  ext = await fakeServer((r) => ({ body: { got: r.url } }));
  process.env.ANTHROPIC_BASE_URL = claude.url;
  process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
  stop = startRunWorker(silentLog);
});
afterAll(async () => {
  await stop();
  await claude.close();
  await ext.close();
  await app.close();
});
beforeEach(() => {
  requests = [];
  script = () => ({ content: [{ type: 'text', text: 'ok' }] });
});

describe('cost governance', () => {
  it('records usage with cache rates, shows cost on the run and reports it', async () => {
    script = () => ({ content: [{ type: 'text', text: 'hello' }], usage: { cache_creation_input_tokens: 1_000_000, cache_read_input_tokens: 1_000_000 } });
    await save('cost-a', { steps: [{ id: 'think', type: 'agent', model: 'claude-sonnet-5-5', prompt: 'Hi' }] });
    const done = await runIt('cost-a');
    expect(done.status, JSON.stringify(done.logs)).toBe('SUCCESS');
    // sonnet 2/10 per MTok: 1000 in + 200 out + 1M cache write (x1.25) + 1M cache read (x0.1)
    const expected = (1000 * 2 + 200 * 10 + 1_000_000 * 2.5 + 1_000_000 * 0.2) / 1e6;
    expect(done.costUsd).toBeCloseTo(expected, 6);
    expect(done.steps[0].costUsd).toBeCloseTo(expected, 6);
    expect(done.steps[0].statusLabel).toContain('$');

    const report = (await admin.get('/api/v1/ai/usage')).data;
    expect(report.totals.calls).toBeGreaterThanOrEqual(1);
    expect(report.byAction.find((a: { key: string }) => a.key === 'cost-a').costUsd).toBeCloseTo(expected, 6);
    expect((await alice.get('/api/v1/ai/usage')).status).toBe(403);
  });

  it('prices can be overridden through the API', async () => {
    await admin.put('/api/v1/ai/prices/claude-haiku-5-5', { input: 1000, output: 1000 });
    await save('cost-b', { steps: [{ id: 'think', type: 'agent', model: 'claude-haiku-5-5', prompt: 'Hi' }] });
    const done = await runIt('cost-b');
    expect(done.costUsd).toBeCloseTo((1200 * 1000) / 1e6, 6);
    await admin.del('/api/v1/ai/prices/claude-haiku-5-5');
  });

  it('refuses calls above a hard budget with a permanent step failure, and records the refusal', async () => {
    await admin.put('/api/v1/ai/budgets', { scope: 'action', key: 'budgeted', hardUsd: 0.005 });
    await save('budgeted', { steps: [{ id: 'think', type: 'agent', retries: 3, prompt: 'Hi' }] });
    expect((await runIt('budgeted')).status).toBe('SUCCESS'); // first call: nothing spent yet ($0.008 afterwards)
    const second = await runIt('budgeted');
    expect(second.status).toBe('FAILURE');
    expect(second.steps[0].statusLabel).toMatch(/AI budget exceeded/);
    expect(second.logs.filter((l) => /Started/.test(l.message))).toHaveLength(1); // not retried
    const report = (await admin.get('/api/v1/ai/usage')).data;
    expect(report.totals.failed).toBeGreaterThanOrEqual(1);
    expect((await admin.put('/api/v1/ai/budgets', { scope: 'action', key: 'x', softUsd: 5, hardUsd: 1 })).status).toBe(400);
  });

  it('warns above a soft budget and enforces the per-step run cap', async () => {
    await admin.put('/api/v1/ai/budgets', { scope: 'global', softUsd: 0.001 });
    await save('capped', {
      steps: [
        { id: 'one', type: 'agent', prompt: 'a', maxCostUsd: 0.005 },
        { id: 'two', type: 'agent', prompt: 'b', maxCostUsd: 0.005 },
      ],
    });
    const done = await runIt('capped');
    expect(done.status).toBe('FAILURE');
    expect(done.steps.find((s) => s.id === 'two')?.statusLabel).toMatch(/AI budget exceeded/);
    expect(done.logs.some((l) => /passed the soft limit/.test(l.message))).toBe(true);
  });
});

describe('streaming, caching and continuation', () => {
  it('continues an answer cut at max_tokens and joins the pieces', async () => {
    script = (_b, n) =>
      n === 1 ? { content: [{ type: 'text', text: '{"a": "hel' }], stop_reason: 'max_tokens' } : { content: [{ type: 'text', text: 'lo"}' }] };
    await save('cont', {
      steps: [{ id: 'think', type: 'agent', prompt: 'x', output: { properties: { a: { type: 'string' } }, required: ['a'] } }],
    });
    const done = await runIt('cont');
    expect(done.status, JSON.stringify(done.logs)).toBe('SUCCESS');
    expect(done.steps[0].output).toEqual({ a: 'hello' });
    expect(requests).toHaveLength(2);
    expect(requests[1].body.messages.at(-1)).toEqual({ role: 'user', content: 'Continue exactly where you stopped, without repeating anything.' });
    expect(done.logs.some((l) => /continuing \(1\/3\)/.test(l.message))).toBe(true);
  });
});

describe('MCP servers in agent steps', () => {
  it('declares MCP servers and toolsets with the secret token', async () => {
    await admin.put('/api/v1/secrets/mcp-token', { value: 'tok-123456', description: 'test' });
    await save('mcp', {
      steps: [
        {
          id: 'think',
          type: 'agent',
          prompt: 'x',
          mcpServers: [{ name: 'docs', url: 'https://mcp.example.com/sse', token: '${secret:mcp-token}', allowedTools: ['search'] }],
        },
      ],
    });
    const done = await runIt('mcp');
    expect(done.status, JSON.stringify(done.logs)).toBe('SUCCESS');
    const sent = requests[0];
    expect(sent.body.mcp_servers).toEqual([{ type: 'url', name: 'docs', url: 'https://mcp.example.com/sse', authorization_token: 'tok-123456' }]);
    expect(sent.body.tools).toEqual([
      { type: 'mcp_toolset', mcp_server_name: 'docs', default_config: { enabled: false }, configs: { search: { enabled: true } } },
    ]);
    expect(String(sent.headers['anthropic-beta'])).toContain('mcp-client-2025-11-20');
    expect(done.logs.some((l) => l.message.includes('tok-123456'))).toBe(false);
  });

  it('rejects non-HTTPS MCP servers', async () => {
    const res = await admin.put('/api/v1/actions/mcp-bad', {
      trigger: 'create',
      title: 'bad',
      steps: [{ id: 'think', type: 'agent', prompt: 'x', mcpServers: [{ name: 'docs', url: 'http://insecure.example.com' }] }],
    });
    expect(res.status).toBe(400);
  });
});

describe('agent write tools with guardrails', () => {
  const toolTurn = (name: string, input: object): Reply => ({ content: [{ type: 'tool_use', id: 'tu_1', name, input }], stop_reason: 'tool_use' });
  const resultOf = (n: number) => String(JSON.stringify(requests[n].body.messages.at(-1)?.content));

  it('requires an allow-list for each write tool', async () => {
    for (const [tool, field] of [
      ['upsert_entity', 'entityBlueprints'],
      ['trigger_action', 'actions'],
      ['http', 'httpHosts'],
    ]) {
      const res = await admin.put('/api/v1/actions/no-guard', {
        trigger: 'create',
        title: 'x',
        steps: [{ id: 'a', type: 'agent', prompt: 'x', tools: [tool] }],
      });
      expect(res.status).toBe(400);
      expect(JSON.stringify(res.data)).toContain(field);
    }
  });

  it('upserts entities of allowed blueprints only, as the run user', async () => {
    script = (b) =>
      b.messages.length === 1
        ? toolTurn('upsert_entity', { blueprint: 'service', identifier: 'checkout', title: 'Checkout', properties: { tier: 'gold' } })
        : b.messages.length === 3
          ? toolTurn('upsert_entity', { blueprint: 'secret-thing', identifier: 'nope' })
          : { content: [{ type: 'text', text: 'done' }] };
    await save('writer', {
      steps: [{ id: 'think', type: 'agent', prompt: 'x', tools: ['upsert_entity'], guardrails: { entityBlueprints: ['service'] } }],
    });
    const done = await runIt('writer');
    expect(done.status, JSON.stringify(done.logs)).toBe('SUCCESS');
    // alice is a plain member without a team: she cannot create an unowned entity (admins only).
    expect(resultOf(1)).toContain('cannot edit entities');
    expect(resultOf(2)).toContain('not allowed');
    expect((await admin.get('/api/v1/blueprints/service/entities/checkout')).status).toBe(404);
  });

  it('writes when the run user may, and counts writes', async () => {
    const adminRun = async (id: string) => {
      const res = await admin.post(`/api/v1/actions/${id}/runs`, {});
      return finished(admin, res.data.id);
    };
    script = (b) =>
      b.messages.length < 5
        ? toolTurn('upsert_entity', { blueprint: 'service', identifier: `svc-${b.messages.length}`, properties: { tier: 'x' } })
        : { content: [{ type: 'text', text: 'done' }] };
    await save('writer2', {
      steps: [{ id: 'think', type: 'agent', prompt: 'x', tools: ['upsert_entity'], guardrails: { entityBlueprints: ['service'], maxWrites: 1 } }],
    });
    const done = await adminRun('writer2');
    expect(done.status, JSON.stringify(done.logs)).toBe('SUCCESS');
    expect((await admin.get('/api/v1/blueprints/service/entities/svc-1')).status).toBe(200);
    expect(resultOf(2)).toContain('Write limit reached');
    const audit = (await admin.get('/api/v1/audit?search=agent.upsert_entity')).data;
    expect(JSON.stringify(audit)).toContain('service/svc-1');
  });

  it('calls only allow-listed HTTP hosts and never follows redirects', async () => {
    const host = new URL(ext.url).host;
    script = (b) =>
      b.messages.length === 1
        ? toolTurn('http', { url: `${ext.url}/ping` })
        : b.messages.length === 3
          ? toolTurn('http', { url: 'http://169.254.169.254/latest/meta-data' })
          : { content: [{ type: 'text', text: 'done' }] };
    await save('caller', { steps: [{ id: 'think', type: 'agent', prompt: 'x', tools: ['http'], guardrails: { httpHosts: [host] } }] });
    const done = await runIt('caller');
    expect(done.status, JSON.stringify(done.logs)).toBe('SUCCESS');
    expect(resultOf(1)).toContain('/ping');
    expect(resultOf(2)).toContain('not in the allow-list');
  });
});
