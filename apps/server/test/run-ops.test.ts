import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { client, register, silentLog, testApp, type Api } from './helpers.js';
import { inDefaultOrg } from './helpers.js';
import { all, one, run as sql } from '../src/db.js';
import { claimRuns, claimSteps, complete, setStep, stepHousekeeping } from '../src/actions/engine.js';

/**
 * Run operations (ap-0ix.3): concurrency groups (queue, cancel-in-progress, reject), priority, pause/unpause and the
 * operator's skip/complete of a step. Claims are driven by hand (no background worker) so interleavings are controlled.
 */

let app: FastifyInstance;
let admin: Api;
let alice: Api;

type StepView = { id: string; status: string; statusLabel: string | null; attempt: number; output: unknown; canSkip?: boolean };
type RunView = {
  id: string;
  status: string;
  statusLabel: string | null;
  priority: number;
  result: Record<string, unknown> | null;
  concurrency: { group: string; max: number; ahead?: number } | null;
  paused: { at: string; by: string | null } | null;
  canPause?: boolean;
  canUnpause?: boolean;
  logs: { message: string }[];
  steps: StepView[];
};
const view = async (id: string) => (await admin.get(`/api/v1/runs/${id}`)).data as RunView;
const step = async (id: string, s: string) => (await view(id)).steps.find((x) => x.id === s)!;
const trigger = async (action: string, body: object = {}, api = alice) => {
  const res = await api.post(`/api/v1/actions/${action}/runs`, body);
  expect(res.status, JSON.stringify(res.data)).toBe(201);
  return res.data.id as string;
};

/** Claim and execute everything that is due until nothing moves (runs, then steps), like a worker would. */
async function drain(worker = 'w-test') {
  for (let i = 0; i < 20; i++) {
    const tasks: Promise<void>[] = [];
    const spawn = (fn: () => Promise<void>) => void tasks.push(fn());
    const n = (await claimRuns(worker, 100, spawn)) + (await claimSteps(worker, 100, spawn));
    await Promise.all(tasks);
    if (!n) return;
  }
}
const noSpawn = () => undefined;
const inProgress = async (ids: string[]) => (await Promise.all(ids.map(view))).filter((r) => r.status === 'IN_PROGRESS').map((r) => r.id);
const approveGate = (id: string) => admin.post(`/api/v1/runs/${id}/steps/gate/approve`, {});

const gated = (extra: object) => ({
  title: 'Gated',
  trigger: { type: 'form', on: 'create', inputs: { properties: { env: { type: 'string' } } } },
  steps: [
    { id: 'gate', type: 'approval' },
    { id: 'after', type: 'transform', output: { ok: 'true' } },
  ],
  ...extra,
});

beforeAll(async () => {
  app = await testApp();
  admin = client(app, (await register(app, 'admin@example.com')).token);
  alice = client(app, (await register(app, 'alice@example.com')).token);
});
afterAll(async () => {
  await app.close();
});

