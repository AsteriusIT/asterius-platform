import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { client, fakeServer, register, silentLog, testApp, waitFor, type Api } from './helpers.js';
import { startRunWorker } from '../src/actions/worker.js';
import { resumableSteps } from '../src/actions/steps.js';
import type { Step } from '../src/actions/workflow.js';

/** Workflow control flow: when, onTimeout, switch / case, inline forEach, run-level vars and outputs. */

let app: FastifyInstance;
let admin: Api;
let alice: Api;
let ext: Awaited<ReturnType<typeof fakeServer>>;
let stop: () => unknown;

type StepView = { id: string; status: string; output: unknown; statusLabel: string | null; continueOnError: boolean; handled?: boolean };
type RunView = { id: string; status: string; statusLabel: string | null; result: Record<string, unknown> | null; steps: StepView[] };
const get = async (api: Api, id: string) => (await api.get(`/api/v1/runs/${id}`)).data as RunView;
const finished = (api: Api, id: string) =>
  waitFor(async () => {
    const r = await get(api, id);
    return ['SUCCESS', 'FAILURE', 'CANCELLED'].includes(r.status) && r;
  }, 40_000);
const stepOf = (r: RunView, id: string) => r.steps.find((s) => s.id === id)!;
const statuses = (r: RunView) => Object.fromEntries(r.steps.map((s) => [s.id, s.status]));
const stepStatus = (api: Api, id: string, step: string, status: string) =>
  waitFor(async () => {
    const r = await get(api, id);
    return stepOf(r, step)?.status === status && r;
  }, 20_000);
const form = (properties: object = {}) => ({ type: 'form', on: 'create', inputs: { properties } });
const save = async (id: string, body: object) => {
  const res = await admin.put(`/api/v1/actions/${id}`, { title: id, ...body });
  expect(res.status, JSON.stringify(res.data)).toBe(200);
};
const saveError = async (body: object) => {
  const res = await admin.put('/api/v1/actions/invalid', { title: 'invalid', trigger: form(), ...body });
  expect(res.status).toBe(400);
  return String(res.data.error);
};
const start = async (api: Api, id: string, inputs: object = {}) => {
  const res = await api.post(`/api/v1/actions/${id}/runs`, { inputs });
  expect(res.status, JSON.stringify(res.data)).toBe(201);
  return res.data.id as string;
};
const hook = (path: string, extra: object = {}) => ({ type: 'webhook', url: `${ext.url}/${path}`, ...extra });
const expire = async (runId: string, stepId: string) => {
  const { run } = await import('../src/db.js');
  await run("UPDATE run_steps SET deadline_at = '2020-01-01T00:00:00.000Z' WHERE run_id = ? AND step_id = ?", runId, stepId);
  const { stepHousekeeping } = await import('../src/actions/engine.js');
  // Housekeeping runs under a database-wide advisory lock: when another test file holds it (Postgres), try again.
  await waitFor(async () => {
    await stepHousekeeping(silentLog);
    const s = stepOf(await get(alice, runId), stepId);
    return ['SKIPPED', 'FAILURE'].includes(s.status);
  });
};

beforeAll(async () => {
  app = await testApp();
  admin = client(app, (await register(app, 'admin@example.com')).token);
  alice = client(app, (await register(app, 'alice@example.com')).token);
  ext = await fakeServer((r) => {
    if (r.url.includes('bad')) return { status: 500, body: { error: 'boom' } };
    const body = r.body ? (JSON.parse(r.body) as { item?: unknown }) : {};
    if (r.url.includes('fail-item') && body.item === 'b') return { status: 500, body: { error: 'item b' } };
    return { body: { ok: true, item: body.item ?? null } };
  });
  stop = startRunWorker(silentLog);
});
afterAll(async () => {
  await stop();
  await ext.close();
  await app.close();
});

