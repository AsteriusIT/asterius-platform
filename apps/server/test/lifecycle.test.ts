import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { client, fakeServer, register, silentLog, testApp, waitFor, type Api } from './helpers.js';
import { startRunWorker } from '../src/actions/worker.js';
import { LEASES, stepHousekeeping } from '../src/actions/engine.js';
import { addLog } from '../src/actions/runs.js';
import { registerInvoker } from '../src/actions/invokers/index.js';
import { config } from '../src/config.js';
import * as events from '../src/events.js';
import { all, migrate, one, sqliteDriver } from '../src/db.js';
import { beat, registerLoop } from '../src/health.js';

/**
 * Engine tests with a live worker: lease heartbeat (ap-na0.1), cancellation of in-flight starts (ap-na0.7),
 * outbox atomicity (ap-na0.5), idempotency keys (ap-na0.9), bounded logs (ap-na0.10), migrations (ap-na0.11)
 * and loop liveness (ap-na0.12).
 */

let app: FastifyInstance;
let admin: Api;
let alice: Api;
const stops: (() => unknown)[] = [];

type RunView = {
  id: string;
  status: string;
  statusLabel: string | null;
  logs: { seq: number; message: string }[];
  logsTruncated?: boolean;
  steps: { id: string; status: string }[];
};
const view = async (id: string) => (await alice.get(`/api/v1/runs/${id}`)).data as RunView;
const finished = (id: string) =>
  waitFor(async () => {
    const r = await view(id);
    return ['SUCCESS', 'FAILURE', 'CANCELLED', 'REJECTED'].includes(r.status) && r;
  });
const trigger = async (action: string, inputs: object = {}, headers?: Record<string, string>) =>
  alice.post(`/api/v1/actions/${action}/runs`, { inputs }, headers);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A server that answers after `delayMs`, counting the requests. */
async function slowServer(delayMs: number) {
  const hits: string[] = [];
  const server = http.createServer((req, res) => {
    hits.push(req.url ?? '');
    setTimeout(() => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    }, delayMs);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, hits, close: () => new Promise((r) => server.close(r)) };
}

const cancelled: Record<string, unknown>[] = [];

beforeAll(async () => {
  app = await testApp();
  admin = client(app, (await register(app, 'admin@example.com')).token);
  alice = client(app, (await register(app, 'alice@example.com')).token);
  await admin.put('/api/v1/blueprints/thing', { title: 'Thing', schema: { properties: { n: { type: 'integer' } } } });
  // An async job whose start call takes a while and which can be cancelled.
  registerInvoker({
    info: { type: 'slowjob', title: 'Slow job', description: 'test', fields: [], example: { type: 'slowjob' } },
    validate() {},
    async start() {
      await sleep(600);
      return { status: 'IN_PROGRESS', state: { job: 'j-1' } };
    },
    async poll(_env, state) {
      return { status: 'IN_PROGRESS', state };
    },
    async cancel(_env, state) {
      cancelled.push(state);
    },
  });
  stops.push(startRunWorker(silentLog));
});
afterAll(async () => {
  for (const s of stops) await s();
  await app.close();
});

describe('lease heartbeat (ap-na0.1)', () => {
  it('keeps a long step leased: housekeeping neither re-queues nor fails it, and it runs once', async () => {
    const slow = await slowServer(1800);
    const saved = { ...LEASES };
    LEASES.invoke = 600; // heartbeat every 200 ms
    try {
      await admin.put('/api/v1/actions/long', {
        title: 'Long',
        trigger: 'create',
        steps: [{ id: 'call', type: 'invoke', invoker: { type: 'webhook', url: `${slow.url}/long`, mode: 'sync' } }],
      });
      const id = (await trigger('long')).data.id as string;
      await waitFor(async () => (await view(id)).steps.find((s) => s.id === 'call')?.status === 'RUNNING');
      await sleep(900); // well past the original lease
      await stepHousekeeping(silentLog);
      await sleep(300);
      await stepHousekeeping(silentLog);
      const done = await finished(id);
      expect(done.status).toBe('SUCCESS');
      expect(slow.hits).toHaveLength(1);
    } finally {
      Object.assign(LEASES, saved);
      await slow.close();
    }
  });
});

