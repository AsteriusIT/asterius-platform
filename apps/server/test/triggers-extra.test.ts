import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { client, register, testApp, type Api } from './helpers.js';
import { all, run as exec } from '../src/db.js';
import { CATCH_UP_WINDOW_MS, dueTicks, fireDeferred, fireDueSchedules } from '../src/actions/triggers.js';
import { activeBlackout, nextBlackout, parseDuration } from '../src/actions/blackouts.js';

/** Schedule catch-up, blackout windows and scheduled fan-out over entities. */

let app: FastifyInstance;
let admin: Api;
let alice: Api;

const HOUR = 3_600_000;
const steps = [{ id: 't', type: 'transform', output: { v: '1' } }];
const put = (id: string, body: object) => admin.put(`/api/v1/actions/${id}`, { title: id, steps, ...body });
const runsOf = async (action: string) =>
  (await admin.get(`/api/v1/runs?action=${action}&limit=100`)).data.items as {
    id: string;
    inputs: Record<string, unknown>;
    trigger: Record<string, unknown>;
    entity: string | null;
    blueprint: string | null;
  }[];
const setNextFire = (action: string, at: string) => exec('UPDATE actions SET next_fire_at = ? WHERE identifier = ?', at, action);
const iso = (ms: number) => new Date(ms).toISOString();
/** Top of the hour `n` hours ago. */
const hoursAgo = (n: number) => iso(Math.floor(Date.now() / HOUR) * HOUR - n * HOUR);
const auditOf = (action: string, target: string) =>
  all<{ detail: string }>('SELECT detail FROM audit_log WHERE action = ? AND target = ? ORDER BY at', action, target);

beforeAll(async () => {
  app = await testApp();
  admin = client(app, (await register(app, 'admin@example.com')).token);
  alice = client(app, (await register(app, 'alice@example.com')).token);
  await admin.put('/api/v1/blueprints/host', { title: 'Host', schema: { properties: { env: { type: 'string' } } } });
  for (const [id, env] of [
    ['h1', 'prod'],
    ['h2', 'dev'],
    ['h3', 'prod'],
    ['h4', 'prod'],
    ['h5', 'dev'],
  ])
    expect((await admin.put(`/api/v1/blueprints/host/entities/${id}`, { properties: { env } })).status).toBeLessThan(300);
});
afterAll(async () => {
  await app.close();
});