describe('validation', () => {
  it('rejects inconsistent control flow', async () => {
    expect(await saveError({ steps: [{ id: 'a', type: 'transform', output: {}, case: 'route.x' }] })).toMatch(/not an earlier switch step/);
    expect(
      await saveError({
        steps: [
          { id: 'route', type: 'switch', cases: [{ id: 'x', when: 'true' }] },
          { id: 'a', type: 'transform', output: {}, case: 'route.y' },
        ],
      }),
    ).toMatch(/has no case "y"/);
    expect(
      await saveError({
        steps: [
          { id: 'route', type: 'switch', cases: [{ id: 'x', when: 'true' }] },
          { id: 'a', type: 'transform', output: {}, needs: [], case: 'route.x' },
        ],
      }),
    ).toMatch(/must run after "route"/);
    expect(
      await saveError({
        steps: [
          {
            id: 'route',
            type: 'switch',
            cases: [
              { id: 'x', when: 'true' },
              { id: 'x', when: 'false' },
            ],
          },
        ],
      }),
    ).toMatch(/used twice/);
    expect(await saveError({ steps: [{ id: 'a', type: 'transform', output: {}, when: 'failure' }] })).toMatch(/needs at least one dependency/);
    expect(await saveError({ steps: [{ id: 'a', type: 'transform', output: {}, retries: 2, forEach: { items: '[1,2]' } }] })).toMatch(
      /retries cannot be combined with forEach/,
    );
    expect(await saveError({ vars: { token: '${secret:X}' }, steps: [{ id: 'a', type: 'transform', output: {} }] })).toMatch(/vars cannot reference secrets/);
    expect(await saveError({ steps: [{ id: 'a', type: 'transform', output: {}, onTimeout: 'later' }] })).toMatch(/onTimeout|Invalid/i);
  });
});

describe('when', () => {
  it('runs a failure handler that recovers the run, skips success steps and runs cleanups', async () => {
    await save('recover', {
      trigger: form(),
      steps: [
        { id: 'deploy', type: 'invoke', invoker: hook('bad') },
        { id: 'verify', type: 'transform', output: { ok: 'true' } },
        { id: 'rollback', type: 'transform', needs: ['verify'], when: 'failure', output: { rolledBack: 'true' } },
        { id: 'cleanup', type: 'transform', needs: ['deploy'], when: 'always', output: { cleaned: 'true' } },
      ],
    });
    const r = await finished(alice, await start(alice, 'recover'));
    expect(statuses(r)).toEqual({ deploy: 'FAILURE', verify: 'SKIPPED', rollback: 'SUCCESS', cleanup: 'SUCCESS' });
    expect(r.status).toBe('SUCCESS');
    expect(r.statusLabel).toMatch(/Recovered: deploy/);
    expect(stepOf(r, 'deploy').handled).toBe(true);
  });

  it('skips failure handlers when nothing failed and still fails runs whose failure is not handled', async () => {
    await save('nohandler', {
      trigger: form(),
      steps: [
        { id: 'ok', type: 'transform', output: { v: '1' } },
        { id: 'onfail', type: 'transform', when: 'failure', output: { v: '2' } },
        { id: 'after', type: 'transform', output: { v: '3' } },
      ],
    });
    let r = await finished(alice, await start(alice, 'nohandler'));
    expect(statuses(r)).toEqual({ ok: 'SUCCESS', onfail: 'SKIPPED', after: 'SUCCESS' });
    expect(stepOf(r, 'onfail').statusLabel).toMatch(/no dependency failed/);

    await save('cleanuponly', {
      trigger: form(),
      steps: [
        { id: 'deploy', type: 'invoke', invoker: hook('bad') },
        { id: 'cleanup', type: 'transform', when: 'always', output: { v: '1' } },
        { id: 'handler', type: 'invoke', needs: ['deploy'], when: 'failure', invoker: hook('bad') },
      ],
    });
    r = await finished(alice, await start(alice, 'cleanuponly'));
    expect(statuses(r)).toEqual({ deploy: 'FAILURE', cleanup: 'SUCCESS', handler: 'FAILURE' });
    expect(r.status).toBe('FAILURE');
  });

  it('treats a continueOnError failure as a failure for handlers', async () => {
    await save('besteffort', {
      trigger: form(),
      steps: [
        { id: 'notify', type: 'invoke', continueOnError: true, invoker: hook('bad') },
        { id: 'fallback', type: 'transform', when: 'failure', output: { v: '1' } },
      ],
    });
    const r = await finished(alice, await start(alice, 'besteffort'));
    expect(statuses(r)).toEqual({ notify: 'FAILURE', fallback: 'SUCCESS' });
    expect(r.status).toBe('SUCCESS');
  });

  it('resumes failed steps with what ran downstream of them', () => {
    const defs = [
      { id: 'a', type: 'transform', output: {} },
      { id: 'b', type: 'transform', output: {} },
      { id: 'clean', type: 'transform', output: {}, when: 'always' },
      { id: 'other', type: 'transform', output: {}, needs: [] },
      { id: 'h', type: 'transform', output: {}, needs: ['other'], when: 'failure' },
    ] as unknown as Step[];
    const rows = [
      { step_id: 'a', status: 'FAILURE' as const, state: null },
      { step_id: 'b', status: 'SKIPPED' as const, state: '{"blocked":true}' },
      { step_id: 'clean', status: 'SUCCESS' as const, state: null },
      { step_id: 'other', status: 'FAILURE' as const, state: null },
      { step_id: 'h', status: 'SUCCESS' as const, state: null },
    ];
    // `other` was handled by h: it stays as it is.
    expect(resumableSteps(defs, rows)).toEqual(['a', 'b', 'clean']);
  });
});

