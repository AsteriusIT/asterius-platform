import { inDefaultOrg } from './helpers.js';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it, vi } from 'vitest';

const created: unknown[] = [];
const patched: unknown[] = [];
let conditions: unknown[] = [];
vi.mock('../src/lib/kube.js', () => ({
  k8s: { PatchStrategy: { MergePatch: 'merge' } },
  kube: () => ({
    objects: {
      create: async (o: unknown) => void created.push(o),
      read: async () => ({ status: { conditions } }),
      patch: async (o: unknown) => void patched.push(o),
    },
  }),
}));

const { renderFiles, renderText } = await import('../src/actions/invokers/scaffolder.js');
const { fromConditions } = await import('../src/actions/invokers/tekton.js');
const { getInvoker } = await import('../src/actions/invokers/index.js');

const ctx = {
  run: { id: 'abcdef12-0000', url: 'https://portal/runs/1', idempotencyKey: 'k', callback: { url: '', token: '' } },
  action: { identifier: 'a', title: 'A', blueprint: null },
  inputs: {},
  entity: null,
  trigger: { user: { id: 'u', email: 'e', name: 'n' }, at: '' },
  steps: {},
};
const b64 = (s: string) => Buffer.from(s).toString('base64');

describe('scaffolder rendering', () => {
  it('substitutes variables in paths and text, copies binaries, refuses unknown variables and unsafe paths', () => {
    expect(renderText('hi {{ name }} {{ cookiecutter.team }}', { name: 'api', team: 'pay' })).toBe('hi api pay');
    expect(() => renderText('{{ nope }}', {})).toThrow(/"nope"/);
    const out = renderFiles(
      [
        { path: '{{ name }}/README.md', content: b64('# {{ name }}') },
        { path: 'logo.png', content: Buffer.from([0, 1, 2, 123, 123]).toString('base64') },
      ],
      { name: 'api' },
      'services',
    );
    expect(out.map((f) => f.path)).toEqual(['services/api/README.md', 'services/logo.png']);
    expect(Buffer.from(out[0]!.content, 'base64').toString()).toBe('# api');
    expect(out[1]!.content).toBe(Buffer.from([0, 1, 2, 123, 123]).toString('base64'));
    expect(() => renderFiles([{ path: '{{ x }}/a', content: b64('') }], { x: '..' }, '.')).toThrow(/unsafe/);
  });
});

describe('scaffolder against a GitHub-like API', () => {
  it('reads the template, creates a branch, puts files and opens a pull request', async () => {
    const calls: string[] = [];
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        calls.push(`${req.method} ${req.url}`);
        const send = (o: unknown, status = 200) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(o));
        if (req.url?.startsWith('/repos/org/tpl/git/trees')) return send({ tree: [{ path: 'src/{{ name }}.txt', type: 'blob', sha: 's1', size: 5 }] });
        if (req.url?.startsWith('/repos/org/tpl/git/blobs/s1')) return send({ content: b64('hello {{ name }}') });
        if (req.url?.startsWith('/repos/org/new/git/ref/heads/main')) return send({ object: { sha: 'base' } });
        if (req.url?.startsWith('/repos/org/new/git/refs')) return send({}, 201);
        if (req.method === 'GET' && req.url?.includes('/contents/')) return send({}, 404);
        if (req.method === 'PUT') {
          expect(Buffer.from(JSON.parse(body).content, 'base64').toString()).toBe('hello api');
          return send({}, 201);
        }
        if (req.url?.endsWith('/pulls')) return send({ html_url: 'https://gh/pr/1', number: 1 }, 201);
        send({}, 404);
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const apiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const out = await getInvoker('scaffolder').start({
      ctx,
      config: { provider: 'github', apiUrl, token: 't', templateRepo: 'org/tpl', repo: 'org/new', variables: { name: 'api' } },
      log: async () => undefined,
    });
    expect(out).toMatchObject({ status: 'SUCCESS', link: 'https://gh/pr/1', result: { files: ['src/api.txt'], branch: 'scaffold/abcdef12' } });
    expect(calls).toContain('POST /repos/org/new/pulls');
    await new Promise((r) => server.close(r));
  });
});

describe('tekton', () => {
  it('maps the Succeeded condition and creates a PipelineRun', () =>
    inDefaultOrg(async () => {
      expect(fromConditions(undefined).status).toBe('IN_PROGRESS');
      expect(fromConditions([{ type: 'Succeeded', status: 'True', reason: 'Succeeded' }]).status).toBe('SUCCESS');
      expect(fromConditions([{ type: 'Succeeded', status: 'False', reason: 'Failed', message: 'x' }])).toMatchObject({ status: 'FAILURE', message: 'x' });
      const inv = getInvoker('tekton');
      const started = await inv.start({ ctx, config: { pipeline: 'build', namespace: 'ci', params: { v: '1' } }, log: async () => undefined });
      expect(started.state).toEqual({ name: 'asterius-abcdef120000', namespace: 'ci' });
      expect(created[0]).toMatchObject({ kind: 'PipelineRun', spec: { pipelineRef: { name: 'build' }, params: [{ name: 'v', value: '1' }] } });
      conditions = [{ type: 'Succeeded', status: 'True' }];
      expect((await inv.poll!({ ctx, config: { pipeline: 'build' }, log: async () => undefined }, started.state!)).status).toBe('SUCCESS');
      await inv.cancel!({ ctx, config: {}, log: async () => undefined }, started.state!);
      expect(patched[0]).toMatchObject({ spec: { status: 'Cancelled' } });
    }));
});
