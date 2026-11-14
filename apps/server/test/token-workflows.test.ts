import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { client, fakeServer, register, testApp, type Api } from './helpers.js';

/**
 * An AI agent is a service account (or a person) with an API token restricted to workflows: these tests cover the
 * `workflows` restriction of tokens, the channel recorded on audit entries and runs, and the read-only MCP tools.
 */

let app: FastifyInstance;
let admin: Api;
let alice: Api; // member of team payments
let bot: Api; // alice's token restricted to the workflow `hello`
let docs: Awaited<ReturnType<typeof fakeServer>>;

const rpc = (api: Api, method: string, params?: object) => api.post('/api/v1/mcp', { jsonrpc: '2.0', id: 1, method, params });
const call = async (api: Api, name: string, args: object = {}) => {
  const res = await rpc(api, 'tools/call', { name, arguments: args });
  expect(res.status, JSON.stringify(res.data)).toBe(200);
  return res.data.result as { isError?: boolean; content: { text: string }[] };
};
const text = (r: { content: { text: string }[] }) => r.content[0]!.text;

beforeAll(async () => {
  docs = await fakeServer(() => ({ headers: { 'content-type': 'text/markdown' }, body: '# Checkout docs' }));
  app = await testApp();
  admin = client(app, (await register(app, 'admin@example.com')).token);
  const a = await register(app, 'alice@example.com');
  alice = client(app, a.token);
  await admin.put('/api/v1/teams/payments', { title: 'Payments' });
  expect((await admin.patch(`/api/v1/users/${a.user.id}`, { teams: ['payments'] })).status).toBe(200);
  await admin.put('/api/v1/blueprints/service', { title: 'Service', schema: { properties: { docs: { type: 'string', format: 'docs' } } } });
  await admin.put('/api/v1/blueprints/vault', { title: 'Vault', schema: { properties: {} } });
  await admin.put('/api/v1/blueprints/service/entities/checkout', { team: 'payments', properties: { docs: `${docs.url}/README.md` } });
  await admin.put('/api/v1/blueprints/vault/entities/keys', { team: 'payments', properties: {} });
  await admin.put('/api/v1/scorecards/ready', {
    title: 'Ready',
    blueprint: 'service',
    levels: [{ name: 'Bronze' }],
    rules: [{ identifier: 'owner', title: 'Has an owner', level: 'Bronze', expression: 'team != null' }],
  });
  for (const id of ['hello', 'other'])
    expect(
      (
        await admin.put(`/api/v1/actions/${id}`, {
          trigger: 'create',
          title: id,
          inputs: { properties: { name: { type: 'string' } } },
          steps: [{ id: 't', type: 'transform', output: { greeting: '"hi " & inputs.name' } }],
        })
      ).status,
    ).toBe(200);
  await admin.put('/api/v1/actions/gated', {
    title: 'Gated',
    trigger: { type: 'form', on: 'create', inputs: { properties: {} }, approval: { required: true } },
    steps: [{ id: 't', type: 'transform', output: { x: '1' } }],
  });
});
afterAll(async () => {
  await app.close();
  await docs.close();
});

