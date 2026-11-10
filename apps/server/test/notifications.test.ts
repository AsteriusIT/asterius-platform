import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { client, fakeServer, register, silentLog, testApp, waitFor, type Api } from './helpers.js';
import { startRunWorker } from '../src/actions/worker.js';
import { setMailTransportFactory } from '../src/notifications/channels.js';

let app: FastifyInstance;
let admin: Api;
let alice: Api;
let carol: Api;
let ext: Awaited<ReturnType<typeof fakeServer>>;
let stop: () => unknown;
const mails: { to: string[]; subject: string; text?: string; from: string }[] = [];

const form = { type: 'form', on: 'create', inputs: { properties: { name: { type: 'string' } } } };
const finished = (api: Api, id: string) =>
  waitFor(async () => {
    const r = (await api.get(`/api/v1/runs/${id}`)).data as { status: string; steps: { id: string; output: unknown; statusLabel: string | null }[] };
    return ['SUCCESS', 'FAILURE'].includes(r.status) && r;
  }, 20_000);
const start = async (api: Api, id: string, inputs: object = {}) => (await api.post(`/api/v1/actions/${id}/runs`, { inputs })).data.id as string;

beforeAll(async () => {
  app = await testApp();
  admin = client(app, (await register(app, 'admin@example.com')).token);
  alice = client(app, (await register(app, 'alice@example.com', 'Alice')).token);
  carol = client(app, (await register(app, 'carol@example.com', 'Carol')).token);
  ext = await fakeServer((r) => {
    if (r.url.startsWith('/slack/users.lookupByEmail'))
      return { body: r.url.includes('alice') ? { ok: true, user: { id: 'U123' } } : { ok: false, error: 'users_not_found' } };
    if (r.url.startsWith('/slack/chat.postMessage')) return { body: { ok: true, channel: 'C1', ts: '1.2' } };
    return { body: { ok: true } };
  });
  setMailTransportFactory(
    () =>
      ({
        sendMail: async (m: { to: string[]; subject: string; text?: string; from: string }) => {
          mails.push({ to: m.to, subject: m.subject, text: m.text, from: m.from });
          return { messageId: `m${mails.length}` };
        },
      }) as never,
  );
  await admin.put('/api/v1/secrets/SLACK_BOT', { value: 'xoxb-test-token-value', description: '' });
  stop = startRunWorker(silentLog);
});
afterAll(async () => {
  await stop();
  await ext.close();
  await app.close();
});

describe('settings and preferences', () => {
  it('stores defaults for admins and preferences per user', async () => {
    expect((await alice.get('/api/v1/notification-settings')).status).toBe(403);
    const put = await admin.put('/api/v1/notification-settings', {
      slack: { botToken: '${secret:SLACK_BOT}', defaultChannel: '#ops' },
      teams: { webhookUrl: `${ext.url}/teams` },
      email: { smtpUrl: 'smtp://mail.example.test:25', from: 'platform@example.com' },
    });
    expect(put.status, JSON.stringify(put.data)).toBe(200);
    expect((await admin.get('/api/v1/notification-settings')).data.slack.defaultChannel).toBe('#ops');
    expect((await alice.get('/api/v1/me/notifications')).data).toEqual({ approvals: ['email'], runs: [] });
    expect((await alice.put('/api/v1/me/notifications', { approvals: ['email'], runs: ['email'] })).status).toBe(200);
    expect((await alice.put('/api/v1/me/notifications', { approvals: ['sms'] })).status).toBe(400);
    expect((await alice.get('/api/v1/notifications/channels')).data).toEqual({ email: true, slack: true });
  });
});

