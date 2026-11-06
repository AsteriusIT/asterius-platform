import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

vi.hoisted(() => {
  process.env.RUN_LOG_MAX_LINES = '100';
});

import { client, register, silentLog, testApp, type Api } from './helpers.js';
import { all, newId, now, one, run } from '../src/db.js';
import { deleteInChunks, housekeeping } from '../src/maintenance.js';
import type { Principal } from '../src/auth/users.js';
import { addLog, listRuns } from '../src/actions/runs.js';
import { homeBlueprints, refreshBlueprintStats } from '../src/catalog/blueprints.js';

const ADMIN: Principal = { id: 'admin', email: 'admin@example.com', name: 'Admin', role: 'admin', provider: 'local', teams: [], roles: [] };
let app: FastifyInstance;
let admin: Api;
let userId: string;

beforeAll(async () => {
  app = await testApp();
  const a = await register(app, 'admin@example.com');
  admin = client(app, a.token);
  userId = a.user.id;
});
afterAll(() => app.close());

const day = (n: number) => new Date(Date.now() - n * 86400_000).toISOString();

async function insertRun(createdAt: string) {
  const id = newId();
  await run(
    `INSERT INTO runs (id, action, action_title, inputs, status, invoker, approval, triggered_by, created_at, updated_at)
     VALUES (?, 'a', 'A', '{}', 'SUCCESS', '{}', '{}', ?, ?, ?)`,
    id,
    userId,
    createdAt,
    createdAt,
  );
  return id;
}

describe('retention', () => {
  it('deletes in chunks and counts what it removed', async () => {
    for (let i = 0; i < 25; i++) await run("INSERT INTO audit_log (id, at, action) VALUES (?, ?, 'x')", newId(), day(400));
    expect(await deleteInChunks('audit_log', 'id', 'at < ?', [day(300)], 10, 0)).toBe(25);
    expect(await deleteInChunks('audit_log', 'id', 'at < ?', [day(300)], 10, 0)).toBe(0);
  });

  it('gives up on pending deliveries older than the retry horizon and purges old finished runs', async () => {
    await run("INSERT INTO webhooks (identifier, title, url, events, created_at, updated_at) VALUES ('w', 'W', 'http://x', '[\"*\"]', ?, ?)", now(), now());
    const old = newId();
    const fresh = newId();
    for (const [id, at] of [
      [old, day(10)],
      [fresh, day(1)],
    ] as const)
      await run(
        "INSERT INTO deliveries (id, webhook, event, payload, status, next_attempt_at, created_at) VALUES (?, 'w', 'e', '{}', 'pending', ?, ?)",
        id,
        at,
        at,
      );
    const oldRun = await insertRun(day(400));
    await run('UPDATE runs SET ended_at = ? WHERE id = ?', day(400), oldRun);
    await housekeeping(silentLog);
    expect((await one<{ status: string }>('SELECT status FROM deliveries WHERE id = ?', old))?.status).toBe('failed');
    expect((await one<{ status: string }>('SELECT status FROM deliveries WHERE id = ?', fresh))?.status).toBe('pending');
    expect(await one('SELECT id FROM runs WHERE id = ?', oldRun)).toBeUndefined();
  });

  it('caps the log lines stored per run', async () => {
    const id = await insertRun(now());
    for (let i = 0; i < 130; i++) await addLog(id, `line ${i}`);
    const rows = await all<{ message: string }>('SELECT message FROM run_logs WHERE run_id = ? ORDER BY seq', id);
    expect(rows).toHaveLength(101);
    expect(rows[100]!.message).toMatch(/Log limit of 100 lines reached/);
  });
});

describe('listing', () => {
  it('pages runs by cursor and can skip the total', async () => {
    for (let i = 0; i < 5; i++) await insertRun(new Date(Date.now() + i * 1000).toISOString());
    const seen = new Set<string>();
    let cursor: string | undefined;
    do {
      const p = await listRuns({ limit: 2, offset: 0, cursor }, ADMIN);
      for (const r of p.items) seen.add(r.id);
      expect(p.total === undefined).toBe(Boolean(cursor));
      cursor = p.nextCursor;
    } while (cursor);
    expect(seen.size).toBeGreaterThanOrEqual(5);
    expect((await listRuns({ limit: 2, offset: 0, count: false }, ADMIN)).total).toBeUndefined();
    const http = await admin.get('/api/v1/runs?limit=1');
    expect(http.status).toBe(200);
  });

  it('pages the audit log by cursor, advertising the next page in headers', async () => {
    for (let i = 0; i < 5; i++) await run("INSERT INTO audit_log (id, at, action) VALUES (?, ?, 'page.test')", newId(), now());
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/audit?limit=2&search=page.test',
      headers: { authorization: `Bearer ${(await login()).token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveLength(2);
    const next = res.headers['x-next-cursor'] as string;
    expect(next).toBeTruthy();
    expect(res.headers.link).toContain('rel="next"');
    const res2 = await app.inject({
      method: 'GET',
      url: `/api/v1/audit?limit=10&search=page.test&cursor=${next}`,
      headers: { authorization: `Bearer ${(await login()).token}` },
    });
    expect(res2.json()).toHaveLength(3);
    expect(res2.headers['x-next-cursor']).toBeUndefined();
  });

  it('serves home blueprint counts from the stats table', async () => {
    await admin.put('/api/v1/blueprints/thing', { title: 'Thing', schema: { properties: {} } });
    await admin.put('/api/v1/blueprints/thing/entities/t1', {});
    await refreshBlueprintStats(true);
    expect((await homeBlueprints()).find((b) => b.identifier === 'thing')?.entityCount).toBe(1);
    await admin.put('/api/v1/blueprints/thing/entities/t2', {});
    expect((await homeBlueprints()).find((b) => b.identifier === 'thing')?.entityCount).toBe(1); // until the next refresh
    expect((await admin.get('/api/v1/blueprints')).data.find((b: { identifier: string }) => b.identifier === 'thing').entityCount).toBe(2);
    await refreshBlueprintStats(true);
    expect((await homeBlueprints()).find((b) => b.identifier === 'thing')?.entityCount).toBe(2);
  });
});

async function login() {
  const r = await client(app).post('/api/auth/login', { email: 'admin@example.com', password: 'correct-horse-battery' });
  return r.data as { token: string };
}
