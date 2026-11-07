import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { client, register, testApp, type Api } from './helpers.js';
import { blueprintDef } from '../src/schemas.js';

let app: FastifyInstance;
let admin: Api;
let alice: Api; // member of team "payments"
let bob: Api; // member of no team
let anon: Api;

beforeAll(async () => {
  app = await testApp();
  const a = await register(app, 'admin@example.com');
  expect(a.user.role).toBe('admin'); // first account bootstraps the admin
  admin = client(app, a.token);
  const al = await register(app, 'alice@example.com');
  expect(al.user.role).toBe('member');
  alice = client(app, al.token);
  bob = client(app, (await register(app, 'bob@example.com')).token);
  anon = client(app);

  expect((await admin.put('/api/v1/teams/payments', { title: 'Payments' })).status).toBe(200);
  expect((await admin.patch(`/api/v1/users/${al.user.id}`, { teams: ['payments'] })).status).toBe(200);
  expect(
    (
      await admin.put('/api/v1/blueprints/system', {
        title: 'System',
        schema: { properties: { criticality: { type: 'string', enum: ['low', 'high'] } }, required: ['criticality'] },
      })
    ).status,
  ).toBe(200);
  const svc = await admin.put('/api/v1/blueprints/service', {
    title: 'Service',
    schema: { properties: { tier: { type: 'integer', minimum: 1, maximum: 3, default: 2 }, url: { type: 'string', format: 'url' } } },
    relations: { system: { target: 'system', required: true }, dependsOn: { target: 'service', many: true } },
  });
  expect(svc.status, JSON.stringify(svc.data)).toBe(200);
});
afterAll(() => app.close());

describe('auth', () => {
  it('rejects anonymous calls and bad passwords', async () => {
    expect((await anon.get('/api/v1/blueprints')).status).toBe(401);
    expect((await anon.post('/api/auth/login', { email: 'alice@example.com', password: 'wrong-password' })).status).toBe(401);
  });

  it('authenticates API tokens and revokes them', async () => {
    const t = await alice.post('/api/v1/tokens', { name: 'ci' });
    expect(t.status).toBe(201);
    const viaToken = client(app, t.data.token);
    expect((await viaToken.get('/api/auth/me')).data.email).toBe('alice@example.com');
    expect((await alice.del(`/api/v1/tokens/${t.data.id}`)).status).toBe(200);
    expect((await viaToken.get('/api/auth/me')).status).toBe(401);
  });

  it('remembers the onboarding tour per user', async () => {
    expect((await bob.get('/api/auth/me')).data.tourCompletedAt).toBeNull();
    const done = await bob.put('/api/auth/me/tour', { completed: true });
    expect(done.data.tourCompletedAt).toEqual(expect.any(String));
    expect((await bob.get('/api/auth/me')).data.tourCompletedAt).toBe(done.data.tourCompletedAt);
    expect((await alice.get('/api/auth/me')).data.tourCompletedAt).toBeNull(); // per user
    expect((await bob.put('/api/auth/me/tour', { completed: false })).data.tourCompletedAt).toBeNull();
  });

  it('describes every invoker for the UI builder', async () => {
    const meta = (await anon.get('/api/meta')).data;
    for (const inv of meta.invokers) {
      expect(inv.fields?.length, inv.type).toBeGreaterThan(0);
      for (const f of inv.fields.filter((x: { required?: boolean }) => x.required)) expect(inv.example, `${inv.type}.${f.key}`).toHaveProperty(f.key);
    }
  });

  it('describes every integration source for the UI builder, with the brand', async () => {
    const meta = (await anon.get('/api/meta')).data;
    expect(meta.name).toBe('Asterius Platform');
    expect(meta.logo).toBeNull();
    // The core sources describe their connection fields; others fall back to the JSON config in the form.
    const described = meta.sources.filter((s: { fields?: unknown[] }) => s.fields?.length);
    expect(described.map((s: { type: string }) => s.type)).toEqual(expect.arrayContaining(['github', 'azure-devops', 'gitlab', 'kubernetes', 'http']));
    for (const src of described) {
      for (const f of src.fields.filter((x: { required?: boolean }) => x.required)) expect(src.example.config, `${src.type}.${f.key}`).toHaveProperty(f.key);
    }
  });

  it('accepts built-in icon names and custom image icons only', () => {
    const icon = (v: string) => blueprintDef.safeParse({ identifier: 'x', title: 'X', icon: v }).success;
    expect(icon('brand-github')).toBe(true);
    expect(icon('https://cdn.example.com/logo.svg')).toBe(true);
    expect(icon('data:image/png;base64,iVBORw0KGgo=')).toBe(true);
    expect(icon('data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=')).toBe(true);
    expect(icon('http://insecure.example.com/x.png')).toBe(false);
    expect(icon('javascript:alert(1)')).toBe(false);
    expect(icon('data:text/html;base64,PHNjcmlwdD4=')).toBe(false);
    expect(icon(`data:image/png;base64,${'A'.repeat(70_000)}`)).toBe(false);
  });

  it('keeps admin endpoints for admins', async () => {
    expect((await alice.get('/api/v1/users')).status).toBe(403);
    expect((await alice.put('/api/v1/blueprints/x', { title: 'X' })).status).toBe(403);
  });
});