describe('schedule catch-up', () => {
  const hourly = { type: 'schedule', cron: '0 * * * *', inputs: { at: '{{ schedule.at }}' } };

  it('computes the missed ticks of each mode', () => {
    const now = Date.parse('2026-03-10T12:30:00Z');
    const nf = '2026-03-10T08:00:00.000Z';
    const t = (o: object) => ({ ...hourly, timezone: 'UTC', ...o }) as never;
    expect(dueTicks(t({}), nf, now)).toEqual([nf]);
    expect(dueTicks(t({ catchUp: 'last' }), nf, now)).toEqual(['2026-03-10T12:00:00.000Z']);
    expect(dueTicks(t({ catchUp: 'all' }), nf, now)).toHaveLength(5);
    expect(dueTicks(t({ catchUp: 'all', maxCatchUp: 2 }), nf, now)).toEqual(['2026-03-10T11:00:00.000Z', '2026-03-10T12:00:00.000Z']);
    // Only the catch-up window is replayed: a daily schedule missed for 30 days replays at most 7 days.
    const daily = dueTicks(t({ cron: '0 0 * * *', catchUp: 'all', maxCatchUp: 100 }), '2026-02-08T00:00:00.000Z', now);
    expect(daily).toHaveLength(7);
    expect(Date.parse(daily[0])).toBeGreaterThanOrEqual(now - CATCH_UP_WINDOW_MS);
    // `last` on a rare schedule missed before the window still runs the claimed tick.
    expect(dueTicks(t({ cron: '0 0 1 1 *', catchUp: 'last' }), '2026-01-01T00:00:00.000Z', now)).toEqual(['2026-01-01T00:00:00.000Z']);
  });

  it('validates catch-up settings', async () => {
    expect((await put('cu-bad', { trigger: { ...hourly, maxCatchUp: 5 } })).data.error).toMatch(/maxCatchUp/);
    expect((await put('cu-bad', { trigger: { ...hourly, catchUp: 'all', maxCatchUp: 500 } })).status).toBe(400);
  });

  it('none: one run for the oldest missed tick, the others are dropped', async () => {
    await put('cu-none', { trigger: hourly });
    await setNextFire('cu-none', hoursAgo(4));
    expect(await fireDueSchedules()).toBe(1);
    expect((await runsOf('cu-none')).map((r) => r.inputs.at)).toEqual([hoursAgo(4)]);
  });

  it('last: one run for the most recent missed tick', async () => {
    await put('cu-last', { trigger: { ...hourly, catchUp: 'last' } });
    await setNextFire('cu-last', hoursAgo(4));
    expect(await fireDueSchedules()).toBe(1);
    const [r] = await runsOf('cu-last');
    expect(r.inputs.at).toBe(hoursAgo(0));
    expect(r.trigger).toMatchObject({ type: 'schedule', tick: hoursAgo(0) });
  });

  it('all: one run per missed tick, bounded, exactly once across replicas', async () => {
    await put('cu-all', { trigger: { ...hourly, catchUp: 'all', maxCatchUp: 3 } });
    await setNextFire('cu-all', hoursAgo(5));
    const started = await Promise.all([fireDueSchedules(), fireDueSchedules(), fireDueSchedules()]);
    expect(started.reduce((a, b) => a + b, 0)).toBe(3);
    const ats = (await runsOf('cu-all')).map((r) => r.inputs.at).sort();
    expect(ats).toEqual([hoursAgo(2), hoursAgo(1), hoursAgo(0)]);
    // Replaying the same ticks (e.g. a stale next_fire_at written back) starts nothing new.
    await setNextFire('cu-all', hoursAgo(5));
    expect(await fireDueSchedules()).toBe(0);
    expect(await runsOf('cu-all')).toHaveLength(3);
  });
});

