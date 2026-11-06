import fs from 'node:fs';
import path from 'node:path';
import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { client, fakeServer, register, silentLog, testApp, type Api } from './helpers.js';
import { runSync } from '../src/integrations/sync.js';
import { registerSource } from '../src/integrations/sources/index.js';
import type { Source } from '../src/integrations/types.js';
import { applyConfig, readConfigDir } from '../src/config-loader.js';

let app: FastifyInstance;
let admin: Api;
let member: Api;
let api: Awaited<ReturnType<typeof fakeServer>>;
let items: unknown[] = [];

beforeAll(async () => {
  app = await testApp();
  admin = client(app, (await register(app, 'admin@example.com')).token);
  member = client(app, (await register(app, 'member@example.com')).token);
  await admin.put('/api/v1/blueprints/app', { title: 'App', schema: { properties: { tier: { type: 'string' }, status: { type: 'string' } } } });
  // A paginated third-party API: /apps?page=1 → { data, next }
  api = await fakeServer((r) => {
    const page = Number(new URL(r.url, 'http://x').searchParams.get('page') ?? 1);
    return { body: { data: items.slice((page - 1) * 2, page * 2), next: page * 2 < items.length ? `/apps?page=${page + 1}` : null } };
  });
});
afterAll(async () => {
  await api.close();
  await app.close();
});

describe('pull integrations (http source)', () => {
  it('syncs paginated items, then deletes the ones gone from the source', async () => {
    const saved = await admin.put('/api/v1/integrations/cmdb', {
      title: 'CMDB',
      type: 'http',
      intervalMinutes: 0,
      deleteMissing: true,
      deleteMaxPercent: 100,
      config: { url: `${api.url}/apps?page=1`, itemsPath: 'data', pagination: { type: 'next', nextUrl: 'next' } },
      mappings: [
        { kind: 'item', filter: 'active', entity: { blueprint: 'app', identifier: 'code', title: 'name', properties: { tier: '"tier-" & $string(tier)' } } },
      ],
    });
    expect(saved.status, JSON.stringify(saved.data)).toBe(200);

    items = [
      { code: 'a1', name: 'Alpha', tier: 1, active: true },
      { code: 'b2', name: 'Beta', tier: 2, active: true },
      { code: 'c3', name: 'Gamma', tier: 3, active: true },
      { code: 'z9', name: 'Inactive', tier: 3, active: false },
    ];
    const first = (await runSync('cmdb', 'manual'))!;
    expect(first.status, first.logs.join('\n')).toBe('success');
    expect(first.stats).toEqual({ upserted: 3, deleted: 0, skipped: 1, failed: 0 });
    const list = await member.get('/api/v1/blueprints/app/entities');
    expect(list.data.items.map((e: { title: string; source: string }) => `${e.title}:${e.source}`)).toEqual([
      'Alpha:integration:cmdb',
      'Beta:integration:cmdb',
      'Gamma:integration:cmdb',
    ]);

    // Manual edits of synced entities are refused (they would be overwritten).
    expect((await admin.patch('/api/v1/blueprints/app/entities/a1', { properties: { tier: 'x' } })).status).toBe(400);

    items = [{ code: 'a1', name: 'Alpha', tier: 1, active: true }];
    const second = (await runSync('cmdb', 'manual'))!;
    expect(second.stats).toMatchObject({ upserted: 0, deleted: 2, skipped: 1 });

    // An empty listing never wipes the catalog (expired token, outage returning []).
    items = [];
    const third = (await runSync('cmdb', 'manual'))!;
    expect(third.stats.deleted).toBe(0);
    expect(third.logs.join('\n')).toMatch(/SKIPPED deleting 1 entities/);
  });

  it('records source failures without deleting anything', async () => {
    await admin.put('/api/v1/integrations/down', {
      title: 'Down',
      type: 'http',
      intervalMinutes: 0,
      deleteMissing: true,
      config: { url: 'http://127.0.0.1:1/nothing' },
      mappings: [{ kind: 'item', entity: { blueprint: 'app', identifier: 'code' } }],
    });
    const r = (await runSync('down', 'manual'))!;
    expect(r.status).toBe('failure');
    expect((await admin.get('/api/v1/integrations/down')).data.lastSync.status).toBe('failure');
  });
});

