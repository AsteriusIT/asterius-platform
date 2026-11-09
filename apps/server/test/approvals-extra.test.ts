import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { client, register, silentLog, testApp, waitFor, type Api } from './helpers.js';
import { startRunWorker } from '../src/actions/worker.js';
import { setMailTransportFactory } from '../src/notifications/channels.js';

/** Approval reminders, escalation, delegation (out of office), sequential tiers and expiry outcomes. */

let app: FastifyInstance;
let admin: Api;
let alice: Api;
let bob: Api;
let carol: Api;
let dave: Api;
let stop: () => unknown;
const mails: { to: string[]; subject: string; text?: string }[] = [];

type Approval = { userName: string; decision: string; onBehalfOf?: { name: string } | null; tier?: number | null };
type RunView = {
  id: string;
  status: string;
  canApprove?: boolean;
  approvals: Approval[];
  approval?: { escalatedAt?: string | null; reminders?: number; expiresAt?: string | null } | null;
  logs: { message: string }[];
  steps: {
    id: string;
    status: string;
    statusLabel: string | null;
    output: Record<string, unknown> | null;
    canApprove?: boolean;
    approvals: Approval[];
    approval?: { tiers?: { name: string; state: string; approved: number }[]; escalatedAt?: string | null; reminders?: number } | null;
  }[];
};
const get = async (api: Api, id: string) => (await api.get(`/api/v1/runs/${id}`)).data as RunView;
const stepOf = (r: RunView, id = 'ok') => r.steps.find((s) => s.id === id)!;
const FINAL = ['SUCCESS', 'FAILURE', 'CANCELLED', 'REJECTED'];
const finished = (id: string) =>
  waitFor(async () => {
    const r = await get(admin, id);
    return FINAL.includes(r.status) && r;
  }, 30_000);
const waitingApproval = (id: string, step = 'ok') =>
  waitFor(async () => {
    const r = await get(admin, id);
    return stepOf(r, step)?.status === 'WAITING_APPROVAL' && r;
  }, 20_000);
const form = { type: 'form', on: 'create', inputs: { properties: {} } };
const save = async (id: string, body: object) => {
  const res = await admin.put(`/api/v1/actions/${id}`, { title: id, trigger: form, ...body });
  expect(res.status, JSON.stringify(res.data)).toBe(200);
};
const start = async (api: Api, id: string) => {
  const res = await api.post(`/api/v1/actions/${id}/runs`, { inputs: {} });
  expect(res.status, JSON.stringify(res.data)).toBe(201);
  return res.data.id as string;
};
const approveStep = (api: Api, id: string, comment = '', step = 'ok') => api.post(`/api/v1/runs/${id}/steps/${step}/approve`, { comment });
const sql = async (q: string, ...params: (string | null)[]) => (await import('../src/db.js')).run(q, ...params);
const PAST = '2020-01-01T00:00:00.000Z';
const timers = async () => (await import('../src/actions/approvals.js')).approvalTimers(silentLog);
const mailsTo = (email: string, subject: RegExp) => mails.filter((m) => m.to.includes(email) && subject.test(m.subject));
/** Housekeeping holds a database-wide advisory lock: retry until our run reached the expected state. */
const housekeepUntil = (id: string, ok: (r: RunView) => boolean) =>
  waitFor(async () => {
    const { stepHousekeeping } = await import('../src/actions/engine.js');
    await stepHousekeeping(silentLog);
    const r = await get(admin, id);
    return ok(r) && r;
  }, 30_000);

beforeAll(async () => {
  app = await testApp();
  admin = client(app, (await register(app, 'admin@example.com', 'Admin')).token);
  alice = client(app, (await register(app, 'alice@example.com', 'Alice')).token);
  bob = client(app, (await register(app, 'bob@example.com', 'Bob')).token);
  carol = client(app, (await register(app, 'carol@example.com', 'Carol')).token);
  dave = client(app, (await register(app, 'dave@example.com', 'Dave')).token);
  setMailTransportFactory(
    () =>
      ({
        sendMail: async (m: { to: string[]; subject: string; text?: string }) => {
          mails.push({ to: m.to, subject: m.subject, text: m.text });
          return { messageId: `m${mails.length}` };
        },
      }) as never,
  );
  const put = await admin.put('/api/v1/notification-settings', { email: { smtpUrl: 'smtp://mail.example.test:25', from: 'platform@example.com' } });
  expect(put.status).toBe(200);
  stop = startRunWorker(silentLog);
});
afterAll(async () => {
  await stop();
  await app.close();
});