describe('cancelling while a step is starting (ap-na0.7)', () => {
  it('stops the external job that was started while the cancel request was in flight', async () => {
    await admin.put('/api/v1/actions/jobby', {
      title: 'Jobby',
      trigger: 'create',
      steps: [{ id: 'job', type: 'invoke', invoker: { type: 'slowjob' } }],
    });
    const id = (await trigger('jobby')).data.id as string;
    await waitFor(async () => (await view(id)).steps.find((s) => s.id === 'job')?.status === 'RUNNING');
    expect((await alice.post(`/api/v1/runs/${id}/cancel`, {})).data.status).toBe('CANCELLED'); // start() is still running
    await waitFor(async () => cancelled.length > 0);
    expect(cancelled).toEqual([{ job: 'j-1' }]);
    const r = await view(id);
    expect(r.status).toBe('CANCELLED');
    expect(r.steps.map((s) => s.status)).toEqual(['CANCELLED']);
  });
});

describe('outbox atomicity (ap-na0.5)', () => {
  it('fails the entity write, and leaves no entity, when the event cannot be queued', async () => {
    const sink = await fakeServer();
    expect((await admin.put('/api/v1/webhooks/sink', { title: 'Sink', url: sink.url, events: ['entity.*'], blueprints: ['thing'] })).status).toBe(200);
    // The first write commits entity and event together.
    expect((await admin.put('/api/v1/blueprints/thing/entities/ok', { properties: { n: 1 } })).status).toBe(200);
    expect(Number((await one<{ n: number }>("SELECT count(*) AS n FROM deliveries WHERE event = 'entity.created'"))?.n)).toBe(1);

    // The outbox insert runs on the write's own transaction connection (a pooled client on Postgres): fail it there.
    const realPrepare = events.prepareEvents;
    const spy = vi.spyOn(events, 'prepareEvents').mockImplementation(async (list) => {
      const write = await realPrepare(list);
      return async (d) => {
        if (d) throw new Error('outbox unavailable');
        return write(d);
      };
    });
    const res = await admin.put('/api/v1/blueprints/thing/entities/lost', { properties: { n: 2 } });
    spy.mockRestore();
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect((await admin.get('/api/v1/blueprints/thing/entities/lost')).status).toBe(404); // rolled back with the event
    await sink.close();
  });
});

describe('idempotency keys (ap-na0.9)', () => {
  it('returns the original run for a repeated trigger, even for concurrent duplicates', async () => {
    await admin.put('/api/v1/actions/idem', {
      title: 'Idem',
      trigger: 'create',
      inputs: { properties: { n: { type: 'string' } } },
      steps: [{ id: 't', type: 'transform', output: { ok: 'true' } }],
    });
    const key = { 'idempotency-key': 'order-42' };
    const res = await Promise.all([trigger('idem', { n: 'a' }, key), trigger('idem', { n: 'a' }, key), trigger('idem', { n: 'a' }, key)]);
    expect(res.map((r) => r.status).sort()).toEqual([200, 200, 201]);
    expect(new Set(res.map((r) => r.data.id)).size).toBe(1);
    expect(Number((await one<{ n: number }>("SELECT count(*) AS n FROM runs WHERE action = 'idem'"))?.n)).toBe(1);
    // Same key, other request: refused rather than silently returning an unrelated run.
    expect((await trigger('idem', { n: 'b' }, key)).status).toBe(409);
    // Another key is another run; no key never deduplicates.
    expect((await trigger('idem', { n: 'a' }, { 'idempotency-key': 'order-43' })).status).toBe(201);
    expect((await trigger('idem', { n: 'a' })).status).toBe(201);
    expect((await trigger('idem', { n: 'a' })).status).toBe(201);
  });

  it('sends the webhook invoker a stable Idempotency-Key per run and step', async () => {
    const sink = await fakeServer();
    await admin.put('/api/v1/actions/keyed', {
      title: 'Keyed',
      trigger: 'create',
      steps: [{ id: 'call', type: 'invoke', invoker: { type: 'webhook', url: `${sink.url}/k`, mode: 'sync' } }],
    });
    const id = (await trigger('keyed')).data.id as string;
    await finished(id);
    expect(sink.received[0].headers['idempotency-key']).toBe(`${id}/call`);
    await sink.close();
  });
});

