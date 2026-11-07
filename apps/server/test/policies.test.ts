import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { client, register, silentLog, testApp, type Api } from './helpers.js';
import { config } from '../src/config.js';
import { checkAllConfig } from '../src/config-loader.js';

let app: FastifyInstance;
let admin: Api;
let bob: Api;
let acme: Api;

const steps = [{ id: 't', type: 'transform', output: { v: '1' } }];
const pol = (o: object) => ({ title: 'Policy', target: 'entity', expression: 'true', ...o });
const auditOf = async (action: string) => (await admin.get(`/api/v1/audit?action=${action}`)).data as { target: string }[];

beforeAll(async () => {
  app = await testApp();
  admin = client(app, (await register(app, 'admin@example.com')).token);
  bob = client(app, (await register(app, 'bob@example.com')).token);
  const bp = { title: 'Service', schema: { properties: { tier: { type: 'string' } } } };
  expect((await admin.put('/api/v1/blueprints/service', bp)).status).toBe(200);
  await admin.put('/api/v1/blueprints/other', { ...bp, title: 'Other' });
  const carol = (await register(app, 'carol@example.com')).token;
  expect((await client(app, carol).post('/api/orgs', { slug: 'acme', name: 'Acme' })).status).toBe(201);
  acme = client(app, carol, 'acme');
});
afterAll(() => app.close());

describe('policy definitions', () => {
  it('is admin only and validates the expression', async () => {
    expect((await bob.put('/api/v1/policies/p', pol({}))).status).toBe(403);
    expect((await bob.get('/api/v1/policies')).status).toBe(403);
    expect((await admin.put('/api/v1/policies/p', pol({ expression: 'a +' }))).status).toBe(400);
    expect((await admin.put('/api/v1/policies/p', pol({ target: 'nope' }))).status).toBe(400);
    const ok = await admin.put('/api/v1/policies/p', pol({}));
    expect(ok.status, JSON.stringify(ok.data)).toBe(200);
    expect(ok.data).toMatchObject({ identifier: 'p', enabled: true, managed: false });
    expect((await admin.del('/api/v1/policies/p')).status).toBe(200);
    expect((await admin.get('/api/v1/policies/p')).status).toBe(404);
  });
});

describe('entity writes', () => {
  it('denies a matching blueprint/operation with 403, the policy id, the message and an audit entry', async () => {
    await admin.put(
      '/api/v1/policies/owner',
      pol({
        match: { blueprints: ['service'], operations: ['create', 'update'] },
        expression: 'entity.team != null',
        message: '{{ entity.identifier }} needs an owner',
      }),
    );
    const denied = await admin.put('/api/v1/blueprints/service/entities/api', { properties: { tier: '1' } });
    expect(denied.status).toBe(403);
    expect(denied.data).toMatchObject({ policy: 'owner', message: 'api needs an owner' });
    expect(denied.data.error).toMatch(/owner/);
    expect((await admin.post('/api/v1/blueprints/service/entities', { identifier: 'api2' })).status).toBe(403);
    expect((await admin.get('/api/v1/blueprints/service/entities/api')).status).toBe(404);
    expect((await auditOf('policy.denied')).some((a) => a.target === 'owner')).toBe(true);

    await admin.put('/api/v1/teams/core', { title: 'Core' });
    expect((await admin.put('/api/v1/blueprints/service/entities/api', { team: 'core' })).status).toBe(200);
    // Other blueprints are not matched.
    expect((await admin.put('/api/v1/blueprints/other/entities/x', {})).status).toBe(200);
    // PATCH merges: the team of the stored entity counts.
    expect((await admin.patch('/api/v1/blueprints/service/entities/api', { properties: { tier: '2' } })).status).toBe(200);
  });

  it('gates deletes by operation and sees the previous state', async () => {
    await admin.put(
      '/api/v1/policies/no-delete',
      pol({ match: { blueprints: ['service'], operations: ['delete'] }, expression: 'previous.properties.tier != "2"', message: 'tier 2 is protected' }),
    );
    const res = await admin.del('/api/v1/blueprints/service/entities/api');
    expect(res.status).toBe(403);
    expect(res.data.policy).toBe('no-delete');
    await admin.put('/api/v1/blueprints/service/entities/api', { team: 'core', properties: { tier: '1' } });
    expect((await admin.del('/api/v1/blueprints/service/entities/api')).status).toBe(200);
  });

  it('ignores disabled policies', async () => {
    await admin.put('/api/v1/policies/off', pol({ enabled: false, match: { blueprints: ['other'] }, expression: 'false' }));
    await new Promise((r) => setTimeout(r, 2100)); // the policy cache lives 2 s (writes through the API invalidate it)
    expect((await admin.put('/api/v1/blueprints/other/entities/y', {})).status).toBe(200);
    await admin.put('/api/v1/policies/off', pol({ enabled: true, match: { blueprints: ['other'] }, expression: 'false' }));
    expect((await admin.put('/api/v1/blueprints/other/entities/y', {})).status).toBe(403);
    await admin.del('/api/v1/policies/off');
  });

  it('fails closed when the expression errors or is not exactly true', async () => {
    await admin.put('/api/v1/policies/boom', pol({ match: { blueprints: ['other'] }, expression: '$error("kaboom")', message: 'no' }));
    const res = await admin.put('/api/v1/blueprints/other/entities/z', {});
    expect(res.status).toBe(403);
    expect(res.data.message).toMatch(/evaluation failed/);
    await admin.put('/api/v1/policies/boom', pol({ match: { blueprints: ['other'] }, expression: '"yes"' })); // truthy, not true
    expect((await admin.put('/api/v1/blueprints/other/entities/z', {})).status).toBe(403);
    await admin.del('/api/v1/policies/boom');
  });

  it('is isolated per organization', async () => {
    await admin.put('/api/v1/policies/everything', pol({ expression: 'false' }));
    expect((await admin.put('/api/v1/blueprints/other/entities/q', {})).status).toBe(403);
    expect((await acme.get('/api/v1/policies')).data).toEqual([]);
    expect((await acme.put('/api/v1/blueprints/other', { title: 'Other', schema: { properties: {} } })).status).toBe(200);
    expect((await acme.put('/api/v1/blueprints/other/entities/q', {})).status).toBe(200);
    await admin.del('/api/v1/policies/everything');
  });
});