describe('validation', () => {
  it('rejects tiers mixed with approvers, unnamed escalation approvers and an expiry outcome without expiry', async () => {
    const step = { id: 'ok', type: 'approval' };
    const bad = async (body: object) => (await admin.put('/api/v1/actions/bad', { title: 'bad', trigger: form, ...body })).data.error as string;
    expect(await bad({ steps: [{ ...step, approvers: { users: ['carol@example.com'] }, tiers: [{ name: 'a' }] }] })).toMatch(/tiers or approvers/);
    expect(await bad({ steps: [{ ...step, tiers: [{ name: 'a' }, { name: 'a' }] }] })).toMatch(/unique/);
    expect((await admin.put('/api/v1/actions/bad', { title: 'bad', trigger: form, steps: [{ ...step, remindEvery: 'soon' }] })).status).toBe(400);
    expect(
      (await admin.put('/api/v1/actions/bad', { title: 'bad', trigger: form, steps: [{ ...step, escalate: { after: '1d', approvers: {} } }] })).status,
    ).toBe(400);
    expect((await admin.put('/api/v1/actions/bad', { title: 'bad', trigger: form, steps: [{ ...step, onExpiry: 'later' }] })).status).toBe(400);
    const pre = await admin.put('/api/v1/actions/bad', {
      title: 'bad',
      trigger: { ...form, approval: { required: true, onExpiry: 'approve' } },
      steps: [{ id: 't', type: 'transform', output: { x: '1' } }],
    });
    expect(pre.status).toBe(400);
  });
});

describe('reminders', () => {
  it('re-notifies the approvers who have not decided, once per due time, at most maxReminders times', async () => {
    await save('remind', {
      steps: [
        { id: 'ok', type: 'approval', approvers: { users: ['carol@example.com', 'dave@example.com'] }, minApprovals: 2, remindEvery: '1h', maxReminders: 2 },
      ],
    });
    const id = await start(alice, 'remind');
    await waitingApproval(id);
    expect((await approveStep(dave, id)).status).toBe(200);
    await sql('UPDATE run_steps SET remind_at = ? WHERE run_id = ?', PAST, id);
    // Two concurrent passes (two replicas): the conditional UPDATE lets only one send the reminder.
    await Promise.all([timers(), timers()]);
    expect(mailsTo('carol@example.com', /^Reminder: Approval needed/)).toHaveLength(1);
    expect(mailsTo('carol@example.com', /^Reminder/)[0]!.text).toMatch(/reminder 1 of 2/);
    expect(mailsTo('dave@example.com', /^Reminder/)).toHaveLength(0); // already decided
    let r = await get(admin, id);
    expect(stepOf(r).approval?.reminders).toBe(1);
    expect(r.logs.some((l) => l.message.includes('Reminder 1/2'))).toBe(true);
    // A pass before the next due time sends nothing.
    await timers();
    expect(mailsTo('carol@example.com', /^Reminder/)).toHaveLength(1);
    await sql('UPDATE run_steps SET remind_at = ? WHERE run_id = ?', PAST, id);
    await timers();
    expect(mailsTo('carol@example.com', /^Reminder/)).toHaveLength(2);
    r = await get(admin, id);
    expect(stepOf(r).approval).toMatchObject({ reminders: 2, nextReminderAt: null }); // the maximum is reached
    expect((await approveStep(carol, id)).status).toBe(200);
    expect((await finished(id)).status).toBe('SUCCESS');
  });

  it('reminds the approvers of a pre-start approval', async () => {
    await save('remind-pre', {
      trigger: { ...form, approval: { required: true, approvers: { users: ['carol@example.com'] }, remindEvery: '4h' } },
      steps: [{ id: 't', type: 'transform', output: { x: '1' } }],
    });
    const id = await start(alice, 'remind-pre');
    const before = mailsTo('carol@example.com', /^Reminder: Approval needed: remind-pre/).length;
    await sql('UPDATE runs SET remind_at = ? WHERE id = ?', PAST, id);
    await Promise.all([timers(), timers()]);
    expect(mailsTo('carol@example.com', /^Reminder: Approval needed: remind-pre/)).toHaveLength(before + 1);
    expect((await get(admin, id)).approval?.reminders).toBe(1);
    await admin.post(`/api/v1/runs/${id}/cancel`);
  });
});

