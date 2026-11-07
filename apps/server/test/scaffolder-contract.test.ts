import { describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { getInvoker } from '../src/actions/invokers/index.js';
import { parseScaffoldConfig } from '../src/actions/invokers/scaffolder/index.js';

const ctx = {
  run: { id: 'abcdef12-0000', url: 'https://portal/runs/1', idempotencyKey: 'k', callback: { url: '', token: '' } },
  action: { identifier: 'a', title: 'A', blueprint: null },
  inputs: {},
  entity: null,
  trigger: { user: { id: 'u', email: 'e', name: 'n' }, at: '' },
  steps: {},
};
const b64 = (s: string) => Buffer.from(s).toString('base64');
const base = { provider: 'github', templateRepo: 'org/tpl', repo: 'org/new', token: 't' };
const log = async () => undefined;

async function fakeServer(handler: (method: string, url: string, send: (o: unknown, status?: number) => void) => void) {
  const server = createServer((req, res) => {
    req.on('data', () => undefined);
    req.on('end', () =>
      handler(req.method!, req.url!, (o, status = 200) => {
        res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(o));
      }),
    );
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => new Promise((r) => server.close(r)) };
}

describe('scaffolder config schema', () => {
  const inv = getInvoker('scaffolder');
  it('defaults the mode to pull-request and accepts the three providers', () => {
    expect(parseScaffoldConfig(base).mode).toBe('pull-request');
    for (const provider of ['github', 'gitlab', 'azure-devops']) expect(() => inv.validate({ ...base, provider })).not.toThrow();
    expect(() => inv.validate({ ...base, mode: 'new-repository' })).not.toThrow();
  });
  it('rejects unknown provider/mode, missing fields and unsafe targetPath', () => {
    expect(() => inv.validate({ ...base, provider: 'bitbucket' })).toThrow(/provider/);
    expect(() => inv.validate({ ...base, mode: 'push' })).toThrow(/mode/);
    expect(() => inv.validate({ ...base, repo: undefined })).toThrow(/repo/);
    expect(() => inv.validate({ ...base, token: '' })).toThrow(/token/);
    expect(() => inv.validate({ ...base, targetPath: '../x' })).toThrow(/targetPath/);
  });
  it('its info.example is valid', () => expect(() => inv.validate(inv.info.example as Record<string, unknown>)).not.toThrow());
});

describe('scaffolder output contract', () => {
  it('github: repoUrl, prUrl, branch, commit, provider, files (+ legacy pullRequest, number)', async () => {
    const srv = await fakeServer((m, url, send) => {
      if (url.startsWith('/repos/org/tpl/git/trees')) return send({ tree: [{ path: 'a.txt', type: 'blob', sha: 's1', size: 5 }] });
      if (url.startsWith('/repos/org/tpl/git/blobs/s1')) return send({ content: b64('hi {{ name }}') });
      if (url.startsWith('/repos/org/new/git/ref/heads/main')) return send({ object: { sha: 'base' } });
      if (url.endsWith('/git/refs')) return send({}, 201);
      if (m === 'GET') return send({}, 404);
      if (m === 'PUT') return send({ commit: { sha: 'c0ffee' } }, 201);
      if (url.endsWith('/pulls')) return send({ html_url: 'https://gh/org/new/pull/7', number: 7, head: { sha: 'c0ffee' } }, 201);
      send({}, 404);
    });
    const out = await getInvoker('scaffolder').start({ ctx, config: { ...base, apiUrl: srv.url, variables: { name: 'api' } }, log });
    expect(out.status).toBe('SUCCESS');
    expect(out.link).toBe('https://gh/org/new/pull/7');
    expect(out.result).toEqual({
      repoUrl: 'https://gh/org/new',
      prUrl: 'https://gh/org/new/pull/7',
      branch: 'scaffold/abcdef12',
      commit: 'c0ffee',
      provider: 'github',
      files: ['a.txt'],
      pullRequest: 'https://gh/org/new/pull/7',
      number: 7,
    });
    await srv.close();
  });

  it('gitlab: same contract from a merge request', async () => {
    const srv = await fakeServer((_m, url, send) => {
      if (url.includes('/projects/org%2Ftpl/repository/tree')) return send([{ path: 'a.txt', type: 'blob' }]);
      if (url.includes('/repository/files/a.txt/raw')) return send('x');
      if (url.endsWith('/repository/commits')) return send({ id: 'abc123' }, 201);
      if (_m === 'GET' && url.includes('/merge_requests?')) return send([]);
      if (url.endsWith('/merge_requests')) return send({ web_url: 'https://gl/org/new/-/merge_requests/3', iid: 3 }, 201);
      send({}, 404);
    });
    const out = await getInvoker('scaffolder').start({ ctx, config: { ...base, provider: 'gitlab', baseUrl: srv.url }, log });
    expect(out.result).toMatchObject({
      repoUrl: 'https://gl/org/new',
      prUrl: 'https://gl/org/new/-/merge_requests/3',
      commit: 'abc123',
      provider: 'gitlab',
      branch: 'scaffold/abcdef12',
      files: ['a.txt'],
      number: 3,
    });
    await srv.close();
  });
});
