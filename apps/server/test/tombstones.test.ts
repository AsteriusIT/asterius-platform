import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { client, register, testApp, type Api } from './helpers.js';
import { housekeeping } from '../src/maintenance.js';
import { run } from '../src/db.js';
import { silentLog } from './helpers.js';

let app: FastifyInstance;
let admin: Api;
let bob: Api;

beforeAll(async () => {
  app = await testApp();
  admin = client(app, (await register(app, 'admin@example.com')).token);
  bob = client(app, (await register(app, 'bob@example.com')).token);
  await admin.put('/api/v1/blueprints/doc', { title: 'Doc', schema: { properties: { body: { type: 'string' } } } });
});
afterAll(() => app.close());

describe('soft delete', () => {
  it('hides deleted entities and keeps a tombstone that an admin can restore', async () => {
    await admin.put('/api/v1/blueprints/doc/entities/readme', { title: 'Readme', properties: { body: 'hello' } });
    await admin.del('/api/v1/blueprints/doc/entities/readme');
    expect((await admin.get('/api/v1/blueprints/doc/entities/readme')).status).toBe(404);
    expect((await admin.get('/api/v1/blueprints/doc/entities')).data.total).toBe(0);

    const dead = await admin.get('/api/v1/deleted-entities');
    expect(dead.data.total).toBe(1);
    expect(dead.data.items[0]).toMatchObject({ blueprint: 'doc', identifier: 'readme', title: 'Readme', deletedBy: 'admin@example.com' });
    expect(dead.data.items[0].expiresAt > dead.data.items[0].deletedAt).toBe(true);

    expect((await bob.get('/api/v1/deleted-entities')).status).toBe(403);
    expect((await bob.post('/api/v1/blueprints/doc/entities/readme/restore')).status).toBe(403);

    const restored = await admin.post('/api/v1/blueprints/doc/entities/readme/restore');
    expect(restored.status).toBe(200);
    expect(restored.data).toMatchObject({ title: 'Readme', properties: { body: 'hello' } });
    expect((await admin.get('/api/v1/deleted-entities')).data.total).toBe(0);
    expect((await admin.get('/api/v1/blueprints/doc/entities/readme/history')).data.items[0]).toMatchObject({ op: 'restore' });
    expect((await admin.post('/api/v1/blueprints/doc/entities/readme/restore')).status).toBe(404);
  });

  it('drops the tombstone when the identifier is created again', async () => {
    await admin.del('/api/v1/blueprints/doc/entities/readme');
    await admin.put('/api/v1/blueprints/doc/entities/readme', { title: 'New readme' });
    expect((await admin.get('/api/v1/deleted-entities')).data.total).toBe(0);
  });

  it('purges expired tombstones in maintenance and on request', async () => {
    await admin.del('/api/v1/blueprints/doc/entities/readme');
    await run("UPDATE entity_tombstones SET expires_at = '2000-01-01T00:00:00.000Z'");
    await housekeeping(silentLog);
    expect((await admin.get('/api/v1/deleted-entities')).data.total).toBe(0);

    await admin.put('/api/v1/blueprints/doc/entities/other', {});
    await admin.del('/api/v1/blueprints/doc/entities/other');
    expect((await admin.del('/api/v1/deleted-entities/doc/other')).status).toBe(200);
    expect((await admin.post('/api/v1/blueprints/doc/entities/other/restore')).status).toBe(404);
  });
});
