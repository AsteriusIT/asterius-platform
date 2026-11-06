import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { client, register, testApp, type Api } from './helpers.js';
import { run } from '../src/db.js';
import { LRU } from '../src/lib/lru.js';

describe('LRU', () => {
  it('evicts the least recently used entry and honours the ttl', async () => {
    const c = new LRU<string, number>(2, 50);
    c.set('a', 1);
    c.set('b', 2);
    expect(c.get('a')).toBe(1); // a is now the most recent
    c.set('c', 3);
    expect(c.get('b')).toBeUndefined();
    expect(c.get('a')).toBe(1);
    expect(c.size).toBe(2);
    await new Promise((r) => setTimeout(r, 70));
    expect(c.get('a')).toBeUndefined();
  });
});

describe('cross-replica invalidation', () => {
  let app: FastifyInstance;
  let admin: Api;
  beforeAll(async () => {
    app = await testApp();
    admin = client(app, (await register(app, 'admin@example.com')).token);
  });
  afterAll(() => app.close());

  it('sees a blueprint changed by another replica within a second', async () => {
    await admin.put('/api/v1/blueprints/thing', { title: 'Thing', schema: { properties: { a: { type: 'string' } } } });
    expect((await admin.put('/api/v1/blueprints/thing/entities/one', { properties: { a: 'x' } })).status).toBe(200); // warms the cache
    // Another replica requires property "b": it writes the row and bumps config_version, we only share the database.
    await run(`UPDATE blueprints SET schema = '{"properties":{"a":{"type":"string"},"b":{"type":"string"}},"required":["b"]}' WHERE identifier = 'thing'`);
    await run('UPDATE config_version SET version = version + 1 WHERE id = 1');
    await new Promise((r) => setTimeout(r, 1100));
    const res = await admin.put('/api/v1/blueprints/thing/entities/two', { properties: { a: 'x' } });
    expect(res.status).toBe(400);
    expect(res.data.error).toMatch(/b/);
  });
});