// A scripted source: items per kind, optional incomplete flag, and a record of the states it was handed.
const script: { items: Record<string, Array<{ code: string }>>; incomplete: Record<string, string>; states: unknown[] } = {
  items: {},
  incomplete: {},
  states: [],
};
const scripted: Source = {
  info: { type: 'scripted', title: 'Scripted', description: 'test', kinds: ['a', 'b'], example: { type: 'scripted' } },
  incremental: true,
  validate: () => undefined,
  async *list(kind, env) {
    script.states.push(env.state);
    if (script.incomplete[kind]) env.incomplete(script.incomplete[kind]);
    yield script.items[kind] ?? [];
    env.setState({ since: env.startedAt });
  },
};

describe('sync safety and incremental state', () => {
  const codes = (n: number, p: string) => Array.from({ length: n }, (_, i) => ({ code: `${p}${i}` }));
  const save = (id: string, extra: Record<string, unknown> = {}) =>
    admin.put(`/api/v1/integrations/${id}`, {
      title: id,
      type: 'scripted',
      intervalMinutes: 0,
      deleteMissing: true,
      config: {},
      mappings: [{ kind: 'a', entity: { blueprint: 'app', identifier: `"${id}-" & code` } }],
      ...extra,
    });
  const count = async (id: string) =>
    (await member.get('/api/v1/blueprints/app/entities')).data.items.filter((e: { source: string }) => e.source === `integration:${id}`).length;

  it('never deletes for an incomplete listing, a too large deletion, and supports dry runs', async () => {
    registerSource(scripted);
    expect((await save('safe', { config: { fullReconcileHours: 0 } })).status).toBe(200);
    script.items = { a: codes(10, 'x') };
    expect((await runSync('safe', 'manual'))!.stats.upserted).toBe(10);

    // Truncated listing: 2 of 10 seen, flagged incomplete → nothing deleted.
    script.items = { a: codes(2, 'x') };
    script.incomplete = { a: 'page cap' };
    let r = (await runSync('safe', 'manual'))!;
    expect(r.stats.deleted).toBe(0);
    expect(r.logs.join('\n')).toMatch(/SKIPPED deleting 8 entities of blueprint app: a listing incomplete \(page cap\)/);
    expect(await count('safe')).toBe(10);

    // Complete but 80% of the entities would go: above the default 20% guard.
    script.incomplete = {};
    r = (await runSync('safe', 'manual'))!;
    expect(r.stats.deleted).toBe(0);
    expect(r.logs.join('\n')).toMatch(/deleteMaxPercent 20%/);

    // Dry run reports without deleting.
    await save('safe', { deleteMaxPercent: 100, deleteDryRun: true });
    r = (await runSync('safe', 'manual'))!;
    expect(r.stats.deleted).toBe(0);
    expect(r.logs.join('\n')).toMatch(/DRY RUN: would delete 8 entities/);
    expect(await count('safe')).toBe(10);

    await save('safe', { deleteMaxPercent: 100 });
    r = (await runSync('safe', 'manual'))!;
    expect(r.stats.deleted).toBe(8);
    expect(await count('safe')).toBe(2);
  });

  it('protects the blueprint when one of its kinds returns nothing', async () => {
    registerSource(scripted);
    await save('two', {
      config: { fullReconcileHours: 0 },
      deleteMaxPercent: 100,
      mappings: [
        { kind: 'a', entity: { blueprint: 'app', identifier: '"two-" & code' } },
        { kind: 'b', entity: { blueprint: 'app', identifier: '"two-b-" & code' } },
      ],
    });
    script.items = { a: codes(3, 'p'), b: codes(3, 'q') };
    await runSync('two', 'manual');
    script.items = { a: codes(3, 'p'), b: [] };
    const r = (await runSync('two', 'manual'))!;
    expect(r.stats.deleted).toBe(0);
    expect(r.logs.join('\n')).toMatch(/b returned nothing/);
    expect(await count('two')).toBe(6);
  });

  it('runs incrementally between full reconciles and only deletes on a full run', async () => {
    registerSource(scripted);
    await save('inc', { deleteMaxPercent: 100 });
    script.items = { a: codes(4, 'i') };
    script.states = [];
    await runSync('inc', 'manual'); // full: no state yet
    script.items = { a: codes(1, 'i') }; // would look like 3 deletions
    const r = (await runSync('inc', 'manual'))!; // incremental: state handed over, nothing deleted
    expect(script.states[0]).toBeUndefined();
    expect(script.states[1]).toMatchObject({ since: expect.any(String) });
    expect(r.stats.deleted).toBe(0);
    expect(r.logs.join('\n')).toMatch(/deferred to the next full reconcile/);
    expect(await count('inc')).toBe(4);
    // Changing the configuration resets the state: full again, deletes.
    await save('inc', { deleteMaxPercent: 100, title: 'inc2' });
    expect((await runSync('inc', 'manual'))!.stats.deleted).toBe(3);
  });

  it('sends If-None-Match and a since parameter from the http source', async () => {
    let seen: Array<{ inm?: string; since: string | null }> = [];
    const s = await fakeServer();
    await s.close();
    const srv = await fakeServer((r) => {
      seen.push({ inm: r.headers['if-none-match'] as string | undefined, since: new URL(r.url, 'http://x').searchParams.get('since') });
      return { body: [{ code: 'e1' }] };
    });
    await admin.put('/api/v1/integrations/etag', {
      title: 'etag',
      type: 'http',
      intervalMinutes: 0,
      config: { url: `${srv.url}/list`, incremental: { sinceParam: 'since' } },
      mappings: [{ kind: 'item', entity: { blueprint: 'app', identifier: '"etag-" & code' } }],
    });
    await runSync('etag', 'manual');
    await runSync('etag', 'manual');
    expect(seen[0]?.since).toBeNull();
    expect(seen[1]?.since).toMatch(/^\d{4}-/);
    await srv.close();
    seen = [];
  });
});

