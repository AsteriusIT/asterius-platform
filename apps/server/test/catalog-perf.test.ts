import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { client, register, testApp, type Api } from './helpers.js';
import { all, dialect } from '../src/db.js';

let app: FastifyInstance;
let admin: Api;
const B = '/api/v1/blueprints/svc';

beforeAll(async () => {
  app = await testApp();
  admin = client(app, (await register(app, 'admin@example.com')).token);
  expect((await admin.put('/api/v1/blueprints/dom', { title: 'Domain', schema: { properties: {} } })).status).toBe(200);
  const r = await admin.put(B, {
    title: 'Svc',
    schema: {
      properties: {
        tier: { type: 'integer' },
        language: { type: 'string' },
        description: { type: 'string' },
        released: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
        owner: { type: 'string' },
        critical: { type: 'boolean' },
      },
    },
    relations: { domain: { target: 'dom' }, dependsOn: { target: 'svc', many: true } },
  });
  expect(r.status, JSON.stringify(r.data)).toBe(200);
  const seeded = await admin.post(`${B}/entities/bulk`, {
    entities: [
      {
        identifier: 'checkout',
        title: 'Checkout API',
        properties: { tier: 1, language: 'go', description: 'Handles shopping carts and orders', released: '2026-03-01', critical: true, owner: 'ann' },
        relations: { domain: 'shop' },
      },
      {
        identifier: 'ledger',
        title: 'Ledger',
        properties: { tier: 2, language: 'rust', description: 'Double entry bookkeeping', released: '2026-06-15' },
        relations: { domain: 'finance', dependsOn: ['checkout'] },
      },
      {
        identifier: 'search',
        title: 'Search Service',
        properties: { tier: 3, language: 'go', description: 'Elastic wrapper', released: '2025-12-31', critical: false },
        relations: { domain: 'shop' },
      },
      { identifier: 'checkout-web', title: 'Checkout Web', properties: { tier: 3, language: 'ts' } },
    ],
  });
  expect(seeded.data.errors).toEqual([]);
});
afterAll(() => app.close());

const ids = (r: { data: { items: { identifier: string }[] } }) => r.data.items.map((e) => e.identifier);

describe('search', () => {
  it('matches property values and ranks exact identifier first', async () => {
    expect(ids(await admin.get(`${B}/entities?search=bookkeeping`))).toEqual(['ledger']);
    expect(ids(await admin.get(`${B}/entities?search=${encodeURIComponent('shopping carts')}`))).toEqual(['checkout']);
    expect(ids(await admin.get(`${B}/entities?search=checkout`))).toEqual(['checkout', 'checkout-web']);
  });
  it.runIf(dialect === 'postgres')('tolerates typos on Postgres (pg_trgm)', async () => {
    expect(ids(await admin.get(`${B}/entities?search=bookkeping`))).toEqual(['ledger']);
  });
  it('escapes LIKE wildcards', async () => {
    expect(ids(await admin.get(`${B}/entities?search=%25`))).toEqual([]);
  });
});

