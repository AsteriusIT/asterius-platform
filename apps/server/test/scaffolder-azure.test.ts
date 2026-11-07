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
const ZERO = '0'.repeat(40);

interface Body {
  name: string;
  refUpdates: Array<{ name: string; oldObjectId: string }>;
  commits: Array<{ changes: Array<{ changeType: string; item: { path: string }; newContent: { content: string } }> }>;
  sourceRefName: string;
  targetRefName: string;
  [k: string]: unknown;
}
interface Req {
  method: string;
  url: string;
  body: Body;
  auth?: string;
}

/** Minimal Azure DevOps Git API: template repo `tpl`, target repos in `repos` (name -> { refs, files }). */
async function fakeAdo(repos: Record<string, { refs: Record<string, string>; files: Set<string> }> = {}) {
  const calls: Req[] = [];
  const prs: Array<{ id: number; source: string; target: string }> = [];
  let origin = '';
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = (raw ? JSON.parse(raw) : undefined) as Body;
      const url = new URL(req.url!, 'http://x');
      calls.push({ method: req.method!, url: req.url!, body, auth: req.headers.authorization });
      const send = (o: unknown, status = 200) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(o));
      const m = url.pathname.match(/^\/org\/P\/_apis\/git\/repositories(?:\/([^/]+))?(?:\/(.*))?$/);
      if (!m) return send({}, 404);
      const [, name, sub] = m;
      if (!name) {
        repos[body.name] = { refs: {}, files: new Set() };
        return send({ id: `id-${body.name}`, webUrl: `${origin}/org/P/_git/${body.name}` }, 201);
      }
      if (name === 'tpl') {
        if (sub === 'items') {
          expect(url.searchParams.get('recursionLevel')).toBe('Full');
          expect(url.searchParams.get('scopePath')).toBe('/skeleton');
          expect(url.searchParams.get('versionDescriptor.version')).toBe('v1');
          return send({
            value: [
              { objectId: 'o0', gitObjectType: 'tree', path: '/skeleton' },
              { objectId: 'o1', gitObjectType: 'blob', path: '/skeleton/src/{{ name }}.txt', size: 5 },
              { objectId: 'o2', gitObjectType: 'blob', path: '/skeleton/logo.bin', size: 3 },
              { objectId: 'o3', gitObjectType: 'blob', path: '/other/skip.txt', size: 3 },
            ],
          });
        }
        if (sub?.startsWith('blobs/o1')) return res.writeHead(200).end('hello {{ name }}');
        if (sub?.startsWith('blobs/o2')) return res.writeHead(200).end(Buffer.from([0, 1, 2]));
        return send({}, 404);
      }
      const repo = repos[name!];
      if (!repo) return send({ message: 'not found' }, 404);
      const web = `${origin}/org/P/_git/${name}`;
      if (!sub) return send({ id: `id-${name}`, webUrl: web });
      if (sub === 'refs' && req.method === 'GET') {
        const f = url.searchParams.get('filter');
        return send({
          value: Object.entries(repo.refs)
            .filter(([n]) => !f || n.startsWith(`refs/${f}`))
            .map(([n, o]) => ({ name: n, objectId: o })),
        });
      }
      if (sub === 'refs') {
        for (const u of body as unknown as Array<{ name: string; newObjectId: string }>) repo.refs[u.name] = u.newObjectId;
        return send({ value: [] });
      }
      if (sub === 'items') return repo.files.has(url.searchParams.get('path')!) ? send({ path: url.searchParams.get('path') }) : send({}, 404);
      if (sub === 'pushes') {
        const u = body.refUpdates[0];
        expect(u.oldObjectId).toBe(repo.refs[u.name] ?? ZERO);
        for (const ch of body.commits[0].changes) repo.files.add(ch.item.path);
        repo.refs[u.name] = `c${Object.keys(repo.refs).length}${calls.length}`;
        return send({ commits: [{ commitId: repo.refs[u.name] }] }, 201);
      }
      if (sub?.startsWith('pullrequests')) {
        if (req.method === 'GET') {
          const s = url.searchParams.get('searchCriteria.sourceRefName');
          const t = url.searchParams.get('searchCriteria.targetRefName');
          return send({ value: prs.filter((p) => p.source === s && p.target === t).map((p) => ({ pullRequestId: p.id, repository: { webUrl: web } })) });
        }
        const id = 40 + prs.length + 1;
        prs.push({ id, source: body.sourceRefName, target: body.targetRefName });
        return send({ pullRequestId: id, repository: { webUrl: web } }, 201);
      }
      send({}, 404);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { origin, calls, repos, close: () => new Promise((r) => server.close(r)) };
}

const base = (origin: string) => ({
  provider: 'azure-devops',
  organization: `${origin}/org/`,
  project: 'P',
  token: 'pat',
  templateRepo: 'tpl',
  templatePath: 'skeleton',
  templateRef: 'v1',
  repo: 'svc',
  variables: { name: 'api' },
});

