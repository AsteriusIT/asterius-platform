import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { client, register, testApp, type Api } from './helpers.js';

/** Per-user preferences, saved catalog views shared with a team, and the `team=@mine` catalog filter. */

let app: FastifyInstance;
let admin: Api;
let alice: Api;
let bob: Api;
let carol: Api;

beforeAll(async () => {
  app = await testApp();
  admin = client(app, (await register(app, 'admin@example.com', 'Admin')).token);
  const a = await register(app, 'alice@example.com', 'Alice');
  const b = await register(app, 'bob@example.com', 'Bob');
  const c = await register(app, 'carol@example.com', 'Carol');
  alice = client(app, a.token);
  bob = client(app, b.token);
  carol = client(app, c.token);
  await admin.put('/api/v1/teams/payments', { title: 'Payments' });
  await admin.put('/api/v1/teams/search', { title: 'Search' });
  expect((await admin.patch(`/api/v1/users/${a.user.id}`, { teams: ['payments'] })).status).toBe(200);
  expect((await admin.patch(`/api/v1/users/${b.user.id}`, { teams: ['payments', 'search'] })).status).toBe(200);
  await admin.put('/api/v1/blueprints/service', { title: 'Service', schema: { properties: { tier: { type: 'string' } } } });
  for (const [id, team] of [
    ['pay-api', 'payments'],
    ['search-api', 'search'],
    ['orphan', null],
  ])
    expect((await admin.post('/api/v1/blueprints/service/entities', { identifier: id, title: id, team, properties: {} })).status).toBe(201);
});
afterAll(async () => {
  await app.close();
});

describe('preferences', () => {
  it('stores validated keys per user, merges updates and removes keys set to null', async () => {
    expect((await alice.get('/api/v1/me/preferences')).data).toEqual({});
    const put = await alice.put('/api/v1/me/preferences', { favourites: ['a', 'b'], recentActions: ['b'], 'catalog.columns.service': ['tier'] });
    expect(put.status, JSON.stringify(put.data)).toBe(200);
    expect(put.data).toEqual({ favourites: ['a', 'b'], recentActions: ['b'], 'catalog.columns.service': ['tier'] });
    await alice.put('/api/v1/me/preferences', { favourites: ['c'], 'catalog.columns.service': null });
    expect((await alice.get('/api/v1/me/preferences')).data).toEqual({ favourites: ['c'], recentActions: ['b'] });
    // Per user.
    expect((await bob.get('/api/v1/me/preferences')).data).toEqual({});
  });

  it('rejects unknown keys, wrong shapes and oversized values', async () => {
    expect((await alice.put('/api/v1/me/preferences', { theme: 'dark' })).status).toBe(400);
    expect((await alice.put('/api/v1/me/preferences', { 'catalog.columns.Bad Name': ['x'] })).status).toBe(400);
    expect((await alice.put('/api/v1/me/preferences', { favourites: 'a' })).status).toBe(400);
    expect((await alice.put('/api/v1/me/preferences', { recentActions: Array.from({ length: 21 }, (_, i) => `a${i}`) })).status).toBe(400);
    expect((await alice.put('/api/v1/me/preferences', { favourites: ['x'.repeat(201)] })).status).toBe(400);
    expect((await alice.get('/api/v1/me/preferences')).data.favourites).toEqual(['c']);
  });
});

