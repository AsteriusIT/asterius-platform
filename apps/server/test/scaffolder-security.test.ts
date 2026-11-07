import { describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { getInvoker } from '../src/actions/invokers/index.js';
import { renderFiles } from '../src/actions/invokers/scaffolder.js';
import { parseScaffoldConfig } from '../src/actions/invokers/scaffolder/index.js';
import { all } from '../src/db.js';
import { inDefaultOrg, testApp } from './helpers.js';

const ctx = {
  run: { id: 'abcdef12-0000', url: 'https://portal/runs/1', idempotencyKey: 'k', callback: { url: '', token: 'callback-token-123' } },
  action: { identifier: 'a', title: 'A', blueprint: null },
  inputs: {},
  entity: null,
  trigger: { user: { id: 'u-1', email: 'dev@example.com', name: 'n' }, at: '' },
  steps: {},
};
const logs: string[] = [];
const log = async (m: string) => void logs.push(m);
const run = (config: Record<string, unknown>) => getInvoker('scaffolder').start({ ctx, config, log });
const TOKEN = 'ghp_SuperSecretToken1234';

const base = { templateRepo: 'org/tpl', repo: 'org/new', token: TOKEN };

async function fake(handler: (url: string, method: string, send: (o: unknown, status?: number) => void) => void) {
  const calls: string[] = [];
  const server = createServer((req, res) => {
    calls.push(`${req.method} ${req.url}`);
    req.resume();
    req.on('end', () =>
      handler(req.url!, req.method!, (o, status = 200) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(o))),
    );
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { calls, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => new Promise((r) => server.close(r)) };
}

describe('scaffolder SSRF / endpoint validation', () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ['github apiUrl (metadata address)', { provider: 'github', apiUrl: 'https://169.254.169.254' }],
    ['github apiUrl (private, http)', { provider: 'github', apiUrl: 'http://10.0.0.5/api/v3' }],
    ['github baseUrl (private https)', { provider: 'github', baseUrl: 'https://192.168.1.10' }],
    ['gitlab baseUrl (private)', { provider: 'gitlab', baseUrl: 'https://10.1.2.3' }],
    ['gitlab baseUrl (plain http hostname)', { provider: 'gitlab', baseUrl: 'http://gitlab.corp.example' }],
    ['azure organization (private)', { provider: 'azure-devops', organization: 'https://172.16.0.9/org', project: 'p' }],
    ['url with credentials', { provider: 'gitlab', baseUrl: 'https://user:pw@gitlab.example.com' }],
    ['non http scheme', { provider: 'github', apiUrl: 'file:///etc/passwd' }],
  ];
  it.each(cases)('refuses %s before any call', async (_n, extra) => {
    const cfg = { ...base, ...extra };
    expect(() => getInvoker('scaffolder').validate(cfg)).toThrow();
    await expect(run(cfg)).rejects.toThrow(/apiUrl|baseUrl|organization/);
  });

  it('accepts a public https endpoint and an allow-listed http one', () => {
    expect(() => parseScaffoldConfig({ ...base, provider: 'gitlab', baseUrl: 'https://gitlab.example.com' })).not.toThrow();
    expect(() => parseScaffoldConfig({ ...base, provider: 'gitlab', baseUrl: 'http://127.0.0.1:9' })).not.toThrow(); // OUTBOUND_ALLOW in tests
    expect(() => parseScaffoldConfig({ ...base, provider: 'github', apiUrl: '{{ inputs.url }}' })).not.toThrow(); // checked once rendered
  });

  it('rejects repository and ref names that could alter API paths', () => {
    for (const bad of [{ repo: 'org/../../admin' }, { templateRepo: 'org/x?y=1' }, { branch: 'a/../b' }, { templateRef: 'main#x' }, { baseBranch: '-d' }])
      expect(() => parseScaffoldConfig({ ...base, provider: 'github', ...bad })).toThrow();
  });
});

describe('scaffolder token handling', () => {
  it('does not leak the token when the provider echoes it in an error', async () => {
    const srv = await fake((_u, _m, send) => send({ message: `Bad credentials for ${TOKEN}` }, 403));
    const err = await run({ ...base, provider: 'github', apiUrl: srv.url }).catch((e: Error) => e);
    await srv.close();
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('403');
    expect((err as Error).message).not.toContain(TOKEN);
    expect(logs.join('\n')).not.toContain(TOKEN);
  });
});

