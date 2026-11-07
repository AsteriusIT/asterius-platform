import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { client, register, testApp, type Api } from './helpers.js';

let app: FastifyInstance;
let admin: Api;
let alice: Api;

beforeAll(async () => {
  app = await testApp();
  admin = client(app, (await register(app, 'admin@example.com')).token);
  const al = await register(app, 'alice@example.com');
  alice = client(app, al.token);
  await admin.put('/api/v1/teams/payments', { title: 'Payments' });
  await admin.patch(`/api/v1/users/${al.user.id}`, { teams: ['payments'] });
  await admin.put('/api/v1/blueprints/svc', {
    title: 'Service',
    schema: { properties: { lang: { type: 'string' }, tier: { type: 'integer' } } },
  });
  for (const [id, lang, team] of [
    ['a', 'go', 'payments'],
    ['b', 'go', null],
    ['c', 'rust', null],
  ])
    await admin.put(`/api/v1/blueprints/svc/entities/${id}`, { team, properties: { lang, tier: 1 } });
  await admin.put('/api/v1/scorecards/q', {
    title: 'Quality',
    blueprint: 'svc',
    levels: [{ name: 'Bronze' }],
    rules: [{ identifier: 'has_team', title: 'Has a team', level: 'Bronze', expression: 'team != null' }],
  });
  await admin.post('/api/v1/scorecards/q/evaluate', {}); // the evaluation on save is fire-and-forget: wait for it
});
afterAll(() => app.close());

describe('dashboards', () => {
  const dashboard = {
    title: 'Overview',
    default: true,
    widgets: [
      { type: 'count', title: 'Services', blueprint: 'svc', width: 3 },
      { type: 'count', title: 'By language', blueprint: 'svc', groupBy: 'lang' },
      { type: 'count', title: 'Go services', blueprint: 'svc', filters: { lang: 'go' } },
      { type: 'scorecard', scorecard: 'q' },
      { type: 'table', blueprint: 'svc', filters: { lang: 'go' }, limit: 5 },
      { type: 'runs', mine: true },
      { type: 'approvals' },
      { type: 'markdown', content: '# Hello' },
      { type: 'scorecard', title: 'Broken', scorecard: 'ghost' },
    ],
  };

  it('validates and is admin only to write', async () => {
    expect((await alice.put('/api/v1/dashboards/main', dashboard)).status).toBe(403);
    expect((await admin.put('/api/v1/dashboards/main', { ...dashboard, widgets: [{ type: 'nope' }] })).status).toBe(400);
    expect((await admin.put('/api/v1/dashboards/main', dashboard)).status).toBe(200);
  });

  it('computes widget data for the viewer, isolating failures', async () => {
    const data = (await alice.get('/api/v1/dashboards/main/data')).data;
    expect(data[0]).toMatchObject({ type: 'count', value: 3 });
    expect(data[1].groups).toEqual([
      { key: 'go', count: 2 },
      { key: 'rust', count: 1 },
    ]);
    expect(data[2]).toMatchObject({ value: 2 });
    expect(data[3]).toMatchObject({ type: 'scorecard', total: 3, distribution: { Bronze: 1, none: 2 } });
    expect(data[4]).toMatchObject({ type: 'table', total: 2 });
    expect(data[5]).toMatchObject({ type: 'runs', total: 0 });
    expect(data[6]).toMatchObject({ type: 'approvals', total: 0 });
    expect(data[7]).toEqual({ type: 'markdown' });
    expect(data[8].error).toContain('ghost');
  });

  it('resolves the dashboard of the home page (team first, then default) and of a blueprint', async () => {
    expect((await alice.get('/api/v1/dashboards/resolve')).data.identifier).toBe('main');
    await admin.put('/api/v1/dashboards/payments-home', { title: 'Payments', team: 'payments', widgets: [] });
    expect((await alice.get('/api/v1/dashboards/resolve')).data.identifier).toBe('payments-home');
    expect((await admin.get('/api/v1/dashboards/resolve')).data.identifier).toBe('main');

    expect((await alice.get('/api/v1/dashboards/resolve?blueprint=svc')).data).toBeNull();
    await admin.put('/api/v1/dashboards/svc-page', { title: 'Services', blueprint: 'svc', widgets: [{ type: 'markdown', content: 'x' }] });
    expect((await alice.get('/api/v1/dashboards/resolve?blueprint=svc')).data.identifier).toBe('svc-page');
    expect((await admin.del('/api/v1/dashboards/svc-page')).status).toBe(200);
  });
});
