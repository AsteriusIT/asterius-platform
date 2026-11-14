import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { client, fakeServer, register, testApp, type Api } from './helpers.js';

let app: FastifyInstance;
let admin: Api;
let alice: Api; // member of team payments (owner of the agent)
let bob: Api; // member without a team
let aliceToken: string;
let botToken: string;
let docs: Awaited<ReturnType<typeof fakeServer>>;

const rpc = (api: Api, method: string, params?: object, headers?: Record<string, string>) =>
  api.post('/api/v1/mcp', { jsonrpc: '2.0', id: 1, method, params }, headers);
const call = async (api: Api, name: string, args: object = {}, headers?: Record<string, string>) => {
  const res = await rpc(api, 'tools/call', { name, arguments: args }, headers);
  expect(res.status, JSON.stringify(res.data)).toBe(200);
  return res.data.result as { isError?: boolean; content: { text: string }[] };
};
const text = (r: { content: { text: string }[] }) => r.content[0]!.text;

const bot = { title: 'Release bot', description: 'Ships releases', ownerTeam: 'payments', workflows: ['hello'], blueprints: ['service'] };

beforeAll(async () => {
  docs = await fakeServer(() => ({ headers: { 'content-type': 'text/markdown' }, body: '# Checkout docs' }));
  app = await testApp();
  admin = client(app, (await register(app, 'admin@example.com')).token);
  const a = await register(app, 'alice@example.com');
  aliceToken = a.token;
  alice = client(app, a.token);
  bob = client(app, (await register(app, 'bob@example.com')).token);
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

describe('agent registry', () => {
  it('is managed by admins and visible to the owner team', async () => {
    expect((await bob.put('/api/v1/agents/bot', bot)).status).toBe(403);
    expect((await admin.put('/api/v1/agents/bot', { ...bot, ownerTeam: 'nobody' })).status).toBe(400);
    expect((await admin.put('/api/v1/agents/bot', { ...bot, blueprints: ['*', 'service'] })).status).toBe(400);
    const res = await admin.put('/api/v1/agents/bot', bot);
    expect(res.status, JSON.stringify(res.data)).toBe(200);
    expect(res.data).toMatchObject({ identifier: 'bot', enabled: true, version: 1, managed: false });
    expect(((await alice.get('/api/v1/agents')).data as { identifier: string }[]).map((x) => x.identifier)).toEqual(['bot']);
    expect((await bob.get('/api/v1/agents')).data).toEqual([]);
    expect((await bob.get('/api/v1/agents/bot')).status).toBe(404);
    const audit = (await admin.get('/api/v1/audit?action=agent.created')).data as { target: string; channel: string }[];
    expect(audit[0]).toMatchObject({ target: 'bot', channel: 'ui', agent: null }); // a session (bearer or cookie) is the UI channel
  });

  it('issues tokens to admins and owner-team members only', async () => {
    expect((await bob.post('/api/v1/agents/bot/tokens', {})).status).toBe(403);
    const res = await alice.post('/api/v1/agents/bot/tokens', { name: 'ci' });
    expect(res.status, JSON.stringify(res.data)).toBe(201);
    botToken = res.data.token;
    expect(botToken).toMatch(/^ast_/);
    const tokens = (await alice.get('/api/v1/agents/bot/tokens')).data as { name: string; agent: string }[];
    expect(tokens).toEqual([expect.objectContaining({ name: 'ci', agent: 'bot' })]);
    expect(((await admin.get('/api/v1/agents')).data as { tokens: number }[])[0]!.tokens).toBe(1);
    // An agent token cannot mint more tokens.
    expect((await client(app, botToken).post('/api/v1/agents/bot/tokens', {})).status).toBe(403);
  });
});

describe('agent permissions: the intersection of the allow-lists and the user rights', () => {
  it('sees and starts only its allowed workflows', async () => {
    const agent = client(app, botToken);
    const listed = JSON.parse(text(await call(agent, 'list_actions'))) as { identifier: string }[];
    expect(listed.map((x) => x.identifier)).toEqual(['hello']);
    const ok = await call(agent, 'trigger_action', { action: 'hello', inputs: { name: 'bot' } });
    expect(ok.isError, text(ok)).toBeUndefined();
    const denied = await call(agent, 'trigger_action', { action: 'other' });
    expect(denied.isError).toBe(true);
    expect(text(denied)).toContain('not allowed');
    expect((await agent.post('/api/v1/actions/other/runs', { inputs: {} })).status).toBe(403);
    expect((await agent.post('/api/v1/actions/hello/runs', { inputs: { name: 'rest' } })).status).toBe(201);
    // The same user without the agent may run both.
    expect((await alice.post('/api/v1/actions/other/runs', { inputs: {} })).status).toBe(201);
  });

  it('reads only its allowed blueprints', async () => {
    const agent = client(app, botToken);
    const found = text(await call(agent, 'search_catalog', { query: '' }));
    expect(found).toContain('checkout');
    expect(found).not.toContain('keys');
    expect(text(await call(agent, 'get_entity', { blueprint: 'vault', identifier: 'keys' }))).toContain('No entity');
    expect(((await agent.get('/api/v1/blueprints')).data as { identifier: string }[]).map((b) => b.identifier)).toEqual(['service']);
    expect((await agent.get('/api/v1/blueprints/vault/entities/keys')).status).toBe(404);
    expect(((await agent.get('/api/v1/blueprints/vault/entities')).data as { items: unknown[] }).items).toEqual([]);
    expect((await alice.get('/api/v1/blueprints/vault/entities/keys')).status).toBe(200);
    // The scorecard and docs tools apply the same rules.
    expect((await call(agent, 'get_scorecards', { blueprint: 'vault', identifier: 'keys' })).isError).toBe(true);
  });

  it('never approves, writes or administers, and has no approval queue', async () => {
    const agent = client(app, botToken);
    const run = await alice.post('/api/v1/actions/gated/runs', { inputs: {} });
    expect(run.data.status).toBe('PENDING_APPROVAL');
    expect((await agent.post(`/api/v1/runs/${run.data.id}/approve`, {})).status).toBe(403);
    expect((await agent.post(`/api/v1/runs/${run.data.id}/steps/x/approve`, {})).status).toBe(403);
    expect((await agent.put('/api/v1/blueprints/service/entities/new-one', { properties: {} })).status).toBe(403);
    expect((await agent.get('/api/v1/audit')).status).toBe(403);
    const tools = (await rpc(agent, 'tools/list')).data.result.tools as { name: string }[];
    expect(tools.map((t) => t.name)).not.toContain('list_approvals');
    expect((await rpc(alice, 'tools/list')).data.result.tools.map((t: { name: string }) => t.name)).toContain('list_approvals');
    const unknown = await rpc(agent, 'tools/call', { name: 'list_approvals', arguments: {} });
    expect(unknown.data.error.code).toBe(-32602);
    const who = JSON.parse(text(await call(agent, 'whoami'))) as { user: { email: string }; agent: { identifier: string } };
    expect(who).toMatchObject({ user: { email: 'alice@example.com' }, agent: { identifier: 'bot' } });
  });

  it('records the agent and the channel on audit entries and runs', async () => {
    const byAgent = (await admin.get('/api/v1/audit?agent=bot&action=run.triggered')).data as { channel: string; agent: string; actorEmail: string }[];
    expect(byAgent.length).toBe(2);
    expect(byAgent.map((e) => e.channel).sort()).toEqual(['api', 'mcp']);
    expect(byAgent.every((e) => e.agent === 'bot' && e.actorEmail === 'alice@example.com')).toBe(true);
    const people = (await admin.get('/api/v1/audit?agent=-&action=run.triggered')).data as { agent: string | null }[];
    expect(people.length).toBeGreaterThan(0);
    expect(people.every((e) => e.agent === null)).toBe(true);
    expect(((await admin.get('/api/v1/audit?agent=*&channel=mcp')).data as unknown[]).length).toBeGreaterThan(0);
    const facets = (await admin.get('/api/v1/audit/facets')).data as { agents: { value: string }[] };
    expect(facets.agents.map((a) => a.value)).toContain('bot');

    const runs = (await admin.get('/api/v1/runs?agent=bot')).data as { items: { agent: string; channel: string; action: string }[] };
    expect(runs.items.length).toBe(2);
    expect(runs.items.every((r) => r.agent === 'bot' && r.action === 'hello')).toBe(true);
    const human = (await admin.get('/api/v1/runs?agent=-&action=other')).data as { items: { agent: string | null; channel: string }[] };
    expect(human.items[0]).toMatchObject({ agent: null, channel: 'ui' });
    // The agent itself reads the runs of its workflows only.
    const own = (await client(app, botToken).get('/api/v1/runs')).data as { items: { action: string }[] };
    expect(own.items.length).toBeGreaterThan(0);
    expect(own.items.every((r) => r.action === 'hello')).toBe(true);
  });

  it('stops at once when the agent is disabled', async () => {
    await admin.put('/api/v1/agents/bot', { ...bot, enabled: false });
    expect((await rpc(client(app, botToken), 'ping')).status).toBe(403);
    expect((await client(app, botToken).get('/api/v1/blueprints')).status).toBe(403);
    await admin.put('/api/v1/agents/bot', bot);
    expect((await rpc(client(app, botToken), 'ping')).status).toBe(200);
  });

  it('lets a person act as an agent on the MCP endpoint (owner team only)', async () => {
    const asBot = { 'x-asterius-agent': 'bot' };
    const who = JSON.parse(text(await call(alice, 'whoami', {}, asBot))) as { agent: { identifier: string } | null };
    expect(who.agent?.identifier).toBe('bot');
    const listed = JSON.parse(text(await call(alice, 'list_actions', {}, asBot))) as { identifier: string }[];
    expect(listed.map((x) => x.identifier)).toEqual(['hello']);
    expect((await rpc(bob, 'ping', undefined, asBot)).status).toBe(403);
    expect((await rpc(alice, 'ping', undefined, { 'x-asterius-agent': 'ghost' })).status).toBe(403);
    // A token bound to an agent cannot claim another one.
    expect((await rpc(client(app, botToken), 'ping', undefined, { 'x-asterius-agent': 'other-bot' })).status).toBe(403);
    // `?agent=` for clients that cannot set headers.
    const res = await app.inject({
      method: 'POST',
      url: '/api/mcp?agent=bot',
      headers: { authorization: `Bearer ${aliceToken}`, 'content-type': 'application/json' },
      payload: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'whoami', arguments: {} } }),
    });
    expect(JSON.parse(res.json().result.content[0].text).agent.identifier).toBe('bot');
  });

  it('revokes the tokens of a deleted agent', async () => {
    await admin.put('/api/v1/agents/tmp', { ...bot, title: 'Temp' });
    const t = (await alice.post('/api/v1/agents/tmp/tokens', {})).data.token as string;
    expect((await rpc(client(app, t), 'ping')).status).toBe(200);
    expect((await admin.del('/api/v1/agents/tmp')).status).toBe(200);
    expect((await rpc(client(app, t), 'ping')).status).toBe(401);
  });
});

