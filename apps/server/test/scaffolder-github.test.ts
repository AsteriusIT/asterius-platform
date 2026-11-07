/* eslint-disable @typescript-eslint/no-explicit-any -- loose JSON bodies of a fake server */
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
const b64 = (s: string) => Buffer.from(s).toString('base64');
const log = async () => undefined;

interface Repo {
  empty: boolean;
  branch: string;
  refs: Record<string, string>;
  commits: number;
}

/** Minimal stateful GitHub: template repo, repository creation, Git Data API, contents API, pulls. */
async function fakeGithub(opts: { me?: string; existing?: Record<string, Repo> } = {}) {
  const calls: Array<{ m: string; url: string; body: any }> = [];
  const repos: Record<string, Repo> = opts.existing ?? {};
  const prs: Array<{ html_url: string; number: number; head: string; base: string }> = [];
  let n = 0;
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : undefined;
      const m = req.method!;
      const url = req.url!;
      calls.push({ m, url, body });
      const send = (o: unknown, status = 200) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(o));
      const path = url.split('?')[0]!;
      if (path.startsWith('/repos/org/tpl/git/trees')) return send({ tree: [{ path: 'README.md', type: 'blob', sha: 's1', size: 5 }] });
      if (path.startsWith('/repos/org/tpl/git/blobs/s1')) return send({ content: b64('# {{ name }}') });
      if (path === '/user') return opts.me ? send({ login: opts.me }) : send({}, 403);
      if (path.startsWith('/orgs/org/teams/') && m === 'PUT') return send({}, 204);
      const create = path.match(/^\/(orgs\/([^/]+)\/repos|user\/repos)$/);
      if (create && m === 'POST') {
        const owner = create[2] ?? opts.me!;
        const key = `${owner}/${body.name}`;
        if (repos[key]) return send({ message: 'Repository creation failed.', errors: [{ message: 'name already exists on this account' }] }, 422);
        repos[key] = { empty: false, branch: 'master', refs: { master: 'init0' }, commits: 1 };
        return send({ html_url: `https://gh/${key}`, default_branch: 'master', name: body.name }, 201);
      }
      const r = path.match(/^\/repos\/([^/]+\/[^/]+)(\/.*)?$/);
      const repo = r && repos[r[1]!];
      if (!r || !repo) return send({ message: 'Not Found' }, 404);
      const rest = r[2] ?? '';
      if (rest === '') return send({ html_url: `https://gh/${r[1]}`, default_branch: repo.branch, name: r[1]!.split('/')[1] });
      if (rest === '/commits') return repo.empty ? send({ message: 'Git Repository is empty.' }, 409) : send([{ sha: 'x' }]);
      const rename = rest.match(/^\/branches\/([^/]+)\/rename$/);
      if (rename) {
        repo.refs[body.new_name] = repo.refs[rename[1]!]!;
        delete repo.refs[rename[1]!];
        repo.branch = body.new_name;
        return send({});
      }
      if (rest === '/topics') return send({});
      const ref = rest.match(/^\/git\/ref\/heads\/(.+)$/);
      if (ref)
        return repo.refs[decodeURIComponent(ref[1]!)] ? send({ object: { sha: repo.refs[decodeURIComponent(ref[1]!)] } }) : send({ message: 'Not Found' }, 404);
      if (rest === '/git/refs' && m === 'POST') {
        repo.refs[body.ref.replace('refs/heads/', '')] = body.sha;
        return send({}, 201);
      }
      if (rest.startsWith('/git/commits/') && m === 'GET') return send({ tree: { sha: `tree-of-${rest.split('/').pop()}` } });
      if (rest === '/git/blobs') return send({ sha: `blob-${b64(body.content).slice(0, 8)}` }, 201);
      if (rest === '/git/trees') {
        return send({ sha: `tree-${++n}` }, 201);
      }
      if (rest === '/git/commits' && m === 'POST') {
        repo.commits++;
        return send({ sha: `commit-${repo.commits}` }, 201);
      }
      const patch = rest.match(/^\/git\/refs\/heads\/(.+)$/);
      if (patch && m === 'PATCH') {
        repo.refs[decodeURIComponent(patch[1]!)] = body.sha;
        return send({});
      }
      if (rest.includes('/contents/')) {
        if (m === 'GET') return send({ message: 'Not Found' }, 404);
        repo.empty = false;
        repo.refs[body.branch] = 'bootstrap1';
        return send({ commit: { sha: 'bootstrap1' } }, 201);
      }
      if (rest === '/pulls' && m === 'GET') {
        const q = new URL(url, 'http://x').searchParams;
        return send(prs.filter((p) => `org:${p.head}` === q.get('head') && p.base === q.get('base')));
      }
      if (rest === '/pulls' && m === 'POST') {
        const pr = { html_url: `https://gh/${r[1]}/pull/${prs.length + 1}`, number: prs.length + 1, head: body.head, base: body.base };
        prs.push(pr);
        return send(pr, 201);
      }
      send({ message: 'Not Found' }, 404);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, calls, repos, prs, close: () => new Promise((r) => server.close(r)) };
}

