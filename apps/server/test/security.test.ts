import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { client, fakeServer, register, silentLog, testApp, waitFor, type Api } from './helpers.js';
import { startRunWorker } from '../src/actions/worker.js';
import { run as sql, one } from '../src/db.js';
import { migrateLiteralWebhookSecrets } from '../src/webhooks/webhooks.js';
import { config } from '../src/config.js';
import { updateUser, upsertEntraUser } from '../src/auth/users.js';
import { http } from '../src/lib/http.js';
import { setOutboundRules } from '../src/lib/netguard.js';
import { checkSecurityContext, checkTarget } from '../src/actions/invokers/kubernetes-job.js';
import { redact, redactDeep } from '../src/lib/expr.js';
import { signPayload } from '../src/webhooks/webhooks.js';
import { createHmac } from 'node:crypto';
import { exportConfig } from '../src/config-loader.js';

let app: FastifyInstance;
let admin: Api;
let alice: Api; // payments
let carol: Api; // payments
let bob: Api; // no team
let ext: Awaited<ReturnType<typeof fakeServer>>;
const stops: (() => unknown)[] = [];

beforeAll(async () => {
  app = await testApp();
  admin = client(app, (await register(app, 'admin@example.com')).token);
  const a = await register(app, 'alice@example.com');
  const c = await register(app, 'carol@example.com');
  alice = client(app, a.token);
  carol = client(app, c.token);
  bob = client(app, (await register(app, 'bob@example.com')).token);
  await admin.put('/api/v1/teams/payments', { title: 'Payments' });
  await admin.patch(`/api/v1/users/${a.user.id}`, { teams: ['payments'] });
  await admin.patch(`/api/v1/users/${c.user.id}`, { teams: ['payments'] });
  await admin.put('/api/v1/blueprints/service', { title: 'Service', schema: { properties: { tier: { type: 'integer' } } } });
  await admin.put('/api/v1/blueprints/service/entities/api', { team: 'payments', properties: { tier: 1 } });
  ext = await fakeServer();
  stops.push(startRunWorker(silentLog));
});
afterAll(async () => {
  for (const s of stops) await s();
  await ext.close();
  await app.close();
});

describe('webhook signing secrets', () => {
  it('rejects literal secrets and accepts references', async () => {
    const base = { title: 'Hook', url: 'https://example.com/hook', events: ['*'] };
    const bad = await admin.put('/api/v1/webhooks/w1', { ...base, secret: 'plaintext-value' });
    expect(bad.status).toBe(400);
    expect(bad.data.error).toMatch(/reference/);
    expect((await admin.put('/api/v1/webhooks/w1', { ...base, secret: '${secret:SIGNING}' })).status).toBe(200);
    expect((await admin.get('/api/v1/webhooks/w1')).data.secret).toBe('${secret:SIGNING}');
  });

  it('moves legacy literal secrets into the secret store', async () => {
    await admin.put('/api/v1/webhooks/legacy', { title: 'Legacy', url: 'https://example.com/l', events: ['*'] });
    await sql("UPDATE webhooks SET secret = 'old-literal' WHERE identifier = 'legacy'");
    expect(JSON.stringify((await admin.get('/api/v1/webhooks/legacy')).data)).not.toContain('old-literal'); // never exposed
    await migrateLiteralWebhookSecrets();
    expect((await admin.get('/api/v1/webhooks/legacy')).data.secret).toBe('${secret:webhook-legacy-signing}');
    expect(await one('SELECT name FROM secrets WHERE name = ?', 'webhook-legacy-signing')).toBeTruthy();
    expect(await exportConfig()).not.toContain('old-literal');
  });
});

