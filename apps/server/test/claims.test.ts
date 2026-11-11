import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { client, register, silentLog, testApp, type Api } from './helpers.js';
import { inDefaultOrg } from './helpers.js';
import { all, driver, later, one, run as sql } from '../src/db.js';
import { cancelSteps, claimPolls, claimRuns, claimSteps, executeStep, stepHousekeeping } from '../src/actions/engine.js';
import { cancelRun, getRunRow } from '../src/actions/runs.js';
import type { Principal } from '../src/auth/users.js';

/**
 * Engine concurrency tests that drive the claim/housekeeping functions by hand (no background worker), so that
 * interleavings are controlled: claims (ap-na0.4), housekeeping (ap-na0.3, ap-na0.6) and cancellation (ap-na0.7).
 */

let app: FastifyInstance;
let admin: Api;
let alice: Api;
let aliceP: Principal;

type RunView = { id: string; status: string; statusLabel: string | null; logs: { message: string }[]; steps: { id: string; status: string }[] };
const view = async (id: string) => (await alice.get(`/api/v1/runs/${id}`)).data as RunView;
const trigger = async (action: string) => {
  const res = await alice.post(`/api/v1/actions/${action}/runs`, {});
  expect(res.status, JSON.stringify(res.data)).toBe(201);
  return res.data.id as string;
};

/** Claim every QUEUED run and run its start to completion (no step is executed). */
async function startQueuedRuns() {
  const tasks: Promise<void>[] = [];
  const n = await claimRuns('w-test', 100, (fn) => void tasks.push(fn()));
  await Promise.all(tasks);
  return n;
}
const noSpawn = () => undefined;

beforeAll(async () => {
  app = await testApp();
  admin = client(app, (await register(app, 'admin@example.com')).token);
  const a = await register(app, 'alice@example.com');
  alice = client(app, a.token);
  aliceP = { id: a.user.id, email: 'alice@example.com', name: 'alice', role: 'member', provider: 'local', teams: [], roles: [], superadmin: false, org: null };
  const base = { trigger: 'create', approval: { required: false } };
  await admin.put('/api/v1/actions/noop', { title: 'Noop', ...base, steps: [{ id: 't', type: 'transform', output: { ok: 'true' } }] });
  await admin.put('/api/v1/actions/gated', {
    title: 'Gated',
    ...base,
    steps: [
      { id: 'gate', type: 'approval' },
      { id: 'after', type: 'transform', output: { ok: 'true' } },
    ],
  });
});
afterAll(async () => {
  await app.close();
});

describe('claims (ap-na0.4)', () => {
  it('concurrent workers each get their share: no slot is wasted racing for the same rows', async () => {
    for (let i = 0; i < 12; i++) await trigger('noop');
    expect(await startQueuedRuns()).toBe(12);
    const [a, b] = await Promise.all([claimSteps('w1', 5, noSpawn), claimSteps('w2', 5, noSpawn)]);
    expect([a, b]).toEqual([5, 5]);
    const owners = await all<{ worker: string; n: number }>(
      "SELECT worker, count(*) AS n FROM run_steps WHERE status = 'RUNNING' GROUP BY worker ORDER BY worker",
    );
    expect(owners.map((o) => [o.worker, Number(o.n)])).toEqual([
      ['w1', 5],
      ['w2', 5],
    ]);
    // Claimed steps carry a lease and a fencing attempt; the rest stays queued for others.
    const claimed = await all<{ attempt: number; locked_until: string | null }>("SELECT attempt, locked_until FROM run_steps WHERE status = 'RUNNING'");
    expect(claimed.every((s) => Number(s.attempt) === 1 && s.locked_until)).toBe(true);
    expect(Number((await one<{ n: number }>("SELECT count(*) AS n FROM run_steps WHERE status = 'QUEUED'"))?.n)).toBe(2);
    // The same holds for run claims and polls: a limit is a limit.
    for (let i = 0; i < 4; i++) await trigger('noop');
    const [r1, r2] = await Promise.all([claimRuns('w1', 3, noSpawn), claimRuns('w2', 3, noSpawn)]);
    // Every queued run is claimed exactly once and no worker exceeds its limit; how the 4 runs split between the two
    // (3+1 or 2+2 with SKIP LOCKED on Postgres) is up to the database.
    expect(r1 + r2).toBe(4);
    expect(Math.max(r1, r2)).toBeLessThanOrEqual(3);
    expect(await claimPolls(0, noSpawn)).toBe(0);
    await sql("UPDATE run_steps SET status = 'CANCELLED' WHERE status IN ('RUNNING', 'QUEUED')");
    await sql("UPDATE runs SET status = 'CANCELLED' WHERE status IN ('IN_PROGRESS', 'QUEUED')");
  });
});