describe('concurrency: queue', () => {
  it('runs one run per group at a time, FIFO, and shows what a queued run waits for', () =>
    inDefaultOrg(async () => {
      const put = await admin.put('/api/v1/actions/deploy', gated({ concurrency: { group: 'deploy-{{ inputs.env }}', max: 1 } }));
      expect(put.status, JSON.stringify(put.data)).toBe(200);
      expect(put.data.concurrency).toEqual({ group: 'deploy-{{ inputs.env }}', max: 1, mode: 'queue' });
      // Concurrent creations: all are accepted and queued.
      const prod = await Promise.all([0, 1, 2].map(() => trigger('deploy', { inputs: { env: 'prod' } })));
      const dev = await trigger('deploy', { inputs: { env: 'dev' } });
      // Two workers claim at the same time: one prod run and the dev run start, never two prod runs.
      const tasks: Promise<void>[] = [];
      const spawn = (fn: () => Promise<void>) => void tasks.push(fn());
      await Promise.all([claimRuns('w1', 10, spawn), claimRuns('w2', 10, spawn), claimRuns('w3', 10, spawn)]);
      await Promise.all(tasks);
      expect(await inProgress(prod)).toHaveLength(1);
      expect((await view(dev)).status).toBe('IN_PROGRESS');
      const ordered = [...prod].sort((a, b) => a.localeCompare(b));
      const rows = await all<{ id: string; created_at: string }>(
        `SELECT id, created_at FROM runs WHERE id IN (${prod.map(() => '?').join(',')}) ORDER BY created_at, id`,
        ...prod,
      );
      const fifo = rows.map((r) => r.id);
      expect(ordered).toHaveLength(3);
      expect(await inProgress(prod)).toEqual([fifo[0]]);
      const waiting = await view(fifo[2]!);
      expect(waiting.status).toBe('QUEUED');
      expect(waiting.concurrency).toMatchObject({ group: 'deploy-prod', max: 1, ahead: 2 });
      // Each finished run lets the next one in, in creation order.
      for (const [i, id] of fifo.entries()) {
        await drain();
        expect(await inProgress(prod)).toEqual([id]);
        expect((await approveGate(id)).status).toBe(200);
        await drain();
        expect((await view(id)).status).toBe('SUCCESS');
        if (i < 2) expect(await inProgress(prod)).toEqual([fifo[i + 1]]); // the freed slot goes to the next one at once
      }
      await drain();
      expect(await one('SELECT count(*) AS n FROM run_slots WHERE grp = ?', 'deploy-prod')).toEqual({ n: 0 });
    }));

  it('child workflow runs and automated runs go through the same gate', () =>
    inDefaultOrg(async () => {
      await admin.put('/api/v1/actions/child', gated({ title: 'Child', concurrency: { max: 1 } }));
      await admin.put('/api/v1/actions/parent', {
        title: 'Parent',
        trigger: { type: 'form', on: 'create' },
        steps: [{ id: 'call', type: 'workflow', action: 'child', forEach: { items: '[1, 2]', maxConcurrency: 2 } }],
      });
      const p = await trigger('parent');
      await drain();
      await drain(); // the fan-out visit starts the children
      const children = await all<{ id: string; status: string }>('SELECT id, status FROM runs WHERE parent_run_id = ?', p);
      for (let i = 0; i < 50 && children.length < 2; i++) {
        await new Promise((r) => setTimeout(r, 100));
        const { claimWaits } = await import('../src/actions/waiting.js');
        const tasks: Promise<void>[] = [];
        await claimWaits(10, (fn) => void tasks.push(fn()));
        await Promise.all(tasks);
        children.splice(0, children.length, ...(await all<{ id: string; status: string }>('SELECT id, status FROM runs WHERE parent_run_id = ?', p)));
      }
      expect(children).toHaveLength(2);
      await drain();
      expect(await inProgress(children.map((c) => c.id))).toHaveLength(1);
      expect((await view(children.find((c) => c.status !== 'IN_PROGRESS')?.id ?? children[1]!.id)).concurrency?.group).toBe('child');
    }));
});

describe('concurrency: reject', () => {
  it('concurrent creations get exactly one slot; the others answer 409 until it is free', () =>
    inDefaultOrg(async () => {
      await admin.put('/api/v1/actions/exclusive', gated({ title: 'Exclusive', concurrency: { mode: 'reject' } }));
      const res = await Promise.all([0, 1, 2, 3].map(() => alice.post('/api/v1/actions/exclusive/runs', {})));
      expect(res.map((r) => r.status).sort()).toEqual([201, 409, 409, 409]);
      expect(res.find((r) => r.status === 409)!.data.error).toMatch(/already running in group "exclusive"/);
      const id = res.find((r) => r.status === 201)!.data.id as string;
      // A new Idempotency-Key competes for the slot like any request.
      const keyed = await alice.post('/api/v1/actions/exclusive/runs', {}, { 'idempotency-key': 'k1' });
      expect(keyed.status).toBe(409);
      await drain();
      await approveGate(id);
      await drain();
      expect((await view(id)).status).toBe('SUCCESS');
      const again = await alice.post('/api/v1/actions/exclusive/runs', {}, { 'idempotency-key': 'k2' });
      expect(again.status).toBe(201);
      const replay = await alice.post('/api/v1/actions/exclusive/runs', {}, { 'idempotency-key': 'k2' });
      expect(replay.status).toBe(200);
      expect(replay.data.id).toBe(again.data.id);
    }));
});

