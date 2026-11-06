import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { client, fakeServer, register, testApp, type Api } from './helpers.js';
import { runSync } from '../src/integrations/sync.js';
import { nextCron } from '../src/lib/cron.js';

let app: FastifyInstance;
let admin: Api;
let api: Awaited<ReturnType<typeof fakeServer>>;

beforeAll(async () => {
  app = await testApp();
  admin = client(app, (await register(app, 'admin@example.com')).token);
  await admin.put('/api/v1/blueprints/svc', { title: 'Svc', schema: { properties: { tier: { type: 'number' } } } });
  api = await fakeServer(() => ({
    body: [
      { code: 'ok1', tier: 1 },
      { code: 'bad', tier: 'not-a-number' },
    ],
  }));
});
afterAll(async () => {
  await api.close();
  await app.close();
});

const def = (extra: Record<string, unknown> = {}) => ({
  title: 'S',
  type: 'http',
  intervalMinutes: 0,
  config: { url: `${api.url}/list` },
  mappings: [{ kind: 'item', entity: { blueprint: 'svc', identifier: 'code', properties: { tier: 'tier' } } }],
  ...extra,
});

describe('sync status model', () => {
  it('reports partial runs with structured item errors and the last success time', async () => {
    expect((await admin.put('/api/v1/integrations/s1', def())).status).toBe(200);
    const r = (await runSync('s1', 'manual'))!;
    expect(r.status).toBe('partial');
    expect(r.stats).toMatchObject({ upserted: 1, failed: 1 });
    expect(r.errors).toEqual([expect.objectContaining({ mapping: 'item', key: 'svc/bad' })]);
    const got = (await admin.get('/api/v1/integrations/s1')).data;
    expect(got.lastSync.errors).toHaveLength(1);
    expect(got.lastSuccessAt).toBeNull();
  });

  it('tests the connection without writing and reports failures per kind', async () => {
    const ok = await admin.post('/api/v1/integrations/s1/test', {});
    expect(ok.data).toMatchObject({ ok: true, kinds: [{ kind: 'item', ok: true, items: 2 }] });
    await admin.put('/api/v1/integrations/s2', def({ config: { url: 'http://127.0.0.1:1/x' } }));
    const bad = await admin.post('/api/v1/integrations/s2/test', {});
    expect(bad.data.ok).toBe(false);
    expect(bad.data.kinds[0].error).toBeTruthy();
  });

  it('queues a single-kind sync and validates the kind', async () => {
    expect((await admin.post('/api/v1/integrations/s1/sync?kind=nope', {})).status).toBe(400);
    expect((await admin.post('/api/v1/integrations/s1/sync?kind=item', {})).status).toBe(202);
  });

  it('accepts cron schedules and rejects invalid ones', async () => {
    expect((await admin.put('/api/v1/integrations/s3', def({ schedule: '*/15 * * * *' }))).status).toBe(200);
    expect((await admin.put('/api/v1/integrations/s3', def({ schedule: 'every day' }))).status).toBe(400);
  });
});

describe('cron', () => {
  it('computes the next run in UTC', () => {
    expect(nextCron('*/15 * * * *', new Date('2026-01-01T10:07:00Z')).toISOString()).toBe('2026-01-01T10:15:00.000Z');
    expect(nextCron('0 3 * * 1', new Date('2026-01-01T10:07:00Z')).toISOString()).toBe('2026-01-05T03:00:00.000Z');
    expect(() => nextCron('61 * * * *')).toThrow();
  });
});