describe('blackout windows', () => {
  const live = () => ({ name: 'freeze', from: iso(Date.now() - HOUR), to: iso(Date.now() + HOUR) });

  it('computes recurring and fixed windows', () => {
    expect(parseDuration('1h30m')).toBe(90 * 60_000);
    expect(() => parseDuration('2w')).toThrow();
    expect(() => parseDuration('40d')).toThrow();
    const nightly = [{ name: 'nightly', cron: '0 22 * * *', duration: '4h', timezone: 'UTC' }];
    expect(activeBlackout(nightly, Date.parse('2026-03-10T23:00:00Z'))).toEqual({
      name: 'nightly',
      from: '2026-03-10T22:00:00.000Z',
      until: '2026-03-11T02:00:00.000Z',
    });
    expect(activeBlackout(nightly, Date.parse('2026-03-11T03:00:00Z'))).toBeNull();
    expect(nextBlackout(nightly, Date.parse('2026-03-11T03:00:00Z'))).toMatchObject({ from: '2026-03-11T22:00:00.000Z' });
    // A fixed window chained right after the recurring one extends the blackout.
    const chained = [...nightly, { name: 'release', from: '2026-03-11T02:00:00Z', to: '2026-03-11T05:00:00Z', timezone: 'UTC' }];
    expect(activeBlackout(chained, Date.parse('2026-03-10T23:00:00Z'))?.until).toBe('2026-03-11T05:00:00.000Z');
  });

  it('validates windows', async () => {
    const trigger = { type: 'api', inputs: { properties: {} } };
    expect((await put('bo-bad', { trigger, blackouts: [{ cron: '0 22 * * *' }] })).data.error).toMatch(/duration/);
    expect((await put('bo-bad', { trigger, blackouts: [{ cron: '0 22 * * *', duration: '3x' }] })).data.error).toMatch(/Invalid duration/);
    expect((await put('bo-bad', { trigger, blackouts: [{ from: iso(Date.now()), to: iso(Date.now() - HOUR) }] })).data.error).toMatch(/after/);
    expect((await put('bo-bad', { trigger, blackouts: [{ name: 'x' }] })).data.error).toMatch(/Blackout "x"/);
  });

  it('refuses form/API submissions with a 409 unless an admin overrides', async () => {
    const r = await put('bo-api', { trigger: { type: 'api', inputs: { properties: {} } }, blackouts: [live()] });
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    expect(r.data.blackout.active).toMatchObject({ name: 'freeze' });
    const refused = await alice.post('/api/v1/actions/bo-api/runs', {});
    expect(refused.status).toBe(409);
    expect(refused.data.error).toMatch(/blackout window \(freeze\)/);
    expect((await alice.post('/api/v1/actions/bo-api/runs', { overrideBlackout: true })).status).toBe(409);
    expect((await admin.post('/api/v1/actions/bo-api/runs', {})).data.error).toMatch(/overrideBlackout/);
    expect((await admin.post('/api/v1/actions/bo-api/runs', { overrideBlackout: true })).status).toBe(201);
    expect(await auditOf('run.blackout_overridden', 'bo-api')).toHaveLength(1);
    // Outside the window, submissions work again; the next window is announced.
    const soon = { name: 'later', from: iso(Date.now() + 2 * HOUR), to: iso(Date.now() + 3 * HOUR) };
    const r2 = await put('bo-api', { trigger: { type: 'api', inputs: { properties: {} } }, blackouts: [soon] });
    expect(r2.data.blackout).toMatchObject({ active: null, next: { name: 'later' } });
    expect((await alice.post('/api/v1/actions/bo-api/runs', {})).status).toBe(201);
  });

  it('skip: automated starts (schedule, event, webhook) are dropped and audited', async () => {
    await put('bo-skip', { trigger: { type: 'schedule', cron: '0 * * * *' }, blackouts: [live()] });
    await setNextFire('bo-skip', hoursAgo(1));
    expect(await fireDueSchedules()).toBe(0);
    expect(await runsOf('bo-skip')).toHaveLength(0);
    expect(JSON.parse((await auditOf('run.skipped', 'bo-skip'))[0].detail)).toMatchObject({ blackout: 'freeze', source: 'schedule' });

    await put('bo-event', { trigger: { type: 'event', event: 'entity.updated', blueprint: 'host' }, blackouts: [live()], blackoutMode: 'skip' });
    await admin.put('/api/v1/blueprints/host/entities/h5', { properties: { env: 'qa' } });
    expect(await runsOf('bo-event')).toHaveLength(0);
    expect(await auditOf('run.skipped', 'bo-event')).toHaveLength(1);
    await put('bo-event', { trigger: { type: 'event', event: 'entity.updated', blueprint: 'host' } }); // no more blackout
    await admin.put('/api/v1/blueprints/host/entities/h5', { properties: { env: 'dev' } });
    expect(await runsOf('bo-event')).toHaveLength(1);
  });

  it('defer: automated starts wait for the end of the window, then start once', async () => {
    await admin.put('/api/v1/secrets/BO_HOOK', { value: 'blackout-secret', description: 'test' });
    const def = { trigger: { type: 'webhook', secret: '${secret:BO_HOOK}', inputs: { repo: '{{ body.repo }}' } }, blackoutMode: 'defer' };
    await put('bo-defer', { ...def, blackouts: [live()] });
    const res = await client(app).post('/api/v1/hooks/bo-defer', { repo: 'payments' }, { 'x-asterius-token': 'blackout-secret' });
    expect(res.status).toBe(202);
    expect(res.data).toMatchObject({ runId: null, deferredUntil: expect.any(String) });
    expect(await fireDeferred()).toBe(0); // not due yet
    expect(await runsOf('bo-defer')).toHaveLength(0);

    // The window ends (moved to the past): the deferred start is due.
    await put('bo-defer', { ...def, blackouts: [{ from: iso(Date.now() - 2 * HOUR), to: iso(Date.now() - HOUR) }] });
    await exec("UPDATE deferred_starts SET due_at = ? WHERE action = 'bo-defer'", iso(Date.now() - 1000));
    const started = await Promise.all([fireDeferred(), fireDeferred(), fireDeferred()]);
    expect(started.reduce((a, b) => a + b, 0)).toBe(1);
    const runs = await runsOf('bo-defer');
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ inputs: { repo: 'payments' }, trigger: { type: 'webhook', deferred: true } });
    expect(await all("SELECT id FROM deferred_starts WHERE action = 'bo-defer'")).toHaveLength(0);
  });

  it('defer: a window still in effect pushes the start back', async () => {
    await put('bo-again', { trigger: { type: 'schedule', cron: '0 * * * *' }, blackouts: [live()], blackoutMode: 'defer' });
    await setNextFire('bo-again', hoursAgo(1));
    expect(await fireDueSchedules()).toBe(0);
    await exec("UPDATE deferred_starts SET due_at = ? WHERE action = 'bo-again'", iso(Date.now() - 1000));
    expect(await fireDeferred()).toBe(0);
    const [row] = await all<{ due_at: string; dedupe_key: string }>("SELECT due_at, dedupe_key FROM deferred_starts WHERE action = 'bo-again'");
    expect(Date.parse(row.due_at)).toBeGreaterThan(Date.now());
    expect(row.dedupe_key).toBe(`schedule:${hoursAgo(1)}`);
  });
});

