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
  const bp = await admin.put('/api/v1/blueprints/app', {
    title: 'App',
    schema: { properties: { lang: { type: 'string' }, tier: { type: 'integer' } } },
  });
  expect(bp.status).toBe(200);
});
afterAll(() => app.close());

describe('entity history', () => {
  it('records create, update (with diff, actor and source) and delete', async () => {
    await admin.put('/api/v1/blueprints/app/entities/shop', { title: 'Shop', properties: { lang: 'go', tier: 1 } });
    await admin.put('/api/v1/blueprints/app/entities/shop', { title: 'Shop', properties: { lang: 'rust', tier: 1 } });
    // an unchanged write creates no version
    await admin.put('/api/v1/blueprints/app/entities/shop', { title: 'Shop', properties: { lang: 'rust', tier: 1 } });

    const h = await admin.get('/api/v1/entities/app/shop/history');
    expect(h.status).toBe(200);
    expect(h.data.total).toBe(2);
    const [latest, first] = h.data.items;
    expect(first).toMatchObject({ version: 1, op: 'create', actor: 'admin@example.com', source: 'ui' });
    expect(latest).toMatchObject({ version: 2, op: 'update' });
    expect(latest.diff).toEqual([{ path: 'properties.lang', before: 'go', after: 'rust' }]);
    expect(latest.snapshot.properties).toEqual({ lang: 'rust', tier: 1 });
  });

  it('reverts by writing a new version', async () => {
    expect((await admin.post('/api/v1/blueprints/app/entities/shop/history/1/revert')).status).toBe(200);
    expect((await admin.get('/api/v1/blueprints/app/entities/shop')).data.properties.lang).toBe('go');
    const h = (await admin.get('/api/v1/blueprints/app/entities/shop/history')).data;
    expect(h.items[0]).toMatchObject({ version: 3, op: 'revert' });
    expect(h.items[0].diff).toEqual([{ path: 'properties.lang', before: 'rust', after: 'go' }]);
    expect((await admin.post('/api/v1/blueprints/app/entities/shop/history/99/revert')).status).toBe(404);
  });

  it('keeps history after a delete and can restore the entity from it', async () => {
    await admin.del('/api/v1/blueprints/app/entities/shop');
    const h = (await admin.get('/api/v1/blueprints/app/entities/shop/history')).data;
    expect(h.items[0]).toMatchObject({ version: 4, op: 'delete' });
    expect(h.items[0].snapshot.title).toBe('Shop');
    expect((await admin.post('/api/v1/blueprints/app/entities/shop/history/4/revert')).status).toBe(200);
    expect((await admin.get('/api/v1/blueprints/app/entities/shop')).data.properties.lang).toBe('go');
  });

  it('applies the same write permissions to reverts', async () => {
    await admin.put('/api/v1/teams/ops', { title: 'Ops' });
    await admin.put('/api/v1/blueprints/app/entities/owned', { team: 'ops', properties: { lang: 'a' } });
    await admin.put('/api/v1/blueprints/app/entities/owned', { team: 'ops', properties: { lang: 'b' } });
    expect((await bob.post('/api/v1/blueprints/app/entities/owned/history/1/revert')).status).toBe(403);
  });
});
