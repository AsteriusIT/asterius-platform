import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { client, register, testApp, type Api } from './helpers.js';

/** Optimistic concurrency for editors: If-Match on actions, fragments and entities, 412 saying who/when. */
let app: FastifyInstance;
let admin: Api;
let alice: Api;

const workflow = (description = '') => ({
  title: 'Deploy',
  description,
  trigger: { type: 'api' },
  steps: [{ id: 'a', type: 'transform', output: { ok: 'true' } }],
});
const fragment = (description = '') => ({
  title: 'Noop',
  description,
  steps: [{ id: 'x', type: 'transform', output: { ok: 'true' } }],
});

beforeAll(async () => {
  app = await testApp();
  admin = client(app, (await register(app, 'admin@example.com', 'Ada Admin')).token);
  const a = await register(app, 'alice@example.com', 'Alice Martin');
  alice = client(app, a.token);
  expect((await admin.patch(`/api/v1/users/${a.user.id}`, { role: 'admin' })).status).toBe(200);
  expect((await admin.put('/api/v1/blueprints/svc', { title: 'Service', schema: { properties: { tier: { type: 'integer' } } } })).status).toBe(200);
});
afterAll(() => app.close());

const expectConflict = (res: { status: number; data: { error: string; conflict: { changedAt: string } } }, currentVersion: number) => {
  expect(res.status, JSON.stringify(res.data)).toBe(412);
  expect(res.data.error).toMatch(/version/);
  expect(res.data.conflict).toEqual({
    currentVersion,
    changedBy: { email: 'alice@example.com', name: 'Alice Martin' },
    changedAt: expect.any(String),
  });
  expect(Date.parse(res.data.conflict.changedAt)).not.toBeNaN();
};

describe('edit conflicts', () => {
  it('actions: a save from a stale version is refused with who/when; without If-Match it overwrites', async () => {
    const v1 = await admin.put('/api/v1/actions/deploy', workflow());
    expect(v1.status, JSON.stringify(v1.data)).toBe(200);
    expect(v1.data.version).toBe(1);
    // Alice saves from version 1 (matches), the admin's tab still holds version 1.
    const v2 = await alice.put('/api/v1/actions/deploy', workflow('by alice'), { 'if-match': '1' });
    expect(v2.status, JSON.stringify(v2.data)).toBe(200);
    expect(v2.data.version).toBe(2);
    expectConflict(await admin.put('/api/v1/actions/deploy', workflow('by admin'), { 'if-match': '"1"' }), 2);
    expect((await admin.get('/api/v1/actions/deploy')).data.description).toBe('by alice');
    // Overwrite: no If-Match, saved as a new version (history keeps Alice's).
    const forced = await admin.put('/api/v1/actions/deploy', workflow('by admin'));
    expect(forced.data).toMatchObject({ version: 3, description: 'by admin' });
    expect((await admin.get('/api/v1/actions/deploy/versions')).data.map((v: { version: number }) => v.version)).toEqual([3, 2, 1]);
    // A matching If-Match saves; a bad one is a 400; a missing action is a conflict with no version.
    expect((await admin.put('/api/v1/actions/deploy', workflow('again'), { 'if-match': '3' })).data.version).toBe(4);
    expect((await admin.put('/api/v1/actions/deploy', workflow(), { 'if-match': 'abc' })).status).toBe(400);
    const gone = await admin.put('/api/v1/actions/nope', workflow(), { 'if-match': '1' });
    expect(gone.status).toBe(412);
    expect(gone.data.conflict).toEqual({ currentVersion: null, changedBy: null, changedAt: null });
  });

  it('fragments: same contract', async () => {
    expect((await admin.put('/api/v1/fragments/noop', fragment())).data.version).toBe(1);
    expect((await alice.put('/api/v1/fragments/noop', fragment('by alice'), { 'if-match': '1' })).data.version).toBe(2);
    expectConflict(await admin.put('/api/v1/fragments/noop', fragment('by admin'), { 'if-match': '1' }), 2);
    expect((await admin.get('/api/v1/fragments/noop')).data.description).toBe('by alice');
    expect((await admin.put('/api/v1/fragments/noop', fragment('by admin'))).data.version).toBe(3);
  });

  it('entities: the 412 says who changed it and when', async () => {
    const e1 = await admin.put('/api/v1/blueprints/svc/entities/api', { title: 'API', properties: { tier: 1 } });
    expect(e1.data.version).toBe(1);
    expect((await alice.put('/api/v1/blueprints/svc/entities/api', { title: 'API', properties: { tier: 2 } }, { 'if-match': '"1"' })).status).toBe(200);
    expectConflict(await admin.put('/api/v1/blueprints/svc/entities/api', { title: 'API', properties: { tier: 3 } }, { 'if-match': '"1"' }), 2);
    expect((await admin.get('/api/v1/blueprints/svc/entities/api')).data.properties.tier).toBe(2);
    expect((await admin.put('/api/v1/blueprints/svc/entities/api', { title: 'API', properties: { tier: 3 } })).data.version).toBe(3);
  });
});
