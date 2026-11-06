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
    expect(r.logs.join('\n')).toMatch(/wrote 1 field\(s\)/);
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

  it('tracks field owners: a mid-priority merge outranks only the fields of lower writers; primaryFor beats priority', async () => {
    // Fresh entity "a" owned by cmdb (10) with a tier written by scanner (1), as above; reset to that state.
    await admin.put('/api/v1/integrations/scanner', def(`${secondary.url}/l`, { priority: 1 }, true));
    await admin.put('/api/v1/integrations/cmdb', def(`${primary.url}/l`, { priority: 10 }));
    await admin.del('/api/v1/blueprints/svc/entities/a');
    await runSync('cmdb', 'manual'); // owner: team-x
    await runSync('scanner', 'manual'); // tier: gold (field owner: scanner), owner untouched
    expect(await get()).toMatchObject({ source: 'integration:cmdb', properties: { owner: 'team-x', tier: 'gold' } });

    const mid = await fakeServer(() => ({ body: [{ code: 'a', owner: 'team-z', tier: 'silver' }] }));
    await admin.put('/api/v1/integrations/mid', def(`${mid.url}/l`, { priority: 5 }, true));
    await runSync('mid', 'manual');
    // mid (5) outranks scanner (1) on tier but not cmdb (10) on owner.
    expect(await get()).toMatchObject({ source: 'integration:cmdb', properties: { owner: 'team-x', tier: 'silver' } });
    // scanner cannot take the tier back
    await runSync('scanner', 'manual');
    expect((await get()).properties.tier).toBe('silver');
    // cmdb (10) owns the entity but a field owned by a lower writer is still its to overwrite when it syncs
    await runSync('cmdb', 'manual');
    expect((await get()).properties.owner).toBe('team-x');

    // A primary source beats any priority on its blueprint, and keeps the fields it does not map.
    const prim = await fakeServer(() => ({ body: [{ code: 'a', owner: 'team-p' }] }));
    await admin.put('/api/v1/integrations/primary', def(`${prim.url}/l`, { priority: 0, primaryFor: ['svc'] }, true));
    await runSync('primary', 'manual');
    expect(await get()).toMatchObject({ source: 'integration:primary', properties: { owner: 'team-p', tier: 'silver' } });
    await mid.close();
    await prim.close();
  });
});