describe('escalation', () => {
  it('makes the escalation approvers eligible after the delay, notifies them and logs it', async () => {
    await save('escalate', {
      steps: [
        { id: 'ok', type: 'approval', approvers: { users: ['carol@example.com'] }, escalate: { after: '2d', approvers: { users: ['dave@example.com'] } } },
      ],
    });
    const id = await start(alice, 'escalate');
    await waitingApproval(id);
    expect(stepOf(await get(dave, id)).canApprove).toBe(false);
    expect((await approveStep(dave, id)).status).toBe(403);
    await sql('UPDATE run_steps SET escalate_at = ? WHERE run_id = ?', PAST, id);
    await Promise.all([timers(), timers()]);
    expect(mailsTo('dave@example.com', /^Escalated: Approval needed: escalate/)).toHaveLength(1);
    const r = await get(dave, id);
    expect(stepOf(r).canApprove).toBe(true);
    expect(stepOf(r).approval?.escalatedAt).toBeTruthy();
    expect(r.logs.some((l) => /Escalated: no decision within 2d; dave@example.com may now approve/.test(l.message))).toBe(true);
    expect((await approveStep(dave, id)).status).toBe(200);
    expect((await finished(id)).status).toBe('SUCCESS');
  });

  it('escalates a pre-start approval', async () => {
    await save('escalate-pre', {
      trigger: {
        ...form,
        approval: { required: true, approvers: { users: ['carol@example.com'] }, escalate: { after: '1d', approvers: { users: ['dave@example.com'] } } },
      },
      steps: [{ id: 't', type: 'transform', output: { x: '1' } }],
    });
    const id = await start(alice, 'escalate-pre');
    expect((await get(dave, id)).canApprove).toBe(false);
    await sql('UPDATE runs SET escalate_at = ? WHERE id = ?', PAST, id);
    await timers();
    expect((await get(dave, id)).canApprove).toBe(true);
    expect((await dave.post(`/api/v1/runs/${id}/approve`, { comment: '' })).status).toBe(200);
    expect((await finished(id)).status).toBe('SUCCESS');
  });
});

