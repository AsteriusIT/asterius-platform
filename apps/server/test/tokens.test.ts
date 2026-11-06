import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { ipAllowed, requiredScope } from '../src/auth/scopes.js';
import { client, register, testApp, type Api } from './helpers.js';

let app: FastifyInstance;
let admin: Api;
let adminToken: string;

beforeAll(async () => {
  app = await testApp();
  adminToken = (await register(app, 'admin@example.com')).token;
  admin = client(app, adminToken);
  await admin.put('/api/v1/blueprints/service', { title: 'Service', schema: { properties: {} } });
  await admin.put('/api/v1/blueprints/system', { title: 'System', schema: { properties: {} } });
  await admin.put('/api/v1/blueprints/service/entities/s1', { title: 'S1' });
});
afterAll(() => app.close());

const mint = async (body: Record<string, unknown>) => {
  const r = await admin.post('/api/v1/tokens', { name: 't', ...body });
  expect(r.status, JSON.stringify(r.data)).toBe(201);
  return client(app, r.data.token);
};

describe('API token scopes', () => {
  it('maps requests to scopes', () => {
    expect(requiredScope('GET', '/api/v1/blueprints/service/entities?limit=5')).toBe('catalog:read');
    expect(requiredScope('PUT', '/api/v1/blueprints/service/entities/s1')).toBe('catalog:write');
    expect(requiredScope('PUT', '/api/v1/blueprints/service')).toBe('admin');
    expect(requiredScope('POST', '/api/v1/actions/x/runs')).toBe('runs:trigger');
    expect(requiredScope('GET', '/api/v1/runs')).toBe('runs:read');
    expect(requiredScope('GET', '/api/v1/secrets')).toBe('admin');
    expect(requiredScope('POST', '/api/v1/tokens')).toBe('admin');
  });

  it('enforces scopes in the guards', async () => {
    const reader = await mint({ scopes: ['catalog:read'] });
    expect((await reader.get('/api/v1/blueprints/service/entities')).status).toBe(200);
    const denied = await reader.put('/api/v1/blueprints/service/entities/s2', { title: 'x' });
    expect(denied.status).toBe(403);
    expect(denied.data.error).toMatch(/catalog:write/);
    expect((await reader.get('/api/v1/users')).status).toBe(403); // admin user, but the token is not admin
    expect((await reader.get('/api/auth/me')).status).toBe(200);

    const writer = await mint({ scopes: ['catalog:write'] });
    expect((await writer.put('/api/v1/blueprints/service/entities/s2', { title: 'x' })).status).toBe(200);
    expect((await writer.get('/api/v1/blueprints/service/entities')).status).toBe(200); // write implies read
    expect((await writer.get('/api/v1/runs')).status).toBe(403);
  });

  it('keeps unscoped tokens working (full rights of the user)', async () => {
    const full = await mint({});
    expect((await full.get('/api/v1/users')).status).toBe(200);
  });

  it('restricts a token to blueprints', async () => {
    const t = await mint({ scopes: ['catalog:read'], blueprints: ['service'] });
    expect((await t.get('/api/v1/blueprints/service/entities')).status).toBe(200);
    expect((await t.get('/api/v1/blueprints/system/entities')).status).toBe(403);
    expect((await t.get('/api/v1/entities')).status).toBe(403);
    expect((await t.get('/api/v1/entities?blueprint=service')).status).toBe(200);
    const bad = await admin.post('/api/v1/tokens', { name: 'x', scopes: ['runs:trigger'], blueprints: ['service'] });
    expect(bad.status).toBe(400);
  });

  it('does not let restricted tokens mint or widen tokens', async () => {
    const reader = await mint({ scopes: ['catalog:read'] });
    expect((await reader.post('/api/v1/tokens', { name: 'child', scopes: ['admin'] })).status).toBe(403);
    const adminScoped = await mint({ scopes: ['admin'] });
    expect((await adminScoped.post('/api/v1/tokens', { name: 'child', scopes: ['catalog:read'] })).status).toBe(201);
  });

  it('applies an IP allow-list', async () => {
    const t = await mint({ scopes: ['catalog:read'], ipAllow: ['10.1.0.0/16'] });
    expect((await t.get('/api/auth/me')).status).toBe(401); // inject requests come from 127.0.0.1
    const ok = await mint({ scopes: ['catalog:read'], ipAllow: ['127.0.0.0/8'] });
    expect((await ok.get('/api/auth/me')).status).toBe(200);
    expect((await admin.post('/api/v1/tokens', { name: 'bad', ipAllow: ['not-an-ip'] })).status).toBe(400);
    expect(ipAllowed('::ffff:10.1.2.3', ['10.1.0.0/16'])).toBe(true);
    expect(ipAllowed('10.2.0.1', ['10.1.0.0/16'])).toBe(false);
    expect(ipAllowed('2001:db8::1', ['2001:db8::/32'])).toBe(true);
  });

  it('audits token creation and admin token use', async () => {
    const t = await mint({ scopes: ['admin'] });
    await t.get('/api/auth/me');
    await new Promise((r) => setTimeout(r, 200));
    const log = (await admin.get('/api/v1/audit?limit=100')).data as { action: string }[];
    const actions = log.map((e) => e.action);
    expect(actions).toContain('token.created');
    expect(actions).toContain('token.used');
  });
});

describe('sessions', () => {
  it('lists, revokes one and revokes the others', async () => {
    const login = () => client(app).post('/api/auth/login', { email: 'admin@example.com', password: 'correct-horse-battery' });
    const s2 = (await login()).data.token as string;
    await login();
    const me = client(app, s2);
    const list = (await me.get('/api/auth/sessions')).data as { id: string; current: boolean }[];
    expect(list.length).toBeGreaterThanOrEqual(3);
    expect(list.filter((s) => s.current)).toHaveLength(1);
    const other = list.find((s) => !s.current)!;
    expect((await me.del(`/api/auth/sessions/${other.id}`)).status).toBe(200);
    expect((await me.post('/api/auth/sessions/revoke-all', { others: true })).data.revoked).toBeGreaterThanOrEqual(1);
    expect((await me.get('/api/auth/sessions')).data).toHaveLength(1);
    expect((await client(app, adminToken).get('/api/auth/me')).status).toBe(401); // the register-time session was revoked
    expect((await me.post('/api/auth/sessions/revoke-all', {})).data.revoked).toBe(1);
    expect((await me.get('/api/auth/me')).status).toBe(401);
  });
});