describe('switch', () => {
  it('runs the matching branch, skips the others and joins', async () => {
    await save('route', {
      trigger: form({ size: { type: 'number' } }),
      steps: [
        {
          id: 'route',
          type: 'switch',
          cases: [
            { id: 'small', when: 'inputs.size < 10' },
            { id: 'large', when: 'inputs.size >= 100' },
          ],
          default: 'medium',
        },
        { id: 's1', type: 'transform', needs: ['route'], case: 'route.small', output: { v: '"s"' } },
        { id: 's2', type: 'transform', needs: ['s1'], case: 'route.small', output: { v: '"s2"' } },
        { id: 'l1', type: 'transform', needs: ['route'], case: 'route.large', output: { v: '"l"' } },
        { id: 'm1', type: 'transform', needs: ['route'], case: ['route.medium', 'route.large'], output: { v: '"m"' } },
        { id: 'join', type: 'transform', needs: ['s2', 'l1', 'm1'], output: { picked: 'steps.route.output.case' } },
      ],
    });
    let r = await finished(alice, await start(alice, 'route', { size: 5 }));
    expect(statuses(r)).toEqual({ route: 'SUCCESS', s1: 'SUCCESS', s2: 'SUCCESS', l1: 'SKIPPED', m1: 'SKIPPED', join: 'SUCCESS' });
    expect(stepOf(r, 'l1').statusLabel).toMatch(/Branch not taken \(route: small\)/);
    expect(stepOf(r, 'join').output).toEqual({ picked: 'small' });
    expect(r.status).toBe('SUCCESS');

    r = await finished(alice, await start(alice, 'route', { size: 50 }));
    expect(statuses(r)).toMatchObject({ s1: 'SKIPPED', s2: 'SKIPPED', l1: 'SKIPPED', m1: 'SUCCESS', join: 'SUCCESS' });
    expect(stepOf(r, 'route').output).toEqual({ case: 'medium' });

    r = await finished(alice, await start(alice, 'route', { size: 500 }));
    expect(statuses(r)).toMatchObject({ s1: 'SKIPPED', l1: 'SUCCESS', m1: 'SUCCESS' });
  });

  it('takes no branch without a match or default, and fails on an expression error', async () => {
    await save('route2', {
      trigger: form(),
      steps: [
        { id: 'route', type: 'switch', cases: [{ id: 'never', when: 'false' }] },
        { id: 'x', type: 'transform', case: 'route.never', output: { v: '1' } },
      ],
    });
    let r = await finished(alice, await start(alice, 'route2'));
    expect(stepOf(r, 'route').output).toEqual({ case: null });
    expect(statuses(r)).toEqual({ route: 'SUCCESS', x: 'SKIPPED' });

    await save('route3', { trigger: form(), steps: [{ id: 'route', type: 'switch', cases: [{ id: 'x', when: '$error("nope")' }] }] });
    r = await finished(alice, await start(alice, 'route3'));
    expect(r.status).toBe('FAILURE');
    expect(stepOf(r, 'route').statusLabel).toMatch(/Case error/);
  });
});