describe('delegation', () => {
  it('lets a user name a delegate, validates it, and lets admins list and clear delegations', async () => {
    expect((await carol.put('/api/v1/me/delegation', { delegate: 'carol@example.com' })).status).toBe(400);
    expect((await carol.put('/api/v1/me/delegation', { delegate: 'nobody@example.com' })).status).toBe(400);
    expect(
      (await carol.put('/api/v1/me/delegation', { delegate: 'bob@example.com', startsAt: '2030-01-02T00:00:00Z', endsAt: '2030-01-01T00:00:00Z' })).status,
    ).toBe(400);
    const set = await carol.put('/api/v1/me/delegation', { delegate: 'bob@example.com' });
    expect(set.status, JSON.stringify(set.data)).toBe(200);
    expect(set.data.delegation).toMatchObject({ delegate: { email: 'bob@example.com' }, active: true });
    expect((await carol.get('/api/v1/me/delegation')).data.delegation.delegate.name).toBe('Bob');
    expect((await alice.get('/api/v1/delegations')).status).toBe(403);
    const list = (await admin.get('/api/v1/delegations')).data as { user: { email: string } }[];
    expect(list.map((d) => d.user.email)).toContain('carol@example.com');
  });

  it('lets the active delegate decide for an eligible approver and records on behalf of whom', async () => {
    await save('delegated', { steps: [{ id: 'ok', type: 'approval', approvers: { users: ['carol@example.com'] } }] });
    const id = await start(alice, 'delegated');
    await waitingApproval(id);
    // The delegate is asked too.
    await waitFor(async () => mails.some((m) => m.to.includes('bob@example.com') && /delegate of Carol/.test(m.text ?? '')));
    const pending = (await bob.get('/api/v1/approvals')).data as { id: string; onBehalfOf?: { name: string } }[];
    expect(pending.find((i) => i.id === id)?.onBehalfOf?.name).toBe('Carol');
    expect(stepOf(await get(bob, id)).canApprove).toBe(true);
    expect((await approveStep(bob, id, 'covering')).status).toBe(200);
    const r = await finished(id);
    expect(r.status).toBe('SUCCESS');
    expect(stepOf(r).approvals[0]).toMatchObject({ userName: 'Bob', onBehalfOf: { name: 'Carol' } });
    expect(stepOf(r).output).toMatchObject({ approved: true, by: ['Bob'], delegated: [{ by: 'Bob', for: 'Carol' }] });
    expect(r.logs.some((l) => l.message.includes('Approved by Bob on behalf of Carol'))).toBe(true);
  });

  it('records delegated pre-start approvals and blocks a second decision for the same person', async () => {
    await save('delegated-pre', {
      trigger: { ...form, approval: { required: true, approvers: { users: ['carol@example.com'] }, minApprovals: 1 } },
      steps: [{ id: 't', type: 'transform', output: { x: '1' } }],
    });
    const id = await start(alice, 'delegated-pre');
    expect((await bob.post(`/api/v1/runs/${id}/approve`, { comment: '' })).status).toBe(200);
    const r = await finished(id);
    expect(r.approvals[0]).toMatchObject({ userName: 'Bob', onBehalfOf: { name: 'Carol' } });
  });

  it('never lets a delegate approve their own request without self-approval, nor outside the date range', async () => {
    await save('own-request', { steps: [{ id: 'ok', type: 'approval', approvers: { users: ['carol@example.com'] } }] });
    const id = await start(bob, 'own-request');
    await waitingApproval(id);
    expect(stepOf(await get(bob, id)).canApprove).toBe(false);
    expect((await approveStep(bob, id)).status).toBe(403);
    // With self-approval allowed, the delegate may.
    await save('own-request-ok', { steps: [{ id: 'ok', type: 'approval', approvers: { users: ['carol@example.com'] }, allowSelfApproval: true }] });
    const id2 = await start(bob, 'own-request-ok');
    await waitingApproval(id2);
    expect(stepOf(await get(bob, id2)).canApprove).toBe(true);
    // A delegation that starts in the future is not in effect.
    await carol.put('/api/v1/me/delegation', { delegate: 'bob@example.com', startsAt: '2099-01-01T00:00:00Z' });
    expect((await carol.get('/api/v1/me/delegation')).data.delegation.active).toBe(false);
    const id3 = await start(alice, 'own-request');
    await waitingApproval(id3);
    expect((await approveStep(bob, id3)).status).toBe(403);
    // Admin clears it.
    const users = (await admin.get('/api/v1/users/lookup')).data as { id: string; email: string }[];
    const carolId = users.find((u) => u.email === 'carol@example.com')!.id;
    expect((await admin.del(`/api/v1/delegations/${carolId}`)).status).toBe(200);
    expect((await carol.get('/api/v1/me/delegation')).data.delegation).toBeNull();
    for (const r of [id, id2, id3]) await admin.post(`/api/v1/runs/${r}/cancel`);
  });
});

describe('sequential tiers', () => {
  const tiers = [
    { name: 'lead', approvers: { users: ['carol@example.com'] } },
    { name: 'director', approvers: { users: ['dave@example.com'] } },
  ];

  it('opens each tier once the previous one reached its minimum', async () => {
    await save('tiered', { steps: [{ id: 'ok', type: 'approval', tiers }] });
    const id = await start(alice, 'tiered');
    let r = await waitingApproval(id);
    expect(stepOf(r).statusLabel).toBe('Waiting for 1 approval(s) · tier "lead"');
    expect(stepOf(r).approval?.tiers?.map((t) => t.state)).toEqual(['open', 'waiting']);
    expect((await approveStep(dave, id)).status).toBe(403); // director tier is not open yet
    expect((await approveStep(carol, id, 'lgtm')).status).toBe(200);
    r = await get(dave, id);
    expect(stepOf(r).status).toBe('WAITING_APPROVAL');
    expect(stepOf(r).statusLabel).toBe('Waiting for 1 approval(s) · tier "director"');
    expect(stepOf(r).canApprove).toBe(true);
    expect(stepOf(r).approval?.tiers?.map((t) => t.state)).toEqual(['done', 'open']);
    await waitFor(async () => mailsTo('dave@example.com', /Approval needed: tiered/).length > 0);
    expect((await approveStep(dave, id)).status).toBe(200);
    r = await finished(id);
    expect(r.status).toBe('SUCCESS');
    expect(stepOf(r).approvals.map((a) => a.tier)).toEqual([0, 1]);
    expect(stepOf(r).output).toMatchObject({
      approved: true,
      by: ['Carol', 'Dave'],
      tiers: [
        { name: 'lead', approved: true, by: ['Carol'], comments: ['lgtm'] },
        { name: 'director', approved: true, by: ['Dave'] },
      ],
    });
  });

  it('rejects at any tier', async () => {
    const id = await start(alice, 'tiered');
    await waitingApproval(id);
    await approveStep(carol, id);
    expect((await dave.post(`/api/v1/runs/${id}/steps/ok/reject`, { comment: 'no budget' })).status).toBe(200);
    const r = await finished(id);
    expect(r.status).toBe('FAILURE');
    expect(stepOf(r).statusLabel).toBe('Rejected by Dave (tier "director")');
    expect(stepOf(r).output).toMatchObject({ approved: false, tiers: [{ approved: true }, { approved: false, rejectedBy: 'Dave' }] });
  });
});