describe('run visibility', () => {
  it('shows a run only to the requester, its team, approvers and admins', async () => {
    await admin.put('/api/v1/actions/ping', {
      title: 'Ping',
      blueprint: 'service',
      trigger: 'day-2',
      inputs: { properties: { note: { type: 'string' } } },
      invoker: { type: 'webhook', url: `${ext.url}/ping` },
    });
    const r = await alice.post('/api/v1/actions/ping/runs', { entity: 'api', inputs: { note: 'private' } });
    expect(r.status, JSON.stringify(r.data)).toBe(201);
    await waitFor(async () => (await alice.get(`/api/v1/runs/${r.data.id}`)).data.status === 'SUCCESS');

    expect((await carol.get(`/api/v1/runs/${r.data.id}`)).status).toBe(200); // owning team
    expect((await admin.get(`/api/v1/runs/${r.data.id}`)).status).toBe(200);
    expect((await bob.get(`/api/v1/runs/${r.data.id}`)).status).toBe(404);
    expect((await bob.get('/api/v1/runs')).data.items).toHaveLength(0);
    expect((await bob.get('/api/v1/runs?entity=api')).data.items).toHaveLength(0);
    const list = await carol.get('/api/v1/runs');
    expect(list.data.items.map((x: { id: string }) => x.id)).toContain(r.data.id);
  });
});

describe('entra roles', () => {
  it('demotes users removed from the admin group, keeps hand-set roles', async () => {
    config.ENTRA_ADMIN_GROUPS.push('g-admin');
    const u = { externalId: 't:1', email: 'e1@example.com', name: 'E1' };
    expect((await upsertEntraUser({ ...u, groups: ['g-admin'] })).role).toBe('admin');
    expect((await upsertEntraUser({ ...u, groups: [] })).role).toBe('member');
    const row = await upsertEntraUser({ ...u, groups: [] });
    await updateUser(row.id, { role: 'admin' }); // set by hand by an admin: survives the next sign-in
    expect((await upsertEntraUser({ ...u, groups: [] })).role).toBe('admin');
  });
});

describe('outbound SSRF guard', () => {
  it('blocks loopback, private and metadata addresses unless allowed', async () => {
    setOutboundRules([], []);
    try {
      await expect(http(`${ext.url}/x`)).rejects.toThrow(/refused/);
      await expect(http('http://169.254.169.254/latest/meta-data')).rejects.toThrow(/refused/);
      await expect(http('http://[::ffff:10.0.0.1]/')).rejects.toThrow(/refused/);
      await expect(http('http://localhost:8081/')).rejects.toThrow(/refused/);
      await expect(http('file:///etc/passwd')).rejects.toThrow(/scheme/);
      setOutboundRules(['127.0.0.0/8'], []);
      expect((await http(`${ext.url}/ok`)).status).toBe(200);
      setOutboundRules(['127.0.0.0/8'], ['127.0.0.1']);
      await expect(http(`${ext.url}/ok`)).rejects.toThrow(/denied/);
    } finally {
      setOutboundRules(['127.0.0.0/8', '::1'], []);
    }
  });

  it('checks redirect targets and drops credentials across origins', async () => {
    const echo = await fakeServer((q) => ({ body: { auth: q.headers.authorization ?? null } }));
    const toEcho = await fakeServer(() => ({ status: 302, headers: { location: `${echo.url}/e` } }));
    const toMeta = await fakeServer(() => ({ status: 302, headers: { location: 'http://169.254.169.254/latest' } }));
    try {
      const res = await http<{ auth: string | null }>(`${toEcho.url}/s`, { headers: { authorization: 'Bearer secret' } });
      expect(res.data.auth).toBeNull(); // another origin: the credential is not forwarded
      await expect(http(`${toMeta.url}/s`)).rejects.toThrow(/refused/);
    } finally {
      await echo.close();
      await toEcho.close();
      await toMeta.close();
    }
  });

  it('refuses pagination links to another origin', async () => {
    const a = await fakeServer(() => ({ body: { data: [{ code: 'x' }], next: 'http://127.0.0.2:9/evil' } }));
    await admin.put('/api/v1/blueprints/app', { title: 'App', schema: { properties: {} } });
    await admin.put('/api/v1/integrations/evil', {
      title: 'Evil',
      type: 'http',
      intervalMinutes: 0,
      config: { url: `${a.url}/apps`, itemsPath: 'data', pagination: { type: 'next', nextUrl: 'next' }, headers: { authorization: 'Bearer t' } },
      mappings: [{ kind: 'item', entity: { blueprint: 'app', identifier: 'code', title: 'code' } }],
    });
    const { runSync } = await import('../src/integrations/sync.js');
    const out = await runSync('evil', 'manual');
    expect(JSON.stringify(out)).toMatch(/another origin/);
    await a.close();
  });
});