describe('scheduled fan-out over entities', () => {
  const fan = (o: object = {}) => ({
    type: 'schedule',
    cron: '0 * * * *',
    entities: { blueprint: 'host', filter: 'entity.properties.env = "prod"', ...o },
    inputs: { name: '{{ entity.identifier }}', at: '{{ schedule.at }}' },
  });

  it('validates the fan-out', async () => {
    expect((await put('fo-bad', { trigger: fan({ blueprint: 'nope' }) })).data.error).toMatch(/does not exist/);
    expect((await put('fo-bad', { trigger: fan({ filter: 'entity.(' }) })).data.error).toMatch(/Invalid expression/);
    expect((await put('fo-bad', { trigger: fan({ limit: 5000 }) })).status).toBe(400);
  });

  it('starts one run per matching entity, on that entity', async () => {
    expect((await put('fo', { trigger: fan() })).status).toBe(200);
    await setNextFire('fo', hoursAgo(1));
    const started = await Promise.all([fireDueSchedules(), fireDueSchedules()]);
    expect(started.reduce((a, b) => a + b, 0)).toBe(3);
    const runs = await runsOf('fo');
    expect(runs.map((r) => r.entity).sort()).toEqual(['h1', 'h3', 'h4']);
    for (const r of runs) {
      expect(r).toMatchObject({ blueprint: 'host', inputs: { name: r.entity, at: hoursAgo(1) }, trigger: { type: 'schedule', entity: r.entity } });
    }
    // The same tick again starts nothing (idempotent per tick and entity).
    await setNextFire('fo', hoursAgo(1));
    expect(await fireDueSchedules()).toBe(0);
    expect(await runsOf('fo')).toHaveLength(3);
  });

  it('is bounded by limit, and combines with catch-up', async () => {
    await put('fo-lim', { trigger: { ...fan({ filter: undefined, limit: 2 }), catchUp: 'all', maxCatchUp: 2 } });
    await setNextFire('fo-lim', hoursAgo(3));
    expect(await fireDueSchedules()).toBe(4); // 2 ticks × 2 entities
    const runs = await runsOf('fo-lim');
    expect(runs.map((r) => r.entity).sort()).toEqual(['h1', 'h1', 'h2', 'h2']);
  });
});
