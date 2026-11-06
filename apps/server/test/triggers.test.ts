import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { client, register, testApp, type Api } from './helpers.js';
import { run as exec } from '../src/db.js';
import { fireDueSchedules } from '../src/actions/triggers.js';
import { nextCron, parseCron } from '../src/lib/cron.js';

let app: FastifyInstance;
let admin: Api;
let alice: Api;

const steps = [{ id: 't', type: 'transform', output: { v: '1' } }];
const put = (id: string, body: object) => admin.put(`/api/v1/actions/${id}`, { title: id, steps, ...body });
const runsOf = async (action: string) =>
  (await admin.get(`/api/v1/runs?action=${action}`)).data.items as {
    id: string;
    inputs: Record<string, unknown>;
    trigger: Record<string, unknown>;
    entity: string | null;
  }[];

beforeAll(async () => {
  app = await testApp();
  admin = client(app, (await register(app, 'admin@example.com')).token);
  alice = client(app, (await register(app, 'alice@example.com')).token);
  await admin.put('/api/v1/blueprints/service', { title: 'Service', schema: { properties: { tier: { type: 'string' } } } });
});
afterAll(async () => {
  await app.close();
});

describe('cron', () => {
  it('computes the next tick in a time zone', () => {
    const at = (s: string) => Date.parse(s);
    expect(new Date(nextCron(parseCron('*/15 * * * *'), at('2026-01-01T10:07:00Z'))!).toISOString()).toBe('2026-01-01T10:15:00.000Z');
    // 09:00 in Paris (UTC+1 in winter, UTC+2 in summer)
    expect(new Date(nextCron(parseCron('0 9 * * *'), at('2026-01-01T10:00:00Z'), 'Europe/Paris')!).toISOString()).toBe('2026-01-02T08:00:00.000Z');
    expect(new Date(nextCron(parseCron('0 9 * * *'), at('2026-07-01T10:00:00Z'), 'Europe/Paris')!).toISOString()).toBe('2026-07-02T07:00:00.000Z');
    // Mondays at midnight
    expect(new Date(nextCron(parseCron('0 0 * * 1'), at('2026-01-01T00:00:00Z'))!).toISOString()).toBe('2026-01-05T00:00:00.000Z');
    expect(() => parseCron('61 * * * *')).toThrow();
    expect(() => parseCron('* * *')).toThrow();
  });
});

describe('trigger definitions', () => {
  it('validates triggers', async () => {
    expect((await put('bad', { trigger: { type: 'schedule', cron: 'nope' } })).data.error).toMatch(/cron/i);
    expect((await put('bad', { trigger: { type: 'schedule', cron: '* * * * *', timezone: 'Mars/Base' } })).data.error).toMatch(/time zone/);
    expect((await put('bad', { trigger: { type: 'event', event: 'entity.created', filter: 'event.(' } })).data.error).toMatch(/Invalid expression/);
    expect((await put('bad', { trigger: { type: 'event', event: 'run.finished', action: 'bad' } })).data.error).toMatch(/own runs/);
    const ok = await put('nightly', { trigger: { type: 'schedule', cron: '0 3 * * *', timezone: 'Europe/Paris' } });
    expect(ok.status, JSON.stringify(ok.data)).toBe(200);
    expect(ok.data.trigger).toMatchObject({ type: 'schedule', cron: '0 3 * * *', timezone: 'Europe/Paris' });
    expect(ok.data.trigger.nextRunAt).toBeTruthy();
  });

  it('refuses to start automatic triggers by hand', async () => {
    const res = await alice.post('/api/v1/actions/nightly/runs', {});
    expect(res.status).toBe(400);
    expect(res.data.error).toMatch(/schedule trigger/);
  });
});

describe('schedule', () => {
  it('starts exactly one run per tick, even when replicas race', async () => {
    await put('tick', { trigger: { type: 'schedule', cron: '* * * * *', inputs: { when: '{{ schedule.at }}', fixed: 'x' } } });
    const past = new Date(Date.now() - 5 * 60_000).toISOString();
    await exec('UPDATE actions SET next_fire_at = ? WHERE identifier = ?', past, 'tick');
    const started = await Promise.all([fireDueSchedules(), fireDueSchedules(), fireDueSchedules()]);
    expect(started.reduce((a, b) => a + b, 0)).toBe(1);
    const runs = await runsOf('tick');
    expect(runs).toHaveLength(1);
    expect(runs[0].inputs).toEqual({ when: past, fixed: 'x' });
    expect(runs[0].trigger).toMatchObject({ type: 'schedule' });
    expect(await fireDueSchedules()).toBe(0); // next tick is in the future
  });
});

