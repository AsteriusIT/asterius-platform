import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { client, fakeServer, register, silentLog, testApp, waitFor, type Api } from './helpers.js';
import { startRunWorker } from '../src/actions/worker.js';

let app: FastifyInstance;
let admin: Api;
let alice: Api;
let carol: Api;
let ext: Awaited<ReturnType<typeof fakeServer>>;
let stop: () => unknown;

type RunView = {
  id: string;
  status: string;
  parent?: { runId: string } | null;
  result: Record<string, unknown> | null;
  steps: {
    id: string;
    status: string;
    output: unknown;
    statusLabel: string | null;
    canSubmit?: boolean;
    canApprove?: boolean;
    children?: { runId: string; status: string }[];
  }[];
};
const get = async (api: Api, id: string) => (await api.get(`/api/v1/runs/${id}`)).data as RunView;
const finished = (api: Api, id: string) =>
  waitFor(async () => {
    const r = await get(api, id);
    return ['SUCCESS', 'FAILURE', 'CANCELLED'].includes(r.status) && r;
  }, 40_000);
const stepOf = (r: RunView, id: string) => r.steps.find((s) => s.id === id)!;
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
const start = async (api: Api, id: string, inputs: object = {}) => {
  const res = await api.post(`/api/v1/actions/${id}/runs`, { inputs });
  expect(res.status, JSON.stringify(res.data)).toBe(201);
  return res.data.id as string;
};

beforeAll(async () => {
  app = await testApp();
  admin = client(app, (await register(app, 'admin@example.com')).token);
  alice = client(app, (await register(app, 'alice@example.com')).token);
  carol = client(app, (await register(app, 'carol@example.com')).token);
  ext = await fakeServer((r) => (r.url.includes('bad') ? { status: 500, body: { error: 'boom' } } : { body: { ok: true } }));
  stop = startRunWorker(silentLog);
});
afterAll(async () => {
  await stop();
  await ext.close();
  await app.close();
});

describe('wait step', () => {
  it('rejects ambiguous definitions', async () => {
    const res = await admin.put('/api/v1/actions/w', { title: 'w', trigger: form(), steps: [{ id: 'w', type: 'wait', duration: '1s', until: '{{ now }}' }] });
    expect(res.data.error).toMatch(/exactly one of duration, until or event/);
    expect((await admin.put('/api/v1/actions/w', { title: 'w', trigger: form(), steps: [{ id: 'w', type: 'wait', duration: 'soon' }] })).status).toBe(400);
  });

  it('sleeps for a duration, then continues', async () => {
    await save('sleepy', {
      trigger: form(),
      steps: [
        { id: 'nap', type: 'wait', duration: '2s' },
        { id: 'after', type: 'transform', output: { ok: 'true' } },
      ],
    });
    const t0 = Date.now();
    const id = await start(alice, 'sleepy');
    expect((await stepStatus(alice, id, 'nap', 'WAITING')).status).toBe('IN_PROGRESS');
    const r = await finished(alice, id);
    expect(r.status).toBe('SUCCESS');
    expect(Date.now() - t0).toBeGreaterThanOrEqual(1900);
  });

  it('waits for an external event and matches its filter', async () => {
    await save('gate', {
      trigger: form(),
      steps: [
        { id: 'w', type: 'wait', event: { name: 'deployed', filter: 'event.env = "prod"' } },
        { id: 'after', type: 'transform', output: { who: 'steps.w.output.payload.by' } },
      ],
    });
    const id = await start(alice, 'gate');
    await stepStatus(alice, id, 'w', 'WAITING');
    const url = `/api/v1/runs/${id}/steps/w/events`;
    expect((await client(app).post(url, { name: 'deployed' })).status).toBe(403); // no token
    expect((await alice.post(url, { name: 'deployed' })).status).toBe(403); // not an admin
    expect((await admin.post(url, { name: 'other' })).data).toEqual({ delivered: false });
    expect((await admin.post(url, { name: 'deployed', payload: { env: 'dev' } })).data).toEqual({ delivered: false });
    expect((await admin.post(url, { name: 'deployed', payload: { env: 'prod', by: 'ci' } })).data).toEqual({ delivered: true });
    const r = await finished(alice, id);
    expect(stepOf(r, 'after').output).toEqual({ who: 'ci' });
    expect((await admin.post(url, { name: 'deployed' })).status).toBe(409); // no longer waiting
  });

  it('times out an event wait', async () => {
    await save('lonely', { trigger: form(), steps: [{ id: 'w', type: 'wait', event: { name: 'never' }, timeoutMinutes: 1 }] });
    const id = await start(alice, 'lonely');
    await stepStatus(alice, id, 'w', 'WAITING');
    const { run } = await import('../src/db.js');
    await run("UPDATE run_steps SET deadline_at = '2020-01-01T00:00:00.000Z' WHERE run_id = ?", id);
    const { stepHousekeeping } = await import('../src/actions/engine.js');
    await stepHousekeeping(silentLog);
    const r = await finished(alice, id);
    expect(stepOf(r, 'w').statusLabel).toBe('Timed out');
  });
});

