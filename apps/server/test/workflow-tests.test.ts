import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { client, inDefaultOrg, register, testApp, type Api } from './helpers.js';
import { partialMatch } from '../src/actions/workflow-tests.js';
import { testActions } from '../src/cli/actions-test.js';

let app: FastifyInstance;
let admin: Api;
let alice: Api;

const workflow = {
  title: 'Provision',
  trigger: { type: 'form', on: 'create', inputs: { properties: { env: { type: 'string', enum: ['dev', 'prod'] } }, required: ['env'] } },
  steps: [
    { id: 'gate', type: 'approval', if: 'inputs.env = "prod"' },
    {
      id: 'deploy',
      type: 'invoke',
      invoker: { type: 'webhook', url: 'https://deploy.example.test/{{ inputs.env }}', headers: { Authorization: 'Bearer ${secret:DEPLOY}' } },
    },
    { id: 'notify', type: 'transform', output: { message: '"Deployed " & steps.deploy.output.url' } },
  ],
  tests: [
    {
      name: 'dev deploys without approval',
      inputs: { env: 'dev' },
      mocks: { deploy: { status: 'SUCCESS', output: { url: 'https://dev.example.test' } } },
      expect: {
        status: 'SUCCESS',
        steps: { gate: { status: 'SKIPPED' }, notify: { output: { message: 'Deployed https://dev.example.test' } } },
        outputs: { deploy: { url: 'https://dev.example.test' } },
      },
    },
    {
      name: 'a failed deploy fails the run and skips the notification',
      inputs: { env: 'prod' },
      mocks: { deploy: { status: 'FAILURE' } },
      expect: { status: 'FAILURE', steps: { gate: { status: 'SUCCESS' }, notify: { status: 'SKIPPED' } } },
    },
  ],
};

beforeAll(async () => {
  app = await testApp();
  admin = client(app, (await register(app, 'admin@example.com')).token);
  alice = client(app, (await register(app, 'alice@example.com')).token);
  const res = await admin.put('/api/v1/actions/provision', workflow);
  expect(res.status, JSON.stringify(res.data)).toBe(200);
});
afterAll(async () => {
  await app.close();
});

describe('workflow tests', () => {
  it('are stored with the action, for admins only', async () => {
    expect((await admin.get('/api/v1/actions/provision')).data.tests).toHaveLength(2);
    expect((await alice.get('/api/v1/actions/provision')).data.tests).toBeUndefined();
    const bad = await admin.put('/api/v1/actions/bad-tests', { ...workflow, tests: [{ name: 'x', mocks: { deploy: { status: 'MAYBE' } } }] });
    expect(bad.status).toBe(400);
  });

  it('run all saved tests and pass', async () => {
    const res = await admin.post('/api/v1/actions/provision/tests/run', {});
    expect(res.status, JSON.stringify(res.data)).toBe(200);
    expect(res.data.failed, JSON.stringify(res.data, null, 2)).toBe(0);
    expect(res.data.passed).toBe(2);
    const [dev] = res.data.results;
    expect(dev.steps.map((s: { status: string }) => s.status)).toEqual(['SKIPPED', 'SUCCESS', 'SUCCESS']);
    expect((await alice.post('/api/v1/actions/provision/tests/run', {})).status).toBe(403);
  });

  it('reports differences and errors of an unsaved draft, and runs one test by name', async () => {
    const draft = {
      ...workflow,
      tests: [
        {
          name: 'wrong expectation',
          inputs: { env: 'dev' },
          mocks: { deploy: { output: { url: 'u' } } },
          expect: { steps: { notify: { output: { message: 'nope' } } } },
        },
        { name: 'unmocked', inputs: { env: 'dev' } },
        { name: 'bad input', inputs: { env: 'qa' }, mocks: { deploy: {}, ghost: {} } },
      ],
    };
    const res = await admin.post('/api/v1/actions/provision/tests/run', { definition: draft });
    expect(res.status, JSON.stringify(res.data)).toBe(200);
    const [wrong, unmocked, badInput] = res.data.results;
    expect(wrong.passed).toBe(false);
    expect(wrong.diffs).toEqual([{ path: 'steps.notify.output.message', expected: 'nope', actual: 'Deployed u' }]);
    expect(unmocked.passed).toBe(false);
    expect(unmocked.errors[0]).toMatch(/Step "deploy" \(invoke\) calls the outside world/);
    expect(unmocked.status).toBe('FAILURE');
    expect(badInput.errors.join('\n')).toMatch(/inputs: env/);
    expect(badInput.errors.join('\n')).toMatch(/mocks.ghost: no step "ghost"/);

    const one = await admin.post('/api/v1/actions/provision/tests/run', { name: 'unmocked', definition: draft });
    expect(one.data.results).toHaveLength(1);
    expect((await admin.post('/api/v1/actions/provision/tests/run', { name: 'missing' })).status).toBe(404);
  });

  it('honours continueOnError and output schemas', async () => {
    const res = await admin.post('/api/v1/actions/provision/tests/run', {
      definition: {
        ...workflow,
        steps: [
          { id: 'deploy', type: 'invoke', continueOnError: true, invoker: { type: 'webhook', url: 'https://x.example.test' } },
          { id: 'shape', type: 'transform', output: { n: '"text"' }, outputSchema: { properties: { n: { type: 'number' } } } },
        ],
        tests: [
          {
            name: 't',
            inputs: { env: 'dev' },
            mocks: { deploy: { status: 'FAILURE' } },
            expect: { status: 'FAILURE', steps: { shape: { status: 'FAILURE' } } },
          },
        ],
      },
    });
    expect(res.data.results[0].passed, JSON.stringify(res.data.results[0])).toBe(true);
    expect(res.data.results[0].steps[1].error).toMatch(/output schema/);
  });

  it('partial matching compares the expected keys only', () => {
    const diffs: never[] = [];
    partialMatch({ a: 1, b: { c: [1, { d: 2 }] } }, { a: 1, x: 9, b: { c: [1, { d: 2, e: 3 }] } }, '', diffs);
    expect(diffs).toEqual([]);
    partialMatch({ a: [1] }, { a: [1, 2] }, 'o', diffs);
    expect(diffs).toHaveLength(1);
  });

  it('CLI: exits 1 when a test fails, 0 otherwise', async () => {
    const log = console.log;
    const lines: string[] = [];
    console.log = (...a: unknown[]) => void lines.push(a.join(' '));
    try {
      expect(await inDefaultOrg(() => testActions({ action: 'provision' }))).toBe(0);
      expect(lines.some((l) => l.startsWith('PASS provision'))).toBe(true);
      await admin.put('/api/v1/actions/provision', {
        ...workflow,
        tests: [{ name: 'fails', inputs: { env: 'dev' }, mocks: { deploy: {} }, expect: { status: 'FAILURE' } }],
      });
      expect(await testActions({})).toBe(1);
      expect(lines.some((l) => l.startsWith('FAIL provision › fails'))).toBe(true);
    } finally {
      console.log = log;
    }
  });
});