describe('concurrency: cancel-in-progress', () => {
  it('a new run cancels the older runs of its group (two-phase cancel), then starts', () =>
    inDefaultOrg(async () => {
      await admin.put('/api/v1/actions/latest', gated({ title: 'Latest', concurrency: { group: 'latest-{{ inputs.env }}', mode: 'cancel-in-progress' } }));
      const a = await trigger('latest', { inputs: { env: 'prod' } });
      await drain();
      expect((await step(a, 'gate')).status).toBe('WAITING_APPROVAL');
      const queued = await trigger('latest', { inputs: { env: 'prod' } }); // cancels a, waits for its slot
      expect((await view(a)).status).toBe('CANCELLED');
      expect((await step(a, 'gate')).status).toBe('CANCELLED');
      expect((await view(a)).logs.some((l) => /Cancelled by a newer run of group "latest-prod"/.test(l.message))).toBe(true);
      const b = await trigger('latest', { inputs: { env: 'prod' } }); // cancels the queued one
      expect((await view(queued)).status).toBe('CANCELLED');
      const other = await trigger('latest', { inputs: { env: 'dev' } }); // another group: untouched
      await drain();
      expect((await view(b)).status).toBe('IN_PROGRESS');
      expect((await view(other)).status).toBe('IN_PROGRESS');
      const audits = await all<{ detail: string }>("SELECT detail FROM audit_log WHERE action = 'run.cancelled' AND detail LIKE '%concurrency%'");
      expect(audits.length).toBeGreaterThanOrEqual(2);
    }));
});

describe('priority', () => {
  it('workers claim queued runs by priority, then age; only admins override it, within bounds', () =>
    inDefaultOrg(async () => {
      await admin.put('/api/v1/actions/prio', {
        title: 'Prio',
        priority: 5,
        trigger: { type: 'form', on: 'create' },
        steps: [{ id: 't', type: 'transform', output: { ok: 'true' } }],
      });
      expect((await alice.post('/api/v1/actions/prio/runs', { priority: 50 })).status).toBe(403);
      expect((await admin.post('/api/v1/actions/prio/runs', { priority: 1000 })).status).toBe(400);
      const low = await trigger('prio', { priority: -10 }, admin);
      const normal = await trigger('prio');
      const high = await trigger('prio', { priority: 50 }, admin);
      expect((await view(normal)).priority).toBe(5);
      const claimed: string[] = [];
      for (let i = 0; i < 3; i++) {
        await claimRuns('w-prio', 1, noSpawn);
        claimed.push(
          ...(await all<{ id: string }>("SELECT id FROM runs WHERE action = 'prio' AND status = 'IN_PROGRESS' ORDER BY started_at"))
            .map((r) => r.id)
            .filter((id) => !claimed.includes(id)),
        );
      }
      expect(claimed).toEqual([high, normal, low]);
    }));

  it('within a concurrency group a later urgent run is admitted before the older ones', () =>
    inDefaultOrg(async () => {
      await admin.put('/api/v1/actions/serial', gated({ title: 'Serial', concurrency: { max: 1 } }));
      const first = await trigger('serial');
      await drain();
      const older = await trigger('serial');
      const urgent = await trigger('serial', { priority: 20 }, admin);
      expect((await view(urgent)).concurrency?.ahead).toBe(1);
      expect((await view(older)).concurrency?.ahead).toBe(2);
      await approveGate(first);
      await drain();
      expect((await view(urgent)).status).toBe('IN_PROGRESS');
      expect((await view(older)).status).toBe('QUEUED');
    }));
});

