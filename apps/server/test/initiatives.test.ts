import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { InitiativeDetail, InitiativeEntity, InitiativeExemption, InitiativeTodo, InitiativeView } from '@asterius/shared';
import { client, inDefaultOrg, register, silentLog, testApp, waitFor, type Api } from './helpers.js';

let app: FastifyInstance;
let admin: Api;
let alice: Api; // team core
let bob: Api; // team web, owner of the initiative

const DAY = 86_400_000;
const day = (offset: number) => new Date(Date.now() + offset * DAY).toISOString().slice(0, 10);

const card = {
  title: 'Readiness',
  blueprint: 'app',
  levels: [{ name: 'Bronze' }, { name: 'Silver' }, { name: 'Gold' }],
  rules: [
    { identifier: 'has_owner', title: 'Has an owner', level: 'Bronze', expression: 'team != null' },
    { identifier: 'has_url', title: 'Has a URL', level: 'Silver', expression: 'properties.url != null' },
    { identifier: 'has_tests', title: 'Has tests', level: 'Gold', expression: 'properties.tests = true' },
  ],
};

const initiative = {
  title: 'Everything at Silver',
  description: 'Owners and URLs everywhere',
  scorecard: 'ready',
  targetLevel: 'Silver',
  startDate: day(-10),
  deadline: day(20),
  owner: 'bob@example.com',
};

beforeAll(async () => {
  app = await testApp();
  admin = client(app, (await register(app, 'admin@example.com', 'Admin')).token);
  alice = client(app, (await register(app, 'alice@example.com', 'Alice')).token);
  bob = client(app, (await register(app, 'bob@example.com', 'Bob')).token);
  await admin.put('/api/v1/teams/core', { title: 'Core' });
  await admin.put('/api/v1/teams/web', { title: 'Web' });
  const users = (await admin.get('/api/v1/users')).data as { id: string; email: string }[];
  const id = (email: string) => users.find((u) => u.email === email)!.id;
  await admin.patch(`/api/v1/users/${id('alice@example.com')}`, { teams: ['core'] });
  await admin.patch(`/api/v1/users/${id('bob@example.com')}`, { teams: ['web'] });
  expect(
    (await admin.put('/api/v1/blueprints/app', { title: 'App', schema: { properties: { url: { type: 'string' }, tests: { type: 'boolean' } } } })).status,
  ).toBe(200);
  expect((await admin.put('/api/v1/scorecards/ready', card)).status).toBe(200);
  // a: Silver (core) · b: Bronze (core) · c: Gold (web) · d: no team, below Bronze
  await admin.put('/api/v1/blueprints/app/entities/a', { title: 'A', team: 'core', properties: { url: 'https://a.test' } });
  await admin.put('/api/v1/blueprints/app/entities/b', { title: 'B', team: 'core' });
  await admin.put('/api/v1/blueprints/app/entities/c', { title: 'C', team: 'web', properties: { url: 'https://c.test', tests: true } });
  await admin.put('/api/v1/blueprints/app/entities/d', { title: 'D', properties: { url: 'https://d.test' } });
});
afterAll(() => app.close());

const view = async (api: Api = admin) => ((await api.get('/api/v1/initiatives')).data as InitiativeView[]).find((i) => i.identifier === 'silver')!;