describe('housekeeping (ap-na0.3, ap-na0.6)', () => {
  it('does not touch healthy runs waiting for an approval, however many there are', async () => {
    for (let i = 0; i < 5; i++) await trigger('gated');
    await startQueuedRuns();
    await sql('UPDATE runs SET started_at = ? WHERE status = ?', later(-10 * 60_000), 'IN_PROGRESS'); // older than the grace period
    const spy = vi.spyOn(driver, 'query');
    await stepHousekeeping(silentLog);
    const statements = spy.mock.calls.map((c) => String(c[0]));
    spy.mockRestore();
    expect(statements.filter((q) => /^\s*(update|insert|delete)/i.test(q))).toEqual([]);
    // A fixed number of bounded queries, not several per run (each due-time scan: deadlines, SLAs, approval timers…).
    expect(statements.length).toBeLessThanOrEqual(10);
    await sql("UPDATE run_steps SET status = 'CANCELLED' WHERE status = 'WAITING_APPROVAL'");
    await sql("UPDATE runs SET status = 'CANCELLED' WHERE status = 'IN_PROGRESS'");
  });

  it('runs on one replica at a time and handles an abandoned step once', async () => {
    const id = await trigger('gated');
    await startQueuedRuns();
    // A worker died while holding the step.
    await sql(
      "UPDATE run_steps SET status = 'RUNNING', worker = 'dead', attempt = 1, locked_until = ?, state = NULL WHERE run_id = ? AND step_id = 'gate'",
      later(-60_000),
      id,
    );
    await Promise.all([stepHousekeeping(silentLog), stepHousekeeping(silentLog)]);
    const r = await view(id);
    expect(r.logs.filter((l) => l.message === 'The worker executing this step stopped before it finished')).toHaveLength(1);
    expect(r.logs.filter((l) => l.message.startsWith('Step failed'))).toHaveLength(1);
    expect(r.status).toBe('FAILURE');
  });

  it('times out an expired approval exactly once', async () => {
    const id = await trigger('gated');
    await startQueuedRuns();
    await sql("UPDATE run_steps SET deadline_at = ? WHERE run_id = ? AND step_id = 'gate'", later(-1000), id);
    await Promise.all([stepHousekeeping(silentLog), stepHousekeeping(silentLog)]);
    const r = await view(id);
    expect(r.steps.find((s) => s.id === 'gate')?.status).toBe('FAILURE');
    expect(r.logs.filter((l) => l.message.includes('Approval expired'))).toHaveLength(1);
    expect(r.status).toBe('FAILURE');
  });

  it('sets a run deadline when the workflow starts (run timeout plus approval waits) and enforces it', () =>
    inDefaultOrg(async () => {
      const id = await trigger('gated');
      await startQueuedRuns();
      const row = await getRunRow(id);
      const hours = (Date.parse(row.deadline_at!) - Date.parse(row.started_at!)) / 3_600_000;
      expect(hours).toBeCloseTo(24 + 7 * 24, 0); // RUN_TIMEOUT_HOURS + the 7 day approval step
      // The step deadlines no longer use RUN_TIMEOUT_HOURS: only the approval's own timeout applies.
      await sql('UPDATE runs SET deadline_at = ? WHERE id = ?', later(-1000), id);
      await Promise.all([stepHousekeeping(silentLog), stepHousekeeping(silentLog)]);
      const r = await view(id);
      expect(r.status).toBe('FAILURE');
      expect(r.statusLabel).toBe('Timed out');
      expect(r.steps.map((s) => s.status)).toEqual(['CANCELLED', 'CANCELLED']);
      expect(r.logs.filter((l) => l.message.includes('exceeded its time limit'))).toHaveLength(1);
    }));
});

describe('cancellation (ap-na0.7)', () => {
  it('cancelling a QUEUED run that a worker claims at the same moment still cancels it', () =>
    inDefaultOrg(async () => {
      const id = await trigger('noop');
      const cancelling = cancelRun(aliceP, id, cancelSteps); // reads QUEUED …
      const claimed = await claimRuns('w-race', 5, noSpawn); // … the worker claims it before the cancel update
      // SQLite serializes the queries, so the claim always lands between the cancel's read and its update. On Postgres
      // they run on separate connections and the cancel may finish first (nothing left to claim): either way the
      // cancel must win.
      if (driver.dialect === 'sqlite') expect(claimed).toBe(1);
      else expect([0, 1]).toContain(claimed);
      const run = await cancelling; // used to fail with 409 "changed meanwhile"
      expect(run.status).toBe('CANCELLED');
      expect((await getRunRow(id)).status).toBe('CANCELLED');
    }));

  it('a run with a cancel request stops advancing', async () => {
    const id = await trigger('gated');
    await startQueuedRuns();
    await sql('UPDATE runs SET cancel_requested = 1 WHERE id = ?', id);
    await sql("UPDATE run_steps SET status = 'SUCCESS' WHERE run_id = ? AND step_id = 'gate'", id);
    await stepHousekeeping(silentLog); // fresh cancel requests are left to their requester …
    expect((await view(id)).steps.map((s) => s.status)).toEqual(['SUCCESS', 'PENDING']);
    await sql('UPDATE runs SET updated_at = ? WHERE id = ?', later(-5 * 60_000), id); // … stale ones are finished
    await stepHousekeeping(silentLog);
    expect((await view(id)).status).toBe('CANCELLED');
  });
});

describe('step ownership (ap-na0.1)', () => {
  it('a worker that lost its lease cannot write the step result', () =>
    inDefaultOrg(async () => {
      const id = await trigger('noop');
      await startQueuedRuns();
      expect(await claimSteps('w-new', 1, noSpawn)).toBe(1);
      await sql("UPDATE run_steps SET attempt = 2 WHERE run_id = ? AND step_id = 't'", id); // re-claimed since the old worker started
      await executeStep(id, 't', { worker: 'w-old', attempt: 1 });
      const step = await one<{ status: string; worker: string }>("SELECT status, worker FROM run_steps WHERE run_id = ? AND step_id = 't'", id);
      expect(step).toEqual({ status: 'RUNNING', worker: 'w-new' });
      expect((await view(id)).status).toBe('IN_PROGRESS');
    }));
});