describe('API tokens restricted to workflows', () => {
  it('are created with a workflows allow-list and listed with it', async () => {
    expect((await alice.post('/api/v1/tokens', { name: 'bad', workflows: ['Not a workflow'] })).status).toBe(400);
    const res = await alice.post('/api/v1/tokens', { name: 'bot', workflows: ['hello'] });
    expect(res.status, JSON.stringify(res.data)).toBe(201);
    bot = client(app, res.data.token);
    const tokens = (await alice.get('/api/v1/tokens')).data as { name: string; workflows: string[] | null }[];
    expect(tokens.find((t) => t.name === 'bot')?.workflows).toEqual(['hello']);
    const created = (await admin.get('/api/v1/audit?action=token.created')).data as { target: string; detail: { workflows: string[] } }[];
    expect(created[0]).toMatchObject({ target: 'bot', detail: { workflows: ['hello'] } });
    // An empty list is no restriction.
    const open = await alice.post('/api/v1/tokens', { name: 'open', workflows: [] });
    expect(((await alice.get('/api/v1/tokens')).data as { name: string; workflows: string[] | null }[]).find((t) => t.name === 'open')?.workflows).toBeNull();
    expect((await client(app, open.data.token).post('/api/v1/actions/other/runs', { inputs: {} })).status).toBe(201);
    // A restricted token cannot mint tokens (it would escape its restriction).
    expect((await bot.post('/api/v1/tokens', { name: 'escape' })).status).toBe(403);
  });

  it('list and start only their workflows, on the API and the MCP endpoint', async () => {
    const listed = JSON.parse(text(await call(bot, 'list_actions'))) as { identifier: string }[];
    expect(listed.map((x) => x.identifier)).toEqual(['hello']);
    expect(((await bot.get('/api/v1/actions')).data as { identifier: string }[]).map((x) => x.identifier)).toEqual(['hello']);
    const ok = await call(bot, 'trigger_action', { action: 'hello', inputs: { name: 'bot' } });
    expect(ok.isError, text(ok)).toBeUndefined();
    const denied = await call(bot, 'trigger_action', { action: 'other' });
    expect(denied.isError).toBe(true);
    expect(text(denied)).toContain('not allowed');
    expect((await bot.post('/api/v1/actions/other/runs', { inputs: {} })).status).toBe(403);
    expect((await bot.post('/api/v1/actions/hello/runs', { inputs: { name: 'rest' } })).status).toBe(201);
    // The same user without the restriction may run both.
    expect((await alice.post('/api/v1/actions/other/runs', { inputs: {} })).status).toBe(201);
    const who = JSON.parse(text(await call(bot, 'whoami'))) as { user: { email: string }; token: { workflows: string[] } };
    expect(who).toMatchObject({ user: { email: 'alice@example.com' }, token: { workflows: ['hello'] } });
    expect(JSON.parse(text(await call(alice, 'whoami')))).not.toHaveProperty('token');
  });

  it('read only the runs of their workflows', async () => {
    const mine = (await alice.get('/api/v1/runs?action=other')).data as { items: { id: string }[] };
    expect(mine.items.length).toBeGreaterThan(0);
    const own = (await bot.get('/api/v1/runs')).data as { items: { action: string }[] };
    expect(own.items.length).toBe(2);
    expect(own.items.every((r) => r.action === 'hello')).toBe(true);
    expect(((await bot.get('/api/v1/runs?action=other')).data as { items: unknown[] }).items).toEqual([]);
    expect((await bot.get(`/api/v1/runs/${mine.items[0]!.id}`)).status).toBe(404);
    expect((await call(bot, 'get_run', { id: mine.items[0]!.id })).isError).toBe(true);
    const viaMcp = JSON.parse(text(await call(bot, 'list_runs', { mine: false }))) as { action: string }[];
    expect(viaMcp.every((r) => r.action === 'hello')).toBe(true);
  });

  it('cannot decide approvals or answer input steps', async () => {
    // An admin could approve; the same admin through a workflow-restricted token cannot.
    const restricted = client(app, (await admin.post('/api/v1/tokens', { name: 'gate-bot', workflows: ['gated'] })).data.token);
    const run = await alice.post('/api/v1/actions/gated/runs', { inputs: {} });
    expect(run.data.status).toBe('PENDING_APPROVAL');
    const refused = await restricted.post(`/api/v1/runs/${run.data.id}/approve`, {});
    expect(refused.status).toBe(403);
    expect(JSON.stringify(refused.data)).toContain('workflow-restricted');
    expect((await restricted.post(`/api/v1/runs/${run.data.id}/reject`, {})).status).toBe(403);
    expect((await restricted.post(`/api/v1/runs/${run.data.id}/steps/x/approve`, {})).status).toBe(403);
    expect((await restricted.post(`/api/v1/runs/${run.data.id}/steps/x/input`, { values: {} })).status).toBe(403);
    // The queue stays readable (as for everyone), and approving is not an MCP tool.
    const tools = ((await rpc(restricted, 'tools/list')).data.result.tools as { name: string }[]).map((t) => t.name);
    expect(tools).toContain('list_approvals');
    expect(tools.some((t) => /approve|reject/.test(t))).toBe(false);
    expect((await admin.post(`/api/v1/runs/${run.data.id}/approve`, {})).status).toBe(200);
  });

  it('scope a service account: the token of an AI agent', async () => {
    const res = await admin.post('/api/v1/service-accounts', { name: 'release-bot', scopes: ['catalog:read', 'runs:trigger'], workflows: ['hello'] });
    expect(res.status, JSON.stringify(res.data)).toBe(201);
    const agent = client(app, res.data.token);
    expect((await agent.post('/api/v1/actions/hello/runs', { inputs: { name: 'sa' } })).status).toBe(201);
    expect((await agent.post('/api/v1/actions/other/runs', { inputs: {} })).status).toBe(403);
    expect((await agent.put('/api/v1/blueprints/service/entities/new-one', { properties: {} })).status).toBe(403); // no catalog:write scope
    expect((await agent.get('/api/v1/audit')).status).toBe(403);
    const all = (await admin.get('/api/v1/tokens?all=true')).data as { name: string; scopes: string[]; workflows: string[] }[];
    expect(all.find((t) => t.name === 'release-bot token')).toMatchObject({ scopes: ['catalog:read', 'runs:trigger'], workflows: ['hello'] });
  });
});