describe('scaffolder: azure-devops', () => {
  const inv = getInvoker('scaffolder');

  it('pull-request mode: reads the template, branches, pushes one commit and opens a PR with reviewers; re-run reuses', async () => {
    const ado = await fakeAdo({ svc: { refs: { 'refs/heads/main': 'base1' }, files: new Set() } });
    const config = { ...base(ado.origin), reviewers: 'r1, r2' };
    const out = await inv.start({ ctx, config, log });
    expect(out).toMatchObject({
      status: 'SUCCESS',
      result: {
        provider: 'azure-devops',
        branch: 'scaffold/abcdef12',
        files: ['src/api.txt', 'logo.bin'],
        number: 41,
        prUrl: `${ado.origin}/org/P/_git/svc/pullrequest/41`,
        repoUrl: `${ado.origin}/org/P/_git/svc`,
      },
    });
    expect((out.result as { commit: string }).commit).toMatch(/^c/);
    // auth: PAT sent as Basic
    expect(ado.calls[0]!.auth).toBe(`Basic ${Buffer.from(':pat').toString('base64')}`);
    const push = ado.calls.find((c) => c.url.includes('/pushes'))!;
    expect(push.body.refUpdates[0]).toEqual({ name: 'refs/heads/scaffold/abcdef12', oldObjectId: 'base1' });
    expect(push.body.commits[0].changes.map((c: { changeType: string }) => c.changeType)).toEqual(['add', 'add']);
    expect(Buffer.from(push.body.commits[0].changes[0].newContent.content, 'base64').toString()).toBe('hello api');
    const prCreate = ado.calls.find((c) => c.method === 'POST' && c.url.includes('/pullrequests'))!;
    expect(prCreate.body).toMatchObject({
      sourceRefName: 'refs/heads/scaffold/abcdef12',
      targetRefName: 'refs/heads/main',
      reviewers: [{ id: 'r1' }, { id: 'r2' }],
    });

    // re-run: branch exists -> pushes on top with edit, reuses the active PR
    const again = await inv.start({ ctx, config, log });
    expect(again.result).toMatchObject({ number: 41, prUrl: `${ado.origin}/org/P/_git/svc/pullrequest/41` });
    const pushes = ado.calls.filter((c) => c.url.includes('/pushes'));
    expect(pushes).toHaveLength(2);
    expect(pushes[1]!.body.commits[0].changes.map((c: { changeType: string }) => c.changeType)).toEqual(['edit', 'edit']);
    expect(ado.calls.filter((c) => c.method === 'POST' && c.url.includes('/pullrequests'))).toHaveLength(1);
    await ado.close();
  });

  it('accepts a Bearer token as is', async () => {
    const ado = await fakeAdo({ svc: { refs: { 'refs/heads/main': 'base1' }, files: new Set() } });
    await inv.start({ ctx, config: { ...base(ado.origin), token: 'Bearer abc' }, log });
    expect(ado.calls[0]!.auth).toBe('Bearer abc');
    await ado.close();
  });

  it('new-repository mode: creates the repo and pushes to the default branch; refuses a non-empty existing one unless reuseExisting', async () => {
    const ado = await fakeAdo();
    const out = await inv.start({ ctx, config: { ...base(ado.origin), mode: 'new-repository', defaultBranch: 'trunk' }, log });
    expect(out).toMatchObject({
      status: 'SUCCESS',
      link: `${ado.origin}/org/P/_git/svc`,
      result: { prUrl: null, branch: 'trunk', provider: 'azure-devops', repoUrl: `${ado.origin}/org/P/_git/svc` },
    });
    expect(ado.calls.find((c) => c.method === 'POST' && c.url.includes('/pushes'))!.body.refUpdates[0]).toEqual({
      name: 'refs/heads/trunk',
      oldObjectId: ZERO,
    });
    expect(ado.repos.svc!.files.has('/src/api.txt')).toBe(true);

    // exists and non-empty
    await expect(inv.start({ ctx, config: { ...base(ado.origin), mode: 'new-repository', defaultBranch: 'trunk' }, log })).rejects.toThrow(/not empty/);
    const reused = await inv.start({ ctx, config: { ...base(ado.origin), mode: 'new-repository', defaultBranch: 'trunk', reuseExisting: true }, log });
    expect(reused.status).toBe('SUCCESS');
    await ado.close();
  });

  it('new-repository mode reuses an existing empty repository', async () => {
    const ado = await fakeAdo({ svc: { refs: {}, files: new Set() } });
    const out = await inv.start({ ctx, config: { ...base(ado.origin), mode: 'new-repository' }, log });
    expect(out.status).toBe('SUCCESS');
    expect(ado.calls.some((c) => c.method === 'POST' && /repositories\?/.test(c.url))).toBe(false);
    await ado.close();
  });
});