describe('input step and approval fields', () => {
  it('asks the requester for data mid-run', async () => {
    await save('ask', {
      trigger: form(),
      steps: [
        {
          id: 'pick',
          type: 'input',
          message: 'Which cluster?',
          inputs: { properties: { cluster: { type: 'string', enum: ['eu', 'us'] } }, required: ['cluster'] },
        },
        { id: 'use', type: 'transform', output: { c: 'steps.pick.output.cluster' } },
      ],
    });
    const id = await start(alice, 'ask');
    const waiting = await stepStatus(alice, id, 'pick', 'WAITING');
    expect(stepOf(waiting, 'pick').canSubmit).toBe(true);
    expect((await carol.get(`/api/v1/runs/${id}`)).data.steps[0].canSubmit).toBe(false);
    expect(((await alice.get('/api/v1/approvals')).data as { pendingStep?: { kind: string } }[]).some((a) => a.pendingStep?.kind === 'input')).toBe(true);
    const url = `/api/v1/runs/${id}/steps/pick/input`;
    expect((await carol.post(url, { values: { cluster: 'eu' } })).status).toBe(403);
    expect((await alice.post(url, { values: { cluster: 'asia' } })).status).toBe(400);
    expect((await alice.post(url, { values: {} })).status).toBe(400);
    expect((await alice.post(url, { values: { cluster: 'eu' } })).status).toBe(200);
    const r = await finished(alice, id);
    expect(stepOf(r, 'use').output).toEqual({ c: 'eu' });
    expect((await alice.post(url, { values: { cluster: 'us' } })).status).toBe(409);
  });

  it('approvals can offer choices and collect fields', async () => {
    await save('choose', {
      trigger: form(),
      steps: [
        {
          id: 'ok',
          type: 'approval',
          choices: ['eu', 'us'],
          fields: { properties: { ticket: { type: 'string' } }, required: ['ticket'] },
        },
        { id: 'use', type: 'transform', output: { c: 'steps.ok.output.choice', t: 'steps.ok.output.values.ticket' } },
      ],
    });
    const id = await start(alice, 'choose');
    await stepStatus(carol, id, 'ok', 'WAITING_APPROVAL');
    const url = `/api/v1/runs/${id}/steps/ok/approve`;
    expect((await admin.post(url, {})).status).toBe(400); // choice required
    expect((await admin.post(url, { choice: 'eu' })).status).toBe(400); // field required
    expect((await admin.post(url, { choice: 'eu', values: { ticket: 'OPS-1' } })).status).toBe(200);
    const r = await finished(alice, id);
    expect(stepOf(r, 'use').output).toEqual({ c: 'eu', t: 'OPS-1' });
  });
});

