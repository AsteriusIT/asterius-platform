import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { config } from '../src/config.js';
import { client, fakeServer, register, silentLog, testApp, waitFor, type Api } from './helpers.js';
import { startRunWorker } from '../src/actions/worker.js';
import { withOrg } from '../src/orgs/context.js';
import { appUrl, orgPath } from '../src/orgs/orgs.js';

/** Links the server builds to web UI pages carry the organization (`/o/<slug>`), so they open in the right one. */

let app: FastifyInstance;
let admin: Api;
let ext: Awaited<ReturnType<typeof fakeServer>>;
let stop: () => unknown;
let org: { id: string; slug: string };

beforeAll(async () => {
  app = await testApp();
  admin = client(app, (await register(app, 'admin@example.com')).token);
  org = (await admin.get('/api/auth/me')).data.organization;
  ext = await fakeServer(() => ({ status: 200, body: { ok: true } }));
  stop = startRunWorker(silentLog);
});
afterAll(async () => {
  await stop();
  await ext.close();
  await app.close();
});

describe('organization links', () => {
  it('prefixes app paths with the organization', async () => {
    expect(orgPath('acme', '/runs/1')).toBe('/o/acme/runs/1');
    expect(orgPath('acme', 'catalog')).toBe('/o/acme/catalog');
    expect(orgPath('acme')).toBe('/o/acme/');
    expect(await withOrg(org.id, () => appUrl('/runs/r1'))).toBe(`http://platform.test/o/${org.slug}/runs/r1`);
    expect(await appUrl('/runs/r1', org.id)).toBe(`http://platform.test/o/${org.slug}/runs/r1`);
    // Outside an organization: the unprefixed path (the UI redirects it to the reader's default organization).
    expect(await appUrl('/runs/r1', null)).toBe('http://platform.test/runs/r1');
  });

  it('gives workflows a run.url in the run organization', async () => {
    const saved = await admin.put('/api/v1/actions/link-check', {
      title: 'Link check',
      invoker: { type: 'webhook', url: `${ext.url}/hook`, body: { url: '{{ run.url }}' } },
    });
    expect(saved.status, JSON.stringify(saved.data)).toBe(200);
    const run = await admin.post('/api/v1/actions/link-check/runs', {});
    expect(run.status, JSON.stringify(run.data)).toBe(201);
    const req = await waitFor(async () => ext.received.find((r) => r.url === '/hook'));
    expect(JSON.parse(req.body).url).toBe(`http://platform.test/o/${org.slug}/runs/${run.data.id}`);
  });

  it('serves the web UI for organization paths', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asterius-web-'));
    fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><div id="root"></div>');
    const previous = config.WEB_DIST_DIR;
    config.WEB_DIST_DIR = dir;
    const web = await testApp();
    try {
      for (const url of [`/o/${org.slug}/catalog/service`, `/o/${org.slug}/`, '/runs/legacy-link', '/login']) {
        const res = await web.inject({ method: 'GET', url });
        expect(res.statusCode, url).toBe(200);
        expect(res.body, url).toContain('id="root"');
      }
      expect((await web.inject({ method: 'GET', url: '/api/nope' })).statusCode).toBe(404);
    } finally {
      config.WEB_DIST_DIR = previous;
      await web.close();
    }
  });
});
