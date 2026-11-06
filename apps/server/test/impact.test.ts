import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { client, register, testApp, waitFor, type Api } from './helpers.js';

let app: FastifyInstance;
let admin: Api;
let bob: Api;

const bp = {
  title: 'Thing',
  schema: { properties: { name: { type: 'string' }, size: { type: 'integer' } } },
};

beforeAll(async () => {
  app = await testApp();
  admin = client(app, (await register(app, 'admin@example.com')).token);
  bob = client(app, (await register(app, 'bob@example.com')).token);
  await admin.put('/api/v1/blueprints/thing', bp);
  for (const [id, name] of [
    ['t1', 'one'],
    ['t2', 'two'],
    ['t3', 'three'],
  ])
    await admin.put(`/api/v1/blueprints/thing/entities/${id}`, { properties: { name, size: 1 } });
});
afterAll(() => app.close());

describe('blueprint change impact', () => {
  const proposed = {
    ...bp,
    schema: { properties: { label: { type: 'string' }, size: { type: 'integer' }, owner: { type: 'string' } }, required: ['label', 'owner'] },
  };

  it('is admin only', async () => {
    expect((await bob.post('/api/v1/blueprints/thing/impact', { blueprint: proposed })).status).toBe(403);
  });

  it('reports how many entities a proposed definition invalidates, without saving it', async () => {
    const r = await admin.post('/api/v1/blueprints/thing/impact', { blueprint: proposed });
    expect(r.status).toBe(200);
    expect(r.data).toMatchObject({ total: 3, invalid: 3, truncated: false });
    expect(r.data.samples[0].errors).toEqual(expect.arrayContaining([expect.stringContaining('label'), expect.stringContaining('owner')]));
    expect((await admin.get('/api/v1/blueprints/thing')).data.schema.required).toBeUndefined();
  });

  it('previews migrations (rename, default) before applying them', async () => {
    const migrations = [
      { type: 'rename', from: 'name', to: 'label' },
      { type: 'default', property: 'owner', value: 'nobody' },
    ];
    const r = await admin.post('/api/v1/blueprints/thing/impact', { blueprint: proposed, migrations });
    expect(r.data).toMatchObject({ total: 3, invalid: 0 });
    // nothing changed yet
    expect((await admin.get('/api/v1/blueprints/thing/entities/t1')).data.properties).toEqual({ name: 'one', size: 1 });

    const done = await admin.post('/api/v1/blueprints/thing/migrate', { migrations });
    expect(done.data).toEqual({ migrated: 3, total: 3 });
    expect((await admin.get('/api/v1/blueprints/thing/entities/t1')).data.properties).toEqual({ label: 'one', size: 1, owner: 'nobody' });
    // recorded in the history
    const h = (await admin.get('/api/v1/blueprints/thing/entities/t1/history')).data;
    expect(h.items[0]).toMatchObject({ op: 'update', source: 'migration' });
  });

  it('re-validates in the background after a save and keeps a report', async () => {
    expect((await admin.put('/api/v1/blueprints/thing', proposed)).status).toBe(200);
    const report = await waitFor(async () => {
      const r = (await admin.get('/api/v1/blueprints/thing/validation')).data;
      return r?.status === 'done' ? r : undefined;
    });
    expect(report).toMatchObject({ total: 3, invalid: 0 });

    // a stricter change leaves invalid entities, listed in the report
    await admin.put('/api/v1/blueprints/thing', {
      ...proposed,
      schema: { ...proposed.schema, required: ['label', 'owner', 'size', 'extra'], properties: { ...proposed.schema.properties, extra: { type: 'string' } } },
    });
    const stricter = await waitFor(async () => {
      const r = (await admin.get('/api/v1/blueprints/thing/validation')).data;
      return r?.status === 'done' && r.invalid > 0 ? r : undefined;
    });
    expect(stricter.invalid).toBe(3);
    expect(stricter.samples).toHaveLength(3);
  });
});
