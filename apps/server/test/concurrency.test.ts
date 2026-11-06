import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { client, register, silentLog, testApp, waitFor, type Api } from './helpers.js';
import { startRunWorker } from '../src/actions/worker.js';
import { decide } from '../src/actions/runs.js';
import { decideStep } from '../src/actions/engine.js';
import type { Principal } from '../src/auth/users.js';

/** Regression tests for the workflow-engine concurrency defects (epic ap-na0). */

let app: FastifyInstance;
let admin: Api;
let alice: Api; // requester
const approvers: Api[] = [];
const principals: Principal[] = [];
const stops: (() => unknown)[] = [];

type RunView = {
  id: string;
  status: string;
  logs: { stepId: string | null; message: string }[];
  steps: { id: string; status: string; statusLabel: string | null }[];
};
const getRun = async (api: Api, id: string) => (await api.get(`/api/v1/runs/${id}`)).data as RunView;
const finished = (id: string) =>
  waitFor(async () => {
    const r = await getRun(alice, id);
    return ['SUCCESS', 'FAILURE', 'CANCELLED', 'REJECTED'].includes(r.status) && r;
  });
const waitingGate = (id: string) => waitFor(async () => (await getRun(alice, id)).steps.find((s) => s.id === 'gate')?.status === 'WAITING_APPROVAL');

/** Exactly one call wins; the other fails with a 4xx (never a primary-key violation / 500). */
function expectOneConflict(res: PromiseSettledResult<unknown>[]) {
  expect(res.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  const failed = res.find((r): r is PromiseRejectedResult => r.status === 'rejected');
  expect([403, 409]).toContain((failed?.reason as { statusCode?: number })?.statusCode);
}

beforeAll(async () => {
  app = await testApp();
  admin = client(app, (await register(app, 'admin@example.com')).token);
  alice = client(app, (await register(app, 'alice@example.com')).token);
  await admin.put('/api/v1/teams/platform', { title: 'Platform' });
  for (const n of ['carol', 'dave', 'erin']) {
    const u = await register(app, `${n}@example.com`);
    await admin.patch(`/api/v1/users/${u.user.id}`, { teams: ['platform'] });
    approvers.push(client(app, u.token));
    principals.push({ id: u.user.id, email: `${n}@example.com`, name: n, role: 'member', provider: 'local', teams: ['platform'] });
  }
  stops.push(startRunWorker(silentLog));
});
afterAll(async () => {
  for (const s of stops) await s();
  await app.close();
});

describe('concurrent approvals (ap-na0.2)', () => {
  it('run-level: two simultaneous approvals reach minApprovals; a duplicate is rejected without a 500', async () => {
    await admin.put('/api/v1/actions/two-eyes', {
      title: 'Two eyes',
      trigger: 'create',
      approval: { required: true, approvers: { teams: ['platform'] }, minApprovals: 3 },
      steps: [{ id: 't', type: 'transform', output: { ok: 'true' } }],
    });
    for (let i = 0; i < 5; i++) {
      const id = (await alice.post('/api/v1/actions/two-eyes/runs', {})).data.id as string;
      await Promise.all(principals.map((p) => decide(p, id, 'approved', '')));
      expect((await finished(id)).status).toBe('SUCCESS');
    }
    const id = (await alice.post('/api/v1/actions/two-eyes/runs', {})).data.id as string;
    const dup = await Promise.allSettled([decide(principals[0], id, 'approved', ''), decide(principals[0], id, 'approved', '')]);
    expectOneConflict(dup);
  });

  it('step-level: two simultaneous approvals complete the step; a duplicate is rejected without a 500', async () => {
    await admin.put('/api/v1/actions/two-eyes-step', {
      title: 'Two eyes step',
      trigger: 'create',
      steps: [
        { id: 'gate', type: 'approval', approvers: { teams: ['platform'] }, minApprovals: 3 },
        { id: 't', type: 'transform', output: { ok: 'true' } },
      ],
    });
    for (let i = 0; i < 5; i++) {
      const id = (await alice.post('/api/v1/actions/two-eyes-step/runs', {})).data.id as string;
      await waitingGate(id);
      await Promise.all(principals.map((p) => decideStep(p, id, 'gate', 'approved', '')));
      expect((await finished(id)).status).toBe('SUCCESS');
    }
    const id = (await alice.post('/api/v1/actions/two-eyes-step/runs', {})).data.id as string;
    await waitingGate(id);
    const dup = await Promise.allSettled([decideStep(principals[2], id, 'gate', 'approved', ''), decideStep(principals[2], id, 'gate', 'approved', '')]);
    expectOneConflict(dup);
  });
});