describe('sub-workflows and fan-out', () => {
  beforeAll(async () => {
    await save('child', {
      trigger: form({ name: { type: 'string' } }),
      steps: [{ id: 'echo', type: 'transform', output: { hello: '"hi " & inputs.name' } }],
    });
    await save('flaky-child', {
      trigger: form({ name: { type: 'string' } }),
      steps: [{ id: 'call', type: 'invoke', invoker: { type: 'webhook', url: `${ext.url}/{{ inputs.name }}`, mode: 'sync' } }],
    });
  });

  it('calls another action and exposes its result', async () => {
    await save('parent', {
      trigger: form({ who: { type: 'string' } }),
      steps: [
        { id: 'sub', type: 'workflow', action: 'child', inputs: { name: '{{ inputs.who }}' } },
        { id: 'use', type: 'transform', output: { greeting: 'steps.sub.output.result.echo.hello' } },
      ],
    });
    const id = await start(alice, 'parent', { who: 'bob' });
    const r = await finished(alice, id);
    expect(r.status, JSON.stringify(r)).toBe('SUCCESS');
    expect(stepOf(r, 'use').output).toEqual({ greeting: 'hi bob' });
    const childId = stepOf(r, 'sub').children![0].runId;
    const child = await get(alice, childId);
    expect(child.parent).toMatchObject({ runId: id });
    expect(child.status).toBe('SUCCESS');
  });

  it('refuses a workflow calling itself and fails on a missing child', async () => {
    const self = await admin.put('/api/v1/actions/loop', { title: 'loop', trigger: form(), steps: [{ id: 's', type: 'workflow', action: 'loop' }] });
    expect(self.data.error).toMatch(/cannot call itself/);
    await save('orphan', { trigger: form(), steps: [{ id: 's', type: 'workflow', action: 'nope' }] });
    const r = await finished(alice, await start(alice, 'orphan'));
    expect(r.status).toBe('FAILURE');
    expect(stepOf(r, 's').statusLabel).toMatch(/not found/);
  });

  it('runs a child per item and aggregates the results', async () => {
    await save('fan', {
      trigger: form({ names: { type: 'array', items: { type: 'string' } } }),
      steps: [{ id: 'each', type: 'workflow', action: 'child', inputs: { name: '{{ item }}' }, forEach: { items: 'inputs.names', maxConcurrency: 2 } }],
    });
    const r = await finished(alice, await start(alice, 'fan', { names: ['a', 'b', 'c'] }));
    expect(r.status, JSON.stringify(r)).toBe('SUCCESS');
    const out = stepOf(r, 'each').output as { succeeded: number; results: { item: string; status: string; result: { echo: { hello: string } } }[] };
    expect(out.succeeded).toBe(3);
    expect(out.results.map((x) => [x.item, x.status, x.result.echo.hello])).toEqual([
      ['a', 'SUCCESS', 'hi a'],
      ['b', 'SUCCESS', 'hi b'],
      ['c', 'SUCCESS', 'hi c'],
    ]);
  });

  it('collects failures, or stops at the first one with failFast', async () => {
    const names = ['good', 'bad', 'fine'];
    await save('fan-collect', {
      trigger: form({ names: { type: 'array', items: { type: 'string' } } }),
      steps: [{ id: 'each', type: 'workflow', action: 'flaky-child', inputs: { name: '{{ item }}' }, forEach: { items: 'inputs.names', maxConcurrency: 3 } }],
    });
    const r = await finished(alice, await start(alice, 'fan-collect', { names }));
    expect(r.status).toBe('FAILURE');
    expect(stepOf(r, 'each').output).toMatchObject({ succeeded: 2, failed: 1 });

    await save('fan-fast', {
      trigger: form({ names: { type: 'array', items: { type: 'string' } } }),
      steps: [
        {
          id: 'each',
          type: 'workflow',
          action: 'flaky-child',
          inputs: { name: '{{ item }}' },
          forEach: { items: 'inputs.names', maxConcurrency: 1, failFast: true },
        },
      ],
    });
    const f = await finished(alice, await start(alice, 'fan-fast', { names: ['bad', 'good', 'fine'] }));
    expect(f.status).toBe('FAILURE');
    const res = (stepOf(f, 'each').output as { results: { status: string }[] }).results;
    expect(res[0].status).toBe('FAILURE');
    expect(res.slice(1).every((x) => x.status === 'CANCELLED')).toBe(true); // never started
  });

  it('cancelling the parent cancels the child', async () => {
    await save('stuck-child', { trigger: form(), steps: [{ id: 'w', type: 'wait', event: { name: 'never' } }] });
    await save('stuck-parent', { trigger: form(), steps: [{ id: 'sub', type: 'workflow', action: 'stuck-child' }] });
    const id = await start(alice, 'stuck-parent');
    const waiting = await waitFor(async () => {
      const r = await get(alice, id);
      return !!stepOf(r, 'sub')?.children?.length && r;
    });
    const childId = stepOf(waiting, 'sub').children![0].runId;
    await stepStatus(alice, childId, 'w', 'WAITING');
    expect((await alice.post(`/api/v1/runs/${id}/cancel`)).status).toBe(200);
    const child = await waitFor(async () => {
      const c = await get(alice, childId);
      return c.status === 'CANCELLED' && c;
    });
    expect(stepOf(child, 'w').status).toBe('CANCELLED');
  });
});
