import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { client, register, silentLog, testApp, waitFor, type Api } from './helpers.js';
import { startRunWorker } from '../src/actions/worker.js';
import { evaluate } from '../src/lib/expr.js';
import { scopedResolver } from '../src/actions/limits.js';

let app: FastifyInstance;
let admin: Api;
let alice: Api;
let stop: () => unknown;

const form = { type: 'api', inputs: { properties: {} } };
const outcome = (id: string) =>
  waitFor(async () => {
    const r = (await alice.get(`/api/v1/runs/${id}`)).data as { status: string; steps: { id: string; statusLabel: string | null; output: unknown }[] };
    return ['SUCCESS', 'FAILURE'].includes(r.status) && r;
  }, 20_000);
const run = async (id: string) => (await alice.post(`/api/v1/actions/${id}/runs`, {})).data.id as string;

beforeAll(async () => {
  app = await testApp();
  admin = client(app, (await register(app, 'admin@example.com')).token);
  alice = client(app, (await register(app, 'alice@example.com')).token);
  stop = startRunWorker(silentLog);
});
afterAll(async () => {
  await stop();
  await app.close();
});

describe('secret allow-list', () => {
  const step = (url: string) => ({ id: 'call', type: 'invoke', invoker: { type: 'webhook', url: 'https://example.test/x', headers: { Authorization: url } } });

  it('rejects references outside the list when saving', async () => {
    const res = await admin.put('/api/v1/actions/guarded', { title: 'g', trigger: form, secrets: ['DEPLOY_TOKEN'], steps: [step('Bearer ${secret:OTHER}')] });
    expect(res.status).toBe(400);
    expect(res.data.error).toMatch(/allow-list.*\$\{secret:OTHER\}/);
    expect(
      (await admin.put('/api/v1/actions/guarded', { title: 'g', trigger: form, secrets: ['DEPLOY_TOKEN'], steps: [step('Bearer ${secret:DEPLOY_TOKEN}')] }))
        .status,
    ).toBe(200);
    expect((await admin.put('/api/v1/actions/guarded', { title: 'g', trigger: form, secrets: ['DEPLOY_TOKEN'], steps: [step('${env:HOME}')] })).status).toBe(
      400,
    );
    expect((await admin.put('/api/v1/actions/guarded', { title: 'g', trigger: form, secrets: ['env:HOME'], steps: [step('${env:HOME}')] })).status).toBe(200);
  });

  it('stays unrestricted without a list, and is enforced when rendering', async () => {
    expect((await admin.put('/api/v1/actions/open', { title: 'o', trigger: form, steps: [step('Bearer ${secret:ANY}')] })).status).toBe(200);
    await expect(scopedResolver(['A'])('secret', 'B')).rejects.toThrow(/allow-list/);
    expect((await admin.get('/api/v1/actions/guarded')).data.secrets).toEqual(['env:HOME']);
  });
});

describe('step outputs', () => {
  it('fails a step whose output does not match its schema', async () => {
    const schema = { properties: { n: { type: 'integer' } }, required: ['n'] };
    await admin.put('/api/v1/actions/typed', {
      title: 't',
      trigger: form,
      steps: [{ id: 'calc', type: 'transform', output: { n: '"many"' }, outputSchema: schema }],
    });
    const r = await outcome(await run('typed'));
    expect(r.status).toBe('FAILURE');
    expect(r.steps[0].statusLabel).toMatch(/does not match the step output schema: n: must be integer/);
    await admin.put('/api/v1/actions/typed', {
      title: 't',
      trigger: form,
      steps: [{ id: 'calc', type: 'transform', output: { n: '3' }, outputSchema: schema }],
    });
    expect((await outcome(await run('typed'))).status).toBe('SUCCESS');
  });

  it('fails a step whose output is too large', async () => {
    await admin.put('/api/v1/actions/huge', {
      title: 'h',
      trigger: form,
      steps: [{ id: 'big', type: 'transform', output: { blob: '$join($map([1..800], function($v){"abcdefghij"}))' } }],
    });
    const r = await outcome(await run('huge'));
    expect(r.status).toBe('FAILURE');
    expect(r.steps[0].statusLabel).toMatch(/Output too large: \d+ bytes \(limit 4096\)/);
  });
});

describe('expression limits', () => {
  const loop = '($loop := function($n){ $loop($n + 1) }; $loop(0))';

  it('stops a runaway expression with a clear message', async () => {
    const t0 = Date.now();
    await expect(evaluate(loop, {})).rejects.toThrow(/took longer than 300 ms and was stopped/);
    expect(Date.now() - t0).toBeLessThan(5000);
    await expect(evaluate('($f := function($n){ 1 + $f($n + 1) }; $f(0))', {})).rejects.toThrow(/nested more than \d+ levels|took longer/);
  });

  it('fails the step, not the worker', async () => {
    await admin.put('/api/v1/actions/runaway', { title: 'r', trigger: form, steps: [{ id: 'spin', type: 'transform', output: { x: loop } }] });
    const r = await outcome(await run('runaway'));
    expect(r.status).toBe('FAILURE');
    expect(r.steps[0].statusLabel).toMatch(/took longer than 300 ms/);
    await admin.put('/api/v1/actions/after', { title: 'a', trigger: form, steps: [{ id: 'ok', type: 'transform', output: { x: '1' } }] });
    expect((await outcome(await run('after'))).status).toBe('SUCCESS'); // the worker is still alive
  });
});
