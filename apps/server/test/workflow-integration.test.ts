import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { client, register, silentLog, testApp, waitFor, type Api } from './helpers.js';
import { startRunWorker } from '../src/actions/worker.js';

/** Features built separately working together: fragments × switch, workflow tests × control flow / vars / outputs / fragments. */

let app: FastifyInstance;
let admin: Api;
const stops: (() => unknown)[] = [];

type RunView = { id: string; status: string; result: Record<string, unknown> | null; steps: { id: string; status: string; output: unknown }[] };

const finished = (id: string) =>
  waitFor(async () => {
    const r = (await admin.get(`/api/v1/runs/${id}`)).data as RunView;
    return ['SUCCESS', 'FAILURE', 'CANCELLED'].includes(r.status) && r;
  }, 25_000);

const ok = async (p: Promise<{ status: number; data: unknown }>, code = 200) => {
  const res = await p;
  expect(res.status, JSON.stringify(res.data)).toBe(code);
  return res.data as Record<string, unknown>;
};

/** A fragment that branches on its parameter: the inner switch and its `case` references are inlined together. */
const route = {
  title: 'Route by environment',
  params: { properties: { env: { type: 'string' } }, required: ['env'] },
  steps: [
    { id: 'pick', type: 'switch', cases: [{ id: 'prod', when: 'params.env = "prod"' }], default: 'other' },
    { id: 'strict', type: 'transform', needs: ['pick'], case: 'pick.prod', output: { mode: '"strict"' } },
    { id: 'relaxed', type: 'transform', needs: ['pick'], case: 'pick.other', output: { mode: '"relaxed"' } },
  ],
  outputs: { mode: 'steps.strict.output.mode ? steps.strict.output.mode : steps.relaxed.output.mode' },
};

const workflow = {
  title: 'Deploy with recovery',
  trigger: { type: 'api', inputs: { properties: { env: { type: 'string' }, name: { type: 'string' } } } },
  vars: { slug: '{{ $lowercase(inputs.name) }}' },
  outputs: { mode: '{{ steps.policy.output.mode }}', slug: '{{ vars.slug }}' },
  steps: [
    { id: 'policy', type: 'fragment', fragment: 'route-env', with: { env: '{{ inputs.env }}' } },
    { id: 'deploy', type: 'invoke', invoker: { type: 'webhook', url: 'https://deploy.example.test/{{ vars.slug }}' } },
    { id: 'rollback', type: 'transform', needs: ['deploy'], when: 'failure', output: { rolledBack: 'true' } },
    { id: 'cleanup', type: 'transform', needs: ['deploy'], when: 'always', output: { done: 'true' } },
  ],
  tests: [
    {
      name: 'prod deploy succeeds',
      inputs: { env: 'prod', name: 'API' },
      mocks: { deploy: { status: 'SUCCESS', output: { ok: true } } },
      expect: {
        status: 'SUCCESS',
        steps: {
          policy__strict: { status: 'SUCCESS' },
          policy__relaxed: { status: 'SKIPPED' },
          rollback: { status: 'SKIPPED' },
          cleanup: { status: 'SUCCESS' },
        },
        outputs: { mode: 'strict', slug: 'api' },
      },
    },
    {
      name: 'a failed deploy is recovered by the rollback',
      inputs: { env: 'dev', name: 'Web' },
      mocks: { deploy: { status: 'FAILURE' } },
      expect: { status: 'SUCCESS', steps: { rollback: { status: 'SUCCESS' }, cleanup: { status: 'SUCCESS' } }, outputs: { mode: 'relaxed', slug: 'web' } },
    },
  ],
};

beforeAll(async () => {
  app = await testApp();
  admin = client(app, (await register(app, 'admin@example.com')).token);
  stops.push(startRunWorker(silentLog));
  await ok(admin.put('/api/v1/fragments/route-env', route));
  await ok(admin.put('/api/v1/actions/deploy-recover', workflow));
});
afterAll(async () => {
  for (const s of stops) await s();
  await app.close();
});

describe('features together', () => {
  it('runs a fragment containing a switch: the inlined case references pick the inlined branch', async () => {
    await ok(
      admin.put('/api/v1/actions/route-only', {
        title: 'Route only',
        trigger: { type: 'api', inputs: { properties: { env: { type: 'string' } } } },
        steps: [{ id: 'policy', type: 'fragment', fragment: 'route-env', with: { env: '{{ inputs.env }}' } }],
      }),
    );
    for (const [env, mode] of [
      ['prod', 'strict'],
      ['dev', 'relaxed'],
    ]) {
      const run = await ok(admin.post('/api/v1/actions/route-only/runs', { inputs: { env } }), 201);
      const r = await finished(run.id as string);
      expect(r.status).toBe('SUCCESS');
      expect(r.steps.find((s) => s.id === 'policy')!.output).toEqual({ mode });
      expect(r.steps.find((s) => s.id === (mode === 'strict' ? 'policy__relaxed' : 'policy__strict'))!.status).toBe('SKIPPED');
    }
  });

  it('workflow tests follow fragments, switch branches, when handlers, vars and run outputs', async () => {
    const report = await ok(admin.post('/api/v1/actions/deploy-recover/tests/run', {}));
    expect(report, JSON.stringify(report, null, 2)).toMatchObject({ passed: 2, failed: 0 });
  });

  it('workflow tests report an unhandled failure', async () => {
    const draft = {
      ...workflow,
      steps: workflow.steps.filter((s) => s.id !== 'rollback'),
      tests: [{ name: 'no rollback', inputs: { env: 'dev', name: 'x' }, mocks: { deploy: { status: 'FAILURE' } }, expect: { status: 'SUCCESS' } }],
    };
    const report = await ok(admin.post('/api/v1/actions/deploy-recover/tests/run', { definition: draft }));
    expect(report).toMatchObject({ passed: 0, failed: 1 });
    expect((report.results as { diffs: unknown[] }[])[0].diffs).toEqual([{ path: 'status', expected: 'SUCCESS', actual: 'FAILURE' }]);
  });
});