describe('catalog', () => {
  it('validates properties and relations against the blueprint', async () => {
    await admin.put('/api/v1/blueprints/system/entities/pay', { title: 'Payments', team: 'payments', properties: { criticality: 'high' } });
    const bad = await alice.put('/api/v1/blueprints/service/entities/api', { team: 'payments', properties: { tier: 9 }, relations: { system: 'pay' } });
    expect(bad.status).toBe(400);
    expect(bad.data.error).toMatch(/tier: must be <= 3/);
    const noRel = await alice.put('/api/v1/blueprints/service/entities/api', { team: 'payments', properties: {} });
    expect(noRel.data.error).toMatch(/Relation "system" is required/);
    const ok = await alice.put('/api/v1/blueprints/service/entities/api', { title: 'API', team: 'payments', properties: {}, relations: { system: 'pay' } });
    expect(ok.status, JSON.stringify(ok.data)).toBe(200);
    expect(ok.data.properties.tier).toBe(2); // default applied
  });

  it('lets team members edit their entities only', async () => {
    expect((await bob.patch('/api/v1/blueprints/service/entities/api', { properties: { tier: 1 } })).status).toBe(403);
    expect((await bob.put('/api/v1/blueprints/service/entities/bobs', { team: 'payments', relations: { system: 'pay' } })).status).toBe(403);
    const patched = await alice.patch('/api/v1/blueprints/service/entities/api', { properties: { tier: 1 } });
    expect(patched.data.properties).toEqual({ tier: 1 });
    expect(patched.data.relations).toEqual({ system: 'pay' }); // PATCH merges
  });

  it('searches, filters and follows relations both ways', async () => {
    await alice.put('/api/v1/blueprints/service/entities/worker', { team: 'payments', relations: { system: 'pay', dependsOn: ['api', 'not-yet-ingested'] } });
    const found = await bob.get('/api/v1/blueprints/service/entities?search=WORK');
    expect(found.data.items.map((e: { identifier: string }) => e.identifier)).toEqual(['worker']);
    const tier1 = await bob.get('/api/v1/blueprints/service/entities?filter.tier=1');
    expect(tier1.data.total).toBe(1);
    const asc = await bob.get('/api/v1/blueprints/service/entities?sort=identifier');
    const desc = await bob.get('/api/v1/blueprints/service/entities?sort=identifier&order=desc');
    const ids = (r: { data: { items: { identifier: string }[] } }) => r.data.items.map((e) => e.identifier);
    expect(ids(desc)).toEqual(ids(asc).reverse());
    expect((await bob.get('/api/v1/blueprints/service/entities?sort=prop.tier')).status).toBe(200);
    expect((await bob.get('/api/v1/blueprints/service/entities?sort=prop.x;drop')).status).toBe(400);
    const rel = await bob.get('/api/v1/blueprints/service/entities/api/related');
    expect(Object.keys(rel.data.incoming)).toEqual(['service.dependsOn']);
    const out = await bob.get('/api/v1/blueprints/service/entities/worker/related');
    expect(out.data.outgoing.dependsOn.map((e: { source: string }) => e.source)).toEqual(['ui', 'missing']);
  });

  it('serves the relation graph and the change history of an entity', async () => {
    const g = await bob.get('/api/v1/blueprints/service/entities/worker/graph?depth=2');
    expect(g.status, JSON.stringify(g.data)).toBe(200);
    const ids = g.data.nodes.map((n: { blueprint: string; identifier: string }) => `${n.blueprint}/${n.identifier}`);
    expect(ids).toContain('service/worker');
    expect(ids).toContain('service/api');
    expect(
      g.data.edges.some(
        (e: { from: { blueprint: string; identifier: string }; to: { blueprint: string; identifier: string }; relation: string }) =>
          e.from.identifier === 'worker' && e.to.identifier === 'api' && e.relation === 'dependsOn',
      ),
    ).toBe(true);
    expect(g.data.nodes.find((n: { identifier: string }) => n.identifier === 'worker').depth).toBe(0);
    const h = await bob.get('/api/v1/blueprints/service/entities/worker/history');
    expect(h.data.items[0]).toMatchObject({ op: expect.stringMatching(/create|update/), actor: 'alice@example.com' });
    expect((await bob.get('/api/v1/blueprints/service/entities/nope/history')).status).toBe(404);
  });

  it('accepts identifiers with slashes (third-party ids)', async () => {
    const r = await admin.put(`/api/v1/blueprints/system/entities/${encodeURIComponent('org/infra')}`, { properties: { criticality: 'low' } });
    expect(r.status).toBe(200);
    expect((await bob.get(`/api/v1/blueprints/system/entities/${encodeURIComponent('org/infra')}`)).data.identifier).toBe('org/infra');
  });

  it('bulk-upserts with per-entity errors', async () => {
    const r = await admin.post('/api/v1/blueprints/system/entities/bulk', {
      entities: [
        { identifier: 'a', properties: { criticality: 'low' } },
        { identifier: 'b', properties: { criticality: 'nope' } },
      ],
    });
    expect(r.data.upserted).toBe(1);
    expect(r.data.errors).toHaveLength(1);
    expect(r.data.errors[0].index).toBe(1);
  });

  it('refuses to delete a blueprint that still has entities', async () => {
    expect((await admin.del('/api/v1/blueprints/system')).status).toBe(409);
  });
});
