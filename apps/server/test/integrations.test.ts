import fs from 'node:fs';
import path from 'node:path';
import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { client, fakeServer, register, silentLog, testApp, type Api } from './helpers.js';
import { runSync } from '../src/integrations/sync.js';
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
    await applyConfig(readConfigDir(dir), silentLog);
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
