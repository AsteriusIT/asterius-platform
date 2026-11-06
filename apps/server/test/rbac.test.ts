import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { client, register, testApp, type Api } from './helpers.js';

let app: FastifyInstance;
let admin: Api;
let alice: Api; // payments team
let bob: Api; // no team
let carol: Api; // custom role "auditor"
let carolId: string;
let bobId: string;

beforeAll(async () => {
  app = await testApp();
  admin = client(app, (await register(app, 'admin@example.com')).token);
  alice = client(app, (await register(app, 'alice@example.com')).token);
  const b = await register(app, 'bob@example.com');
  bob = client(app, b.token);
  bobId = b.user.id;
  const c = await register(app, 'carol@example.com');
  carol = client(app, c.token);
  carolId = c.user.id;
  await admin.put('/api/v1/teams/payments', { title: 'Payments' });
  const users = (await admin.get('/api/v1/users')).data as { id: string; email: string }[];
  const aliceId = users.find((u) => u.email === 'alice@example.com')!.id;
  await admin.patch(`/api/v1/users/${aliceId}`, { teams: ['payments'] });
  await admin.patch(`/api/v1/users/${carolId}`, { roles: ['auditor'] });

  await admin.put('/api/v1/blueprints/service', { title: 'Service', schema: { properties: {} } });
  await admin.put('/api/v1/blueprints/secretproj', {
    title: 'Secret project',
    schema: { properties: {} },
    permissions: { read: { ownerTeam: true, roles: ['auditor'] }, write: { teams: ['payments'] }, delete: { roles: ['admin'] } },
  });
  await admin.put('/api/v1/blueprints/teamonly', {
    title: 'Team only',
    schema: { properties: {} },
    permissions: { read: { ownerTeam: true } },
  });
  await admin.put('/api/v1/blueprints/service/entities/s1', { title: 'S1' });
  await admin.put('/api/v1/blueprints/teamonly/entities/mine', { title: 'Mine', team: 'payments' });
  await admin.put('/api/v1/blueprints/teamonly/entities/other', { title: 'Other' });
  await admin.put('/api/v1/blueprints/secretproj/entities/p1', { title: 'P1', team: 'payments' });
});
afterAll(() => app.close());

describe('fine-grained RBAC', () => {
  it('filters listings in SQL, including totals and pagination', async () => {
    const aliceList = await alice.get('/api/v1/blueprints/teamonly/entities?limit=1');
    expect(aliceList.data.total).toBe(1);
    expect(aliceList.data.items.map((e: { identifier: string }) => e.identifier)).toEqual(['mine']);
    expect((await bob.get('/api/v1/blueprints/teamonly/entities')).data.total).toBe(0);
    expect((await admin.get('/api/v1/blueprints/teamonly/entities')).data.total).toBe(2);
    const all = await bob.get('/api/v1/entities');
    expect(all.data.items.map((e: { blueprint: string }) => e.blueprint)).toEqual(['service']);
  });

  it('answers 404 for entities and blueprints the caller cannot read', async () => {
    expect((await bob.get('/api/v1/blueprints/teamonly/entities/mine')).status).toBe(404);
    expect((await alice.get('/api/v1/blueprints/teamonly/entities/other')).status).toBe(404);
    expect((await alice.get('/api/v1/blueprints/teamonly/entities/mine')).status).toBe(200);
    const names = (await bob.get('/api/v1/blueprints')).data.map((b: { identifier: string }) => b.identifier);
    expect(names).toEqual(['service']);
    expect((await bob.get('/api/v1/blueprints/secretproj')).status).toBe(404);
  });

  it('grants read through a custom role', async () => {
    const list = await carol.get('/api/v1/blueprints/secretproj/entities');
    expect(list.data.total).toBe(1);
    expect((await carol.get('/api/v1/blueprints/teamonly/entities')).data.total).toBe(0);
  });

  it('enforces write and delete rules', async () => {
    expect((await alice.put('/api/v1/blueprints/secretproj/entities/p1', { title: 'P1b', team: 'payments' })).status).toBe(200);
    expect((await bob.put('/api/v1/blueprints/secretproj/entities/p1', { title: 'hax' })).status).toBe(403);
    expect((await alice.del('/api/v1/blueprints/secretproj/entities/p1')).status).toBe(403);
    expect((await admin.del('/api/v1/blueprints/secretproj/entities/p1')).status).toBe(200);
  });

  it('exposes effective permissions through /me', async () => {
    const me = await alice.get('/api/auth/me');
    expect(me.data.permissions.blueprints.teamonly.read).toBe('team');
    expect(me.data.permissions.blueprints.service.read).toBe(true);
    const c = await carol.get('/api/auth/me');
    expect(c.data.roles).toEqual(['auditor']);
    expect(c.data.permissions.blueprints.secretproj.read).toBe(true);
  });

  it('delegates blueprint and integration administration', async () => {
    expect((await bob.get('/api/v1/integrations')).status).toBe(403);
    expect((await bob.put('/api/v1/blueprints/x', { title: 'X', schema: { properties: {} } })).status).toBe(403);
    await admin.patch(`/api/v1/users/${bobId}`, { roles: ['blueprint-owner', 'integration-admin'] });
    expect((await bob.get('/api/v1/integrations')).status).toBe(200);
    expect((await bob.put('/api/v1/blueprints/x', { title: 'X', schema: { properties: {} } })).status).toBe(200);
    expect((await bob.get('/api/v1/users')).status).toBe(403);
  });

  it('rejects invalid role names', async () => {
    expect((await admin.patch(`/api/v1/users/${bobId}`, { roles: ['Bad Role!'] })).status).toBe(400);
  });
});