describe('filters', () => {
  const q = async (qs: string) => ids(await admin.get(`${B}/entities?sort=identifier&${qs}`));
  it('supports operators', async () => {
    expect(await q('filter.tier[gt]=1')).toEqual(['checkout-web', 'ledger', 'search']);
    expect(await q('filter.tier[between]=1,2')).toEqual(['checkout', 'ledger']);
    expect(await q('filter.language[in]=go,rust')).toEqual(['checkout', 'ledger', 'search']);
    expect(await q('filter.language[neq]=go')).toEqual(['checkout-web', 'ledger']);
    expect(await q('filter.description[contains]=BOOK')).toEqual(['ledger']);
    expect(await q('filter.owner[exists]=true')).toEqual(['checkout']);
    expect(await q('filter.owner[exists]=false')).toEqual(['checkout-web', 'ledger', 'search']);
    expect(await q('filter.critical=true')).toEqual(['checkout']);
    expect(await q('filter.released[lt]=2026-01-01')).toEqual(['search']);
    expect(await q('filter.tier=1&filter.language=go')).toEqual(['checkout']);
  });
  it('filters by relation target and sorts by property', async () => {
    expect(await q('relation.domain=shop')).toEqual(['checkout', 'search']);
    expect(await q('relation.dependsOn=checkout')).toEqual(['ledger']);
    expect(ids(await admin.get(`${B}/entities?sort=prop:tier&dir=desc&limit=2`))).toHaveLength(2);
    expect(ids(await admin.get(`${B}/entities?sort=prop:released&dir=asc`))[0]).toBe('search');
  });
  it('accepts a JSON body and rejects bad input', async () => {
    const r = await admin.post(`${B}/entities/query`, {
      filters: [
        { property: 'tier', op: 'gte', value: 2 },
        { property: 'language', op: 'in', value: ['go', 'rust'] },
      ],
      relations: [{ relation: 'domain', target: ['shop', 'finance'] }],
      sort: 'prop:tier',
    });
    expect(ids(r)).toEqual(['ledger', 'search']);
    expect((await admin.get(`${B}/entities?filter.tier[bogus]=1`)).status).toBe(400);
    expect((await admin.get(`${B}/entities?filter.${encodeURIComponent("x'--")}=1`)).status).toBe(400);
    expect((await admin.post(`${B}/entities/query`, { filters: [{ property: 'tier', op: 'between', value: [1] }] })).status).toBe(400);
  });
});

describe('pagination', () => {
  it('walks every entity by cursor without total, caps offsets', async () => {
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const r = await admin.get(`/api/v1/entities?limit=2&sort=identifier${cursor ? `&cursor=${cursor}` : ''}`);
      expect(r.status).toBe(200);
      if (cursor) expect(r.data.total).toBeUndefined(); // cursor pages skip the count
      seen.push(...ids(r));
      cursor = r.data.nextCursor;
    } while (cursor);
    expect(seen).toEqual([...seen].sort());
    expect(seen).toHaveLength(4);
    expect((await admin.get(`${B}/entities?count=false`)).data.total).toBeUndefined();
    expect((await admin.get(`${B}/entities`)).data.total).toBe(4);
    expect((await admin.get(`${B}/entities?offset=10001`)).status).toBe(400);
    expect((await admin.get(`${B}/entities?cursor=garbage`)).status).toBe(400);
  });
});