describe('bounded run logs (ap-na0.10)', () => {
  it('caps the log of a run and says so once', async () => {
    await admin.put('/api/v1/actions/chatty', { title: 'Chatty', trigger: 'create', steps: [{ id: 't', type: 'transform', output: { ok: 'true' } }] });
    const id = (await trigger('chatty')).data.id as string;
    await finished(id);
    const cap = config.RUN_LOG_MAX_LINES;
    try {
      config.RUN_LOG_MAX_LINES = 100;
      for (let i = 0; i < 150; i++) await addLog(id, `line ${i}`);
      const n = Number((await one<{ n: number }>('SELECT count(*) AS n FROM run_logs WHERE run_id = ?', id))?.n);
      expect(n).toBe(101); // the cap plus one notice
      expect(Number((await one<{ n: number }>("SELECT count(*) AS n FROM run_logs WHERE run_id = ? AND message LIKE 'Log limit of %'", id))?.n)).toBe(1);
    } finally {
      config.RUN_LOG_MAX_LINES = cap;
    }
  });

  it('returns the newest lines by default, pages through the log and polls incrementally', async () => {
    await admin.put('/api/v1/actions/verbose', { title: 'Verbose', trigger: 'create', steps: [{ id: 't', type: 'transform', output: { ok: 'true' } }] });
    const id = (await trigger('verbose')).data.id as string;
    await finished(id);
    const cap = config.RUN_LOG_MAX_LINES;
    try {
      config.RUN_LOG_MAX_LINES = 5000;
      for (let i = 0; i < 1200; i++) await addLog(id, `line ${i}`);
    } finally {
      config.RUN_LOG_MAX_LINES = cap;
    }
    const r = await view(id);
    expect(r.logs).toHaveLength(1000); // not the whole log on every poll
    expect(r.logsTruncated).toBe(true);
    expect(r.logs.at(-1)?.message).toBe('line 1199');

    const seen: number[] = [];
    let after = 0;
    for (;;) {
      const page = (await alice.get(`/api/v1/runs/${id}/logs?after=${after}&limit=500`)).data as { items: { seq: number }[]; next: number | null };
      seen.push(...page.items.map((l) => l.seq));
      if (page.next === null) break;
      after = page.next;
    }
    const total = Number((await one<{ n: number }>('SELECT count(*) AS n FROM run_logs WHERE run_id = ?', id))?.n);
    expect(seen).toHaveLength(total);
    expect(seen).toEqual([...seen].sort((a, b) => a - b));

    const last = r.logs.at(-1)!.seq;
    await addLog(id, 'one more');
    const delta = (await alice.get(`/api/v1/runs/${id}?after=${last}`)).data as RunView;
    expect(delta.logs.map((l) => l.message)).toEqual(['one more']);
    expect(await all('SELECT 1 FROM run_logs WHERE run_id = ? AND step_id IS NOT NULL LIMIT 1', id)).toHaveLength(1);
  });
});

describe('migrations (ap-na0.11)', () => {
  it('applies each migration atomically: a failing one leaves nothing behind', async () => {
    const d = sqliteDriver(':memory:');
    await expect(
      migrate(d, [
        { id: 1, name: 'first', up: (x) => x.exec('CREATE TABLE a (id INTEGER)') },
        {
          id: 2,
          name: 'second (fails half way)',
          up: async (x) => {
            await x.exec('CREATE TABLE b (id INTEGER)');
            throw new Error('boom');
          },
        },
      ]),
    ).rejects.toThrow('boom');
    expect((await d.query<{ id: number }>('SELECT id FROM schema_migrations')).rows.map((r) => r.id)).toEqual([1]);
    const tables = (await d.query<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")).rows.map((r) => r.name);
    expect(tables).toContain('a');
    expect(tables).not.toContain('b');
    await d.close();
  });
});

describe('loop liveness (ap-na0.12)', () => {
  it('reports a stuck loop on /healthz until it beats again', async () => {
    const unregister = registerLoop('test-loop', 80);
    try {
      expect((await app.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200);
      await sleep(150);
      const stuck = await app.inject({ method: 'GET', url: '/healthz' });
      expect(stuck.statusCode).toBe(503);
      expect(stuck.json()).toEqual({ ok: false, stuck: ['test-loop'] });
      beat('test-loop');
      expect((await app.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200);
    } finally {
      unregister();
    }
  });
});