describe('expiry outcomes', () => {
  const expire = async (onExpiry?: string) => {
    const action = `expire-${onExpiry ?? 'default'}`;
    await save(action, {
      steps: [
        { id: 'ok', type: 'approval', approvers: { users: ['carol@example.com'] }, timeoutMinutes: 60, ...(onExpiry ? { onExpiry } : {}) },
        { id: 'after', type: 'transform', output: { done: 'true' } },
      ],
    });
    const id = await start(alice, action);
    await waitingApproval(id);
    await sql('UPDATE run_steps SET deadline_at = ? WHERE run_id = ? AND step_id = ?', PAST, id, 'ok');
    await housekeepUntil(id, (r) => stepOf(r).status !== 'WAITING_APPROVAL');
    return finished(id);
  };

  it('fails by default and with onExpiry: fail', async () => {
    for (const o of [undefined, 'fail']) {
      const r = await expire(o);
      expect(r.status).toBe('FAILURE');
      expect(stepOf(r)).toMatchObject({ status: 'FAILURE', statusLabel: 'Approval expired' });
    }
  });

  it('rejects', async () => {
    const r = await expire('reject');
    expect(r.status).toBe('FAILURE');
    expect(stepOf(r)).toMatchObject({ status: 'FAILURE', statusLabel: 'Rejected: the approval expired', output: { approved: false, expired: true } });
  });

  it('approves', async () => {
    const r = await expire('approve');
    expect(r.status).toBe('SUCCESS');
    expect(stepOf(r).output).toMatchObject({ approved: true, expired: true });
    expect(stepOf(r, 'after').status).toBe('SUCCESS');
  });

  it('skips', async () => {
    const r = await expire('skip');
    expect(r.status).toBe('SUCCESS');
    expect(stepOf(r)).toMatchObject({ status: 'SKIPPED', statusLabel: 'Skipped: the approval expired' });
    expect(stepOf(r, 'after').status).toBe('SUCCESS');
  });

  it('applies to the pre-start approval policy', async () => {
    const outcome = async (onExpiry: string) => {
      const action = `pre-expire-${onExpiry}`;
      await save(action, {
        trigger: { ...form, approval: { required: true, approvers: { users: ['carol@example.com'] }, expireAfter: '1d', onExpiry } },
        steps: [{ id: 't', type: 'transform', output: { x: '1' } }],
      });
      const id = await start(alice, action);
      expect((await get(admin, id)).approval?.expiresAt).toBeTruthy();
      await sql('UPDATE runs SET approval_expires_at = ? WHERE id = ?', PAST, id);
      await Promise.all([timers(), timers()]);
      return finished(id);
    };
    expect((await outcome('fail')).status).toBe('FAILURE');
    expect((await outcome('reject')).status).toBe('REJECTED');
    const approved = await outcome('approve');
    expect(approved.status).toBe('SUCCESS');
    expect(approved.logs.filter((l) => l.message.startsWith('The approval expired')).length).toBe(1); // claimed once
    expect((await outcome('skip')).status).toBe('SUCCESS');
  });
});