describe('inbound webhooks', () => {
  beforeAll(async () => {
    await admin.put('/api/v1/secrets/HOOK', { value: 'hook-secret-1' });
    const saved = await admin.put('/api/v1/integrations/events', {
      title: 'Events',
      type: 'webhook',
      config: { secret: '${secret:HOOK}', signatureHeader: 'x-hub-signature-256' },
      mappings: [
        {
          kind: 'event',
          filter: '$headers."x-event" = "app"',
          delete: 'action = "deleted"',
          entity: { blueprint: 'app', identifier: 'app.id', title: 'app.name', properties: { status: 'action' } },
        },
      ],
    });
    expect(saved.status, JSON.stringify(saved.data)).toBe(200);
    expect(saved.data.webhookUrl).toBe('http://platform.test/api/v1/ingest/events');
  });

  const post = (body: unknown, secret = 'hook-secret-1', event = 'app') => {
    const raw = JSON.stringify(body);
    return app.inject({
      method: 'POST',
      url: '/api/v1/ingest/events',
      headers: {
        'content-type': 'application/json',
        'x-event': event,
        'x-hub-signature-256': `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`,
      },
      payload: raw,
    });
  };

  it('verifies the HMAC signature over the raw body', async () => {
    expect((await post({ action: 'created', app: { id: 'w1', name: 'Web' } }, 'wrong')).statusCode).toBe(401);
    const ok = await post({ action: 'created', app: { id: 'w1', name: 'Web' } });
    expect(ok.json()).toMatchObject({ upserted: 1, failed: 0 });
    expect((await member.get('/api/v1/blueprints/app/entities/w1')).data.properties.status).toBe('created');
  });

  it('filters events and deletes on a delete expression', async () => {
    expect((await post({ action: 'created', app: { id: 'w2' } }, 'hook-secret-1', 'other')).json()).toMatchObject({ upserted: 0, skipped: 1 });
    expect((await post({ action: 'deleted', app: { id: 'w1' } })).json()).toMatchObject({ deleted: 1 });
    expect((await member.get('/api/v1/blueprints/app/entities/w1')).status).toBe(404);
  });
});