describe('inline forEach', () => {
  it('loops a transform over items', async () => {
    await save('loop-t', {
      trigger: form(),
      steps: [{ id: 'sq', type: 'transform', forEach: { items: '[1, 2, 3]' }, output: { square: 'item * item', at: 'index' } }],
    });
    const r = await finished(alice, await start(alice, 'loop-t'));
    expect(stepOf(r, 'sq').output).toEqual({
      results: [
        { item: 1, status: 'SUCCESS', output: { square: 1, at: 0 } },
        { item: 2, status: 'SUCCESS', output: { square: 4, at: 1 } },
        { item: 3, status: 'SUCCESS', output: { square: 9, at: 2 } },
      ],
      succeeded: 3,
      failed: 0,
    });
  });

  it('stops at the first failure with failFast', async () => {
    await save('loop-ff', {
      trigger: form(),
      steps: [
        {
          id: 't',
          type: 'transform',
          continueOnError: true,
          forEach: { items: '[1, 0, 2]', failFast: true },
          output: { v: 'item = 0 ? $error("zero") : item' },
        },
      ],
    });
    const r = await finished(alice, await start(alice, 'loop-ff'));
    const out = stepOf(r, 't').output as { results: { status: string; error?: string }[]; failed: number };
    expect(out.results.map((x) => x.status)).toEqual(['SUCCESS', 'FAILURE', 'SKIPPED']);
    expect(out.results[1].error).toMatch(/zero/);
    expect(stepOf(r, 't').status).toBe('FAILURE');
    expect(r.status).toBe('SUCCESS'); // continueOnError
  });

  it('calls a synchronous invoker once per item with its own idempotency key', async () => {
    const before = ext.received.length;
    await save('loop-i', {
      trigger: form(),
      steps: [{ id: 'call', type: 'invoke', forEach: { items: '["a", "b", "c"]' }, invoker: hook('fail-item', { body: { item: '{{ item }}' } }) }],
    });
    const r = await finished(alice, await start(alice, 'loop-i'));
    const calls = ext.received.slice(before).filter((x) => x.url.includes('fail-item'));
    expect(calls.map((c) => JSON.parse(c.body).item)).toEqual(['a', 'b', 'c']);
    expect(new Set(calls.map((c) => c.headers['idempotency-key'])).size).toBe(3);
    expect(calls[1].headers['idempotency-key']).toBe(`${r.id}/call/1`);
    const out = stepOf(r, 'call').output as { results: { item: string; status: string; output: unknown }[]; succeeded: number; failed: number };
    expect(out.results.map((x) => [x.item, x.status])).toEqual([
      ['a', 'SUCCESS'],
      ['b', 'FAILURE'],
      ['c', 'SUCCESS'],
    ]);
    expect(out.results[0].output).toEqual({ ok: true, item: 'a' });
    expect(r.status).toBe('FAILURE');
  });

  it('waits for the callback of each item of an asynchronous invoker, one at a time', async () => {
    const before = ext.received.length;
    await save('loop-async', {
      trigger: form(),
      steps: [
        { id: 'job', type: 'invoke', forEach: { items: '["x", "y"]' }, invoker: hook('async-job', { mode: 'async', body: { item: '{{ item }}' } }) },
        { id: 'after', type: 'transform', output: { n: '$count(steps.job.output.results)' } },
      ],
    });
    const id = await start(alice, 'loop-async');
    const sent = () => ext.received.slice(before).filter((x) => x.url.includes('async-job'));
    await waitFor(async () => sent().length === 1);
    await stepStatus(alice, id, 'job', 'RUNNING');
    expect(sent().length).toBe(1); // the second item waits for the first
    const done = async (result: unknown) =>
      waitFor(async () => (await admin.patch(`/api/v1/runs/${id}/steps/job`, { status: 'SUCCESS', result })).status === 200);
    await done({ n: 1 });
    await waitFor(async () => sent().length === 2);
    expect(JSON.parse(sent()[1].body).item).toBe('y');
    await done({ n: 2 });
    const r = await finished(alice, id);
    expect(r.status).toBe('SUCCESS');
    expect((stepOf(r, 'job').output as { results: unknown[] }).results).toEqual([
      { item: 'x', status: 'SUCCESS', output: { n: 1 } },
      { item: 'y', status: 'SUCCESS', output: { n: 2 } },
    ]);
    expect(stepOf(r, 'after').output).toEqual({ n: 2 });
  });
});

describe('onTimeout', () => {
  it('skips a timed out step and the workflow continues', async () => {
    await save('to-skip', {
      trigger: form(),
      steps: [
        { id: 'w', type: 'wait', event: { name: 'never' }, onTimeout: 'skip' },
        { id: 'after', type: 'transform', output: { v: '1' } },
      ],
    });
    const id = await start(alice, 'to-skip');
    await stepStatus(alice, id, 'w', 'WAITING');
    await expire(id, 'w');
    const r = await finished(alice, id);
    expect(statuses(r)).toEqual({ w: 'SKIPPED', after: 'SUCCESS' });
    expect(stepOf(r, 'w').statusLabel).toMatch(/Timed out: skipped/);
    expect(r.status).toBe('SUCCESS');
  });

  it('continues after a timed out step like continueOnError', async () => {
    await save('to-continue', {
      trigger: form(),
      steps: [
        { id: 'ok', type: 'approval', onTimeout: 'continue' },
        { id: 'after', type: 'transform', output: { v: 'steps.ok.status' } },
      ],
    });
    const id = await start(alice, 'to-continue');
    await stepStatus(alice, id, 'ok', 'WAITING_APPROVAL');
    await expire(id, 'ok');
    const r = await finished(alice, id);
    expect(statuses(r)).toEqual({ ok: 'FAILURE', after: 'SUCCESS' });
    expect(stepOf(r, 'ok').continueOnError).toBe(true);
    expect(stepOf(r, 'ok').statusLabel).toMatch(/Approval expired: continuing/);
    expect(r.status).toBe('SUCCESS');
  });

  it('fails by default', async () => {
    await save('to-fail', { trigger: form(), steps: [{ id: 'w', type: 'wait', event: { name: 'never' } }] });
    const id = await start(alice, 'to-fail');
    await stepStatus(alice, id, 'w', 'WAITING');
    await expire(id, 'w');
    expect((await finished(alice, id)).status).toBe('FAILURE');
  });
});