describe('scaffolder secrets in variables', () => {
  it('rejects ${secret:…} / ${env:…} in variables, title and description', () => {
    const v = getInvoker('scaffolder');
    for (const extra of [
      { variables: { k: '${secret:DB_PASSWORD}' } },
      { variables: { k: 'x-${env:HOME}' } },
      { title: '${secret:X}' },
      { description: '${secret:X}' },
    ])
      expect(() => v.validate({ ...base, provider: 'github', ...extra })).toThrow(/cannot reference secrets/);
    expect(() => v.validate({ ...base, provider: 'github', token: '${secret:GH}' })).not.toThrow();
  });

  it('refuses to commit a file containing the token or the callback token', async () => {
    const srv = await fake((url, _m, send) => {
      if (url.includes('/git/trees/')) return send({ tree: [{ path: 'a.txt', type: 'blob', sha: 's1', size: 5 }] });
      if (url.includes('/git/blobs/s1')) return send({ content: Buffer.from('{{ name }}').toString('base64') });
      send({}, 500);
    });
    for (const secret of [TOKEN, 'callback-token-123']) {
      await expect(run({ ...base, provider: 'github', apiUrl: srv.url, variables: { name: secret } })).rejects.toThrow(/credential would be written/);
    }
    expect(srv.calls.some((c) => c.startsWith('POST') || c.startsWith('PUT'))).toBe(false);
    await srv.close();
  });
});

describe('scaffolder target paths', () => {
  const file = (path: string) => [{ path, content: Buffer.from('x').toString('base64') }];
  it('rejects .git, traversal, absolute and backslash paths', () => {
    for (const p of ['.git/config', 'sub/.GIT/hooks/pre-commit', '../x', 'a/../b', 'a\\b', '/etc/passwd', 'a//b'])
      expect(() => renderFiles(file(p), {}, '.'), p).toThrow(/unsafe path|\.git/);
    expect(() => renderFiles(file('{{ d }}/config'), { d: '.git' }, '.')).toThrow(/\.git/); // rendered
    expect(() => renderFiles(file('config'), {}, '.git/x')).toThrow(/\.git/); // targetPath
  });
  it('rejects bad targetPath in the config and allows .github/workflows', () => {
    expect(() => parseScaffoldConfig({ ...base, provider: 'github', targetPath: 'a\\b' })).toThrow();
    expect(renderFiles(file('.github/workflows/ci.yml'), {}, 'svc')[0]!.path).toBe('svc/.github/workflows/ci.yml');
  });
});

describe('scaffold.published audit entry', () => {
  it('is written on success without the token', async () => {
    const app = await testApp();
    const srv = await fake((url, method, send) => {
      if (url.includes('/repository/tree')) return send([{ path: 'a.txt', type: 'blob' }]);
      if (url.includes('/repository/files/a.txt/raw')) return send('x');
      if (method === 'GET' && url.startsWith('/api/v4/projects/team%2Fsvc')) return send({}, 404);
      if (url === '/api/v4/namespaces/team') return send({ id: 1 });
      if (url === '/api/v4/projects') return send({ id: 9, web_url: 'https://gl/team/svc' }, 201);
      send({ id: 'c1' }, 201);
    });
    const out = await inDefaultOrg(() => run({ ...base, provider: 'gitlab', mode: 'new-repository', repo: 'team/svc', baseUrl: srv.url }));
    await srv.close();
    expect(out.status).toBe('SUCCESS');
    expect(JSON.stringify(out)).not.toContain(TOKEN);
    const rows = await all<{ org_id: string; actor_id: string; actor_email: string; target: string; detail: string }>(
      "SELECT org_id, actor_id, actor_email, target, detail FROM audit_log WHERE action = 'scaffold.published'",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ org_id: 'default', actor_id: 'u-1', actor_email: 'dev@example.com', target: 'https://gl/team/svc' });
    expect(JSON.parse(rows[0]!.detail)).toMatchObject({
      runId: ctx.run.id,
      provider: 'gitlab',
      mode: 'new-repository',
      repoUrl: 'https://gl/team/svc',
      prUrl: null,
      files: 1,
    });
    expect(rows[0]!.detail).not.toContain(TOKEN);
    await app.close();
  });
});
