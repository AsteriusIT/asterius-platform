import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { client, register, testApp, type Api } from './helpers.js';

let app: FastifyInstance;
let admin: Api;
let alice: Api;

const step = (id: string, v = '1') => ({ id, type: 'transform', output: { v } });
const body = (steps: object[], extra: object = {}) => ({ title: 'Versioned', trigger: { type: 'api', inputs: { properties: {} } }, steps, ...extra });

beforeAll(async () => {
  app = await testApp();
  admin = client(app, (await register(app, 'admin@example.com')).token);
  alice = client(app, (await register(app, 'alice@example.com')).token);
});
afterAll(async () => {
  await app.close();
});

describe('action versions', () => {
  it('numbers every change, not every save', async () => {
    const v1 = await admin.put('/api/v1/actions/ver', body([step('a')]));
    expect(v1.data.version).toBe(1);
    expect((await admin.put('/api/v1/actions/ver', body([step('a')]))).data.version).toBe(1); // unchanged
    const v2 = await admin.put('/api/v1/actions/ver', body([step('a'), step('b', '2')]));
    expect(v2.data.version).toBe(2);
    expect((await admin.put('/api/v1/actions/ver', body([step('b', '3')], { title: 'Renamed' }))).data.version).toBe(3);
    const history = (await admin.get('/api/v1/actions/ver/versions')).data as { version: number; actor: string }[];
    expect(history.map((h) => h.version)).toEqual([3, 2, 1]);
    expect(history[0].actor).toBe('admin@example.com');
  });

  it('records the version on runs', async () => {
    const run = await alice.post('/api/v1/actions/ver/runs', {});
    expect(run.data.actionVersion).toBe(3);
    await admin.put('/api/v1/actions/ver', body([step('b', '4')], { title: 'Renamed' }));
    expect((await alice.get(`/api/v1/runs/${run.data.id}`)).data.actionVersion).toBe(3); // the run keeps its version
  });

  it('compares versions', async () => {
    const diff = (await admin.get('/api/v1/actions/ver/diff?from=1&to=3')).data;
    expect(diff.fields.map((f: { path: string }) => f.path)).toContain('title');
    expect(diff.stepsRemoved).toEqual(['a']);
    expect(diff.stepsAdded).toEqual(['b']);
    const small = (await admin.get('/api/v1/actions/ver/diff?from=3&to=4')).data;
    expect(small.stepsChanged).toEqual([{ id: 'b', changes: [{ path: 'output.v', before: '3', after: '4' }] }]);
    expect((await admin.get('/api/v1/actions/ver/diff?from=1&to=99')).status).toBe(404);
  });

  it('rolls back to an earlier version as a new version', async () => {
    const res = await admin.post('/api/v1/actions/ver/rollback', { version: 1 });
    expect(res.status, JSON.stringify(res.data)).toBe(200);
    expect(res.data).toMatchObject({ version: 5, title: 'Versioned' });
    expect(res.data.steps.map((s: { id: string }) => s.id)).toEqual(['a']);
    const history = (await admin.get('/api/v1/actions/ver/versions')).data as { version: number; note: string | null }[];
    expect(history[0]).toMatchObject({ version: 5, note: 'Rollback to version 1' });
    expect((await admin.post('/api/v1/actions/ver/rollback', { version: 42 })).status).toBe(404);
  });

  it('is admin only, and history survives deletion', async () => {
    expect((await alice.get('/api/v1/actions/ver/versions')).status).toBe(403);
    expect((await alice.post('/api/v1/actions/ver/rollback', { version: 1 })).status).toBe(403);
    await admin.del('/api/v1/actions/ver');
    expect((await admin.put('/api/v1/actions/ver', body([step('a')]))).data.version).toBe(6);
  });
});
