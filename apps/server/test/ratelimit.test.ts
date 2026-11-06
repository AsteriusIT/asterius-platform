import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

vi.hoisted(() => {
  process.env.RATE_LIMIT_STORE = 'database';
});

import { client, register, testApp } from './helpers.js';
import { DatabaseRateLimitStore } from '../src/lib/rate-limit-store.js';
import { all } from '../src/db.js';

let app: FastifyInstance;
beforeAll(async () => {
  app = await testApp();
  await register(app, 'admin@example.com');
});
afterAll(() => app.close());

const incr = (s: DatabaseRateLimitStore, key: string, window: number) =>
  new Promise<{ current: number; ttl: number }>((resolve, reject) => s.incr(key, (e, r) => (e ? reject(e) : resolve(r!)), window));

describe('database rate-limit store', () => {
  it('counts atomically across concurrent callers and resets after the window', async () => {
    const s = new DatabaseRateLimitStore();
    const rs = await Promise.all(Array.from({ length: 8 }, () => incr(s, 'ip-1', 200)));
    expect(rs.map((r) => r.current).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect((await incr(s.child({ max: 1, timeWindow: 200 }), 'ip-1', 200)).current).toBe(1); // separate scope
    await new Promise((r) => setTimeout(r, 250));
    expect((await incr(s, 'ip-1', 200)).current).toBe(1);
  });

  it('limits logins across the whole app and locks accounts after repeated failures', async () => {
    const anon = client(app);
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) statuses.push((await anon.post('/api/auth/login', { email: 'admin@example.com', password: 'wrong-password' })).status);
    // five failures lock the account (429), the per-IP limit of 10/min kicks in too
    expect(statuses.slice(0, 5)).toEqual([401, 401, 401, 401, 401]);
    expect(statuses.slice(5).every((s) => s === 429)).toBe(true);
    const rows = await all<{ n: number }>('SELECT count(*) AS n FROM rate_limits');
    expect(Number(rows[0]!.n)).toBeGreaterThan(0);
  });
});
