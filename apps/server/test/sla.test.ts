import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { client, register, silentLog, testApp, waitFor, type Api } from './helpers.js';
import { startRunWorker } from '../src/actions/worker.js';
import { stepHousekeeping } from '../src/actions/engine.js';
import { later, one, run as sql } from '../src/db.js';

let app: FastifyInstance;
let admin: Api;
let alice: Api;
let stop: () => unknown;

type RunView = {
  id: string;
  status: string;
  slaBreachedAt: string | null;
  logs: { message: string }[];
  steps: { id: string; status: string; slaBreachedAt: string | null }[];
};
const view = async (id: string) => (await alice.get(`/api/v1/runs/${id}`)).data as RunView;
const form = { type: 'form', on: 'create', inputs: { properties: {} } };
const count = async (event: string) => Number((await one<{ n: number }>('SELECT count(*) AS n FROM deliveries WHERE event = ?', event))?.n ?? 0);

beforeAll(async () => {
  app = await testApp();
  admin = client(app, (await register(app, 'admin@example.com')).token);
  alice = client(app, (await register(app, 'alice@example.com')).token);
  const hook = await admin.put('/api/v1/webhooks/sla-sink', {
    title: 'SLA sink',
    url: 'https://hooks.example.test/sla',
    events: ['step.sla_breached', 'run.sla_breached'],
  });
  expect(hook.status, JSON.stringify(hook.data)).toBe(200);
  stop = startRunWorker(silentLog);
});
afterAll(async () => {
  await stop();
  await app.close();
});

describe('SLA', () => {
  it('validates slaMinutes on steps and actions', async () => {
    const bad = await admin.put('/api/v1/actions/bad-sla', { title: 'x', trigger: form, steps: [{ id: 's', type: 'transform', output: {}, slaMinutes: 0 }] });
    expect(bad.status).toBe(400);
    const ok = await admin.put('/api/v1/actions/sla-ok', { title: 'x', slaMinutes: 30, trigger: form, steps: [{ id: 's', type: 'transform', output: {} }] });
    expect(ok.data.slaMinutes).toBe(30);
  });

  it('reports a breached step and run once, notifies and counts it', async () => {
    const saved = await admin.put('/api/v1/actions/slow-approval', {
      title: 'Slow approval',
      slaMinutes: 60,
      trigger: form,
      steps: [{ id: 'gate', type: 'approval', slaMinutes: 5 }],
    });
    expect(saved.status, JSON.stringify(saved.data)).toBe(200);
    const id = (await alice.post('/api/v1/actions/slow-approval/runs', { inputs: {} })).data.id as string;
    await waitFor(async () => (await view(id)).steps.find((s) => s.id === 'gate')?.status === 'WAITING_APPROVAL');
    // The clocks are armed; nothing is due yet, so housekeeping changes nothing.
    expect((await one<{ sla_due_at: string | null }>("SELECT sla_due_at FROM run_steps WHERE run_id = ? AND step_id = 'gate'", id))?.sla_due_at).toBeTruthy();
    await stepHousekeeping(silentLog);
    expect((await view(id)).slaBreachedAt).toBeNull();

    await sql("UPDATE run_steps SET sla_due_at = ? WHERE run_id = ? AND step_id = 'gate'", later(-1000), id);
    await sql('UPDATE runs SET sla_due_at = ? WHERE id = ?', later(-1000), id);
    await Promise.all([stepHousekeeping(silentLog), stepHousekeeping(silentLog)]);
    await stepHousekeeping(silentLog);

    const r = await view(id);
    expect(r.status).toBe('IN_PROGRESS'); // an SLA never stops the run
    expect(r.slaBreachedAt).toBeTruthy();
    expect(r.steps[0]!.slaBreachedAt).toBeTruthy();
    expect(r.logs.filter((l) => l.message.startsWith('SLA breached'))).toHaveLength(2);
    expect(await count('step.sla_breached')).toBe(1);
    expect(await count('run.sla_breached')).toBe(1);

    // The requester and the admins are notified.
    for (const api of [alice, admin]) {
      const inbox = (await api.get('/api/v1/notifications')).data.items as { kind: string; link: string }[];
      expect(inbox.filter((n) => n.kind === 'sla.breached' && n.link === `/runs/${id}`)).toHaveLength(2);
    }
    const metrics = await app.inject({ method: 'GET', url: '/metrics' });
    expect(metrics.body).toMatch(/asterius_sla_breaches_total\{kind="step",action="slow-approval"\} 1/);
    expect(metrics.body).toMatch(/asterius_sla_breaches_total\{kind="run",action="slow-approval"\} 1/);
    await admin.post(`/api/v1/runs/${id}/cancel`);
  });

  it('only clears the clock of a step that finished in time', async () => {
    await admin.put('/api/v1/actions/fast', {
      title: 'Fast',
      trigger: form,
      steps: [{ id: 'quick', type: 'transform', output: { ok: 'true' }, slaMinutes: 5 }],
    });
    const id = (await alice.post('/api/v1/actions/fast/runs', { inputs: {} })).data.id as string;
    await waitFor(async () => (await view(id)).status === 'SUCCESS');
    await sql("UPDATE run_steps SET sla_due_at = ? WHERE run_id = ? AND step_id = 'quick'", later(-1000), id);
    const before = await count('step.sla_breached');
    await stepHousekeeping(silentLog);
    const row = await one<{ sla_due_at: string | null; sla_breached_at: string | null }>(
      "SELECT sla_due_at, sla_breached_at FROM run_steps WHERE run_id = ? AND step_id = 'quick'",
      id,
    );
    expect(row).toEqual({ sla_due_at: null, sla_breached_at: null });
    expect(await count('step.sla_breached')).toBe(before);
  });

  it('accepts the SLA events in webhook subscriptions', async () => {
    const res = await admin.put('/api/v1/webhooks/sla-any', { title: 'x', url: 'https://hooks.example.test/any', events: ['step.*', 'run.sla_breached'] });
    expect(res.status).toBe(200);
  });
});
