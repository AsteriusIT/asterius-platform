import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { client, register, testApp, type Api } from './helpers.js';
import { bucketStart, buckets, quantile } from '../src/catalog/charts.js';
import { DEFAULT_ORG, withOrg } from '../src/orgs/context.js';
import { run } from '../src/db.js';

let app: FastifyInstance;
let admin: Api;
let alice: Api;
let aliceId: string;
let adminId: string;

const DAY = 86_400_000;
const NOW = Date.now();
const iso = (t: number) => new Date(t).toISOString();
/** Noon UTC, `n` days ago: never on a bucket boundary. */
const daysAgo = (n: number) => {
  const d = new Date(NOW - n * DAY);
  d.setUTCHours(12, 0, 0, 0);
  return d.getTime() > NOW ? d.getTime() - DAY : d.getTime();
};

const insertRun = (id: string, status: string, at: number, opts: { by?: string; minutes?: number; team?: string; entity?: string; action?: string } = {}) =>
  withOrg(DEFAULT_ORG, () =>
    run(
      `INSERT INTO runs (id, action, action_title, blueprint, entity, inputs, status, invoker, approval, triggered_by, team, created_at, started_at, ended_at, updated_at, org_id)
       VALUES (?, ?, 'Ship', ?, ?, '{}', ?, '{}', '{}', ?, ?, ?, ?, ?, ?, ?)`,
      id,
      opts.action ?? 'ship',
      opts.entity ? 'svc' : null,
      opts.entity ?? null,
      status,
      opts.by ?? adminId,
      opts.team ?? null,
      iso(at),
      iso(at),
      opts.minutes === undefined ? null : iso(at + opts.minutes * 60_000),
      iso(at),
      DEFAULT_ORG,
    ),
  );

const chart = (series: object, o: object = {}) => ({ type: 'chart', interval: 'week', days: 28, series, ...o });

beforeAll(async () => {
  app = await testApp();
  const ad = await register(app, 'admin@example.com');
  admin = client(app, ad.token);
  adminId = ad.user.id;
  const al = await register(app, 'alice@example.com');
  alice = client(app, al.token);
  aliceId = al.user.id;
  await admin.put('/api/v1/teams/payments', { title: 'Payments' });
  await admin.patch(`/api/v1/users/${al.user.id}`, { teams: ['payments'] });
  await admin.put('/api/v1/blueprints/svc', {
    title: 'Service',
    schema: { properties: { lang: { type: 'string' }, url: { type: 'string' } } },
  });
  for (const [id, lang, team, age] of [
    ['a', 'go', 'payments', 40],
    ['b', 'go', null, 10],
    ['c', 'rust', null, 3],
  ] as const) {
    await admin.put(`/api/v1/blueprints/svc/entities/${id}`, { team, properties: { lang } });
    await withOrg(DEFAULT_ORG, () => run('UPDATE entities SET created_at = ? WHERE blueprint = ? AND identifier = ?', iso(daysAgo(age)), 'svc', id));
  }
  await admin.put('/api/v1/scorecards/q', {
    title: 'Quality',
    blueprint: 'svc',
    levels: [{ name: 'Bronze', color: 'orange' }, { name: 'Gold' }],
    rules: [
      { identifier: 'has_team', title: 'Has a team', level: 'Bronze', expression: 'team != null' },
      { identifier: 'go', title: 'Go', level: 'Gold', expression: "properties.lang = 'go'" },
    ],
  });
  await admin.post('/api/v1/scorecards/q/evaluate', {});
});
afterAll(() => app.close());

