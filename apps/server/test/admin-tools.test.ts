import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { client, register, testApp, type Api } from './helpers.js';

let app: FastifyInstance;
let admin: Api;
let bob: Api;

beforeAll(async () => {
  app = await testApp();
  admin = client(app, (await register(app, 'admin@example.com')).token);
  bob = client(app, (await register(app, 'bob@example.com')).token);
  await admin.put('/api/v1/teams/payments', { title: 'Payments' });
  await admin.put('/api/v1/teams/platform', { title: 'Platform' });
});
afterAll(() => app.close());

describe('audit filters', () => {
  it('filters by action prefix, actor and target, and lists facets', async () => {
    const teams = await admin.get('/api/v1/audit?action=team.*');
    expect(teams.data.length).toBeGreaterThanOrEqual(2);
    expect(teams.data.every((a: { action: string }) => a.action.startsWith('team.'))).toBe(true);
    const target = await admin.get('/api/v1/audit?target=payments');
    expect(target.data.map((a: { target: string }) => a.target)).toEqual(['payments']);
    expect((await admin.get('/api/v1/audit?actor=nobody@')).data).toEqual([]);
    expect((await admin.get('/api/v1/audit?from=2999-01-01')).data).toEqual([]);
    const facets = await admin.get('/api/v1/audit/facets');
    expect(facets.data.actions.map((a: { value: string }) => a.value)).toContain('team.created');
    expect(facets.data.actors.map((a: { value: string }) => a.value)).toContain('admin@example.com');
    expect((await bob.get('/api/v1/audit/facets')).status).toBe(403);
  });
});

describe('deliveries', () => {
  it('lists across webhooks and redelivers in bulk', async () => {
    expect((await admin.get('/api/v1/deliveries?status=failed')).data).toEqual([]);
    const res = await admin.post('/api/v1/deliveries/redeliver', { ids: ['missing'] });
    expect(res.data).toEqual({ queued: 0 });
  });
});

describe('config status, diff and import', () => {
  it('reports status and diff', async () => {
    const info = await admin.get('/api/v1/config');
    expect(info.data.status).toHaveProperty('lastCheckedAt');
    const diff = await admin.get('/api/v1/config/diff');
    expect(diff.status).toBe(200);
    expect(diff.data.kinds).toBeTypeOf('object');
  });

  it('validates and imports a YAML export', async () => {
    const yaml = 'teams:\n  - identifier: imported\n    title: Imported\n';
    const dry = await admin.post('/api/v1/config/import', { yaml, dryRun: true });
    expect(dry.data.counts.teams).toBe(1);
    expect((await admin.get('/api/v1/teams')).data.some((t: { identifier: string }) => t.identifier === 'imported')).toBe(false);
    expect((await admin.post('/api/v1/config/import', { yaml })).status).toBe(200);
    expect((await admin.get('/api/v1/teams')).data.some((t: { identifier: string }) => t.identifier === 'imported')).toBe(true);
    expect((await admin.post('/api/v1/config/import', { yaml: 'teams: [{}]' })).status).toBe(400);
  });
});
