import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { client, register, testApp, waitFor, type Api } from './helpers.js';
import { inDefaultOrg } from './helpers.js';

let app: FastifyInstance;
let admin: Api;
let bob: Api;

const card = {
  title: 'Production readiness',
  blueprint: 'svc',
  levels: [{ name: 'Bronze' }, { name: 'Silver', color: 'gray' }, { name: 'Gold', color: 'yellow' }],
  rules: [
    { identifier: 'has_owner', title: 'Has an owner', level: 'Bronze', expression: 'team != null' },
    { identifier: 'has_url', title: 'Has a URL', level: 'Silver', expression: 'properties.url != null' },
    { identifier: 'dep_tier', title: 'Depends on tier 1', level: 'Gold', expression: '$count(related.dependsOn[properties.tier = 1]) > 0' },
  ],
};

beforeAll(async () => {
  app = await testApp();
  admin = client(app, (await register(app, 'admin@example.com')).token);
  bob = client(app, (await register(app, 'bob@example.com')).token);
  await admin.put('/api/v1/teams/core', { title: 'Core' });
  const bp = await admin.put('/api/v1/blueprints/svc', {
    title: 'Svc',
    schema: { properties: { url: { type: 'string' }, tier: { type: 'integer' } } },
    relations: { dependsOn: { target: 'svc', many: true } },
  });
  expect(bp.status, JSON.stringify(bp.data)).toBe(200);
});
afterAll(() => app.close());

describe('scorecards', () => {
  it('validates the definition and is admin only', async () => {
    expect((await bob.put('/api/v1/scorecards/pr', card)).status).toBe(403);
    expect((await admin.put('/api/v1/scorecards/pr', { ...card, rules: [{ ...card.rules[0], level: 'Platinum' }] })).status).toBe(400);
    expect((await admin.put('/api/v1/scorecards/pr', { ...card, rules: [{ ...card.rules[0], expression: 'a +' }] })).status).toBe(400);
    expect((await admin.put('/api/v1/scorecards/pr', { ...card, blueprint: 'nope' })).status).toBe(400);
    expect((await admin.put('/api/v1/scorecards/pr', card)).status).toBe(200);
  });

  it('evaluates on entity write, stores the level and emits scorecard.changed', async () => {
    await admin.put('/api/v1/webhooks/hook', { title: 'h', url: 'http://127.0.0.1:9/x', events: ['scorecard.changed'] });
    await admin.put('/api/v1/blueprints/svc/entities/core-api', { title: 'Core API', properties: { tier: 1 } });
    let r = await admin.get('/api/v1/blueprints/svc/entities/core-api/scorecards');
    expect(r.data[0]).toMatchObject({ scorecard: 'pr', level: null, passed: 0, total: 3 });

    await admin.put('/api/v1/blueprints/svc/entities/core-api', { title: 'Core API', team: 'core', properties: { tier: 1, url: 'https://x.test' } });
    r = await admin.get('/api/v1/blueprints/svc/entities/core-api/scorecards');
    expect(r.data[0]).toMatchObject({ level: 'Silver', passed: 2, levelColor: 'gray' });

    await admin.put('/api/v1/blueprints/svc/entities/web', { team: 'core', properties: { url: 'https://w.test' }, relations: { dependsOn: ['core-api'] } });
    r = await admin.get('/api/v1/blueprints/svc/entities/web/scorecards');
    expect(r.data[0]).toMatchObject({ level: 'Gold', passed: 3 });

    const events = await waitFor(async () => {
      const d = (await admin.get('/api/v1/webhooks/hook/deliveries')).data as { event: string }[];
      return d.length >= 1 ? d : undefined;
    });
    expect(events.every((e) => e.event === 'scorecard.changed')).toBe(true);
  });

  it('exposes table levels, summary and the level to workflow contexts', () =>
    inDefaultOrg(async () => {
      const lv = await admin.get('/api/v1/blueprints/svc/scorecard-levels?ids=core-api,web');
      expect(lv.data).toEqual({ pr: { 'core-api': 'Silver', web: 'Gold' } });
      const sum = await admin.get('/api/v1/scorecards/pr/summary?days=3');
      expect(sum.data.distribution).toMatchObject({ Silver: 1, Gold: 1, Bronze: 0, none: 0 });
      expect(sum.data.trend).toHaveLength(3);
      expect(sum.data.trend[2].distribution).toMatchObject({ Silver: 1, Gold: 1 });
      const { scorecardLevels } = await import('../src/catalog/scorecards.js');
      expect((await scorecardLevels('svc', 'web')).pr).toMatchObject({ level: 'Gold', rank: 3 });
    }));

  it('re-evaluates every entity when the scorecard changes', async () => {
    const changed = { ...card, rules: [card.rules[0], { ...card.rules[1], expression: 'properties.url = "https://x.test"' }, card.rules[2]] };
    expect((await admin.put('/api/v1/scorecards/pr', changed)).status).toBe(200);
    await waitFor(async () => (await admin.get('/api/v1/blueprints/svc/entities/web/scorecards')).data[0].level === 'Bronze');
  });

  it('removes results with the entity and refuses to delete a blueprint in use', async () => {
    await admin.del('/api/v1/blueprints/svc/entities/web');
    expect((await admin.get('/api/v1/blueprints/svc/scorecard-levels?ids=web')).data).toEqual({});
    expect((await admin.del('/api/v1/blueprints/svc')).status).toBe(409);
    expect((await admin.del('/api/v1/scorecards/pr')).status).toBe(200);
  });
});