describe('MCP read tools', () => {
  it('exposes scorecards, entity docs and DORA insights with the caller permissions', async () => {
    const cards = JSON.parse(text(await call(alice, 'get_scorecards', { blueprint: 'service', identifier: 'checkout' }))) as {
      scorecard: string;
      level: string;
    }[];
    expect(cards[0]).toMatchObject({ scorecard: 'ready', level: 'Bronze' });
    const doc = JSON.parse(text(await call(alice, 'get_entity_docs', { blueprint: 'service', identifier: 'checkout' }))) as { markdown: string };
    expect(doc.markdown).toContain('# Checkout docs');
    expect((await call(alice, 'get_entity_docs', { blueprint: 'vault', identifier: 'keys' })).isError).toBe(true); // no docs property
    const insights = JSON.parse(text(await call(alice, 'get_dora_insights', { days: 7 }))) as { days: number };
    expect(insights).toHaveProperty('deploymentFrequency');
    const tools = (await rpc(alice, 'tools/list')).data.result.tools as { name: string; annotations?: { readOnlyHint?: boolean } }[];
    for (const n of ['get_scorecards', 'get_entity_docs', 'get_dora_insights']) expect(tools.find((t) => t.name === n)?.annotations?.readOnlyHint).toBe(true);
  });
});