describe('event', () => {
  it('starts on matching catalog events only', async () => {
    const r = await put('on-gold', {
      trigger: {
        type: 'event',
        event: 'entity.created',
        blueprint: 'service',
        filter: 'event.entity.properties.tier = "gold"',
        inputs: { name: '{{ event.entity.identifier }}' },
      },
    });
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    await admin.put('/api/v1/blueprints/service/entities/api-a', { properties: { tier: 'gold' } });
    await admin.put('/api/v1/blueprints/service/entities/api-b', { properties: { tier: 'bronze' } });
    const runs = await runsOf('on-gold');
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ inputs: { name: 'api-a' }, entity: 'api-a', trigger: { type: 'event', event: 'entity.created' } });
  });

  it('chains on run.finished of another action, with a depth limit', async () => {
    await put('after', { trigger: { type: 'event', event: 'run.finished', action: 'first', inputs: { parent: '{{ event.run.id }}' } } });
    await put('first', { trigger: { type: 'api', inputs: { properties: {} } } });
    const started = await alice.post('/api/v1/actions/first/runs', {});
    expect(started.status).toBe(201);
    // Nothing runs the workflow here: cancel the run, which finishes it.
    expect((await alice.post(`/api/v1/runs/${started.data.id}/cancel`)).status).toBe(200);
    const runs = await runsOf('after');
    expect(runs).toHaveLength(1);
    expect(runs[0].inputs.parent).toBe(started.data.id);
  });
});

describe('webhook and api', () => {
  const body = JSON.stringify({ repo: 'payments', ref: 'main' });

  it('runs the workflow when the secret matches', async () => {
    await admin.put('/api/v1/secrets/HOOK_SECRET', { value: 'topsecret-value', description: 'test' });
    const r = await put('hooked', { trigger: { type: 'webhook', secret: '${secret:HOOK_SECRET}', inputs: { repo: '{{ body.repo }}' } } });
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    const anon = client(app);
    expect((await anon.post('/api/v1/hooks/hooked', { repo: 'x' })).status).toBe(401);
    expect((await anon.post('/api/v1/hooks/hooked', { repo: 'x' }, { 'x-asterius-token': 'wrong-value-here' })).status).toBe(401);
    const ok = await anon.post('/api/v1/hooks/hooked', JSON.parse(body), { 'x-asterius-token': 'topsecret-value' });
    expect(ok.status).toBe(202);
    expect((await runsOf('hooked'))[0]).toMatchObject({ inputs: { repo: 'payments' }, trigger: { type: 'webhook' } });
    expect((await anon.post('/api/v1/hooks/nope', {}, { 'x-asterius-token': 'topsecret-value' })).status).toBe(404);
  });

  it('verifies HMAC signatures over the raw body', async () => {
    await put('signed', { trigger: { type: 'webhook', secret: '${secret:HOOK_SECRET}', signatureHeader: 'X-Signature', inputs: {} } });
    const sig = `sha256=${createHmac('sha256', 'topsecret-value').update(body).digest('hex')}`;
    const anon = client(app);
    expect((await anon.post('/api/v1/hooks/signed', JSON.parse(body), { 'x-signature': 'sha256=00' })).status).toBe(401);
    expect((await anon.post('/api/v1/hooks/signed', JSON.parse(body), { 'x-signature': sig })).status).toBe(202);
  });

  it('api triggers take inputs from the API and are hidden from the self-service lists', async () => {
    await put('apionly', { trigger: { type: 'api', on: 'create', inputs: { properties: { n: { type: 'string' } }, required: ['n'] } } });
    expect((await alice.post('/api/v1/actions/apionly/runs', { inputs: {} })).status).toBe(400);
    const ok = await alice.post('/api/v1/actions/apionly/runs', { inputs: { n: 'a' } });
    expect(ok.status).toBe(201);
    expect(ok.data.trigger).toMatchObject({ type: 'api' });
    const forms = (await alice.get('/api/v1/actions?trigger=create')).data as { identifier: string }[];
    expect(forms.map((a) => a.identifier)).not.toContain('apionly');
  });
});
