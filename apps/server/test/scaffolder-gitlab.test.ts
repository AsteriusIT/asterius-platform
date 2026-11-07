import { describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { getInvoker } from '../src/actions/invokers/index.js';

const ctx = {
  run: { id: 'abcdef12-0000', url: 'https://portal/runs/1', idempotencyKey: 'k', callback: { url: '', token: '' } },
  action: { identifier: 'a', title: 'A', blueprint: null },
  inputs: {},
  entity: null,
  trigger: { user: { id: 'u', email: 'e', name: 'n' }, at: '' },
  steps: {},
};
const log = async () => undefined;
type Call = { method: string; url: string; body: Record<string, unknown> | null };

async function gitlab(handler: (call: Call, send: (o: unknown, status?: number) => void) => void) {
  const calls: Call[] = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => {
      const call = { method: req.method!, url: req.url!, body: raw ? JSON.parse(raw) : null };
      calls.push(call);
      handler(call, (o, status = 200) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(o)));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { calls, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => new Promise((r) => server.close(r)) };
}

const template = (url: string, send: (o: unknown, status?: number) => void) => {
  if (url.includes('/projects/org%2Ftpl/repository/tree')) return send([{ path: 'a.txt', type: 'blob' }]);
  if (url.includes('/projects/org%2Ftpl/repository/files/a.txt/raw')) return send('x');
  return false;
};
const cfg = (baseUrl: string, extra: Record<string, unknown> = {}) => ({
  provider: 'gitlab',
  templateRepo: 'org/tpl',
  repo: 'team/sub/svc',
  token: 't',
  baseUrl,
  ...extra,
});
const run = (config: Record<string, unknown>) => getInvoker('scaffolder').start({ ctx, config, log });

describe('gitlab new-repository', () => {
  it('creates the project in the namespace and pushes the initial commit', async () => {
    const srv = await gitlab(({ method, url }, send) => {
      if (template(url, send) !== false) return;
      if (method === 'GET' && url === '/api/v4/projects/team%2Fsub%2Fsvc') return send({}, 404);
      if (url === '/api/v4/namespaces/team%2Fsub') return send({ id: 42 });
      if (url === '/api/v4/projects') return send({ id: 9, web_url: 'https://gl/team/sub/svc' }, 201);
      if (url === '/api/v4/projects/9/repository/commits') return send({ id: 'c1' }, 201);
      send({}, 404);
    });
    const out = await run(cfg(srv.url, { mode: 'new-repository', description: 'd', visibility: 'internal', defaultBranch: 'trunk' }));
    expect(out.result).toMatchObject({ repoUrl: 'https://gl/team/sub/svc', prUrl: null, branch: 'trunk', commit: 'c1', files: ['a.txt'] });
    const create = srv.calls.find((c) => c.method === 'POST' && c.url === '/api/v4/projects')!;
    expect(create.body).toMatchObject({ name: 'svc', path: 'svc', namespace_id: 42, description: 'd', visibility: 'internal', default_branch: 'trunk' });
    const commit = srv.calls.find((c) => c.url.endsWith('/repository/commits'))!;
    expect(commit.body).toMatchObject({ branch: 'trunk', actions: [{ action: 'create', file_path: 'a.txt' }] });
    expect(commit.body?.start_branch).toBeUndefined();
    await srv.close();
  });

  it('defaults to a private project and an explicit namespace field', async () => {
    const srv = await gitlab(({ method, url }, send) => {
      if (template(url, send) !== false) return;
      if (method === 'GET' && url.startsWith('/api/v4/projects/grp%2Fsvc')) return send({}, 404);
      if (url === '/api/v4/namespaces/grp') return send({ id: 5 });
      if (url === '/api/v4/projects') return send({ id: 9, web_url: 'https://gl/grp/svc' }, 201);
      send({ id: 'c1' }, 201);
    });
    await run(cfg(srv.url, { mode: 'new-repository', repo: 'svc', namespace: 'grp' }));
    const create = srv.calls.find((c) => c.method === 'POST' && c.url === '/api/v4/projects')!;
    expect(create.body).toMatchObject({ namespace_id: 5, visibility: 'private', default_branch: 'main' });
    await srv.close();
  });

  const existing = (empty: boolean, current = 'old') =>
    gitlab(({ method, url }, send) => {
      if (template(url, send) !== false) return;
      if (method === 'GET' && url === '/api/v4/projects/team%2Fsub%2Fsvc')
        return send({ id: 9, web_url: 'https://gl/team/sub/svc', empty_repo: empty, default_branch: empty ? null : 'main' });
      if (url.startsWith('/api/v4/projects/9/repository/tree')) return send([{ path: 'a.txt', type: 'blob' }]);
      if (url.startsWith('/api/v4/projects/9/repository/files/a.txt?ref=main'))
        return send({ encoding: 'base64', content: Buffer.from(current).toString('base64') });
      if (url.startsWith('/api/v4/projects/9/repository/branches/main')) return send({ name: 'main', commit: { id: 'tip9' } });
      if (url === '/api/v4/projects/9/repository/commits') return send({ id: 'c2' }, 201);
      send({}, 404);
    });

  it('uses an existing empty project', async () => {
    const srv = await existing(true);
    const out = await run(cfg(srv.url, { mode: 'new-repository' }));
    expect(out.result).toMatchObject({ repoUrl: 'https://gl/team/sub/svc', commit: 'c2', branch: 'main' });
    expect(srv.calls.some((c) => c.method === 'POST' && c.url === '/api/v4/projects')).toBe(false);
    await srv.close();
  });

  it('refuses a non-empty project unless reuseExisting, then updates files on its default branch', async () => {
    const srv = await existing(false);
    await expect(run(cfg(srv.url, { mode: 'new-repository' }))).rejects.toThrow(/already exists and is not empty/);
    expect(srv.calls.some((c) => c.url.endsWith('/commits'))).toBe(false);
    await run(cfg(srv.url, { mode: 'new-repository', reuseExisting: true }));
    const commit = srv.calls.find((c) => c.url.endsWith('/commits'))!;
    expect(commit.body).toMatchObject({ branch: 'main', actions: [{ action: 'update', file_path: 'a.txt' }] });
    await srv.close();
  });
});

describe('gitlab merge request re-runs', () => {
  const mrServer = (branchExists: boolean, openMr: boolean, current = 'old') =>
    gitlab(({ method, url }, send) => {
      if (template(url, send) !== false) return;
      if (url.startsWith('/api/v4/projects/team%2Fsub%2Fsvc/repository/branches/'))
        return branchExists ? send({ name: 'b', commit: { id: 'tip1' } }) : send({}, 404);
      if (url.startsWith('/api/v4/projects/team%2Fsub%2Fsvc/repository/tree')) return send([{ path: 'a.txt', type: 'blob' }]);
      if (url.startsWith('/api/v4/projects/team%2Fsub%2Fsvc/repository/files/a.txt?ref='))
        return send({ encoding: 'base64', content: Buffer.from(current).toString('base64') });
      if (url.endsWith('/repository/commits')) return send({ id: 'c3' }, 201);
      if (method === 'GET' && url.includes('/merge_requests?state=opened&source_branch=scaffold%2Fabcdef12&target_branch=main'))
        return send(openMr ? [{ web_url: 'https://gl/team/sub/svc/-/merge_requests/8', iid: 8 }] : []);
      if (method === 'POST' && url.endsWith('/merge_requests')) return send({ web_url: 'https://gl/team/sub/svc/-/merge_requests/9', iid: 9 }, 201);
      send({}, 404);
    });

  it('first run: new branch from base and a new MR', async () => {
    const srv = await mrServer(false, false);
    const out = await run(cfg(srv.url));
    expect(out.result).toMatchObject({ number: 9 });
    const commit = srv.calls.find((c) => c.url.endsWith('/commits'))!;
    expect(commit.body).toMatchObject({ start_branch: 'main', actions: [{ action: 'create' }] });
    await srv.close();
  });

  it('re-run: commits on the existing branch and reuses the open MR', async () => {
    const srv = await mrServer(true, true);
    const out = await run(cfg(srv.url));
    expect(out.result).toMatchObject({ prUrl: 'https://gl/team/sub/svc/-/merge_requests/8', number: 8, commit: 'c3' });
    const commit = srv.calls.find((c) => c.url.endsWith('/commits'))!;
    expect(commit.body?.start_branch).toBeUndefined();
    expect(commit.body).toMatchObject({ branch: 'scaffold/abcdef12', actions: [{ action: 'update' }] });
    expect(srv.calls.some((c) => c.method === 'POST' && c.url.endsWith('/merge_requests'))).toBe(false);
    await srv.close();
  });

  it('re-run with identical content: no commit, branch tip returned, MR reused', async () => {
    const srv = await mrServer(true, true, '"x"');
    const out = await run(cfg(srv.url));
    expect(out.result).toMatchObject({ number: 8, commit: 'tip1' });
    expect(srv.calls.some((c) => c.method === 'POST' && c.url.endsWith('/commits'))).toBe(false);
    await srv.close();
  });
});

describe('gitlab new-repository re-run with identical content', () => {
  it('skips the commit and returns the branch tip', async () => {
    const srv = await gitlab(({ method, url }, send) => {
      if (template(url, send) !== false) return;
      if (method === 'GET' && url === '/api/v4/projects/team%2Fsub%2Fsvc')
        return send({ id: 9, web_url: 'https://gl/team/sub/svc', empty_repo: false, default_branch: 'main' });
      if (url.startsWith('/api/v4/projects/9/repository/tree')) return send([{ path: 'a.txt', type: 'blob' }]);
      if (url.startsWith('/api/v4/projects/9/repository/files/a.txt?ref=main'))
        return send({ encoding: 'base64', content: Buffer.from('"x"').toString('base64') });
      if (url.startsWith('/api/v4/projects/9/repository/branches/main')) return send({ commit: { id: 'tip9' } });
      send({}, 404);
    });
    const out = await run(cfg(srv.url, { mode: 'new-repository', reuseExisting: true }));
    expect(out.result).toMatchObject({ commit: 'tip9', branch: 'main' });
    expect(srv.calls.some((c) => c.method === 'POST')).toBe(false);
    await srv.close();
  });
});