describe('initiatives', () => {
  it('validates the definition against its scorecard and is admin only', async () => {
    expect((await alice.put('/api/v1/initiatives/silver', initiative)).status).toBe(403);
    expect((await admin.put('/api/v1/initiatives/silver', { ...initiative, scorecard: 'nope' })).status).toBe(400);
    expect((await admin.put('/api/v1/initiatives/silver', { ...initiative, targetLevel: 'Platinum' })).status).toBe(400);
    expect((await admin.put('/api/v1/initiatives/silver', { ...initiative, rules: ['nope'] })).status).toBe(400);
    expect((await admin.put('/api/v1/initiatives/silver', { ...initiative, targetLevel: null })).status).toBe(400);
    expect((await admin.put('/api/v1/initiatives/silver', { ...initiative, deadline: day(-20) })).status).toBe(400);
    const r = await admin.put('/api/v1/initiatives/silver', initiative);
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    expect(r.data).toMatchObject({ identifier: 'silver', targetLevel: 'Silver', rules: [], teams: [], enabled: true, reminderDays: 7, managed: false });
  });

  it('computes progress overall and per team, with a status and a trend', async () => {
    const v = await view(alice);
    expect(v.progress).toEqual({ passing: 2, total: 4, exempted: 0, ratio: 0.5 });
    expect(v).toMatchObject({ blueprint: 'app', scorecardTitle: 'Readiness', status: 'on_track' });
    const d = (await alice.get('/api/v1/initiatives/silver')).data as InitiativeDetail;
    expect(d.byTeam).toEqual([
      { team: null, passing: 0, total: 1, exempted: 0, ratio: 0 },
      { team: 'core', passing: 1, total: 2, exempted: 0, ratio: 0.5 },
      { team: 'web', passing: 1, total: 1, exempted: 0, ratio: 1 },
    ]);
    expect(d.requiredRules.map((r) => r.rule)).toEqual(['has_owner', 'has_url']);
    expect(d.trend.at(-1)).toMatchObject({ day: day(0), passing: 2, total: 4, teams: { core: { passing: 1, total: 2 }, '-': { passing: 0, total: 1 } } });

    const failing = (await alice.get('/api/v1/initiatives/silver/entities?status=failing')).data as { items: InitiativeEntity[] };
    expect(failing.items.map((e) => [e.identifier, e.failing.map((f) => f.rule)])).toEqual([
      ['b', ['has_url']],
      ['d', ['has_owner']],
    ]);
    const core = (await alice.get('/api/v1/initiatives/silver/entities?team=core')).data as { items: InitiativeEntity[] };
    expect(core.items.map((e) => e.identifier)).toEqual(['a', 'b']);

    // A rule-only initiative of one team: just has_tests, for web.
    expect(
      (await admin.put('/api/v1/initiatives/tests', { ...initiative, title: 'Tests', targetLevel: null, rules: ['has_tests'], teams: ['web'] })).status,
    ).toBe(200);
    expect(((await admin.get('/api/v1/initiatives/tests')).data as InitiativeDetail).progress).toMatchObject({ passing: 1, total: 1 });
    expect((await admin.del('/api/v1/initiatives/tests')).status).toBe(200);
  });

  it('lists the failing entities of the caller’s teams in their To do', async () => {
    const mine = (await alice.get('/api/v1/me/initiatives')).data as InitiativeTodo[];
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({
      initiative: { identifier: 'silver', title: 'Everything at Silver', deadline: day(20), targetLevel: 'Silver' },
      entity: { blueprint: 'app', identifier: 'b', title: 'B', team: 'core' },
      failing: [{ rule: 'has_url', title: 'Has a URL', level: 'Silver' }],
    });
    expect((await bob.get('/api/v1/me/initiatives')).data).toEqual([]);
  });

  it('exempts entities and rules until they expire, granted by admins or the owner, audited', async () => {
    const until = new Date(Date.now() + 30 * DAY).toISOString();
    expect((await alice.post('/api/v1/initiatives/silver/exemptions', { entity: 'd', reason: 'Decommissioned soon', expiresAt: until })).status).toBe(403);
    expect(
      (await bob.post('/api/v1/initiatives/silver/exemptions', { entity: 'd', reason: 'Decommissioned soon', expiresAt: day(-1) + 'T00:00:00Z' })).status,
    ).toBe(400);
    expect((await bob.post('/api/v1/initiatives/silver/exemptions', { entity: 'zz', reason: 'Nope', expiresAt: until })).status).toBe(404);
    expect((await bob.post('/api/v1/initiatives/silver/exemptions', { entity: 'b', rule: 'nope', reason: 'Nope', expiresAt: until })).status).toBe(400);
    const whole = await bob.post('/api/v1/initiatives/silver/exemptions', { entity: 'd', reason: 'Decommissioned soon', expiresAt: until });
    expect(whole.status, JSON.stringify(whole.data)).toBe(200);
    expect(whole.data).toMatchObject({ entity: 'd', rule: null, active: true, grantedBy: { email: 'bob@example.com' } });
    expect((await view()).progress).toEqual({ passing: 2, total: 3, exempted: 1, ratio: 2 / 3 });

    const rule = await admin.post('/api/v1/initiatives/silver/exemptions', { entity: 'b', rule: 'has_url', reason: 'Internal only', expiresAt: until });
    expect(rule.status).toBe(200);
    expect((await view()).progress).toMatchObject({ passing: 3, total: 3, ratio: 1 });
    expect((await view()).status).toBe('done');
    expect((await alice.get('/api/v1/me/initiatives')).data).toEqual([]);
    const exempt = (await admin.get('/api/v1/initiatives/silver/entities?status=exempt')).data as { items: InitiativeEntity[] };
    expect(exempt.items.map((e) => e.identifier)).toEqual(['d']);

    const list = (await alice.get('/api/v1/initiatives/silver/exemptions')).data as InitiativeExemption[];
    expect(list.map((x) => [x.entity, x.rule])).toEqual(
      expect.arrayContaining([
        ['d', null],
        ['b', 'has_url'],
      ]),
    );
    const audit = (await admin.get('/api/v1/audit?action=initiative.exemption.granted')).data as { items?: unknown[] } | unknown[];
    expect(JSON.stringify(audit)).toContain('initiative.exemption.granted');

    // Expired: the entity counts again.
    await inDefaultOrg(async () => {
      const { run } = await import('../src/db.js');
      await run("UPDATE initiative_exemptions SET expires_at = ? WHERE entity = 'b'", new Date(Date.now() - 1000).toISOString());
    });
    expect((await view()).progress).toMatchObject({ passing: 2, total: 3 });
    expect((await alice.get('/api/v1/me/initiatives')).data).toHaveLength(1);

    // Revoked by the owner.
    const b = list.find((x) => x.entity === 'b')!;
    expect((await alice.del(`/api/v1/initiatives/silver/exemptions/${b.id}`)).status).toBe(403);
    expect((await bob.del(`/api/v1/initiatives/silver/exemptions/${b.id}`)).status).toBe(200);
    expect(((await admin.get('/api/v1/initiatives/silver/exemptions')).data as InitiativeExemption[]).map((x) => x.entity)).toEqual(['d']);
  });

  it('writes one snapshot a day, announces status changes once and reminds the teams once per period', () =>
    inDefaultOrg(async () => {
      const { tickInitiatives } = await import('../src/catalog/initiatives.js');
      const { all, one, run } = await import('../src/db.js');
      expect((await admin.put('/api/v1/webhooks/ini', { title: 'i', url: 'http://127.0.0.1:9/x', events: ['initiative.*'] })).status).toBe(200);
      await run("UPDATE initiatives SET remind_at = ? WHERE identifier = 'silver'", new Date(Date.now() - 1000).toISOString());

      const first = await tickInitiatives();
      expect(first).toMatchObject({ snapshots: 1, reminders: 2 }); // alice (core: b failing) and bob (the owner)
      expect(await tickInitiatives()).toEqual({ snapshots: 0, events: 0, reminders: 0 });
      const snaps = await all<{ team: string; passing: number; total: number }>(
        "SELECT team, passing, total FROM initiative_snapshots WHERE initiative = 'silver'",
      );
      expect(snaps.map((s) => [s.team, Number(s.passing), Number(s.total)]).sort()).toEqual([
        ['', 2, 3],
        ['-', 0, 0],
        ['core', 1, 2],
        ['web', 1, 1],
      ]);
      const notes = (await alice.get('/api/v1/notifications')).data as { items: { kind: string; title: string; link: string }[] };
      expect(notes.items.filter((n) => n.kind === 'initiative.reminder')).toEqual([
        expect.objectContaining({ title: 'Reminder: Everything at Silver', link: '/initiatives/silver' }),
      ]);
      expect(Date.parse((await one<{ remind_at: string }>("SELECT remind_at FROM initiatives WHERE identifier = 'silver'"))!.remind_at)).toBeGreaterThan(
        Date.now() + 6 * DAY,
      );

      // b gets a URL: everything in scope is at Silver → initiative.completed, once.
      await admin.put('/api/v1/blueprints/app/entities/b', { title: 'B', team: 'core', properties: { url: 'https://b.test' } });
      expect((await tickInitiatives()).events).toBe(1);
      expect((await tickInitiatives()).events).toBe(0);
      const deliveries = await waitFor(async () => {
        const d = (await admin.get('/api/v1/webhooks/ini/deliveries')).data as { event: string }[];
        return d.length ? d : undefined;
      });
      expect(deliveries.map((d) => d.event)).toEqual(['initiative.completed']);
    }));

  it('is overdue after the deadline and at risk when behind schedule', async () => {
    const { statusOf, expectedRatio, judge } = await import('../src/catalog/initiatives.js');
    const i = { startDate: '2026-01-01', deadline: '2026-01-10' };
    expect(statusOf(i, { ratio: 1 }, Date.parse('2026-02-01T00:00:00Z'))).toBe('done');
    expect(statusOf(i, { ratio: 0.9 }, Date.parse('2026-01-11T00:00:00Z'))).toBe('overdue');
    expect(statusOf(i, { ratio: 0.9 }, Date.parse('2026-01-10T23:00:00Z'))).toBe('on_track');
    expect(expectedRatio(i, Date.parse('2026-01-06T00:00:00Z'))).toBe(0.5);
    expect(statusOf(i, { ratio: 0.3 }, Date.parse('2026-01-06T00:00:00Z'))).toBe('at_risk');
    expect(statusOf(i, { ratio: 0.45 }, Date.parse('2026-01-06T00:00:00Z'))).toBe('on_track');
    const req = [
      { rule: 'x', title: 'X', level: 'A' },
      { rule: 'y', title: 'Y', level: 'A' },
    ];
    expect(judge([{ rule: 'x', title: 'X', level: 'A', passed: true }], req, new Set())).toMatchObject({ passing: false, failing: [{ rule: 'y' }] });
    expect(judge([{ rule: 'x', title: 'X', level: 'A', passed: true }], req, new Set(['y'])).passing).toBe(true);

    const late = await admin.put('/api/v1/initiatives/late', { ...initiative, title: 'Late', targetLevel: 'Gold', startDate: day(-30), deadline: day(-1) });
    expect(late.status).toBe(200);
    expect(((await admin.get('/api/v1/initiatives')).data as InitiativeView[]).find((x) => x.identifier === 'late')).toMatchObject({ status: 'overdue' });
    await admin.del('/api/v1/initiatives/late');
  });

  it('has a dashboard widget', async () => {
    const r = await admin.put('/api/v1/dashboards/ini', { title: 'Ini', widgets: [{ type: 'initiative', initiative: 'silver', width: 6 }] });
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    const data = (await alice.get('/api/v1/dashboards/ini/data')).data;
    expect(data[0]).toMatchObject({
      type: 'initiative',
      initiative: 'silver',
      title: 'Everything at Silver',
      status: 'done',
      progress: { passing: 3, total: 3 },
    });
  });

  it('is declared in configuration files (managed) and listed by the MCP server', () =>
    inDefaultOrg(async () => {
      const { applyConfig } = await import('../src/config-loader.js');
      const { configFile } = await import('../src/schemas.js');
      const data = configFile.parse({ initiatives: [{ ...initiative, identifier: 'from-git', title: 'From Git' }] });
      expect(await applyConfig({ files: [], hash: 'x', data }, silentLog)).toEqual([]);
      const v = ((await admin.get('/api/v1/initiatives')).data as InitiativeView[]).find((i) => i.identifier === 'from-git');
      expect(v).toMatchObject({ managed: true, status: 'on_track', progress: { passing: 3, total: 4 } }); // exemptions are per initiative
      expect((await admin.put('/api/v1/initiatives/from-git', initiative)).status).toBe(409);
      expect((await admin.del('/api/v1/initiatives/from-git')).status).toBe(409);
      const mcp = await alice.post('/api/v1/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_initiatives', arguments: {} } });
      const listed = JSON.parse(mcp.data.result.content[0].text) as { identifier: string; status: string; passing: number; total: number }[];
      expect(listed).toContainEqual(expect.objectContaining({ identifier: 'from-git', status: 'on_track', passing: 3, total: 4 }));
      // No longer declared: removed.
      expect(await applyConfig({ files: [], hash: 'y', data: configFile.parse({}) }, silentLog)).toEqual([]);
      expect((await admin.get('/api/v1/initiatives/from-git')).status).toBe(404);
    }));

  it('ships a valid example (examples/demo-config/initiatives.yaml)', async () => {
    const path = await import('node:path');
    const { readConfigDir } = await import('../src/config-loader.js');
    const { data } = readConfigDir(path.resolve(__dirname, '../../../examples/demo-config'), { platform: false });
    expect(data.initiatives.map((i) => i.identifier)).toEqual(['supply-chain-silver', 'sbom-everywhere']);
    const sc = data.scorecards.find((s) => s.identifier === 'supply-chain-security')!;
    for (const i of data.initiatives) {
      expect(i.scorecard).toBe(sc.identifier);
      for (const r of i.rules) expect(sc.rules.map((x) => x.identifier)).toContain(r);
      if (i.targetLevel) expect(sc.levels.map((l) => l.name)).toContain(i.targetLevel);
    }
  });
});
