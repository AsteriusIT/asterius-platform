import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { client, register, testApp, type Api } from './helpers.js';
import { all, one } from '../src/db.js';
import { decrypt, parseKey, rotateSecretsKey } from '../src/secrets.js';

let app: FastifyInstance;
let admin: Api;
let member: Api;

beforeAll(async () => {
  app = await testApp();
  admin = client(app, (await register(app, 'admin@example.com')).token);
  member = client(app, (await register(app, 'member@example.com')).token);
  await admin.put('/api/v1/teams/platform', { title: 'Platform' });
  await admin.put('/api/v1/blueprints/service', {
    title: 'Service',
    schema: { properties: { tier: { type: 'string' } } },
    relations: { owner: { title: 'Owner', target: 'service', many: false } },
  });
  for (const [id, tier, owner] of [
    ['api', 'gold', undefined],
    ['web', 'silver', 'api'],
    ['db', 'gold', 'api'],
  ] as const)
    await admin.put(`/api/v1/blueprints/service/entities/${id}`, {
      title: id.toUpperCase(),
      team: 'platform',
      properties: { tier },
      relations: owner ? { owner } : {},
    });
  await admin.put('/api/v1/secrets/TOKEN', { value: 'super-secret-value', description: 'ci token' });
});
afterAll(() => app.close());

describe('archive export / import', () => {
  it('is admin only and never contains secret values', async () => {
    expect((await member.get('/api/v1/archive')).status).toBe(403);
    const res = await admin.get('/api/v1/archive');
    expect(res.status).toBe(200);
    expect(res.data.format).toBe('asterius-archive');
    expect(res.data.entities).toHaveLength(3);
    expect(res.data.definitions.blueprints.map((b: { identifier: string }) => b.identifier)).toContain('service');
    expect(res.data.secrets).toEqual([{ name: 'TOKEN', description: 'ci token' }]);
    expect(JSON.stringify(res.data)).not.toContain('super-secret-value');
  });

  it('restores entities and definitions into an emptied catalog, skipping or overwriting existing ones', async () => {
    const archive = (await admin.get('/api/v1/archive')).data;
    for (const id of ['api', 'web', 'db']) await admin.del(`/api/v1/blueprints/service/entities/${id}`);
    expect((await admin.get('/api/v1/blueprints/service/entities')).data.total).toBe(0);

    const dry = (await admin.post('/api/v1/archive/import?dryRun=true', archive)).data;
    expect(dry.created.entities).toBe(3);
    expect((await admin.get('/api/v1/blueprints/service/entities')).data.total).toBe(0); // nothing written

    const first = (await admin.post('/api/v1/archive/import', archive)).data;
    expect(first.failed).toMatchObject({ entities: 0, blueprints: 0, teams: 0 });
    expect(first.created.entities).toBe(3);
    expect(first.skipped.blueprints).toBe(1);
    expect(first.missingSecrets).toEqual([]);
    const web = (await admin.get('/api/v1/blueprints/service/entities/web')).data;
    expect(web).toMatchObject({ title: 'WEB', team: 'platform', properties: { tier: 'silver' }, relations: { owner: 'api' } });

    // Second run with skip: nothing changes; with overwrite: entities are rewritten.
    const again = (await admin.post('/api/v1/archive/import', archive)).data;
    expect(again.skipped.entities).toBe(3);
    const over = (await admin.post('/api/v1/archive/import?mode=overwrite', archive)).data;
    expect(over.updated.entities).toBe(3);
  });

  it('rejects files that are not archives', async () => {
    const res = await admin.post('/api/v1/archive/import', { hello: 'world' });
    expect(res.status).toBe(400);
    expect(res.data.error).toMatch(/Not an Asterius archive/);
  });
});

describe('secrets key rotation', () => {
  it('re-encrypts stored secrets with the new key', async () => {
    const before = await one<{ value_enc: string }>("SELECT value_enc FROM secrets WHERE name = 'TOKEN'");
    const newKey = randomBytes(32).toString('hex');
    expect(await rotateSecretsKey(newKey)).toBe(1);
    const rows = await all<{ value_enc: string }>("SELECT value_enc FROM secrets WHERE name = 'TOKEN'");
    expect(rows[0]!.value_enc).not.toBe(before!.value_enc);
    expect(decrypt(rows[0]!.value_enc, parseKey(newKey))).toBe('super-secret-value');
    await expect(rotateSecretsKey('short')).rejects.toThrow(/32 bytes/);
  });
});