describe('writes', () => {
  it('bulk-upserts hundreds of entities with relations and reports unchanged', async () => {
    const entities: unknown[] = Array.from({ length: 450 }, (_, i) => ({
      identifier: `bulk-${i}`,
      properties: { tier: (i % 3) + 1 },
      relations: { dependsOn: [`bulk-${(i + 1) % 450}`], domain: 'shop' },
    }));
    const first = entities.slice(0, 450);
    entities.push({ identifier: 'bulk-0', properties: { tier: 3 }, relations: {} }); // duplicate: applies on top
    entities.push({ identifier: 'bad', properties: { tier: 'x' } });
    const r = await admin.post(`${B}/entities/bulk`, { entities });
    expect(r.data.upserted).toBe(451);
    expect(r.data.errors).toHaveLength(1);
    expect(r.data.errors[0].index).toBe(451);
    const e = await admin.get(`${B}/entities/bulk-0`);
    expect(e.data.properties.tier).toBe(3);
    expect(e.data.relations).toEqual({});
    expect(e.data.version).toBe(2);
    const rel = await all<{ n: number }>("SELECT count(*) AS n FROM entity_relations WHERE identifier = 'bulk-7'");
    expect(Number(rel[0]!.n)).toBe(2);
    const again = await admin.post(`${B}/entities/bulk`, { entities: first.slice(1, 100) });
    expect(again.data).toMatchObject({ upserted: 0, unchanged: 99 });
  });

  it('serves ETags, honours If-Match and ignores key order', async () => {
    const g = await admin.get(`${B}/entities/ledger`);
    expect(g.data.version).toBe(1);
    expect(g.data.version).toBe(Number(g.data.version));
    const body = {
      title: 'Ledger',
      properties: { released: '2026-06-15', language: 'rust', tier: 2, description: 'Double entry bookkeeping' },
      relations: { dependsOn: ['checkout'], domain: 'finance' },
      team: null,
    };
    const first = await admin.put(`${B}/entities/ledger`, body); // source changes api -> ui
    const same = await admin.put(`${B}/entities/ledger`, {
      ...body,
      properties: { tier: 2, language: 'rust', released: '2026-06-15', description: 'Double entry bookkeeping' },
    });
    expect(same.data.version).toBe(first.data.version);
    const stale = await admin.patch(`${B}/entities/ledger`, { properties: { tier: 1 } }, { 'if-match': '"7"' });
    expect(stale.status).toBe(412);
    const ok = await admin.patch(`${B}/entities/ledger`, { properties: { tier: 1 } }, { 'if-match': `"${first.data.version}"` });
    expect(ok.status).toBe(200);
    expect(ok.data.version).toBe(first.data.version + 1);
  });

  it('turns concurrent creates into one 201 and 409s, and keeps concurrent patches', async () => {
    const rs = await Promise.all(Array.from({ length: 4 }, () => admin.post(`${B}/entities`, { identifier: 'race', properties: {} })));
    expect(rs.map((r) => r.status).sort()).toEqual([201, 409, 409, 409]);
    const ps = await Promise.all(['owner', 'language', 'description'].map((k) => admin.patch(`${B}/entities/race`, { properties: { [k]: 'x' } })));
    expect(ps.map((r) => r.status)).toEqual([200, 200, 200]);
    const final = await admin.get(`${B}/entities/race`);
    expect(Object.keys(final.data.properties).sort()).toEqual(['description', 'language', 'owner']);
  });
});

describe('graph', () => {
  it('walks dependencies and dependents across several hops, surviving cycles and missing targets', async () => {
    await admin.post(`${B}/entities/bulk`, {
      entities: [
        { identifier: 'g-a', relations: { dependsOn: ['g-b'] } },
        { identifier: 'g-b', relations: { dependsOn: ['g-c'] } },
        { identifier: 'g-c', relations: { dependsOn: ['g-d', 'g-ghost'] } },
        { identifier: 'g-d', relations: { dependsOn: ['g-a'] } },
      ],
    });
    const out = await admin.get(`${B}/entities/g-a/graph?direction=out&depth=2`);
    expect(out.status).toBe(200);
    expect(out.data.nodes.map((n: { identifier: string; depth: number }) => `${n.identifier}:${n.depth}`).sort()).toEqual(['g-a:0', 'g-b:1', 'g-c:2']);
    const deep = await admin.get(`/api/v1/entities/svc/g-a/graph?direction=out&depth=6`);
    const ids = deep.data.nodes.map((n: { identifier: string }) => n.identifier).sort();
    expect(ids).toEqual(['g-a', 'g-b', 'g-c', 'g-d', 'g-ghost']);
    expect(deep.data.nodes.find((n: { identifier: string }) => n.identifier === 'g-ghost').missing).toBe(true);
    const impact = await admin.get(`${B}/entities/g-c/graph?direction=in&depth=1`);
    expect(impact.data.nodes.map((n: { identifier: string }) => n.identifier).sort()).toEqual(['g-b', 'g-c']);
    expect(impact.data.edges).toEqual([{ from: { blueprint: 'svc', identifier: 'g-b' }, relation: 'dependsOn', to: { blueprint: 'svc', identifier: 'g-c' } }]);
    const capped = await admin.get(`${B}/entities/g-a/graph?direction=out&depth=6&limit=2`);
    expect(capped.data.nodes).toHaveLength(2);
    expect(capped.data.truncated).toBe(true);
    expect((await admin.get(`${B}/entities/g-a/graph?depth=9`)).status).toBe(400);
  });
});