describe('call channels', () => {
  it('are recorded on audit entries and runs, and filter both', async () => {
    const triggered = (await admin.get('/api/v1/audit?action=run.triggered&limit=100')).data as { channel: string; actorEmail: string }[];
    expect([...new Set(triggered.map((e) => e.channel))].sort()).toEqual(['api', 'mcp', 'ui']); // a session (bearer or cookie) is the UI channel
    const mcp = (await admin.get('/api/v1/audit?channel=mcp&action=run.triggered')).data as { channel: string; actorEmail: string }[];
    expect(mcp).toEqual([expect.objectContaining({ channel: 'mcp', actorEmail: 'alice@example.com' })]);
    expect((await admin.get('/api/v1/audit?channel=nope')).status).toBe(400);
    const csv = (await admin.get('/api/v1/audit/export?format=csv&channel=mcp')).data as string;
    expect(csv.split('\n')[0]).toBe('id,at,action,actor,target,detail,channel');
    expect(csv.split('\n')[1]).toMatch(/,mcp$/);

    const viaMcp = (await admin.get('/api/v1/runs?channel=mcp')).data as { items: { channel: string; action: string }[] };
    expect(viaMcp.items).toEqual([expect.objectContaining({ channel: 'mcp', action: 'hello' })]);
    const viaApi = (await admin.get('/api/v1/runs?channel=api&action=hello')).data as { items: { channel: string }[] };
    expect(viaApi.items.length).toBe(2); // the restricted token and the service account
    const viaUi = (await admin.get('/api/v1/runs?channel=ui&action=gated')).data as { items: { channel: string }[] };
    expect(viaUi.items[0]).toMatchObject({ channel: 'ui' });
    expect((await admin.get('/api/v1/runs?channel=nope')).status).toBe(400);
  });
});

describe('MCP read tools', () => {
  it('exposes scorecards, entity docs and DORA insights with the caller permissions', async () => {
    const cards = JSON.parse(text(await call(alice, 'get_scorecards', { blueprint: 'service', identifier: 'checkout' }))) as {
      scorecard: string;
      level: string;
    }[];
    expect(cards[0]).toMatchObject({ scorecard: 'ready', level: 'Bronze' });
    expect((await call(alice, 'get_scorecards', { blueprint: 'service', identifier: 'ghost' })).isError).toBe(true);
    const doc = JSON.parse(text(await call(alice, 'get_entity_docs', { blueprint: 'service', identifier: 'checkout' }))) as { markdown: string };
    expect(doc.markdown).toContain('# Checkout docs');
    expect((await call(alice, 'get_entity_docs', { blueprint: 'vault', identifier: 'keys' })).isError).toBe(true); // no docs property
    const insights = JSON.parse(text(await call(alice, 'get_dora_insights', { days: 7 }))) as { days: number };
    expect(insights).toHaveProperty('deploymentFrequency');
    expect(text(await call(alice, 'search_catalog', { query: '' }))).toContain('checkout');
    const tools = (await rpc(alice, 'tools/list')).data.result.tools as { name: string; annotations?: { readOnlyHint?: boolean } }[];
    for (const n of ['get_scorecards', 'get_entity_docs', 'get_dora_insights', 'list_initiatives'])
      expect(tools.find((t) => t.name === n)?.annotations?.readOnlyHint).toBe(true);
  });
});