describe('metrics endpoint', () => {
  it('refuses requests that came through a proxy when no token is configured', async () => {
    expect((await app.inject({ method: 'GET', url: '/metrics' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/metrics', headers: { 'x-forwarded-for': '203.0.113.9' } })).statusCode).toBe(404);
  });

  it('compares the bearer token when one is configured', async () => {
    config.METRICS_TOKEN = 'tok-1234';
    try {
      expect((await app.inject({ method: 'GET', url: '/metrics' })).statusCode).toBe(401);
      expect((await app.inject({ method: 'GET', url: '/metrics', headers: { authorization: 'Bearer tok-1235' } })).statusCode).toBe(401);
      expect(
        (await app.inject({ method: 'GET', url: '/metrics', headers: { authorization: 'Bearer tok-1234', 'x-forwarded-for': '1.2.3.4' } })).statusCode,
      ).toBe(200);
    } finally {
      config.METRICS_TOKEN = undefined;
    }
  });
});

describe('kubernetes job invoker policy', () => {
  it('whitelists security context fields and keeps non-root', () => {
    expect(() => checkSecurityContext({ runAsUser: 10001, seccompProfile: { type: 'RuntimeDefault' } })).not.toThrow();
    expect(() => checkSecurityContext({ runAsNonRoot: false })).toThrow(/non-root/);
    expect(() => checkSecurityContext({ runAsUser: 0 })).toThrow(/root/);
    expect(() => checkSecurityContext({ sysctls: [{ name: 'a', value: 'b' }] })).toThrow(/not allowed/);
    expect(() => checkSecurityContext({ seccompProfile: { type: 'Unconfined' } })).toThrow(/seccomp/);
  });

  it('applies the namespace, service account and context allow-lists', () => {
    expect(() => checkTarget('any', 'any', undefined)).not.toThrow(); // empty lists: unrestricted
    expect(() => checkTarget('any', undefined, 'other-cluster')).toThrow(/context/); // contexts are default-deny
    config.KUBE_JOB_NAMESPACES.push('jobs');
    config.KUBE_JOB_SERVICE_ACCOUNTS.push('runner');
    try {
      expect(() => checkTarget('jobs', 'runner', undefined)).not.toThrow();
      expect(() => checkTarget('kube-system', 'runner', undefined)).toThrow(/namespace/);
      expect(() => checkTarget('jobs', 'cluster-admin', undefined)).toThrow(/service account/);
    } finally {
      config.KUBE_JOB_NAMESPACES.length = 0;
      config.KUBE_JOB_SERVICE_ACCOUNTS.length = 0;
    }
  });
});

describe('login lockout', () => {
  const login = (password: string, ip: string) =>
    app.inject({ method: 'POST', url: '/api/auth/login', headers: { 'x-forwarded-for': ip }, payload: { email: 'carol@example.com', password } });

  it('locks an account per client address, not for everyone', async () => {
    for (let i = 0; i < 5; i++) expect((await login('wrong-password', '198.51.100.7')).statusCode).toBe(401);
    expect((await login('correct-horse-battery', '198.51.100.7')).statusCode).toBe(429); // the attacker stays locked out
    expect((await login('correct-horse-battery', '198.51.100.8')).statusCode).toBe(200); // the owner is not
  });
});

describe('secret masking', () => {
  const secret = 's3cr3t/Value+42=ok';
  it('masks encoded forms of a secret', () => {
    const forms = [
      secret,
      encodeURIComponent(secret),
      Buffer.from(secret).toString('base64'),
      Buffer.from(secret).toString('base64url'),
      Buffer.from(`user:${secret}`).toString('base64'),
      Buffer.from(`xuser:${secret}`).toString('base64'),
      Buffer.from(`xxuser:${secret}`).toString('base64'),
      Buffer.from(secret).toString('hex'),
      JSON.stringify({ k: secret }),
    ];
    for (const f of forms) {
      const out = redact(`before ${f} after`, [secret]);
      expect(out, f).toContain('****');
    }
    // `Authorization: Basic …` keeps no recoverable part of the secret
    const basic = Buffer.from(`user:${secret}`).toString('base64');
    expect(redact(`Authorization: Basic ${basic}`, [secret])).not.toContain(basic.slice(6, -4));
  });

  it('skips short secrets and masks nested results', () => {
    expect(redact('abcd efgh', ['abcd'])).toBe('abcd efgh');
    expect(redactDeep({ a: ['x ' + secret], b: 1 }, [secret])).toEqual({ a: ['x ****'], b: 1 });
  });

  it('masks what a pipeline reports through the callback API', async () => {
    const cb = await fakeServer((r) => {
      callback = JSON.parse(r.body).callback;
      return { status: 202 };
    });
    let callback: { url: string; token: string } | undefined;
    await admin.put('/api/v1/secrets/PIPE_KEY', { value: 'pipeline-key-987654' });
    await admin.put('/api/v1/actions/leaky', {
      title: 'Leaky',
      invoker: {
        type: 'webhook',
        url: cb.url,
        mode: 'async',
        headers: { authorization: 'Bearer ${secret:PIPE_KEY}' },
        body: { callback: '{{ run.callback }}' },
      },
    });
    const run = await alice.post('/api/v1/actions/leaky/runs', {});
    await waitFor(async () => callback);
    const path = `/api/v1/runs/${run.data.id}/steps/run`;
    const svc = client(app, callback!.token);
    await svc.post(`${path}/logs`, { message: `env: KEY=pipeline-key-987654 b64=${Buffer.from('pipeline-key-987654').toString('base64')}` });
    await svc.patch(path, { status: 'SUCCESS', result: { echo: 'pipeline-key-987654' } });
    const r = (await alice.get(`/api/v1/runs/${run.data.id}`)).data;
    expect(JSON.stringify(r)).not.toContain('pipeline-key-987654');
    expect(JSON.stringify(r)).not.toContain(Buffer.from('pipeline-key-987654').toString('base64'));
    expect(JSON.stringify(r)).toContain('****');
    const warn = await admin.put('/api/v1/secrets/TINY', { value: 'abc' });
    expect(warn.data.warning).toMatch(/shorter than 8/);
    await cb.close();
  });
});

describe('outbound webhook signatures', () => {
  it('signs timestamp + body, with both secrets during a rotation', () => {
    const sig = signPayload('{"a":1}', ['old-secret', 'new-secret'], 1700000000)!;
    const mac = (k: string) => createHmac('sha256', k).update('1700000000.{"a":1}').digest('hex');
    expect(sig).toBe(`t=1700000000,v1=${mac('old-secret')},v1=${mac('new-secret')}`);
    expect(signPayload('x', [undefined, undefined])).toBeUndefined();
  });

  it('accepts a secondary secret reference and rejects a literal one', async () => {
    const base = { title: 'Rot', url: 'https://example.com/r', events: ['*'], secret: '${secret:SIGNING}' };
    expect((await admin.put('/api/v1/webhooks/rot', { ...base, secondarySecret: 'literal' })).status).toBe(400);
    const ok = await admin.put('/api/v1/webhooks/rot', { ...base, secondarySecret: '${secret:SIGNING_NEXT}' });
    expect(ok.data.hasSecondarySecret).toBe(true);
    expect((await admin.get('/api/v1/webhooks/rot')).data.secondarySecret).toBe('${secret:SIGNING_NEXT}');
  });
});