describe('saved views', () => {
  let shared: string;
  let priv: string;

  it('creates private and team-shared views; only the owner’s teams can be used', async () => {
    const p = await alice.post('/api/v1/views', { name: 'Gold', blueprint: 'service', query: '?f=tier:gold&page=3' });
    expect(p.status, JSON.stringify(p.data)).toBe(201);
    expect(p.data).toMatchObject({ name: 'Gold', query: 'f=tier%3Agold', team: null, mine: true, canEdit: true, owner: { name: 'Alice' } });
    priv = p.data.id;
    const s = await alice.post('/api/v1/views', { name: 'Payments services', blueprint: 'service', query: 'team=payments', team: 'payments' });
    expect(s.status).toBe(201);
    expect(s.data.team).toEqual({ identifier: 'payments', title: 'Payments' });
    shared = s.data.id;
    expect((await alice.post('/api/v1/views', { name: 'x', blueprint: 'service', team: 'search' })).status).toBe(403);
    expect((await alice.post('/api/v1/views', { name: 'x', blueprint: 'service', team: 'nope' })).status).toBe(400);
    expect((await alice.post('/api/v1/views', { name: 'Gold', blueprint: 'service' })).status).toBe(409);
    expect((await alice.post('/api/v1/views', { name: '', blueprint: 'service' })).status).toBe(400);
  });

  it('shows a view to its owner and to members of the team it is shared with', async () => {
    const mine = (await alice.get('/api/v1/views?blueprint=service')).data as { id: string }[];
    expect(mine.map((v) => v.id).sort()).toEqual([priv, shared].sort());
    const bobs = (await bob.get('/api/v1/views?blueprint=service')).data as { id: string; mine: boolean; canEdit: boolean }[];
    expect(bobs).toEqual([expect.objectContaining({ id: shared, mine: false, canEdit: false })]);
    expect((await carol.get('/api/v1/views')).data).toEqual([]);
    expect((await carol.get(`/api/v1/views/${shared}`)).status).toBe(404);
    expect((await bob.get(`/api/v1/views/${priv}`)).status).toBe(404);
    expect((await alice.get('/api/v1/views?blueprint=other')).data).toEqual([]);
    // Admins: their own and shared ones by default, every view with all=true.
    expect((await admin.get('/api/v1/views')).data).toEqual([]);
    expect(((await admin.get('/api/v1/views?all=true')).data as unknown[]).length).toBe(2);
  });

  it('lets only the owner or an admin change or delete a view', async () => {
    expect((await bob.put(`/api/v1/views/${shared}`, { name: 'Mine now' })).status).toBe(403);
    expect((await bob.del(`/api/v1/views/${shared}`)).status).toBe(403);
    expect((await carol.del(`/api/v1/views/${shared}`)).status).toBe(404);
    const r = await alice.put(`/api/v1/views/${priv}`, { name: 'Gold tier', team: 'payments' });
    expect(r.status).toBe(200);
    expect(r.data).toMatchObject({ name: 'Gold tier', team: { identifier: 'payments' }, query: 'f=tier%3Agold' });
    expect((await bob.get(`/api/v1/views/${priv}`)).status).toBe(200);
    expect((await alice.put(`/api/v1/views/${priv}`, { team: null })).data.team).toBeNull();
    expect((await alice.put(`/api/v1/views/${priv}`, { name: 'Payments services' })).status).toBe(409);
    expect((await admin.put(`/api/v1/views/${shared}`, { query: 'team=@mine' })).data.query).toBe('team=%40mine');
    expect((await admin.del(`/api/v1/views/${shared}`)).status).toBe(200);
    expect((await alice.del(`/api/v1/views/${priv}`)).status).toBe(200);
    expect((await alice.get('/api/v1/views')).data).toEqual([]);
  });
});

describe('catalog team filter', () => {
  const ids = async (api: Api, query: string) =>
    ((await api.get(`/api/v1/blueprints/service/entities?${query}`)).data.items as { identifier: string }[]).map((e) => e.identifier).sort();

  it('filters on several teams and on the viewer’s own teams with team=@mine', async () => {
    expect(await ids(admin, 'team=payments,search')).toEqual(['pay-api', 'search-api']);
    expect(await ids(admin, 'team=payments')).toEqual(['pay-api']);
    expect(await ids(alice, 'team=@mine')).toEqual(['pay-api']);
    expect(await ids(bob, 'team=@mine')).toEqual(['pay-api', 'search-api']);
    expect(await ids(carol, 'team=@mine')).toEqual([]);
  });
});