describe('runs', () => {
  it('denies a run, allows when the policy is true', async () => {
    const a = await admin.put('/api/v1/actions/deploy', {
      title: 'Deploy',
      steps,
      trigger: { type: 'api', inputs: { type: 'object', properties: { env: { type: 'string' } } }, approval: { required: false } },
    });
    expect(a.status, JSON.stringify(a.data)).toBe(200);
    await admin.put(
      '/api/v1/policies/no-prod',
      pol({ target: 'run', match: { actions: ['deploy'] }, expression: 'inputs.env != "prod"', message: 'no prod deploys ({{ principal.email }})' }),
    );
    const denied = await admin.post('/api/v1/actions/deploy/runs', { inputs: { env: 'prod' } });
    expect(denied.status, JSON.stringify(denied.data)).toBe(403);
    expect(denied.data).toMatchObject({ policy: 'no-prod', message: 'no prod deploys (admin@example.com)' });
    expect(((await admin.get('/api/v1/runs?action=deploy')).data.items as unknown[]).length).toBe(0);
    expect((await auditOf('policy.denied')).some((x) => x.target === 'no-prod')).toBe(true);
    const ok = await admin.post('/api/v1/actions/deploy/runs', { inputs: { env: 'dev' } });
    expect(ok.status, JSON.stringify(ok.data)).toBeLessThan(300);
  });
});

describe('configuration as code', () => {
  it('manages policies declared in files (read-only through the API) and removes them when undeclared', async () => {
    const file = path.join(config.CONFIG_DIR, 'policies-test.yaml');
    fs.mkdirSync(config.CONFIG_DIR, { recursive: true });
    fs.writeFileSync(
      file,
      'policies:\n  - identifier: from-file\n    title: From file\n    target: entity\n    match: { blueprints: [other] }\n    expression: "true"\n',
    );
    try {
      await checkAllConfig(silentLog);
      expect((await admin.get('/api/v1/policies/from-file')).data).toMatchObject({ managed: true, target: 'entity' });
      expect((await admin.put('/api/v1/policies/from-file', pol({}))).status).toBe(409);
      expect((await admin.del('/api/v1/policies/from-file')).status).toBe(409);
      expect((await acme.get('/api/v1/policies/from-file')).status).toBe(404);
    } finally {
      fs.rmSync(file, { force: true });
    }
    await checkAllConfig(silentLog);
    expect((await admin.get('/api/v1/policies/from-file')).status).toBe(404);
  });
});

describe('catalog invoker', () => {
  it('is gated like the API', async () => {
    const { catalogInvoker } = await import('../src/actions/invokers/catalog.js');
    const { inDefaultOrg } = await import('./helpers.js');
    await admin.put('/api/v1/policies/inv', pol({ match: { blueprints: ['other'], operations: ['create'] }, expression: 'false', message: 'blocked' }));
    const ctx = { trigger: { user: { id: 'u1', email: 'admin@example.com', name: 'Admin' }, at: new Date().toISOString() } };
    const start = (config: Record<string, unknown>) =>
      inDefaultOrg(() => catalogInvoker.start({ ctx, config, log: async () => undefined } as unknown as Parameters<typeof catalogInvoker.start>[0]));
    await expect(start({ blueprint: 'other', identifier: 'inv1', operation: 'upsert' })).rejects.toThrow(/Denied by policy "inv"/);
    await admin.del('/api/v1/policies/inv');
    await new Promise((r) => setTimeout(r, 2100));
    expect((await start({ blueprint: 'other', identifier: 'inv1', operation: 'upsert' })).status).toBe('SUCCESS');
  });
});