describe('configuration as code', () => {
  it('applies files, protects managed resources and prunes removed ones', async () => {
    const dir = process.env.CONFIG_DIR!;
    fs.writeFileSync(
      path.join(dir, 'platform.yaml'),
      `teams:
  - { identifier: ops, title: Ops }
blueprints:
  - identifier: db
    title: Database
    schema: { properties: { engine: { type: string, enum: [postgres, mysql] } } }
actions:
  - identifier: create-db
    title: Create database
    blueprint: db
    inputs: { properties: { name: { type: string } }, required: [name] }
    invoker: { type: catalog, blueprint: db, identifier: "{{ inputs.name }}", properties: { engine: postgres } }
entities:
  - { blueprint: db, identifier: main, properties: { engine: mysql } }
`,
    );
    const plan = (await admin.get('/api/v1/config/plan')).data as Array<{ kind: string; identifier: string; action: string }>;
    expect(plan).toContainEqual({ kind: 'blueprint', identifier: 'db', action: 'create' });
    expect(await applyConfig(readConfigDir(dir), silentLog)).toEqual([]);
    const after = (await admin.get('/api/v1/config/plan')).data as Array<{ action: string }>;
    expect(after.filter((p) => p.action !== 'unchanged')).toEqual([]);
    const bp = await member.get('/api/v1/blueprints/db');
    expect(bp.data.managed).toBe(true);
    expect((await admin.put('/api/v1/blueprints/db', { title: 'Changed' })).status).toBe(409);
    expect((await admin.del('/api/v1/actions/create-db')).status).toBe(409);
    expect((await member.get('/api/v1/blueprints/db/entities/main')).data.source).toBe('config');

    // The action disappears from the files → removed; the blueprint still has an entity created by someone →
    // kept, with a warning (the seeded entity is gone).
    expect((await admin.post('/api/v1/blueprints/db/entities', { identifier: 'mine' })).status).toBeLessThan(300);
    fs.writeFileSync(path.join(dir, 'platform.yaml'), 'teams:\n  - { identifier: ops, title: Ops }\n');
    await applyConfig(readConfigDir(dir), silentLog);
    expect((await admin.get('/api/v1/actions/create-db')).status).toBe(404);
    expect((await admin.get('/api/v1/blueprints/db')).status).toBe(200);
    expect((await admin.get('/api/v1/blueprints/db/entities/main')).status).toBe(404);

    // Without it, the blueprint goes too.
    await admin.del('/api/v1/blueprints/db/entities/mine');
    await applyConfig(readConfigDir(dir), silentLog);
    expect((await admin.get('/api/v1/blueprints/db')).status).toBe(404);

    // A broken file is surfaced by the status endpoint (the previous configuration stays in force).
    fs.writeFileSync(path.join(dir, 'broken.yaml'), 'blueprints: [ {identifier: 1} ]\n');
    const status = (await admin.get('/api/v1/config/status')).data;
    expect(status.readError).toMatch(/broken\.yaml/);
    expect(status.inSync).toBe(false);
    fs.rmSync(path.join(dir, 'broken.yaml'));

    const exported = await admin.get('/api/v1/config/export');
    expect(exported.data).toContain('identifier: app');
  });

  it('reads the shipped configuration, with YAML merge keys', () => {
    const { data } = readConfigDir(path.resolve(__dirname, '../../../config'));
    expect(data.blueprints.map((b) => b.identifier)).toEqual(['ado-project', 'ado-repository', 'ado-member']);
    const create = data.actions.find((a) => a.identifier === 'create-ado-project')!;
    expect(create.trigger).toMatchObject({ type: 'form', on: 'create', blueprint: 'ado-project' });
    // `<<: *ado-pipeline` merged the shared pipeline settings with the step's own parameters.
    expect(create.steps[0]).toMatchObject({
      type: 'invoke',
      invoker: { type: 'azure-pipeline', project: 'Platform', token: '${secret:ADO_PAT}', templateParameters: { operation: 'create-project' } },
    });
    expect(data.actions.map((a) => `${a.identifier}:${a.trigger?.on}`).sort()).toEqual([
      'add-ado-member:day-2',
      'add-ado-repository:day-2',
      'create-ado-project:create',
      'delete-ado-project:delete',
      'delete-ado-repository:delete',
      'remove-ado-member:delete',
    ]);
  });

  it('rejects invalid files as a whole', () => {
    const dir = fs.mkdtempSync(path.join(process.env.DATA_DIR!, 'bad-'));
    fs.writeFileSync(path.join(dir, 'a.yaml'), 'blueprints:\n  - { identifier: Bad Id, title: x }\n');
    expect(() => readConfigDir(dir)).toThrow(/a\.yaml: blueprints\.0\.identifier/);
  });
});