describe('buckets', () => {
  it('starts weeks on Monday and months on the 1st, in UTC', () => {
    const wed = Date.parse('2026-11-11T15:00:00Z'); // a Wednesday
    expect(iso(bucketStart('week', wed))).toBe('2026-11-09T00:00:00.000Z');
    expect(iso(bucketStart('month', wed))).toBe('2026-11-01T00:00:00.000Z');
    expect(iso(bucketStart('day', wed))).toBe('2026-11-11T00:00:00.000Z');
    const sun = Date.parse('2026-11-15T23:59:00Z');
    expect(iso(bucketStart('week', sun))).toBe('2026-11-09T00:00:00.000Z');
  });

  it('covers the window ending now, the current bucket last', () => {
    const now = Date.parse('2026-11-11T15:00:00Z');
    const b = buckets('week', 28, now);
    expect(b.labels).toEqual(['2026-10-12', '2026-10-19', '2026-10-26', '2026-11-02', '2026-11-09']);
    expect(b.indexOf('2026-10-12')).toBe(0);
    expect(b.indexOf('2026-11-08T23:59:59Z')).toBe(3);
    expect(b.indexOf('2026-10-11T23:00:00Z')).toBe(-1);
    expect(buckets('month', 60, now).labels).toEqual(['2026-09-01', '2026-10-01', '2026-11-01']);
    expect(buckets('day', 1, now).labels).toEqual(['2026-11-11']);
  });

  it('interpolates quantiles', () => {
    expect(quantile([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(quantile([10], 0.9)).toBe(10);
    expect(quantile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9)).toBeCloseTo(9.1);
  });
});

describe('chart widgets', () => {
  beforeAll(async () => {
    await insertRun('r1', 'SUCCESS', daysAgo(1), { minutes: 10, entity: 'a' });
    await insertRun('r2', 'SUCCESS', daysAgo(1), { minutes: 30 });
    await insertRun('r3', 'FAILURE', daysAgo(1), { minutes: 2 });
    await insertRun('r4', 'FAILURE', daysAgo(15), { minutes: 5, by: aliceId });
    await insertRun('r5', 'SUCCESS', daysAgo(100), { minutes: 5 }); // outside the window
    await insertRun('r6', 'SUCCESS', daysAgo(2), { minutes: 1, team: 'payments', action: 'other' });
    // Scorecard history: `b` was Bronze before the window, reached Gold 10 days ago.
    await withOrg(DEFAULT_ORG, async () => {
      await run('DELETE FROM scorecard_history WHERE scorecard = ?', 'q');
      const h = (entity: string, level: string | null, at: number) =>
        run(
          'INSERT INTO scorecard_history (org_id, scorecard, blueprint, entity, level, passed, total, at) VALUES (?, ?, ?, ?, ?, 0, 2, ?)',
          DEFAULT_ORG,
          'q',
          'svc',
          entity,
          level,
          iso(at),
        );
      await h('a', 'Bronze', daysAgo(60));
      await h('b', 'Bronze', daysAgo(50));
      await h('b', 'Gold', daysAgo(10));
      await h('c', null, daysAgo(3));
    });
    const res = await admin.put('/api/v1/dashboards/trends', {
      title: 'Trends',
      widgets: [
        chart({ kind: 'runs' }),
        chart({ kind: 'runs', metric: 'failureRate' }),
        chart({ kind: 'runs', metric: 'duration' }),
        chart({ kind: 'scorecard', scorecard: 'q' }, { chart: 'bar', stacked: true }),
        chart({ kind: 'entities', blueprint: 'svc', groupBy: 'lang' }, { days: 60 }),
        chart({ kind: 'entities', blueprint: 'svc', mode: 'created' }, { interval: 'month', days: 90 }),
        chart({ kind: 'dora', deploymentActions: ['ship'], deployments: { blueprint: 'ghost' } }),
        chart({ kind: 'runs', team: 'payments' }),
        chart({ kind: 'scorecard', scorecard: 'ghost' }),
      ],
    });
    expect(res.status).toBe(200);
  });

  it('validates the series', async () => {
    expect((await admin.put('/api/v1/dashboards/bad', { title: 'x', widgets: [chart({ kind: 'nope' })] })).status).toBe(400);
    expect((await admin.put('/api/v1/dashboards/bad', { title: 'x', widgets: [chart({ kind: 'runs' }, { interval: 'year' })] })).status).toBe(400);
  });

  it('counts runs by status per bucket, in the window, with drill-down filters', async () => {
    const [byStatus, rate, duration] = (await admin.get('/api/v1/dashboards/trends/data')).data;
    expect(byStatus).toMatchObject({ type: 'chart', interval: 'week', unit: 'count', drill: { kind: 'runs' } });
    expect(byStatus.buckets).toHaveLength(buckets('week', 28).labels.length);
    const sum = (s: { values: number[] }) => s.values.reduce((a, b) => a + b, 0);
    const ok = byStatus.series.find((s: { key: string }) => s.key === 'SUCCESS');
    const ko = byStatus.series.find((s: { key: string }) => s.key === 'FAILURE');
    expect(sum(ok)).toBe(3); // r1, r2, r6 (r5 is older than the window)
    expect(sum(ko)).toBe(2);
    expect(ok.filter).toEqual({ scope: ['all'], status: ['SUCCESS'] });
    expect(byStatus.series.map((s: { key: string }) => s.key)).toEqual(['SUCCESS', 'FAILURE']);

    const last = rate.series[0].values.at(-1);
    const r = rate.series[0].values.filter((v: number | null) => v !== null);
    expect(rate.unit).toBe('ratio');
    expect(r.length).toBeGreaterThan(0);
    expect(JSON.stringify(rate)).not.toContain('NaN');
    expect(last === null || (last >= 0 && last <= 1)).toBe(true);

    expect(duration.unit).toBe('minutes');
    const p50 = duration.series.find((s: { key: string }) => s.key === 'p50');
    const all = p50.values.filter((v: number | null) => v !== null);
    expect(all.length).toBeGreaterThan(0);
    expect(Math.max(...all)).toBeLessThanOrEqual(30);
  });

  it('only counts the runs the viewer may see', async () => {
    const data = (await alice.get('/api/v1/dashboards/trends/data')).data;
    const sum = (s: { values: number[] }) => s.values.reduce((a, b) => a + b, 0);
    // alice: her own run (r4) and her team's (r6)
    expect(data[0].series.map((s: { key: string; values: number[] }) => [s.key, sum(s)])).toEqual([
      ['SUCCESS', 1],
      ['FAILURE', 1],
    ]);
    expect(data[7].series.map((s: { key: string }) => s.key)).toEqual(['SUCCESS']);
    expect(data[7].series[0].filter).toMatchObject({ team: ['payments'] });
  });

  it('replays scorecard levels per bucket', async () => {
    const sc = (await admin.get('/api/v1/dashboards/trends/data')).data[3];
    expect(sc).toMatchObject({ unit: 'count', drill: { kind: 'catalog', blueprint: 'svc' } });
    const at = (key: string) => sc.series.find((s: { key: string }) => s.key === key);
    expect(sc.series.map((s: { key: string }) => s.key)).toEqual(['none', 'Bronze', 'Gold']);
    expect(at('Bronze').color).toBe('orange');
    expect(at('Bronze').filter).toEqual({ level: ['q:Bronze'] });
    // first bucket: a and b Bronze; last bucket: a Bronze, b Gold, c none
    expect([at('none').values[0], at('Bronze').values[0], at('Gold').values[0]]).toEqual([0, 2, 0]);
    expect([at('none').values.at(-1), at('Bronze').values.at(-1), at('Gold').values.at(-1)]).toEqual([1, 1, 1]);
  });

  it('counts entities over time, as a running total per group or as new ones', async () => {
    const [total, created] = (await admin.get('/api/v1/dashboards/trends/data')).data.slice(4, 6);
    const go = total.series.find((s: { key: string }) => s.key === 'go');
    const rust = total.series.find((s: { key: string }) => s.key === 'rust');
    // 60 days, weekly: a (40 days ago) joins in a middle bucket, b (10 days ago) later; never decreasing
    expect(go.values[0]).toBe(0);
    expect(go.values).toContain(1);
    expect([...go.values].sort((x: number, y: number) => x - y)).toEqual(go.values);
    expect(go.values.at(-1)).toBe(2);
    expect(rust.values.at(-1)).toBe(1);
    expect(go.filter).toEqual({ f: ['lang:go'] });
    expect(created.series).toHaveLength(1);
    expect(created.series[0].values.reduce((a: number, b: number) => a + b, 0)).toBe(3);
    // alice reads every service too (no read rule)
    expect((await alice.get('/api/v1/dashboards/trends/data')).data[4].series.length).toBe(2);
  });

  it('plots a DORA metric over time and reports widget errors in place', async () => {
    const data = (await admin.get('/api/v1/dashboards/trends/data')).data;
    expect(data[6]).toMatchObject({ unit: 'count', drill: { kind: 'runs' } });
    expect(data[6].series[0].values.reduce((a: number, b: number | null) => a + (b ?? 0), 0)).toBe(2); // r1, r2
    expect(data[6].series[0].filter).toMatchObject({ action: ['ship'] });
    expect(data[8].error).toContain('ghost');
  });

  it('filters the runs list by creation time and team (drill-down targets)', async () => {
    const since = iso(daysAgo(1) - 3_600_000);
    const page = (await admin.get(`/api/v1/runs?since=${since}&status=SUCCESS,FAILURE`)).data;
    expect(page.items.map((r: { id: string }) => r.id).sort()).toEqual(['r1', 'r2', 'r3']);
    const until = iso(daysAgo(14));
    expect((await admin.get(`/api/v1/runs?until=${until}&since=${iso(daysAgo(16))}`)).data.items.map((r: { id: string }) => r.id)).toEqual(['r4']);
    expect((await admin.get('/api/v1/runs?team=payments')).data.items.map((r: { id: string }) => r.id)).toEqual(['r6']);
    expect((await admin.get('/api/v1/runs?since=yesterday')).status).toBe(400);
  });

  it('filters entities by scorecard level', async () => {
    const ids = async (q: string) => (await admin.get(`/api/v1/blueprints/svc/entities?${q}`)).data.items.map((e: { identifier: string }) => e.identifier);
    expect(await ids('scorecard.q=Gold')).toEqual(['a']);
    expect(await ids('scorecard.q=Bronze')).toEqual([]);
    expect(await ids('scorecard.q=none')).toEqual(['b', 'c']);
    expect((await admin.get('/api/v1/blueprints/svc/entities?scorecard.Bad!=x')).status).toBe(400);
  });
});

describe('entity-page dashboards', () => {
  beforeAll(async () => {
    await admin.put('/api/v1/blueprints/svc', {
      title: 'Service',
      schema: { properties: { lang: { type: 'string' }, url: { type: 'string' } } },
      permissions: { read: { ownerTeam: true } },
    });
  });

  it('needs a blueprint and resolves by scope', async () => {
    expect((await admin.put('/api/v1/dashboards/e', { title: 'E', scope: 'entity', widgets: [] })).status).toBe(400);
    const r = await admin.put('/api/v1/dashboards/svc-entity', {
      title: 'Service page',
      blueprint: 'svc',
      scope: 'entity',
      widgets: [
        { type: 'entity', show: 'properties' },
        { type: 'markdown', content: 'Language: **{{ entity.properties.lang }}** · {{ entity.title }}' },
        chart({ kind: 'runs' }),
        { type: 'runs' },
      ],
    });
    expect(r.status).toBe(200);
    expect(r.data.scope).toBe('entity');
    expect((await admin.get('/api/v1/dashboards/resolve?blueprint=svc&scope=entity')).data.identifier).toBe('svc-entity');
    // The catalog page of the blueprint does not pick it.
    expect((await admin.get('/api/v1/dashboards/resolve?blueprint=svc')).data).toBeNull();
    expect((await admin.get('/api/v1/dashboards/resolve?scope=entity')).data).toBeNull();
  });

  it('computes the widgets for the entity, templates escaped', async () => {
    await admin.put('/api/v1/blueprints/svc/entities/a', { team: 'payments', title: 'A [x](javascript:alert(1))', properties: { lang: 'go' } });
    const data = (await alice.get('/api/v1/dashboards/svc-entity/data?entity=a')).data;
    expect(data[0]).toEqual({ type: 'entity' });
    expect(data[1].content).toBe('Language: **go** · A \\[x\\]\\(javascript:alert\\(1\\)\\)');
    const sum = (s: { values: number[] }) => s.values.reduce((x, y) => x + y, 0);
    expect(data[2].series).toEqual([]); // r1 was started by the admin for no team: alice cannot see it
    const mine = (await admin.get('/api/v1/dashboards/svc-entity/data?entity=a')).data;
    expect(mine[2].series.map((s: { key: string; values: number[] }) => [s.key, sum(s)])).toEqual([['SUCCESS', 1]]); // r1 only
    expect(mine[2].series[0].filter).toMatchObject({ blueprint: ['svc'], entity: ['a'] });
    expect(mine[3].items.map((x: { id: string }) => x.id)).toEqual(['r1']);
  });

  it('hides entities the viewer cannot read and rejects an entity on other dashboards', async () => {
    expect((await alice.get('/api/v1/dashboards/svc-entity/data?entity=b')).status).toBe(404);
    expect((await admin.get('/api/v1/dashboards/svc-entity/data?entity=b')).status).toBe(200);
    expect((await admin.get('/api/v1/dashboards/trends/data?entity=a')).status).toBe(400);
  });
});
