import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { client, register, testApp, type Api } from './helpers.js';

let app: FastifyInstance;
let admin: Api;

const ids = (r: { data: { items: { identifier: string }[] } }) => r.data.items.map((e) => e.identifier).sort();

beforeAll(async () => {
  app = await testApp();
  admin = client(app, (await register(app, 'admin@example.com')).token);
  const mk = (id: string, relations: Record<string, unknown>) => admin.put(`/api/v1/blueprints/${id}`, { title: id, schema: { properties: {} }, relations });
  expect((await mk('team2', {})).status).toBe(200);
  expect((await mk('domain', {})).status).toBe(200);
  const r = await mk('component', {
    owner: { target: 'team2', onDelete: 'restrict', inverseTitle: 'Owns', requireExisting: true },
    domain: { target: 'domain', onDelete: 'cascade', inverseTitle: 'Components' },
    peers: { target: 'component', many: true, onDelete: 'detach' },
  });
  expect(r.status, JSON.stringify(r.data)).toBe(200);
});
afterAll(() => app.close());

const put = (bp: string, id: string, relations: Record<string, unknown> = {}) => admin.put(`/api/v1/blueprints/${bp}/entities/${id}`, { relations });

describe('relation integrity', () => {
  it('requires existing targets for hand-written entities only when asked', async () => {
    expect((await put('component', 'c0', { owner: 'ghost' })).status).toBe(400);
    expect((await put('component', 'c0', { domain: 'not-yet' })).status).toBe(200); // no requireExisting: may point ahead
    await put('team2', 'ops');
    expect((await put('component', 'c1', { owner: 'ops' })).status).toBe(200);
  });

  it('restricts deleting a target that is still referenced', async () => {
    const res = await admin.del('/api/v1/blueprints/team2/entities/ops');
    expect(res.status).toBe(409);
    expect(res.data.error).toContain('component/c1');
    expect((await admin.get('/api/v1/blueprints/team2/entities/ops')).status).toBe(200);
    await admin.del('/api/v1/blueprints/component/entities/c1');
    expect((await admin.del('/api/v1/blueprints/team2/entities/ops')).status).toBe(200);
  });

  it('cascades to referrers', async () => {
    await put('domain', 'd1');
    await put('component', 'a', { domain: 'd1' });
    await put('component', 'b', { domain: 'd1' });
    await put('component', 'keep');
    expect((await admin.del('/api/v1/blueprints/domain/entities/d1')).status).toBe(200);
    const left = await admin.get('/api/v1/blueprints/component/entities');
    expect(ids(left)).toEqual(['c0', 'keep']);
  });

  it('detaches references instead of leaving them dangling', async () => {
    await put('component', 'x', { peers: ['y', 'z'] });
    await put('component', 'y');
    await put('component', 'z');
    expect((await admin.del('/api/v1/blueprints/component/entities/y')).status).toBe(200);
    expect((await admin.get('/api/v1/blueprints/component/entities/x')).data.relations).toEqual({ peers: ['z'] });
    await admin.del('/api/v1/blueprints/component/entities/z');
    expect((await admin.get('/api/v1/blueprints/component/entities/x')).data.relations).toEqual({});
  });

  it('names the reverse relation on the target page', async () => {
    await put('domain', 'd2');
    await put('component', 'in-d2', { domain: 'd2' });
    const rel = await admin.get('/api/v1/blueprints/domain/entities/d2/related');
    expect(rel.data.incomingTitles).toEqual({ 'component.domain': 'Components' });
  });

  it('repairs the relation index when a relation is retargeted or removed', async () => {
    // peers now points to domain: the index follows without rewriting entities
    const bp = (await admin.get('/api/v1/blueprints/component')).data;
    await admin.put('/api/v1/blueprints/component', { ...bp, relations: { ...bp.relations, peers: { ...bp.relations.peers, target: 'domain' } } });
    await put('component', 'p1', { peers: ['d2'] });
    const rel = await admin.get('/api/v1/blueprints/domain/entities/d2/related');
    expect(Object.keys(rel.data.incoming).sort()).toEqual(['component.domain', 'component.peers']);

    // remove the relation from the blueprint: its index rows go
    const { peers: _peers, ...rest } = bp.relations;
    await admin.put('/api/v1/blueprints/component', { ...bp, relations: rest });
    const after = await admin.get('/api/v1/blueprints/domain/entities/d2/related');
    expect(Object.keys(after.data.incoming)).toEqual(['component.domain']);

    const repaired = await admin.post('/api/v1/blueprints/component/repair-relations');
    expect(repaired.status).toBe(200);
    expect(repaired.data.references).toBeGreaterThan(0);
  });
});