describe('pause / unpause', () => {
  it('a paused run starts no successor; waits and approvals still complete; unpause continues and extends the deadline', () =>
    inDefaultOrg(async () => {
      await admin.put('/api/v1/actions/pausable', gated({ title: 'Pausable' }));
      const id = await trigger('pausable');
      await drain();
      expect((await view(id)).canPause).toBe(true);
      const paused = await alice.post(`/api/v1/runs/${id}/pause`, {}); // the requester may pause
      expect(paused.status, JSON.stringify(paused.data)).toBe(200);
      expect(paused.data.paused.by).toBe('alice');
      expect(paused.data.canUnpause).toBe(true);
      expect((await alice.post(`/api/v1/runs/${id}/pause`, {})).status).toBe(409);
      // The approval still works, its successor does not start.
      expect((await approveGate(id)).status).toBe(200);
      await drain();
      expect((await step(id, 'gate')).status).toBe('SUCCESS');
      expect((await step(id, 'after')).status).toBe('PENDING');
      expect((await view(id)).statusLabel).toBe('Paused by alice');
      // Housekeeping does not treat it as abandoned, even past its deadline.
      await sql(
        'UPDATE runs SET started_at = ?, deadline_at = ?, paused_at = ? WHERE id = ?',
        '2020-01-01T00:00:00.000Z',
        new Date(Date.now() - 60_000).toISOString(),
        new Date(Date.now() - 3_600_000).toISOString(),
        id,
      );
      await stepHousekeeping(silentLog);
      expect((await view(id)).status).toBe('IN_PROGRESS');
      expect((await step(id, 'after')).status).toBe('PENDING');
      const before = Date.now() - 60_000;
      const resumed = await alice.post(`/api/v1/runs/${id}/unpause`, {});
      expect(resumed.status).toBe(200);
      const deadline = Date.parse((await one<{ deadline_at: string }>('SELECT deadline_at FROM runs WHERE id = ?', id))!.deadline_at);
      expect(deadline - before).toBeGreaterThan(3_500_000); // extended by the hour it was paused
      await drain();
      expect((await view(id)).status).toBe('SUCCESS');
      const actions = (await all<{ action: string }>("SELECT action FROM audit_log WHERE action IN ('run.paused', 'run.unpaused')")).map((a) => a.action);
      expect(actions).toEqual(expect.arrayContaining(['run.paused', 'run.unpaused']));
    }));

  it('queued steps of a paused run are not claimed', () =>
    inDefaultOrg(async () => {
      await admin.put('/api/v1/actions/single', {
        title: 'Single',
        trigger: { type: 'form', on: 'create' },
        steps: [{ id: 't', type: 'transform', output: { ok: 'true' } }],
      });
      const id = await trigger('single');
      const tasks: Promise<void>[] = [];
      await claimRuns('w-p', 10, (fn) => void tasks.push(fn()));
      await Promise.all(tasks);
      expect((await step(id, 't')).status).toBe('QUEUED');
      expect((await admin.post(`/api/v1/runs/${id}/pause`, {})).status).toBe(200);
      const bob = client(app, (await register(app, 'bob@example.com')).token);
      expect((await bob.post(`/api/v1/runs/${id}/unpause`, {})).status).toBe(403); // like cancel: requester and admins only
      expect(await claimSteps('w-p', 10, noSpawn)).toBe(0);
      await admin.post(`/api/v1/runs/${id}/unpause`, {});
      await drain();
      expect((await view(id)).status).toBe('SUCCESS');
    }));
});

