import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { client, register, testApp, waitFor, type Api } from './helpers.js';

let app: FastifyInstance;
let admin: Api;

const get = async (bp: string, id: string) => (await admin.get(`/api/v1/blueprints/${bp}/entities/${id}`)).data;

beforeAll(async () => {
  app = await testApp();
  admin = client(app, (await register(app, 'admin@example.com')).token);
  expect((await admin.put('/api/v1/blueprints/squad', { title: 'Squad', schema: { properties: { lead: { type: 'string' } } } })).status).toBe(200);
  expect(
    (
      await admin.put('/api/v1/blueprints/incident', {
        title: 'Incident',
        schema: { properties: { open: { type: 'boolean' }, cost: { type: 'number' } } },
        relations: { squad: { target: 'squad' } },
      })
    ).status,
  ).toBe(200);
  const svc = await admin.put('/api/v1/blueprints/product', {
    title: 'Product',
    schema: { properties: { name: { type: 'string' } } },
    relations: { squad: { target: 'squad' } },
    computed: {
      slug: { kind: 'calculated', expression: '$lowercase(properties.name)' },
      squadLead: { kind: 'mirror', relation: 'squad', property: 'lead' },
    },
  });
  expect(svc.status, JSON.stringify(svc.data)).toBe(200);
  const sq = await admin.put('/api/v1/blueprints/squad', {
    title: 'Squad',
    schema: { properties: { lead: { type: 'string' } } },
    computed: {
      openIncidents: { kind: 'aggregation', blueprint: 'incident', relation: 'squad', function: 'count', filter: 'properties.open = true' },
      totalCost: { kind: 'aggregation', blueprint: 'incident', relation: 'squad', function: 'sum', property: 'cost' },
    },
  });
  expect(sq.status, JSON.stringify(sq.data)).toBe(200);
});
afterAll(() => app.close());

describe('computed properties', () => {
  it('validates definitions', async () => {
    const bad = (computed: unknown) =>
      admin.put('/api/v1/blueprints/product', {
        title: 'P',
        schema: { properties: { name: { type: 'string' } } },
        relations: { squad: { target: 'squad' } },
        computed,
      });
    expect((await bad({ name: { kind: 'calculated', expression: '1' } })).status).toBe(400); // clashes with a property
    expect((await bad({ x: { kind: 'mirror', relation: 'nope' } })).status).toBe(400);
    expect((await bad({ x: { kind: 'calculated', expression: 'a +' } })).status).toBe(400);
    expect((await bad({ x: { kind: 'aggregation', blueprint: 'incident', relation: 'squad', function: 'sum' } })).status).toBe(400);
    expect((await bad({ x: { kind: 'aggregation', blueprint: 'incident', relation: 'other', function: 'count' } })).status).toBe(400);
  });

  it('evaluates calculated properties on read', async () => {
    await admin.put('/api/v1/blueprints/product/entities/p1', { properties: { name: 'Shop FRONT' } });
    expect((await get('product', 'p1')).computed.slug).toBe('shop front');
  });

  it('materialises mirrors and follows the related entity', async () => {
    await admin.put('/api/v1/blueprints/squad/entities/blue', { properties: { lead: 'Ann' } });
    await admin.put('/api/v1/blueprints/product/entities/p1', { properties: { name: 'Shop' }, relations: { squad: 'blue' } });
    expect((await get('product', 'p1')).computed.squadLead).toBe('Ann');
    await admin.patch('/api/v1/blueprints/squad/entities/blue', { properties: { lead: 'Bob' } });
    expect((await get('product', 'p1')).computed.squadLead).toBe('Bob');
    // filterable like a property
    const list = await admin.get('/api/v1/blueprints/product/entities?filter.squadLead=Bob');
    expect(list.data.items.map((e: { identifier: string }) => e.identifier)).toEqual(['p1']);
    expect((await admin.get('/api/v1/blueprints/product/entities?filter.squadLead=Zed')).data.total).toBe(0);
  });

  it('maintains aggregations when related entities are written, moved and deleted', async () => {
    await admin.put('/api/v1/blueprints/squad/entities/red', { properties: {} });
    const inc = (id: string, squad: string, open: boolean, cost: number) =>
      admin.put(`/api/v1/blueprints/incident/entities/${id}`, { properties: { open, cost }, relations: { squad } });
    await inc('i1', 'blue', true, 10);
    await inc('i2', 'blue', false, 5);
    await inc('i3', 'blue', true, 1);
    expect((await get('squad', 'blue')).computed).toEqual({ openIncidents: 2, totalCost: 16 });

    await inc('i3', 'red', true, 1); // moved: both squads refresh
    expect((await get('squad', 'blue')).computed).toEqual({ openIncidents: 1, totalCost: 15 });
    expect((await get('squad', 'red')).computed).toEqual({ openIncidents: 1, totalCost: 1 });

    await admin.del('/api/v1/blueprints/incident/entities/i1');
    expect((await get('squad', 'blue')).computed).toEqual({ openIncidents: 0, totalCost: 5 });
    expect((await admin.get('/api/v1/blueprints/squad/entities?filter.openIncidents=1')).data.items.map((e: { identifier: string }) => e.identifier)).toEqual([
      'red',
    ]);
  });

  it('backfills existing entities when a definition is added', async () => {
    const bp = (await admin.get('/api/v1/blueprints/squad')).data;
    await admin.put('/api/v1/blueprints/squad', {
      ...bp,
      computed: { ...bp.computed, incidents: { kind: 'aggregation', blueprint: 'incident', relation: 'squad', function: 'count' } },
    });
    await waitFor(async () => (await get('squad', 'blue')).computed.incidents === 1);
  });
});
