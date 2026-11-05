import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { client, fakeServer, register, silentLog, testApp, waitFor, type Api } from './helpers.js';
import { startRunWorker } from '../src/actions/worker.js';
import { startDeliveryWorker } from '../src/webhooks/webhooks.js';

let app: FastifyInstance;
let admin: Api;
let alice: Api; // payments member
let carol: Api; // payments member (second approver)
let bob: Api; // no team
let ext: Awaited<ReturnType<typeof fakeServer>>;
const stops: (() => unknown)[] = [];

const runStatus = async (api: Api, id: string, want: string[]) =>
  waitFor(async () => {
    const r = await api.get(`/api/v1/runs/${id}`);
    return want.includes(r.data.status) && r.data;
  });

beforeAll(async () => {
  app = await testApp();
  admin = client(app, (await register(app, 'admin@example.com')).token);
  const a = await register(app, 'alice@example.com');
  const c = await register(app, 'carol@example.com');
  alice = client(app, a.token);
  carol = client(app, c.token);
  bob = client(app, (await register(app, 'bob@example.com')).token);
  await admin.put('/api/v1/teams/payments', { title: 'Payments' });
  await admin.patch(`/api/v1/users/${a.user.id}`, { teams: ['payments'] });
  await admin.patch(`/api/v1/users/${c.user.id}`, { teams: ['payments'] });
  await admin.put('/api/v1/blueprints/service', { title: 'Service', schema: { properties: { tier: { type: 'integer' } } } });
  await admin.put('/api/v1/blueprints/service/entities/api', { team: 'payments', properties: { tier: 1 } });
  await admin.put('/api/v1/secrets/SIGNING', { value: 'signing-key-123' });

  ext = await fakeServer((r) =>
    r.url.startsWith('/fail') ? { status: 500, body: { error: 'boom' } } : { status: 200, body: { accepted: true, echo: r.url } },
  );
  stops.push(startRunWorker(silentLog), startDeliveryWorker(silentLog));
});
afterAll(async () => {
  for (const s of stops) await s();
  await ext.close();
  await app.close();
});

describe('self-service actions', () => {
  it('validates invoker configuration and templates on save', async () => {
    expect((await admin.put('/api/v1/actions/x', { title: 'X', invoker: { type: 'nope' } })).data.error).toMatch(/Unknown invoker/);
    expect((await admin.put('/api/v1/actions/x', { title: 'X', invoker: { type: 'webhook' } })).data.error).toMatch(/missing url/);
    expect((await admin.put('/api/v1/actions/x', { title: 'X', invoker: { type: 'webhook', url: 'http://x/{{ ( }}' } })).data.error).toMatch(
      /Invalid expression/,
    );
    expect((await admin.put('/api/v1/actions/x', { title: 'X', trigger: 'day-2', invoker: { type: 'webhook', url: 'http://x' } })).data.error).toMatch(
      /need a blueprint/,
    );
  });

  it('runs a synchronous webhook with rendered, signed and redacted payload', async () => {
    const saved = await admin.put('/api/v1/actions/notify', {
      title: 'Notify',
      blueprint: 'service',
      trigger: 'day-2',
      inputs: { properties: { message: { type: 'string' } }, required: ['message'] },
      invoker: {
        type: 'webhook',
        url: `${ext.url}/hook/{{ entity.identifier }}`,
        headers: { authorization: 'Bearer ${secret:SIGNING}' },
        body: { text: '{{ inputs.message }} by {{ trigger.user.email }}', tier: '{{ entity.properties.tier }}' },
        secret: '${secret:SIGNING}',
      },
    });
    expect(saved.status, JSON.stringify(saved.data)).toBe(200);
    // Non-admins never see invoker details.
    expect((await bob.get('/api/v1/actions/notify')).data.invoker).toEqual({ type: 'webhook' });

    const run = await alice.post('/api/v1/actions/notify/runs', { entity: 'api', inputs: { message: 'hello' } });
    expect(run.status, JSON.stringify(run.data)).toBe(201);
    const done = await runStatus(alice, run.data.id, ['SUCCESS', 'FAILURE']);
    expect(done.status).toBe('SUCCESS');
    expect(done.result).toEqual({ run: { accepted: true, echo: '/hook/api' } }); // outputs by step id (one-step workflow: `run`)

    const req = ext.received.find((r) => r.url === '/hook/api')!;
    expect(JSON.parse(req.body)).toEqual({ text: 'hello by alice@example.com', tier: 1 });
    expect(req.headers['x-asterius-signature']).toBe(`sha256=${createHmac('sha256', 'signing-key-123').update(req.body).digest('hex')}`);
    expect(JSON.stringify(done.logs)).not.toContain('signing-key-123');
  });

  it('fails the run with the upstream error', async () => {
    await admin.put('/api/v1/actions/broken', { title: 'Broken', invoker: { type: 'webhook', url: `${ext.url}/fail` } });
    const run = await alice.post('/api/v1/actions/broken/runs', {});
    const done = await runStatus(alice, run.data.id, ['SUCCESS', 'FAILURE']);
    expect(done.status).toBe('FAILURE');
    expect(done.logs.at(-2).message).toMatch(/→ 500/);
  });

  it('completes async runs through the callback API with the run token only', async () => {
    let callback: { url: string; token: string } | undefined;
    const cb = await fakeServer((r) => {
      callback = JSON.parse(r.body).callback;
      return { status: 202 };
    });
    await admin.put('/api/v1/actions/provision', {
      title: 'Provision',
      invoker: { type: 'webhook', url: cb.url, mode: 'async', body: { callback: '{{ run.callback }}' } },
    });
    const run = await alice.post('/api/v1/actions/provision/runs', {});
    await runStatus(alice, run.data.id, ['IN_PROGRESS']);
    await waitFor(async () => callback);
    expect(callback!.url).toBe(`http://platform.test/api/v1/runs/${run.data.id}/steps/run`); // scoped to the step

    const path = `/api/v1/runs/${run.data.id}/steps/run`;
    expect((await client(app, 'astrun_forged').patch(path, { status: 'SUCCESS' })).status).toBe(403);
    expect((await alice.patch(path, { status: 'SUCCESS' })).status).toBe(403); // a user token is not enough
    const svc = client(app, callback!.token);
    expect((await svc.post(`${path}/logs`, { message: 'terraform apply: 3 added' })).status).toBe(200);
    const fin = await svc.patch(path, { status: 'SUCCESS', link: 'https://ci.example/run/1', result: { url: 'https://new.example' } });
    expect(fin.data.status).toBe('SUCCESS');
    expect((await svc.patch(path, { status: 'FAILURE' })).status).toBe(409); // final is final
    const r = await alice.get(`/api/v1/runs/${run.data.id}`);
    expect(r.data.link).toBe('https://ci.example/run/1');
    expect(r.data.logs.map((l: { message: string }) => l.message)).toContain('terraform apply: 3 added');
    await cb.close();
  });

  it('enforces who may trigger', async () => {
    await admin.put('/api/v1/actions/team-only', {
      title: 'Team only',
      blueprint: 'service',
      trigger: 'day-2',
      allowed: { ownerTeam: true },
      invoker: { type: 'catalog', blueprint: 'service', identifier: '{{ entity.identifier }}', merge: true, properties: { tier: 3 } },
    });
    expect((await bob.post('/api/v1/actions/team-only/runs', { entity: 'api' })).status).toBe(403);
    const actions = await bob.get('/api/v1/blueprints/service/entities/api/actions');
    expect(actions.data.find((a: { identifier: string }) => a.identifier === 'team-only').allowedForMe).toBe(false);
    const run = await alice.post('/api/v1/actions/team-only/runs', { entity: 'api' });
    expect((await runStatus(alice, run.data.id, ['SUCCESS', 'FAILURE'])).status).toBe('SUCCESS');
    expect((await bob.get('/api/v1/blueprints/service/entities/api')).data.properties.tier).toBe(3);
  });
});

