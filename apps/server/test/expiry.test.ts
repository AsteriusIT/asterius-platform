import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { client, register, testApp, type Api } from './helpers.js';
import { onEvent, type DomainEvent } from '../src/events.js';
import { expiryTime, expireEntities, expireAllOrganizations } from '../src/catalog/expiry.js';
import { upsertBlueprint } from '../src/catalog/blueprints.js';
import { upsertEntity, deleteEntity } from '../src/catalog/entities.js';
import { DEFAULT_ORG, withOrg } from '../src/orgs/context.js';
import { all, one } from '../src/db.js';

let app: FastifyInstance;
let alice: Api;
let ACME: string;
const seen: { org: string; e: DomainEvent }[] = [];
const expired = (org: string, id?: string) =>
  seen.filter(
    (s) => s.org === org && s.e.type === ('entity.expired' as string) && (!id || (s.e.data as { entity: { identifier: string } }).entity.identifier === id),
  );

const past = '2020-01-01T00:00:00.000Z';
const future = '2999-01-01T00:00:00.000Z';
const bpDef = (ttl?: string) => ({
  identifier: 'env',
  title: 'Env',
  schema: { properties: { expiresAt: { type: 'string', format: 'date-time' }, note: { type: 'string' } } },
  ...(ttl ? { ttlProperty: ttl } : {}),
});
const put = (org: string, id: string, properties: Record<string, unknown>) =>
  withOrg(org, () => upsertEntity('env', { identifier: id, title: id, properties }, { source: 'test' }));

beforeAll(async () => {
  app = await testApp();
  alice = client(app, (await register(app, 'admin@example.com')).token);
  const { orgId: ctx } = await import('../src/orgs/context.js');
  onEvent(async (e) => {
    seen.push({ org: ctx(), e });
  });
  const created = await alice.post('/api/orgs', { slug: 'acme', name: 'Acme' });
  expect(created.status, JSON.stringify(created.data)).toBe(201);
  await withOrg(DEFAULT_ORG, () => upsertBlueprint(bpDef('expiresAt')));
  ACME = (await one<{ id: string }>('SELECT id FROM organizations WHERE slug = ?', 'acme'))!.id;
  await withOrg(ACME, () => upsertBlueprint(bpDef('expiresAt')));
});
afterAll(() => app.close());

describe('entity expiry', () => {
  it('validates ttlProperty', async () => {
    await expect(withOrg(DEFAULT_ORG, () => upsertBlueprint({ ...bpDef(), ttlProperty: 'note' }))).rejects.toThrow(/ttlProperty/);
    await expect(withOrg(DEFAULT_ORG, () => upsertBlueprint({ ...bpDef(), ttlProperty: 'nope' }))).rejects.toThrow(/ttlProperty/);
  });

  it('does not emit before expiry, without the property, or for blueprints without a ttl', async () => {
    await put(DEFAULT_ORG, 'later', { expiresAt: future });
    await put(DEFAULT_ORG, 'bare', { note: 'x' });
    await withOrg(DEFAULT_ORG, () => upsertBlueprint({ ...bpDef(), identifier: 'plain', title: 'Plain' }));
    await withOrg(DEFAULT_ORG, () => upsertEntity('plain', { identifier: 'old', title: 'old', properties: { expiresAt: past } }, { source: 'test' }));
    expect(await withOrg(DEFAULT_ORG, () => expireEntities())).toBe(0);
    expect(expired(DEFAULT_ORG)).toHaveLength(0);
  });

  it('emits once per expiry value and re-arms when the date changes', async () => {
    await put(DEFAULT_ORG, 'e1', { expiresAt: past });
    expect(await withOrg(DEFAULT_ORG, () => expireEntities())).toBe(1);
    expect(await withOrg(DEFAULT_ORG, () => expireEntities())).toBe(0);
    const ev = expired(DEFAULT_ORG, 'e1');
    expect(ev).toHaveLength(1);
    expect(ev[0].e).toMatchObject({ blueprint: 'env', data: { property: 'expiresAt', expiresAt: past } });
    // extended into the future, then expired again: announced again
    await put(DEFAULT_ORG, 'e1', { expiresAt: future });
    await withOrg(DEFAULT_ORG, () => expireEntities());
    expect(expired(DEFAULT_ORG, 'e1')).toHaveLength(1);
    await put(DEFAULT_ORG, 'e1', { expiresAt: '2021-01-01T00:00:00.000Z' });
    await withOrg(DEFAULT_ORG, () => expireEntities());
    expect(expired(DEFAULT_ORG, 'e1')).toHaveLength(2);
    // a date-only value expires at the end of its day
    expect(expiryTime('2999-01-01')).toBe(Date.parse('2999-01-02T00:00:00Z'));
    expect(expiryTime('nonsense')).toBeNull();
  });

  it('emits once when passes run concurrently', async () => {
    await put(DEFAULT_ORG, 'race', { expiresAt: past });
    const counts = await Promise.all([1, 2, 3, 4].map(() => withOrg(DEFAULT_ORG, () => expireEntities())));
    expect(counts.reduce((a, b) => a + b, 0)).toBe(1);
    expect(expired(DEFAULT_ORG, 'race')).toHaveLength(1);
  });

  it('is scoped to organizations', async () => {
    await put(DEFAULT_ORG, 'same', { expiresAt: past });
    await put(ACME, 'same', { expiresAt: past });
    await expireAllOrganizations();
    expect(expired(DEFAULT_ORG, 'same')).toHaveLength(1);
    expect(expired(ACME, 'same')).toHaveLength(1);
    expect((await all('SELECT org_id FROM entity_expiry WHERE identifier = ?', 'same')).length).toBe(2);
    await expireAllOrganizations();
    expect(expired(ACME, 'same')).toHaveLength(1);
  });

  it('forgets the record when the entity is deleted', async () => {
    await withOrg(DEFAULT_ORG, () => deleteEntity('env', 'race'));
    expect(await all('SELECT 1 FROM entity_expiry WHERE identifier = ?', 'race')).toHaveLength(0);
  });
});
