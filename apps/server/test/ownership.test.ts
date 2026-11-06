import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { client, fakeServer, register, testApp, type Api } from './helpers.js';
import { runSync } from '../src/integrations/sync.js';

let app: FastifyInstance;
let admin: Api;
let primary: Awaited<ReturnType<typeof fakeServer>>;
let secondary: Awaited<ReturnType<typeof fakeServer>>;

beforeAll(async () => {
  app = await testApp();
  admin = client(app, (await register(app, 'admin@example.com')).token);
  await admin.put('/api/v1/blueprints/svc', { title: 'Svc', schema: { properties: { owner: { type: 'string' }, tier: { type: 'string' } } } });
  primary = await fakeServer(() => ({ body: [{ code: 'a', owner: 'team-x' }] }));
  secondary = await fakeServer(() => ({ body: [{ code: 'a', owner: 'team-y', tier: 'gold' }] }));
});
afterAll(async () => {
  await primary.close();
  await secondary.close();
  await app.close();
});

const def = (url: string, extra: Record<string, unknown> = {}, merge = false) => ({
  title: 'x',
  type: 'http',
  intervalMinutes: 0,
  config: { url },
  mappings: [{ kind: 'item', merge, entity: { blueprint: 'svc', identifier: 'code', properties: { owner: 'owner', tier: 'tier' } } }],
  ...extra,
});
const get = async () => (await admin.get('/api/v1/blueprints/svc/entities/a')).data;

describe('integration ownership', () => {
  it('lets the higher priority integration own the entity and report conflicts', async () => {
    await admin.put('/api/v1/integrations/cmdb', def(`${primary.url}/l`, { priority: 10 }));
    await admin.put('/api/v1/integrations/scanner', def(`${secondary.url}/l`, { priority: 1 }));
    await runSync('cmdb', 'manual');
    const r = (await runSync('scanner', 'manual'))!;
    expect(r.logs.join('\n')).toMatch(/CONFLICT svc\/a is owned by integration:cmdb/);
    expect(r.stats.skipped).toBe(1);
    expect(await get()).toMatchObject({ source: 'integration:cmdb', properties: { owner: 'team-x' } });
    expect((await get()).properties.tier).toBeUndefined();
  });

  it('merge mappings of a lower priority integration only fill the gaps', async () => {
    await admin.put('/api/v1/integrations/scanner', def(`${secondary.url}/l`, { priority: 1 }, true));
    const r = (await runSync('scanner', 'manual'))!;
    expect(r.logs.join('\n')).toMatch(/filled only the fields/);
    expect(await get()).toMatchObject({ source: 'integration:cmdb', properties: { owner: 'team-x', tier: 'gold' } });
  });

  it('a higher priority integration takes over', async () => {
    await admin.put('/api/v1/integrations/scanner', def(`${secondary.url}/l`, { priority: 50 }));
    await runSync('scanner', 'manual');
    expect(await get()).toMatchObject({ source: 'integration:scanner', properties: { owner: 'team-y' } });
    // the former owner now loses (50 > 10)
    const r = (await runSync('cmdb', 'manual'))!;
    expect(r.logs.join('\n')).toMatch(/CONFLICT/);
  });
});
