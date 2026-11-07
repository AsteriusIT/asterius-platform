import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { client, register, testApp, type Api } from './helpers.js';
import { bands, computeInsights } from '../src/catalog/insights.js';
import { insightsConfig } from '../src/schemas.js';
import { DEFAULT_ORG, withOrg } from '../src/orgs/context.js';
import { run } from '../src/db.js';
import type { Principal } from '../src/auth/users.js';

let app: FastifyInstance;
let admin: Api;

const NOW = Date.parse('2026-06-30T12:00:00Z');
const ago = (h: number) => new Date(NOW - h * 3_600_000).toISOString();
const principal = {
  id: 'u',
  email: 'a@x',
  name: 'A',
  role: 'admin',
  roles: [],
  provider: 'local',
  teams: [],
  superadmin: false,
  org: null,
} as unknown as Principal;
const compute = (o: object = {}, org = DEFAULT_ORG) => withOrg(org, () => computeInsights(cfg(o), principal, NOW));
const cfg = (o: object = {}) => insightsConfig.parse(o);

beforeAll(async () => {
  app = await testApp();
  admin = client(app, (await register(app, 'admin@example.com')).token);
  await admin.put('/api/v1/blueprints/svc', { title: 'Service', schema: { properties: {} } });
  await admin.put('/api/v1/blueprints/deployment', {
    relations: { service: { title: 'Service', target: 'svc' } },
    title: 'Deployment',
    schema: { properties: { status: { type: 'string' }, deployedAt: { type: 'string' }, mergedAt: { type: 'string' } } },
  });
  await admin.put('/api/v1/teams/alpha', { title: 'Alpha' });
  await admin.put('/api/v1/teams/beta', { title: 'Beta' });
  await admin.put('/api/v1/blueprints/incident', {
    title: 'Incident',
    schema: { properties: { createdAt: { type: 'string' }, resolvedAt: { type: 'string' } } },
  });
});
afterAll(() => app.close());

const deploy = async (id: string, props: object, team: string | null = null, service?: string) => {
  if (service) await admin.put(`/api/v1/blueprints/svc/entities/${service}`, { properties: {} });
  const r = await deploy0(id, props, team, service);
  if (r.status !== 200) throw new Error(JSON.stringify(r.data));
};
const deploy0 = (id: string, props: object, team: string | null = null, service?: string) =>
  admin.put(`/api/v1/blueprints/deployment/entities/${id}`, { team, properties: props, relations: service ? { service } : undefined });

