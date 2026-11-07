import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { client, register, testApp, type Api } from './helpers.js';
import { inDefaultOrg } from './helpers.js';
import { repositoryOfPush } from '../src/integrations/sources/descriptors.js';
import { runSync } from '../src/integrations/sync.js';
import { one } from '../src/db.js';

describe('push event parsing', () => {
  it('extracts the repository of default-branch pushes only', () => {
    const gh = { ref: 'refs/heads/main', repository: { full_name: 'acme/api', default_branch: 'main' } };
    expect(repositoryOfPush(gh, { 'x-github-event': 'push' })).toBe('acme/api');
    expect(repositoryOfPush({ ...gh, ref: 'refs/heads/feature' }, { 'x-github-event': 'push' })).toBeUndefined();
    expect(repositoryOfPush(gh, { 'x-github-event': 'ping' })).toBeUndefined();
    expect(
      repositoryOfPush({ ref: 'refs/heads/main', project: { path_with_namespace: 'g/p', default_branch: 'main' } }, { 'x-gitlab-event': 'Push Hook' }),
    ).toBe('g/p');
    expect(
      repositoryOfPush({
        eventType: 'git.push',
        resource: { repository: { name: 'r', defaultBranch: 'refs/heads/main', project: { name: 'P' } }, refUpdates: [{ name: 'refs/heads/main' }] },
      }),
    ).toBe('P/r');
    expect(repositoryOfPush({ hello: 1 })).toBeUndefined();
  });
});

let app: FastifyInstance;
let admin: Api;
const fetched: string[] = [];
let upstream: ReturnType<typeof createServer>;
let apiUrl = '';

beforeAll(async () => {
  app = await testApp();
  admin = client(app, (await register(app, 'admin@example.com')).token);
  await admin.put('/api/v1/blueprints/component', { title: 'Component', schema: { properties: { repo: { type: 'string' } } } });
  upstream = createServer((req, res) => {
    const url = new URL(req.url ?? '', 'http://x');
    if (url.pathname === '/orgs/acme/repos') {
      const repos = ['one', 'two'].map((n) => ({ name: n, full_name: `acme/${n}`, html_url: `https://host/acme/${n}`, default_branch: 'main' }));
      return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(repos));
    }
    const repo = /repos\/acme\/(\w+)\/contents/.exec(url.pathname)?.[1];
    if (repo) {
      fetched.push(repo);
      return void res.writeHead(200, { 'content-type': 'text/plain' }).end(`name: comp-${repo}\n`);
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
  apiUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise((r) => upstream.close(r));
  await app.close();
});

describe('descriptor refresh on push', () => {
  it('verifies the webhook, queues a scoped sync and rescans only that repository', () =>
    inDefaultOrg(async () => {
      const saved = await admin.put('/api/v1/integrations/descriptors', {
        title: 'Descriptors',
        type: 'git-descriptors',
        intervalMinutes: 0,
        deleteMissing: true,
        config: { provider: 'github', org: 'acme', token: 't', apiUrl, pushSecret: 'hook-secret', pushPreset: 'github' },
        mappings: [{ kind: 'descriptor', entity: { blueprint: 'component', identifier: 'descriptor.name', properties: { repo: 'repository.url' } } }],
      });
      expect(saved.status, JSON.stringify(saved.data)).toBe(200);

      const full = (await runSync('descriptors', 'manual'))!;
      expect(full.status, full.logs.join('\n')).toBe('success');
      expect(fetched.sort()).toEqual(['one', 'two']);
      fetched.length = 0;

      const body = JSON.stringify({ ref: 'refs/heads/main', repository: { full_name: 'acme/two', default_branch: 'main' } });
      const sign = (b: string) => `sha256=${createHmac('sha256', 'hook-secret').update(b).digest('hex')}`;
      const post = (payload: string, sig: string) =>
        app.inject({
          method: 'POST',
          url: '/api/v1/ingest/descriptors',
          headers: { 'content-type': 'application/json', 'x-github-event': 'push', 'x-hub-signature-256': sig },
          payload,
        });
      expect((await post(body, 'sha256=bad')).statusCode).toBe(401);
      const ok = await post(body, sign(body));
      expect(ok.statusCode).toBe(202);
      expect(ok.json()).toEqual({ queued: true, scope: 'acme/two' });
      const row = await one<{ requested_scope: string }>('SELECT requested_scope FROM integrations WHERE identifier = ?', 'descriptors');
      expect(row?.requested_scope).toBe('acme/two');

      const other = JSON.stringify({ ref: 'refs/heads/dev', repository: { full_name: 'acme/two', default_branch: 'main' } });
      expect((await post(other, sign(other))).json()).toEqual({ queued: false, ignored: true });

      const scoped = (await runSync('descriptors', 'manual', { scope: 'acme/two' }))!;
      expect(scoped.status).toBe('success');
      expect(fetched).toEqual(['two']);
      expect(scoped.logs.join('\n')).toMatch(/targeted sync of "acme\/two"/);
      expect(scoped.stats.deleted).toBe(0);
    }));

  it('does not accept webhooks for pull integrations without a pushSecret', async () => {
    await admin.put('/api/v1/integrations/nosecret', {
      title: 'No secret',
      type: 'git-descriptors',
      intervalMinutes: 0,
      config: { provider: 'github', org: 'acme', token: 't', apiUrl },
      mappings: [],
    });
    const res = await app.inject({ method: 'POST', url: '/api/v1/ingest/nosecret', headers: { 'content-type': 'application/json' }, payload: '{}' });
    expect(res.statusCode).toBe(404);
  });
});