describe('operator step control', () => {
  it('skip: admins only, with a comment; the run continues', () =>
    inDefaultOrg(async () => {
      await admin.put('/api/v1/actions/skippable', gated({ title: 'Skippable' }));
      const id = await trigger('skippable');
      await drain();
      expect((await step(id, 'gate')).canSkip).toBe(true);
      expect((await alice.post(`/api/v1/runs/${id}/steps/gate/skip`, { comment: 'x' })).status).toBe(403);
      expect((await admin.post(`/api/v1/runs/${id}/steps/gate/skip`, {})).status).toBe(400);
      expect((await admin.post(`/api/v1/runs/${id}/steps/gate/skip`, { comment: '  ' })).status).toBe(400);
      const res = await admin.post(`/api/v1/runs/${id}/steps/gate/skip`, { comment: 'approved by phone' });
      expect(res.status, JSON.stringify(res.data)).toBe(200);
      await drain();
      const r = await view(id);
      expect(r.status).toBe('SUCCESS');
      expect(r.steps.map((s) => s.status)).toEqual(['SKIPPED', 'SUCCESS']);
      expect(r.logs.some((l) => l.message === 'Step skipped by admin: approved by phone')).toBe(true);
      expect((await admin.post(`/api/v1/runs/${id}/steps/gate/skip`, { comment: 'again' })).status).toBe(409);
      expect(await one("SELECT action FROM audit_log WHERE action = 'run.step_skipped'")).toBeTruthy();
    }));

  it('complete: forces a failed step to SUCCESS with an output, and the failed run continues', () =>
    inDefaultOrg(async () => {
      await admin.put('/api/v1/actions/flaky', {
        title: 'Flaky',
        trigger: { type: 'form', on: 'create' },
        steps: [
          { id: 'boom', type: 'transform', output: { x: '$error("nope")' } },
          { id: 'after', type: 'transform', output: { got: 'steps.boom.output.x' } },
        ],
      });
      const id = await trigger('flaky');
      await drain();
      expect((await view(id)).status).toBe('FAILURE');
      expect((await step(id, 'after')).status).toBe('SKIPPED');
      const res = await admin.post(`/api/v1/runs/${id}/steps/boom/complete`, { comment: 'done by hand', output: { x: 42 } });
      expect(res.status, JSON.stringify(res.data)).toBe(200);
      await drain();
      const r = await view(id);
      expect(r.status).toBe('SUCCESS');
      expect(r.result).toMatchObject({ boom: { x: 42 }, after: { got: 42 } });
      expect(await one("SELECT action FROM audit_log WHERE action = 'run.step_completed'")).toBeTruthy();
    }));

  it('fencing: an executor still in flight cannot overwrite the forced result', () =>
    inDefaultOrg(async () => {
      await admin.put('/api/v1/actions/fenced', {
        title: 'Fenced',
        trigger: { type: 'form', on: 'create' },
        steps: [{ id: 't', type: 'transform', output: { ok: 'true' } }],
      });
      const id = await trigger('fenced');
      const tasks: Promise<void>[] = [];
      await claimRuns('w-f', 10, (fn) => void tasks.push(fn()));
      await Promise.all(tasks);
      expect(await claimSteps('w-fence', 10, noSpawn)).toBe(1); // claimed, never executed: the executor is "in flight"
      const claimed = await step(id, 't');
      expect(claimed.status).toBe('RUNNING');
      const owner = { worker: 'w-fence', attempt: claimed.attempt };
      const res = await admin.post(`/api/v1/runs/${id}/steps/t/complete`, { comment: 'stuck worker', output: { forced: true } });
      expect(res.status).toBe(200);
      // The late executor reports: refused by the fencing token, the forced result stays.
      expect(await complete(id, 't', ['RUNNING', 'SUCCESS'], { status: 'FAILURE', statusLabel: 'late' }, owner)).toBe(false);
      expect(await setStep(id, 't', ['RUNNING', 'SUCCESS'], { status_label: 'late' }, owner)).toBe(false);
      const after = await step(id, 't');
      expect(after.status).toBe('SUCCESS');
      expect(after.output).toEqual({ forced: true });
      expect(after.attempt).toBe(owner.attempt + 1);
      expect((await view(id)).status).toBe('SUCCESS');
    }));
});