describe('vars and outputs', () => {
  it('evaluates vars at start and outputs at the end; parents see the outputs', async () => {
    await save('child-out', {
      trigger: form({ name: { type: 'string' } }),
      vars: { slug: '{{ $lowercase(inputs.name) }}', who: '{{ trigger.user.email }}' },
      outputs: { url: 'https://{{ steps.make.output.host }}/{{ vars.slug }}', count: '{{ $count(steps.*) }}' },
      steps: [
        { id: 'route', type: 'switch', cases: [{ id: 'yes', when: 'vars.slug = "demo"' }] },
        { id: 'make', type: 'transform', case: 'route.yes', output: { host: '"example.com"', by: 'vars.who' } },
      ],
    });
    const child = await finished(alice, await start(alice, 'child-out', { name: 'DEMO' }));
    expect(child.status).toBe('SUCCESS');
    expect(child.result).toEqual({ url: 'https://example.com/demo', count: 2 });
    expect(stepOf(child, 'make').output).toEqual({ host: 'example.com', by: 'alice@example.com' });

    await save('parent-out', {
      trigger: form(),
      steps: [
        { id: 'sub', type: 'workflow', action: 'child-out', inputs: { name: 'Demo' } },
        { id: 'use', type: 'transform', output: { url: 'steps.sub.output.result.url' } },
      ],
    });
    const parent = await finished(alice, await start(alice, 'parent-out'));
    expect(stepOf(parent, 'use').output).toEqual({ url: 'https://example.com/demo' });
    // Without outputs, the result stays the outputs by step id.
    expect(parent.result).toMatchObject({ use: { url: 'https://example.com/demo' } });
  });

  it('fails the run when vars cannot be evaluated', async () => {
    await save('bad-vars', { trigger: form(), vars: { x: '{{ $error("no") }}' }, steps: [{ id: 'a', type: 'transform', output: {} }] });
    const r = await finished(alice, await start(alice, 'bad-vars'));
    expect(r.status).toBe('FAILURE');
    expect(r.statusLabel).toMatch(/Variables could not be evaluated/);
  });

  it('exposes vars and outputs to admins only', async () => {
    expect((await admin.get('/api/v1/actions/child-out')).data.vars).toBeDefined();
    expect((await alice.get('/api/v1/actions/child-out')).data.vars).toBeUndefined();
  });
});

describe('dry run', () => {
  it('plans branches, loops, vars and outputs', async () => {
    const res = await admin.post('/api/v1/actions/dry/dry-run', {
      definition: {
        title: 'dry',
        trigger: form({ n: { type: 'number' } }),
        vars: { double: '{{ inputs.n * 2 }}' },
        outputs: { total: '{{ $sum(steps.loop.output.results.output.v) }}' },
        steps: [
          { id: 'route', type: 'switch', cases: [{ id: 'big', when: 'vars.double > 5' }], default: 'small' },
          { id: 'big', type: 'transform', case: 'route.big', output: { v: '1' } },
          { id: 'loop', type: 'transform', needs: ['route'], forEach: { items: '[1, 2]' }, output: { v: 'item + vars.double' } },
          { id: 'handler', type: 'transform', when: 'failure', output: {} },
        ],
      },
      inputs: { n: 1 },
    });
    expect(res.status, JSON.stringify(res.data)).toBe(200);
    const byId = Object.fromEntries((res.data.steps as { id: string; status: string; output?: unknown }[]).map((s) => [s.id, s]));
    expect(res.data.vars).toEqual({ double: 2 });
    expect(byId.route.output).toEqual({ case: 'small' });
    expect(byId.big.status).toBe('skipped');
    expect(byId.handler.status).toBe('skipped');
    expect(byId.loop.output).toMatchObject({ succeeded: 2 });
    expect(res.data.outputs).toEqual({ total: 7 });
  });
});
