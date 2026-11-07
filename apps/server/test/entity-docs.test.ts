import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { client, fakeServer, register, testApp } from './helpers.js';
import { setOutboundRules } from '../src/lib/netguard.js';
import { toRawDocsUrl } from '../src/catalog/docs.js';

let app: FastifyInstance;
let admin: ReturnType<typeof client>;
let other: ReturnType<typeof client>;
let docs: Awaited<ReturnType<typeof fakeServer>>;

beforeAll(async () => {
  docs = await fakeServer((r) => {
    if (r.url === '/big.md') return { headers: { 'content-type': 'text/markdown' }, body: 'x'.repeat(1_100_000) };
    return { headers: { 'content-type': 'text/markdown' }, body: '# Hello' };
  });
  app = await testApp();
  const token = (await register(app, 'admin@example.com', 'Admin')).token;
  admin = client(app, token);
  await admin.put('/api/v1/blueprints/service', {
    title: 'Service',
    schema: { properties: { docs: { type: 'string', format: 'docs' }, note: { type: 'string' } } },
  });
  await admin.put('/api/v1/blueprints/plain', { title: 'Plain', schema: { properties: { note: { type: 'string' } } } });
  await admin.post('/api/v1/blueprints/plain/entities', { identifier: 'p1', title: 'P1', properties: {} });
  const mk = (id: string, url?: string) =>
    admin.post('/api/v1/blueprints/service/entities', { identifier: id, title: id, properties: url ? { docs: url } : {} });
  await mk('ok', `${docs.url}/readme.md`);
  await mk('big', `${docs.url}/big.md`);
  await mk('private', 'http://169.254.169.254/latest/meta-data');
  await mk('none');
  const carol = (await register(app, 'carol@example.com', 'Carol')).token;
  await client(app, carol).post('/api/orgs', { slug: 'other', name: 'Other' });
  other = client(app, carol, 'other');
});
afterAll(async () => {
  setOutboundRules([], []);
  await app.close();
  await docs.close();
});

describe('entity docs', () => {
  it('rejects a non-http(s) value for a docs property', async () => {
    const r = await admin.post('/api/v1/blueprints/service/entities', { identifier: 'bad', title: 'bad', properties: { docs: 'file:///etc/passwd' } });
    expect(r.status).toBe(400);
  });

  it('fetches the markdown through the SSRF guard', async () => {
    setOutboundRules([], []);
    expect((await admin.get('/api/v1/blueprints/service/entities/ok/docs')).status).toBe(400); // loopback refused
    setOutboundRules(['127.0.0.0/8'], []);
    const r = await admin.get('/api/v1/blueprints/service/entities/ok/docs');
    expect(r.status).toBe(200);
    expect(r.data).toMatchObject({ property: 'docs', markdown: expect.stringContaining('# Hello') });
  });

  it('refuses private and metadata addresses', async () => {
    setOutboundRules(['127.0.0.0/8'], []);
    const r = await admin.get('/api/v1/blueprints/service/entities/private/docs');
    expect(r.status).toBe(400);
    expect(JSON.stringify(r.data)).toMatch(/refused|private/);
  });

  it('caps the size', async () => {
    setOutboundRules(['127.0.0.0/8'], []);
    const r = await admin.get('/api/v1/blueprints/service/entities/big/docs');
    expect(r.status).toBe(400);
    expect(JSON.stringify(r.data)).toMatch(/larger/);
  });

  it('is 404 without a docs property or value, and across organizations', async () => {
    setOutboundRules(['127.0.0.0/8'], []);
    expect((await admin.get('/api/v1/blueprints/service/entities/none/docs')).status).toBe(404);
    expect((await admin.get('/api/v1/blueprints/plain/entities/p1/docs')).status).toBe(404);
    expect((await other.get('/api/v1/blueprints/service/entities/ok/docs')).status).toBe(404);
    expect((await client(app).get('/api/v1/blueprints/service/entities/ok/docs')).status).toBe(401);
  });

  it('turns blob URLs into raw ones', () => {
    expect(toRawDocsUrl('https://github.com/acme/api/blob/main/docs/index.md')).toBe('https://raw.githubusercontent.com/acme/api/main/docs/index.md');
    expect(toRawDocsUrl('https://gitlab.com/acme/api/-/blob/main/README.md')).toBe('https://gitlab.com/acme/api/-/raw/main/README.md');
    expect(toRawDocsUrl('https://example.com/a.md')).toBe('https://example.com/a.md');
  });
});
