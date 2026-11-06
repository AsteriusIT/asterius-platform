import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { client, fakeServer, register, silentLog, testApp, waitFor, type Api } from './helpers.js';
import { startRunWorker } from '../src/actions/worker.js';

let app: FastifyInstance;
let admin: Api;
let alice: Api;
let carol: Api;
let ext: Awaited<ReturnType<typeof fakeServer>>;
let broken = true;
let stop: () => unknown;

type RunView = {
  id: string;
  status: string;
  inputs: Record<string, unknown>;
  trigger: { type: string; of?: string };
  canResume?: boolean;
  canRerun?: boolean;
  steps: { id: string; status: string; attempt: number; output: unknown; canRetry?: boolean }[];
};
const get = async (api: Api, id: string) => (await api.get(`/api/v1/runs/${id}`)).data as RunView;
const finished = (api: Api, id: string) =>
  waitFor(async () => {
    const r = await get(api, id);
    return ['SUCCESS', 'FAILURE', 'CANCELLED'].includes(r.status) && r;
  }, 25_000);
const step = (r: RunView, id: string) => r.steps.find((s) => s.id === id)!;

beforeAll(async () => {
  app = await testApp();
  admin = client(app, (await register(app, 'admin@example.com')).token);
  alice = client(app, (await register(app, 'alice@example.com')).token);
  carol = client(app, (await register(app, 'carol@example.com')).token);
  ext = await fakeServer(() => (broken ? { status: 500, body: { error: 'down' } } : { body: { ok: true } }));
  stop = startRunWorker(silentLog);
  const res = await admin.put('/api/v1/actions/deploy', {
    title: 'Deploy',
    trigger: { type: 'form', on: 'create', inputs: { properties: { name: { type: 'string' } } } },
    steps: [
      { id: 'prep', type: 'transform', output: { name: 'inputs.name' } },
      { id: 'call', type: 'invoke', invoker: { type: 'webhook', url: `${ext.url}/deploy`, mode: 'sync' } },
      { id: 'after', type: 'transform', output: { done: '"yes"' } },
    ],
  });
  expect(res.status, JSON.stringify(res.data)).toBe(200);
});
afterAll(async () => {
  await stop();
  await ext.close();
  await app.close();
});

describe('re-run, resume and retry', () => {
  let failedId: string;

  it('fails at the invoke step and skips what follows', async () => {
    const res = await alice.post('/api/v1/actions/deploy/runs', { inputs: { name: 'orders' } });
    failedId = res.data.id;
    const r = await finished(alice, failedId);
    expect(r.status).toBe('FAILURE');
    expect(step(r, 'prep').status).toBe('SUCCESS');
    expect(step(r, 'call').status).toBe('FAILURE');
    expect(step(r, 'after').status).toBe('SKIPPED');
    expect(r).toMatchObject({ canResume: true, canRerun: true });
    expect(step(r, 'call').canRetry).toBe(true);
  });

  it('only the requester or an admin may recover a run', async () => {
    expect((await carol.post(`/api/v1/runs/${failedId}/resume`)).status).toBe(403);
    expect((await carol.post(`/api/v1/runs/${failedId}/rerun`)).status).toBe(403);
    expect((await carol.post(`/api/v1/runs/${failedId}/steps/call/retry`)).status).toBe(403);
    expect((await alice.post(`/api/v1/runs/${failedId}/steps/prep/retry`)).status).toBe(409); // not failed
  });

  it('re-runs with the same inputs and links to the original', async () => {
    const res = await alice.post(`/api/v1/runs/${failedId}/rerun`);
    expect(res.status, JSON.stringify(res.data)).toBe(201);
    expect(res.data.id).not.toBe(failedId);
    expect(res.data.inputs).toEqual({ name: 'orders' });
    expect(res.data.trigger).toMatchObject({ type: 'rerun', of: failedId });
    await finished(alice, res.data.id);
    expect((await alice.post(`/api/v1/runs/${res.data.id}/resume`)).status).toBe(200); // failed again: resumable
    await finished(alice, res.data.id);
  });

  it('resumes from the failed step and keeps successful outputs', async () => {
    broken = false;
    const before = await get(alice, failedId);
    const prepOut = step(before, 'prep').output;
    const res = await alice.post(`/api/v1/runs/${failedId}/resume`);
    expect(res.status, JSON.stringify(res.data)).toBe(200);
    const r = await finished(alice, failedId);
    expect(r.status).toBe('SUCCESS');
    expect(step(r, 'prep')).toMatchObject({ status: 'SUCCESS', attempt: 1, output: prepOut }); // not executed again
    expect(step(r, 'call')).toMatchObject({ status: 'SUCCESS', attempt: 1 }); // attempts restart for the step
    expect(step(r, 'after').status).toBe('SUCCESS');
    expect((await alice.post(`/api/v1/runs/${failedId}/resume`)).status).toBe(409); // nothing left to resume
  });

  it('retries one failed step', async () => {
    broken = true;
    const id = (await alice.post('/api/v1/actions/deploy/runs', { inputs: { name: 'billing' } })).data.id;
    expect((await finished(alice, id)).status).toBe('FAILURE');
    broken = false;
    const res = await admin.post(`/api/v1/runs/${id}/steps/call/retry`); // admins may too
    expect(res.status, JSON.stringify(res.data)).toBe(200);
    const r = await finished(alice, id);
    expect(r.status).toBe('SUCCESS');
    expect(step(r, 'after').status).toBe('SUCCESS');
    const audit = (await admin.get('/api/v1/audit')).data as { items?: { action: string }[] } | { action: string }[];
    const actions = (Array.isArray(audit) ? audit : (audit.items ?? [])).map((a) => a.action);
    expect(actions).toContain('run.resumed');
  });
});