describe('notification invokers', () => {
  it('posts to Slack, resolving mentions by email', async () => {
    await admin.put('/api/v1/actions/slack-it', {
      title: 'slack',
      trigger: form,
      steps: [
        {
          id: 'say',
          type: 'invoke',
          invoker: { type: 'slack', apiUrl: `${ext.url}/slack`, text: 'Hello {{ inputs.name }}', mentions: ['alice@example.com', 'nobody@example.com'] },
        },
      ],
    });
    const r = await finished(alice, await start(alice, 'slack-it', { name: 'team' }));
    expect(r.status).toBe('SUCCESS');
    const post = ext.received.find((x) => x.url.startsWith('/slack/chat.postMessage'))!;
    expect(post.headers.authorization).toBe('Bearer xoxb-test-token-value');
    expect(JSON.parse(post.body)).toEqual({ channel: '#ops', text: '<@U123> nobody@example.com Hello team' });
    expect(r.steps[0].output).toEqual({ channel: 'C1', ts: '1.2' });
  });

  it('posts an Adaptive Card to Teams', async () => {
    await admin.put('/api/v1/actions/teams-it', {
      title: 'teams',
      trigger: form,
      steps: [{ id: 'say', type: 'invoke', invoker: { type: 'teams', title: 'Done', text: '{{ inputs.name }} is ready', mentions: ['alice@example.com'] } }],
    });
    expect((await finished(alice, await start(alice, 'teams-it', { name: 'db' }))).status).toBe('SUCCESS');
    const post = ext.received.find((x) => x.url === '/teams')!;
    const card = JSON.parse(post.body).attachments[0].content;
    expect(card.body[0].text).toBe('Done');
    expect(card.body[1].text).toBe('<at>alice</at> db is ready');
    expect(card.msteams.entities[0].mentioned.id).toBe('alice@example.com');
  });

  it('sends email with the default sender', async () => {
    await admin.put('/api/v1/actions/mail-it', {
      title: 'mail',
      trigger: form,
      steps: [{ id: 'mail', type: 'invoke', invoker: { type: 'email', to: ['{{ trigger.user.email }}'], subject: 'Hi {{ inputs.name }}', text: 'Body' } }],
    });
    expect((await finished(alice, await start(alice, 'mail-it', { name: 'Al' }))).status).toBe('SUCCESS');
    expect(mails.find((m) => m.subject === 'Hi Al')).toMatchObject({ to: ['alice@example.com'], from: 'platform@example.com', text: 'Body' });
  });

  it('validates configurations when the workflow is saved', async () => {
    expect(
      (await admin.put('/api/v1/actions/bad', { title: 'x', trigger: form, steps: [{ id: 's', type: 'invoke', invoker: { type: 'email', to: ['a@b.c'] } }] }))
        .status,
    ).toBe(400);
    expect(
      (await admin.put('/api/v1/actions/bad', { title: 'x', trigger: form, steps: [{ id: 's', type: 'invoke', invoker: { type: 'slack' } }] })).data.error,
    ).toMatch(/missing text/);
  });
});

describe('platform notifications', () => {
  it('asks approvers by email and tells the requester about the outcome', async () => {
    await admin.put('/api/v1/actions/needs-ok', {
      title: 'Needs OK',
      trigger: { ...form, approval: { required: true, approvers: { users: ['carol@example.com'] } } },
      steps: [{ id: 't', type: 'transform', output: { v: '1' } }],
    });
    mails.length = 0;
    const id = await start(alice, 'needs-ok', { name: 'x' });
    await waitFor(async () => mails.find((m) => m.to[0] === 'carol@example.com'));
    expect(mails.find((m) => m.to[0] === 'carol@example.com')!.subject).toBe('Approval needed: Needs OK');
    expect(mails.find((m) => m.to[0] === 'admin@example.com')).toBeUndefined(); // not an approver of this action
    expect((await carol.post(`/api/v1/runs/${id}/approve`, {})).status).toBe(200);
    await finished(alice, id);
    const done = await waitFor(async () => mails.find((m) => m.to[0] === 'alice@example.com' && m.subject === 'Needs OK succeeded'));
    expect(done.text).toMatch(new RegExp(`http://platform\\.test/o/[a-z0-9-]+/runs/${id}`)); // opens in the run's organization
  });
});
