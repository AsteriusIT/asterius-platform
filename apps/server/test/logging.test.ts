import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { client, fakeServer, register, testApp, type Api } from './helpers.js';
import { maskText } from '../src/lib/mask.js';
import { runSync } from '../src/integrations/sync.js';
import { traceFields } from '../src/tracing.js';

describe('maskText', () => {
  it('masks known secrets and common credential shapes', () => {
    expect(maskText('boom hunter2-value', ['hunter2-value'])).toBe('boom ****');
    expect(maskText('Authorization: Bearer abcdef123456789')).not.toContain('abcdef123456789');
    expect(maskText('{"access_token":"abc123xyz"}')).not.toContain('abc123xyz');
    expect(maskText('https://user:pw0rdpw0rd@example.com/x')).not.toContain('pw0rdpw0rd');
    expect(maskText('ghp_abcdefghijklmnopqrstuvwxyz0123')).toBe('****');
    expect(maskText('plain message about entity a1')).toBe('plain message about entity a1');
  });
  it('trace fields are empty outside a span', () => expect(traceFields()).toEqual({}));
});

describe('stored sync logs', () => {
  let app: FastifyInstance;
  let admin: Api;
  let api: Awaited<ReturnType<typeof fakeServer>>;
  beforeAll(async () => {
    app = await testApp();
    admin = client(app, (await register(app, 'admin@example.com')).token);
    // The upstream echoes the request URL (with the secret in the query) inside its error body.
    api = await fakeServer((r) => ({ status: 500, body: { error: `cannot serve ${r.url}` } }));
  });
  afterAll(async () => {
    await api.close();
    await app.close();
  });

  it('never stores secret values in sync_runs.logs', async () => {
    await admin.put('/api/v1/secrets/LEAKY', { value: 'zq-very-secret-42' });
    await admin.put('/api/v1/blueprints/thing', { title: 'Thing', schema: { properties: {} } });
    const saved = await admin.put('/api/v1/integrations/leaky', {
      title: 'Leaky',
      type: 'http',
      intervalMinutes: 0,
      config: { url: `${api.url}/items?k=\${secret:LEAKY}`, itemsPath: 'data' },
      mappings: [{ kind: 'item', entity: { blueprint: 'thing', identifier: 'id', title: 'id' } }],
    });
    expect(saved.status, JSON.stringify(saved.data)).toBe(200);
    const res = (await runSync('leaky', 'manual'))!;
    expect(res.status).toBe('failure');
    expect(res.logs.join('\n')).toContain('FAILED');
    expect(res.logs.join('\n')).not.toContain('zq-very-secret-42');
    expect(api.received.some((r) => r.url.includes('zq-very-secret-42'))).toBe(true); // the secret was really used
  });
});