describe('approvals', () => {
  beforeAll(async () => {
    await admin.put('/api/v1/actions/prod-change', {
      title: 'Prod change',
      blueprint: 'service',
      trigger: 'day-2',
      inputs: { properties: { reason: { type: 'string' } } },
      approval: { required: true, approvers: { ownerTeam: true }, minApprovals: 1 },
      invoker: { type: 'webhook', url: `${ext.url}/prod` },
    });
  });

  it('needs an approver other than the requester, from the owning team', async () => {
    const run = await alice.post('/api/v1/actions/prod-change/runs', { entity: 'api', inputs: { reason: 'hotfix' } });
    expect(run.data.status).toBe('PENDING_APPROVAL');
    expect((await alice.get('/api/v1/approvals')).data).toHaveLength(0); // no self-approval
    expect((await bob.post(`/api/v1/runs/${run.data.id}/approve`, {})).status).toBe(403); // not in the team
    expect((await carol.get('/api/v1/approvals')).data.map((r: { id: string }) => r.id)).toEqual([run.data.id]);
    const approved = await carol.post(`/api/v1/runs/${run.data.id}/approve`, { comment: 'lgtm' });
    expect(approved.data.status).toBe('QUEUED');
    expect((await runStatus(alice, run.data.id, ['SUCCESS', 'FAILURE'])).approvals[0]).toMatchObject({
      userName: 'carol',
      decision: 'approved',
      comment: 'lgtm',
    });
  });

  it('rejects with a reason, and lets the requester cancel', async () => {
    const r1 = await alice.post('/api/v1/actions/prod-change/runs', { entity: 'api' });
    expect((await carol.post(`/api/v1/runs/${r1.data.id}/reject`, {})).status).toBe(400);
    expect((await carol.post(`/api/v1/runs/${r1.data.id}/reject`, { comment: 'not now' })).data.status).toBe('REJECTED');
    const r2 = await alice.post('/api/v1/actions/prod-change/runs', { entity: 'api' });
    expect((await bob.post(`/api/v1/runs/${r2.data.id}/cancel`, {})).status).toBe(403);
    expect((await alice.post(`/api/v1/runs/${r2.data.id}/cancel`, {})).data.status).toBe('CANCELLED');
  });
});

describe('outbound webhooks', () => {
  it('delivers signed catalog events', async () => {
    const sink = await fakeServer();
    const saved = await admin.put('/api/v1/webhooks/sink', {
      title: 'Sink',
      url: sink.url,
      events: ['entity.*'],
      blueprints: ['service'],
      secret: '${secret:SIGNING}',
    });
    expect(saved.status, JSON.stringify(saved.data)).toBe(200);
    expect(saved.data.hasSecret).toBe(true);
    await new Promise((r) => setTimeout(r, 50));
    await admin.put('/api/v1/blueprints/service/entities/hooked', { team: 'payments', properties: { tier: 2 } });
    const got = await waitFor(async () => sink.received.find((r) => JSON.parse(r.body).data.entity?.identifier === 'hooked'), 20_000);
    const evt = JSON.parse(got.body);
    expect(evt.type).toBe('entity.created');
    expect(got.headers['x-asterius-signature']).toBe(`sha256=${createHmac('sha256', 'signing-key-123').update(got.body).digest('hex')}`);
    const deliveries = await admin.get('/api/v1/webhooks/sink/deliveries');
    expect(deliveries.data.some((d: { status: string }) => d.status === 'success')).toBe(true);
    await sink.close();
  });
});