describe('configuration as code', () => {
  it('declares agents and MCP servers as managed resources', async () => {
    const { applyConfig } = await import('../src/config-loader.js');
    const { configFile } = await import('../src/schemas.js');
    const { inDefaultOrg, silentLog } = await import('./helpers.js');
    const declared = configFile.parse({
      agents: [{ identifier: 'cfg-bot', title: 'Config bot', ownerTeam: 'payments', workflows: ['hello'], blueprints: ['*'] }],
      mcpServers: [{ identifier: 'cfg-mcp', title: 'Config MCP', url: 'https://mcp.example.com/mcp', tools: ['search'] }],
    });
    const errors = await inDefaultOrg(() => applyConfig({ files: [], hash: 'h1', data: declared }, silentLog));
    expect(errors).toEqual([]);
    const agent = ((await admin.get('/api/v1/agents')).data as { identifier: string; managed: boolean }[]).find((a) => a.identifier === 'cfg-bot');
    expect(agent?.managed).toBe(true);
    expect((await admin.put('/api/v1/agents/cfg-bot', { title: 'x', ownerTeam: 'payments' })).status).toBe(409);
    expect(((await admin.get('/api/v1/mcp-servers/cfg-mcp')).data as { managed: boolean }).managed).toBe(true);
    // Removed from the files: removed from the platform.
    await inDefaultOrg(() => applyConfig({ files: [], hash: 'h2', data: configFile.parse({}) }, silentLog));
    expect((await admin.get('/api/v1/agents/cfg-bot')).status).toBe(404);
    expect((await admin.get('/api/v1/mcp-servers/cfg-mcp')).status).toBe(404);
  });

  it('a personal API token is the api channel and cannot issue agent tokens', async () => {
    const t = (await alice.post('/api/v1/tokens', { name: 'laptop' })).data.token as string;
    const viaToken = client(app, t);
    expect((await viaToken.post('/api/v1/agents/bot/tokens', {})).status).toBe(403);
    await viaToken.post('/api/v1/actions/other/runs', { inputs: {} });
    const runs = (await admin.get('/api/v1/runs?action=other&channel=api')).data as { items: { channel: string }[] };
    expect(runs.items.length).toBe(1);
  });
});
