import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { emitJobLog, tailLines } from '../src/lib/ci-logs.js';
import { getInvoker } from '../src/actions/invokers/index.js';
import type { InvokeEnv } from '../src/actions/types.js';

describe('log helpers', () => {
  it('strips ANSI codes and timestamps, keeps the tail and truncates long lines', () => {
    const text = ['2026-01-01T10:00:00.1234567Z \u001b[31mfirst\u001b[0m', 'second', '', 'x'.repeat(2000), 'last'].join('\n');
    const { lines, skipped } = tailLines(text, 3);
    expect(skipped).toBe(1);
    expect(lines[1]).toHaveLength(1001);
    expect(lines.at(-1)).toBe('last');
    expect(tailLines(text, 10).lines[0]).toBe('first');
  });

  it('prefixes lines with the job and marks error lines of failed jobs', async () => {
    const out: Array<[string, string | undefined]> = [];
    await emitJobLog(async (m, l) => void out.push([m, l]), 'build', 'compiling\nERROR: boom', true);
    expect(out).toEqual([
      ['[build] compiling', 'info'],
      ['[build] ERROR: boom', 'error'],
    ]);
  });
});

async function api(handler: (url: string) => { status?: number; body: unknown; text?: boolean }) {
  const s = createServer((req, res) => {
    const out = handler(req.url ?? '');
    res
      .writeHead(out.status ?? 200, { 'content-type': out.text ? 'text/plain' : 'application/json' })
      .end(out.text ? String(out.body) : JSON.stringify(out.body));
  });
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(s.address() as AddressInfo).port}`, close: () => new Promise((r) => s.close(r)) };
}
const ctx = {
  run: { id: 'r', url: '', callback: { url: '', token: '' } },
  action: { identifier: 'a', title: 'A', blueprint: null },
  inputs: {},
  entity: null,
  trigger: { user: { id: 'u', email: 'e', name: 'n' }, at: '' },
  steps: {},
};

describe('pipeline logs on completion', () => {
  it('GitHub Actions: failed jobs first, logs copied into the run log', async () => {
    const s = await api((url) => {
      if (url.startsWith('/repos/o/r/actions/runs/9/jobs'))
        return {
          body: {
            jobs: [
              { id: 1, name: 'lint', conclusion: 'success' },
              { id: 2, name: 'test', conclusion: 'failure' },
            ],
          },
        };
      if (url.startsWith('/repos/o/r/actions/jobs/2/logs')) return { body: '2026-01-01T00:00:00Z running\nERROR: tests failed', text: true };
      if (url.startsWith('/repos/o/r/actions/jobs/1/logs')) return { body: 'ok', text: true };
      return { body: { id: 9, status: 'completed', conclusion: 'failure', html_url: 'https://x/9', created_at: '' } };
    });
    const logs: string[] = [];
    const env: InvokeEnv = { ctx, config: { owner: 'o', repo: 'r', workflow: 'w.yml', token: 't', apiUrl: s.url }, log: async (m) => void logs.push(m) };
    const out = await getInvoker('github-workflow').poll!(env, { runId: 9 });
    expect(out.status).toBe('FAILURE');
    expect(logs.filter((l) => l.startsWith('[')).slice(0, 2)).toEqual(['[test] running', '[test] ERROR: tests failed']);
    expect(logs).toContain('[lint] ok');
    await s.close();
  });

  it('GitLab: job traces; can be disabled', async () => {
    const s = await api((url) => {
      if (url.includes('/pipelines/5/jobs')) return { body: [{ id: 7, name: 'deploy', status: 'failed' }] };
      if (url.includes('/jobs/7/trace')) return { body: 'deploying\nfatal: denied', text: true };
      return { body: { id: 5, status: 'failed', web_url: 'https://x' } };
    });
    const config = { project: 'g/p', token: 't', baseUrl: s.url };
    const logs: string[] = [];
    const log: InvokeEnv['log'] = async (m) => void logs.push(m);
    await getInvoker('gitlab-pipeline').poll!({ ctx, config, log }, { pipelineId: 5 });
    expect(logs).toContain('[deploy] fatal: denied');
    logs.length = 0;
    await getInvoker('gitlab-pipeline').poll!({ ctx, config: { ...config, logs: false }, log }, { pipelineId: 5 });
    expect(logs.some((l) => l.startsWith('[deploy]'))).toBe(false);
    await s.close();
  });
});