describe('insights', () => {
  it('has null metrics without data, never NaN', async () => {
    const r = (await admin.get('/api/v1/insights')).data;
    expect(r.deploymentFrequency).toMatchObject({ value: 0, count: 0, band: 'low' });
    expect(r.leadTime).toMatchObject({ value: null, band: null });
    expect(r.changeFailureRate).toMatchObject({ value: null, total: 0, band: null });
    expect(r.mttr).toMatchObject({ value: null, incidents: 0 });
    expect(JSON.stringify(r)).not.toContain('NaN');
  });

  it('is null when no deployment source exists', async () => {
    const r = (await admin.get('/api/v1/insights?deploymentBlueprint=ghost&incidentBlueprint=ghost')).data;
    expect(r.deploymentFrequency).toMatchObject({ value: null, band: null });
  });

  it('computes the four metrics inside the window boundaries', async () => {
    await deploy('d1', { status: 'success', deployedAt: ago(10), mergedAt: ago(12) }, 'alpha'); // lead 2h
    await deploy('d2', { status: 'Succeeded', deployedAt: ago(24), mergedAt: ago(30) }, 'alpha'); // lead 6h
    await deploy('d3', { status: 'failed', deployedAt: ago(48) }, 'beta');
    await deploy('d4', { status: 'success', deployedAt: ago(30 * 24 + 1) }); // before the window
    await deploy('d5', { status: 'success', deployedAt: ago(-5) }); // in the future
    await deploy('d6', { status: 'in_progress', deployedAt: ago(5) }); // not finished
    await deploy('d7', { status: 'success', deployedAt: ago(30 * 24 - 1) }, null, 'svc-x'); // just inside
    for (const [id, c, r] of [
      ['i1', ago(20), ago(18)], // 2h
      ['i2', ago(40), ago(34)], // 6h
      ['i3', ago(5), undefined], // still open
      ['i4', ago(24 * 40), ago(24 * 40 - 1)], // out of the window
    ] as const)
      await admin.put(`/api/v1/blueprints/incident/entities/${id}`, { properties: { createdAt: c, resolvedAt: r } });

    const out = await compute();
    expect(out.deploymentFrequency).toMatchObject({ count: 3, value: 0.1 });
    expect(out.changeFailureRate).toMatchObject({ failed: 1, total: 4, value: 0.25, band: 'low' });
    expect(out.leadTime).toMatchObject({ value: 4, samples: 2, band: 'elite' });
    expect(out.mttr).toMatchObject({ value: 4, incidents: 2, band: 'high' });
  });

  it('filters by team and service', async () => {
    const alpha = await compute({ team: 'alpha' });
    expect(alpha.deploymentFrequency.count).toBe(2);
    expect(alpha.changeFailureRate).toMatchObject({ failed: 0, total: 2, value: 0 });
    expect(alpha.changeFailureRate.band).toBe('elite');
    const beta = await compute({ team: 'beta' });
    expect(beta.changeFailureRate).toMatchObject({ failed: 1, total: 1, value: 1 });
    expect(beta.leadTime.value).toBeNull();
    expect((await compute({ service: 'svc-x' })).deploymentFrequency.count).toBe(1);
    // d1 (10h) and d2 (exactly 24h, boundary inclusive)
    expect((await compute({ days: 1 })).deploymentFrequency.count).toBe(2);
  });

  it('counts runs of deployment actions', async () => {
    const [{ id: userId }] = [(await admin.get('/api/auth/me')).data.user ?? (await admin.get('/api/v1/users')).data[0]];
    const insert = (id: string, status: string, hoursAgo: number) =>
      run(
        `INSERT INTO runs (id, action, action_title, inputs, status, invoker, approval, triggered_by, created_at, ended_at, updated_at, org_id)
         VALUES (?, 'ship', 'Ship', '{}', ?, '{}', '{}', ?, ?, ?, ?, ?)`,
        id,
        status,
        userId,
        ago(hoursAgo),
        ago(hoursAgo),
        ago(hoursAgo),
        DEFAULT_ORG,
      );
    await withOrg(DEFAULT_ORG, async () => {
      await insert('r1', 'SUCCESS', 3);
      await insert('r2', 'FAILURE', 4);
      await insert('r3', 'IN_PROGRESS', 1);
      await insert('r4', 'SUCCESS', 24 * 60);
    });
    const out = await compute({ deployments: { blueprint: 'ghost' }, deploymentActions: ['ship'] });
    expect(out.deploymentFrequency.count).toBe(1);
    expect(out.changeFailureRate).toMatchObject({ failed: 1, total: 2 });
  });

  it('is isolated per organization', async () => {
    const other = await compute({}, 'other-org');
    expect(other.deploymentFrequency.value).toBeNull();
    expect(other.changeFailureRate.total).toBe(0);
    expect(other.mttr.value).toBeNull();
  });
});

describe('bands', () => {
  it('uses the DORA thresholds', () => {
    expect(bands.deploymentFrequency(2)).toBe('elite');
    expect(bands.deploymentFrequency(0.2)).toBe('high');
    expect(bands.deploymentFrequency(0.05)).toBe('medium');
    expect(bands.deploymentFrequency(0.01)).toBe('low');
    expect(bands.changeFailureRate(0.05)).toBe('elite');
    expect(bands.changeFailureRate(0.16)).toBe('low');
    expect(bands.mttr(0.5)).toBe('elite');
    expect(bands.leadTime(24 * 8)).toBe('medium');
  });
});