const cfg = (apiUrl: string, extra: Record<string, unknown> = {}) => ({
  provider: 'github',
  mode: 'new-repository',
  apiUrl,
  token: 't',
  templateRepo: 'org/tpl',
  repo: 'org/svc',
  variables: { name: 'svc' },
  ...extra,
});
const start = (config: Record<string, unknown>) => getInvoker('scaffolder').start({ ctx, config, log });
const has = (gh: { calls: Array<{ m: string; url: string }> }, s: string) => gh.calls.some((c) => `${c.m} ${c.url}` === s);

describe('scaffolder github new-repository', () => {
  it('creates an organization repository, renames the default branch, commits, sets topics and team permission', async () => {
    const gh = await fakeGithub({ me: 'someone' });
    const out = await start(cfg(gh.url, { description: 'd', visibility: 'internal', topics: 'a, b', team: 'platform', teamPermission: 'maintain' }));
    expect(out.status).toBe('SUCCESS');
    expect(out.result).toEqual({
      repoUrl: 'https://gh/org/svc',
      prUrl: null,
      branch: 'main',
      commit: 'commit-2',
      provider: 'github',
      files: ['README.md'],
      pullRequest: null,
      number: null,
    });
    const create = gh.calls.find((c) => c.url === '/orgs/org/repos')!;
    expect(create.body).toMatchObject({ name: 'svc', description: 'd', visibility: 'internal', private: true, auto_init: true });
    expect(has(gh, 'POST /repos/org/svc/branches/master/rename')).toBe(true);
    expect(gh.repos['org/svc']!.refs).toEqual({ main: 'commit-2' });
    expect(gh.calls.find((c) => c.url === '/repos/org/svc/topics')!.body).toEqual({ names: ['a', 'b'] });
    const team = gh.calls.find((c) => c.url === '/orgs/org/teams/platform/repos/org/svc')!;
    expect(team.m).toBe('PUT');
    expect(team.body).toEqual({ permission: 'maintain' });
    await gh.close();
  });

  it('creates a repository for the authenticated user', async () => {
    const gh = await fakeGithub({ me: 'org' });
    const out = await start(cfg(gh.url, { visibility: 'public', baseBranch: 'master' }));
    expect(out.status).toBe('SUCCESS');
    expect(gh.calls.find((c) => c.url === '/user/repos')!.body).toMatchObject({ name: 'svc', private: false });
    expect(has(gh, 'POST /orgs/org/repos')).toBe(false);
    expect(gh.calls.some((c) => c.url.endsWith('/rename'))).toBe(false);
    expect((out as { result: { branch: string } }).result.branch).toBe('master');
    await gh.close();
  });

  it('refuses a non-empty existing repository unless reuseExisting, and reuses it when allowed', async () => {
    const gh = await fakeGithub({ me: 'x', existing: { 'org/svc': { empty: false, branch: 'main', refs: { main: 'tip' }, commits: 5 } } });
    await expect(start(cfg(gh.url))).rejects.toThrow(/already exists and is not empty/);
    const out = await start(cfg(gh.url, { reuseExisting: true }));
    expect(out.status).toBe('SUCCESS');
    expect(gh.repos['org/svc']!.refs.main).toBe('commit-6');
    expect(gh.calls.some((c) => c.url.endsWith('/rename'))).toBe(false);
    await gh.close();
  });

  it('fills an existing empty repository (previous attempt failed after creation)', async () => {
    const gh = await fakeGithub({ me: 'x', existing: { 'org/svc': { empty: true, branch: 'main', refs: {}, commits: 0 } } });
    const out = await start(cfg(gh.url, { template: undefined }));
    expect(out.status).toBe('SUCCESS');
    // the only file bootstraps the repository through the contents API
    expect(gh.calls.some((c) => c.m === 'PUT' && c.url.startsWith('/repos/org/svc/contents/README.md'))).toBe(true);
    expect((out as { result: { commit: string } }).result.commit).toBe('bootstrap1');
    await gh.close();
  });
});

describe('scaffolder github pull-request re-runs', () => {
  const pr = (url: string) => ({ provider: 'github', apiUrl: url, token: 't', templateRepo: 'org/tpl', repo: 'org/svc', variables: { name: 'svc' } });
  it('reuses the existing branch and the open pull request', async () => {
    const gh = await fakeGithub({ existing: { 'org/svc': { empty: false, branch: 'main', refs: { main: 'base' }, commits: 1 } } });
    const first = await start(pr(gh.url));
    const second = await start(pr(gh.url));
    expect(first.status).toBe('SUCCESS');
    expect(second.status).toBe('SUCCESS');
    expect(gh.calls.filter((c) => c.m === 'POST' && c.url === '/repos/org/svc/git/refs')).toHaveLength(1);
    expect(gh.calls.filter((c) => c.m === 'POST' && c.url === '/repos/org/svc/pulls')).toHaveLength(1);
    expect(gh.prs).toHaveLength(1);
    expect(second.link).toBe(first.link);
    expect((second as { result: { number: number } }).result.number).toBe(1);
    await gh.close();
  });
});
