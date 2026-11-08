import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Run } from '@asterius/shared';
import { client, fakeServer, inDefaultOrg, register, silentLog, testApp, waitFor, type Api } from './helpers.js';
import { applyConfig, readConfigDir } from '../src/config-loader.js';
import { processInbound } from '../src/integrations/inbound.js';
import { runSync } from '../src/integrations/sync.js';
import { upsertEntity } from '../src/catalog/entities.js';
import { mappingDef } from '../src/schemas.js';
import { startRunWorker } from '../src/actions/worker.js';
import { all } from '../src/db.js';
import {
  buildTimeline,
  catalogEvents,
  isTerminal,
  lokiEvents,
  mergeEvents,
  portalEvents,
  runSelector,
  SETTLE_MS,
  tempoEvents,
} from '../src/v2/read/timeline.js';

/**
 * V2 read side (docs/V2-READ-SIDE.md): the catalog watcher's deliveries (signed and shaped by the agent's own code),
 * ownership between the portal, the watcher and Azure DevOps, the V2 scorecards and the run timeline.
 */

// The agent is a standalone package (Node type stripping): load its modules by path so the server's tsc does not follow them.
type AgentPortal = { sign: (secret: string, body: string) => string; SIGNATURE_HEADER: string };
type AgentState = { computeAll: (snap: unknown, at?: string) => Record<string, unknown>[] };
type Fn = (...args: unknown[]) => unknown;
interface Fixtures {
  xr: Fn;
  mr: Fn;
  app: Fn;
  cond: Fn;
  READY: unknown[];
}
const agent = (p: string) => import(/* @vite-ignore */ path.resolve(__dirname, '../../agent', p));
let portal: AgentPortal;
let state: AgentState;
let fx: Fixtures;

const SECRET = 'watcher-test-secret';
const V2 = path.resolve(__dirname, '../../../examples/v2/config');
const V2_CROSSPLANE = path.resolve(__dirname, '../../../examples/v2/crossplane/config');

let app: FastifyInstance;
let admin: Api;
let ado: Awaited<ReturnType<typeof fakeServer>>;
let obs: Awaited<ReturnType<typeof fakeServer>>;
const stops: (() => unknown)[] = [];
let lokiCalls = 0;
let runId = '';

const adoData = {
  projects: [
    { id: 'p1', name: 'payments-api' },
    { id: 'p2', name: 'billing-ledger' },
    { id: 'p3', name: 'Legacy' },
    { id: 'p0', name: 'Platform' },
  ],
  repos: [
    { name: 'api', webUrl: 'https://dev.azure.com/AsteriusIT/payments-api/_git/api', project: { name: 'payments-api' } },
    { name: 'ledger', webUrl: 'https://dev.azure.com/AsteriusIT/billing-ledger/_git/ledger', project: { name: 'billing-ledger' } },
    { name: 'tools', webUrl: 'https://dev.azure.com/AsteriusIT/Legacy/_git/tools', project: { name: 'Legacy' } },
    { name: 'portal-resources', webUrl: 'https://dev.azure.com/AsteriusIT/Platform/_git/portal-resources', project: { name: 'Platform' } },
  ],
  pipelines: {
    'payments-api': [{ id: 42, name: 'api-ci', _links: { web: { href: 'https://dev.azure.com/AsteriusIT/payments-api/_build?definitionId=42' } } }],
  } as Record<string, unknown[]>,
  /** Completed runs of portal-services-drift (definition 13), newest first as the API answers. */
  driftBuilds: [] as { id: number; finishTime: string; tags: string[]; _links?: unknown }[],
};

/** POST a watcher delivery exactly as the agent does (body, signature header, delivery id). */
async function deliver(services: unknown[], opts: { secret?: string; sentAt?: string } = {}) {
  const body = JSON.stringify({ source: 'crossplane-watcher', sentAt: opts.sentAt ?? new Date().toISOString(), mode: 'delta', services });
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/ingest/crossplane-watcher',
    headers: {
      'content-type': 'application/json',
      [portal.SIGNATURE_HEADER]: portal.sign(opts.secret ?? SECRET, body),
      'x-asterius-delivery': crypto.randomUUID(),
    },
    payload: body,
  });
  await processInbound(50);
  return res.statusCode;
}

const statuses = (xrs: unknown[], mrs: unknown[] = []) => state.computeAll({ xrs, mrs, constraints: [], apps: [], compositions: new Map() });
const entity = async (id: string) => (await admin.get(`/api/v1/blueprints/platform-service/entities/${encodeURIComponent(id)}`)).data;

beforeAll(async () => {
  portal = (await agent('src/portal.ts')) as AgentPortal;
  state = (await agent('src/state.ts')) as AgentState;
  fx = (await agent('test/fixtures.ts')) as Fixtures;
  process.env.CROSSPLANE_WATCHER_SECRET = SECRET;
  process.env.ADO_PAT = 'pat';

  ado = await fakeServer((r) => {
    const u = new URL(r.url, 'http://x');
    if (u.pathname === '/_apis/projects') return { body: { value: adoData.projects } };
    if (u.pathname === '/_apis/git/repositories') return { body: { value: adoData.repos } };
    if (u.pathname === '/Platform/_apis/build/definitions')
      return { body: { value: u.searchParams.get('name') === 'portal-services-drift' ? [{ id: 13, name: 'portal-services-drift' }] : [] } };
    if (u.pathname === '/Platform/_apis/build/builds') {
      expect(u.searchParams.get('definitions')).toBe('13');
      expect(u.searchParams.get('statusFilter')).toBe('completed');
      return { body: { value: [...adoData.driftBuilds].sort((a, b) => Date.parse(b.finishTime) - Date.parse(a.finishTime)) } };
    }
    const m = /^\/([^/]+)\/_apis\/pipelines$/.exec(u.pathname);
    if (m) return { body: { value: adoData.pipelines[decodeURIComponent(m[1]!)] ?? [] } };
    return { status: 404, body: {} };
  });
  obs = await fakeServer((r) => {
    const u = new URL(r.url, 'http://x');
    if (u.pathname === '/loki/api/v1/query_range') {
      lokiCalls++;
      expect(u.searchParams.get('query')).toBe(runSelector(runId));
      const t = `${BigInt(Date.now() - 1_000) * 1_000_000n}`;
      return {
        body: {
          status: 'success',
          data: {
            resultType: 'streams',
            result: [
              {
                stream: { run_id: runId, service: 'api', source: 'k8s_events', step: 'Repository', provider: 'azuredevops' },
                values: [[t, 'CreatedExternalResource: Successfully requested creation of external resource']],
              },
            ],
          },
        },
      };
    }
    if (u.pathname === '/api/search')
      return {
        body: {
          traces: [
            {
              traceID: 'abc123',
              rootServiceName: 'action-runner',
              rootTraceName: 'workflow',
              startTimeUnixNano: `${BigInt(Date.now() - 500) * 1_000_000n}`,
              durationMs: 1200,
            },
          ],
        },
      };
    return { status: 404, body: {} };
  });

  app = await testApp();
  admin = client(app, (await register(app, 'admin@example.com')).token);
  await admin.put('/api/v1/teams/payments', { title: 'Payments' });

  // The V2 read-side configuration as shipped (the ADO organization pointed at the fake server).
  const dir = fs.mkdtempSync(path.join(process.env.DATA_DIR!, 'v2-'));
  // Lean files + the crossplane profile's watcher feed.
  for (const [from, f] of [
    [V2, 'platform-service.yaml'],
    [V2, 'scorecards.yaml'],
    [V2, 'ado.yaml'],
    [V2, 'drift.yaml'],
    [V2_CROSSPLANE, 'watcher.yaml'],
  ] as const)
    fs.writeFileSync(path.join(dir, f), fs.readFileSync(path.join(from, f), 'utf8').replaceAll('https://dev.azure.com/AsteriusIT', ado.url));
  const errors = await inDefaultOrg(() => applyConfig(readConfigDir(dir), silentLog));
  expect(errors).toEqual([]);
  stops.push(startRunWorker(silentLog));
});
afterAll(async () => {
  for (const s of stops) await s();
  await ado.close();
  await obs.close();
  await app.close();
});

describe('catalog watcher feed', () => {
  it('accepts only deliveries signed with the shared secret', async () => {
    expect(await deliver(statuses([fx.xr('api')]), { secret: 'wrong' })).toBe(401);
    expect((await admin.get('/api/v1/blueprints/platform-service/entities/payments%2Fapi')).status).toBe(404);
  });

  it('writes its observed properties and keeps the intent written by the portal', async () => {
    // The portal registers the request first (lifecycle Committed, intent properties).
    await inDefaultOrg(() =>
      upsertEntity(
        'platform-service',
        {
          identifier: 'payments/api',
          title: 'api',
          team: 'payments',
          properties: { lifecycle: 'Committed', lastRunId: 'r-1', goldenPath: 'java-api', costCenter: 'CC-1', onCall: 'payments-oncall', vaultSecrets: true },
        },
        { source: 'action', merge: true },
      ),
    );
    const xr = fx.xr('api', { runId: 'r-1', conditions: fx.READY });
    const mr = fx.mr('Project', 'payments-api', 'api', { conditions: fx.READY, externalName: '6f1c' });
    expect(await deliver(statuses([xr], [mr]))).toBe(202);
    const e = await entity('payments/api');
    expect(e.source).toBe('integration:crossplane-watcher');
    expect(e.properties).toMatchObject({
      // watcher
      lifecycle: 'Ready',
      managedBy: 'crossplane',
      xrReady: true,
      xrSynced: true,
      goldenPathVersion: '3',
      observedRunId: 'r-1',
      violations: [],
      resources: [{ kind: 'Project', name: 'payments-api', externalName: '6f1c', ready: true, synced: true }],
      // portal intent, untouched
      lastRunId: 'r-1',
      goldenPath: 'java-api',
      costCenter: 'CC-1',
      onCall: 'payments-oncall',
      vaultSecrets: true,
    });
    expect(e.team).toBe('payments');
  });

  it('ignores stale deliveries (replays, long-queued events)', async () => {
    const xr = fx.xr('api', { runId: 'r-1', conditions: [fx.cond('Synced', 'False', 'ReconcileError', 'boom')] });
    expect(await deliver(statuses([xr]), { sentAt: new Date(Date.now() - 3_600_000).toISOString() })).toBe(202);
    expect((await entity('payments/api')).properties.lifecycle).toBe('Ready');
  });

  it('reports admission denials from Argo CD as Rejected with the policy', async () => {
    const rejected = state.computeAll({
      xrs: [],
      mrs: [],
      constraints: [],
      compositions: new Map(),
      apps: [
        fx.app('team-payments', [
          {
            kind: 'Service',
            name: 'web',
            namespace: 'team-payments',
            status: 'SyncFailed',
            message: 'denied the request: [prod-requires-oncall] prod needs onCall',
          },
        ]),
      ],
    });
    expect(await deliver(rejected)).toBe(202);
    const e = await entity('payments/web');
    expect(e.properties).toMatchObject({ lifecycle: 'Rejected', managedBy: 'crossplane', xrReady: false });
    expect(e.properties.violations).toEqual([{ policy: 'prod-requires-oncall', message: 'prod needs onCall', resource: 'Service/web', source: 'admission' }]);
  });
});

describe('Azure DevOps feed and ownership', () => {
  it('adds repository and pipeline properties without touching the watcher or the portal properties', async () => {
    const r = (await inDefaultOrg(() => runSync('ado-services', 'manual')))!;
    expect(r.status, r.logs.join('\n')).toBe('success');
    const e = await entity('payments/api');
    expect(e.properties).toMatchObject({
      repoUrl: 'https://dev.azure.com/AsteriusIT/payments-api/_git/api',
      adoProjectUrl: `${ado.url}/payments-api`,
      pipelineId: '42',
      pipelineUrl: 'https://dev.azure.com/AsteriusIT/payments-api/_build?definitionId=42',
      managedBy: 'crossplane', // set-once default: never overwrites the watcher
      lifecycle: 'Ready',
      xrReady: true,
      costCenter: 'CC-1',
    });
  });

  it('creates legacy entities for projects without a Service spec, and skips the Portal project', async () => {
    expect((await entity('billing/ledger')).properties).toMatchObject({ managedBy: 'legacy', team: 'billing', repoUrl: expect.stringContaining('ledger') });
    expect((await entity('legacy/tools')).properties).toMatchObject({ managedBy: 'legacy', team: 'legacy' });
    expect((await admin.get(`/api/v1/blueprints/platform-service/entities/${encodeURIComponent('platform/portal-resources')}`)).status).toBe(404);
  });

  it('keeps every feed intact whatever the order of the writes', async () => {
    // The portal writes again (a day-2 change: merge), then ADO, then the watcher's full resync.
    await inDefaultOrg(() =>
      upsertEntity(
        'platform-service',
        { identifier: 'payments/api', properties: { lifecycle: 'Committed', lastRunId: 'r-2' } },
        { source: 'action', merge: true },
      ),
    );
    await inDefaultOrg(() => runSync('ado-services', 'manual'));
    let e = await entity('payments/api');
    expect(e.properties).toMatchObject({ managedBy: 'crossplane', lifecycle: 'Committed', lastRunId: 'r-2', repoUrl: expect.any(String), xrReady: true });
    const xr = fx.xr('api', { runId: 'r-2', conditions: fx.READY });
    await deliver(statuses([xr]));
    e = await entity('payments/api');
    expect(e.properties).toMatchObject({
      lifecycle: 'Ready',
      observedRunId: 'r-2',
      lastRunId: 'r-2',
      repoUrl: expect.any(String),
      pipelineId: '42',
      costCenter: 'CC-1',
    });
    // A legacy service adopted by Crossplane: the watcher's managedBy wins over the ADO default.
    await deliver(statuses([fx.xr('ledger', { team: 'billing', conditions: fx.READY })]));
    expect((await entity('billing/ledger')).properties).toMatchObject({ managedBy: 'crossplane', repoUrl: expect.stringContaining('ledger') });
    await inDefaultOrg(() => runSync('ado-services', 'manual'));
    expect((await entity('billing/ledger')).properties.managedBy).toBe('crossplane');
  });

  it('validates setOnce (needs merge)', () => {
    expect(() => mappingDef.parse({ setOnce: ['managedBy'], entity: { blueprint: 'x', identifier: 'id' } })).toThrow(/setOnce needs merge/);
    expect(mappingDef.parse({ merge: true, setOnce: ['managedBy'], entity: { blueprint: 'x', identifier: 'id' } }).setOnce).toEqual(['managedBy']);
  });
});

describe('drift feed (portal-services-drift build tags)', () => {
  it('sets drift and driftCheckedAt from both tag formats, the newest run winning, without touching other properties', async () => {
    const at = (h: number) => new Date(Date.now() - h * 3600_000).toISOString();
    adoData.driftBuilds.push(
      // one run for many services (older)
      { id: 1, finishTime: at(30), tags: ['drift:payments/api=yes', 'drift:billing/ledger=YES', 'service:all'], _links: { web: { href: 'https://ado/b/1' } } },
      // one run per service (newer): wins for payments/api
      { id: 2, finishTime: at(2), tags: ['service:payments/api', 'drift:no', 'run:r-9'], _links: { web: { href: 'https://ado/b/2' } } },
      { id: 3, finishTime: at(1), tags: ['run:r-10'] }, // no drift tag: ignored
    );
    const before = await entity('payments/api');
    const r = (await inDefaultOrg(() => runSync('ado-drift', 'manual')))!;
    expect(r.status, r.logs.join('\n')).toBe('success');
    const e = await entity('payments/api');
    expect(e.properties).toMatchObject({ drift: false, driftCheckedAt: expect.any(String), driftRunUrl: 'https://ado/b/2' });
    expect(Date.parse(e.properties.driftCheckedAt)).toBeGreaterThan(Date.now() - 3 * 3600_000);
    // merge: nothing else changed (lifecycle, managedBy, the ADO feed's properties)
    const { drift: _d, driftCheckedAt: _c, driftRunUrl: _u, ...rest } = e.properties;
    const { drift: _d0, driftCheckedAt: _c0, driftRunUrl: _u0, ...restBefore } = before.properties;
    expect(rest).toEqual(restBefore);
    expect((await entity('billing/ledger')).properties).toMatchObject({ drift: true, driftRunUrl: 'https://ado/b/1', managedBy: 'crossplane' });
  });
});

describe('V2 scorecards', () => {
  it('scores a platform service', async () => {
    const res = await admin.get(`/api/v1/blueprints/platform-service/entities/${encodeURIComponent('payments/api')}/scorecards`);
    expect(res.status).toBe(200);
    const sc = res.data.find((s: { scorecard: string }) => s.scorecard === 'platform-service-health');
    const passed = Object.fromEntries(sc.rules.map((r: { rule: string; passed: boolean; error?: string }) => [r.rule, r.error ?? r.passed]));
    expect(passed).toEqual({
      managedByPlatform: true,
      ownerAndOnCall: true,
      currentGoldenPath: true,
      noPolicyViolations: true,
      noDrift: true,
      secretsFromVault: true,
      qualityGatePasses: false,
    });
    expect(sc.level).toBe('Silver');
    // A lean service (applied by OpenTofu, no watcher property) passes the same rules.
    await inDefaultOrg(() =>
      upsertEntity(
        'platform-service',
        {
          identifier: 'payments/lean-api',
          team: 'payments',
          properties: {
            lifecycle: 'Ready',
            managedBy: 'opentofu',
            goldenPath: 'java-api',
            goldenPathVersion: '3',
            onCall: 'payments-oncall',
            vaultSecrets: true,
            drift: false,
            driftCheckedAt: new Date().toISOString(),
          },
        },
        { source: 'action' },
      ),
    );
    const lean = (await admin.get(`/api/v1/blueprints/platform-service/entities/${encodeURIComponent('payments/lean-api')}/scorecards`)).data[0];
    expect(lean.level, JSON.stringify(lean.rules)).toBe('Silver');
    // Drift found (or an old check): not up to date.
    await inDefaultOrg(() =>
      upsertEntity('platform-service', { identifier: 'payments/lean-api', properties: { drift: true } }, { source: 'action', merge: true }),
    );
    const drifted = (await admin.get(`/api/v1/blueprints/platform-service/entities/${encodeURIComponent('payments/lean-api')}/scorecards`)).data[0];
    expect(drifted.rules.find((x: { rule: string }) => x.rule === 'noDrift').passed).toBe(false);
    const legacy = (await admin.get(`/api/v1/blueprints/platform-service/entities/${encodeURIComponent('legacy/tools')}/scorecards`)).data[0];
    expect(legacy.rules.find((r: { rule: string }) => r.rule === 'managedByPlatform').passed).toBe(false);
  });
});

describe('run timeline', () => {
  const finished = async (id: string) =>
    waitFor(async () => {
      const r = await admin.get(`/api/v1/runs/${id}`);
      return ['SUCCESS', 'FAILURE'].includes(r.data.status) && (r.data as Run);
    });

  it('merges the run, the catalog transitions, Loki logs and Tempo traces, then caches once terminal', async () => {
    process.env.LOKI_URL = obs.url;
    process.env.TEMPO_URL = obs.url;
    await admin.put('/api/v1/actions/create-platform-service', {
      title: 'Create a platform service',
      trigger: { type: 'form', on: 'create', blueprint: 'platform-service', inputs: { properties: { name: { type: 'string' } }, required: ['name'] } },
      steps: [
        {
          id: 'register',
          name: 'Register in the catalog',
          type: 'invoke',
          invoker: {
            type: 'catalog',
            blueprint: 'platform-service',
            identifier: 'payments/{{ inputs.name }}',
            team: 'payments',
            merge: true,
            properties: { lifecycle: 'Committed', lastRunId: '{{ run.id }}' },
          },
        },
      ],
    });
    const created = await admin.post('/api/v1/actions/create-platform-service/runs', { inputs: { name: 'orders' } });
    expect(created.status, JSON.stringify(created.data)).toBe(201);
    runId = created.data.id;
    const r = await finished(runId);
    expect(r.status).toBe('SUCCESS');

    // The watcher reports the XR, then its resources becoming ready.
    const pending = fx.mr('Repository', 'orders', 'orders', { conditions: [fx.cond('Synced', 'True'), fx.cond('Ready', 'False', 'Creating')] });
    await deliver(statuses([fx.xr('orders', { runId, conditions: [fx.cond('Synced', 'True'), fx.cond('Ready', 'False', 'Creating')] })], [pending]));
    const ready = fx.mr('Repository', 'orders', 'orders', { conditions: fx.READY });
    await deliver(statuses([fx.xr('orders', { runId, conditions: fx.READY })], [ready]));

    const t = (await admin.get(`/api/v1/runs/${runId}/timeline`)).data;
    expect(t.entity).toMatchObject({ blueprint: 'platform-service', identifier: 'payments/orders', lifecycle: 'Ready' });
    expect(t.sources.map((s: { name: string; status: string }) => `${s.name}:${s.status}`)).toEqual(['portal:ok', 'catalog:ok', 'loki:ok', 'tempo:ok']);
    const steps = t.events.map((e: { step: string; symbol: string; source: string }) => `${e.source}:${e.step}:${e.symbol}`);
    expect(steps).toEqual(
      expect.arrayContaining([
        'portal:Requested:·',
        'portal:Register in the catalog:✓',
        'portal:Run success:✓',
        'catalog:Committed:·',
        'catalog:Reconciling:…',
        'catalog:Repository orders:…',
        'catalog:Repository orders:✓',
        'catalog:Ready:✓',
        'k8s_events:Repository:✓',
        'tempo:workflow:·',
      ]),
    );
    const times = t.events.map((e: { time: string }) => Date.parse(e.time));
    expect([...times].sort((a, b) => a - b)).toEqual(times);
    expect(steps.indexOf('catalog:Committed:·')).toBeLessThan(steps.indexOf('catalog:Ready:✓'));
    // Ready a moment ago: not settled yet, so not cached.
    expect(t).toMatchObject({ terminal: false, cached: false });

    // Later on (past the settle delay) the timeline is final and stored with the run.
    const run = (await admin.get(`/api/v1/runs/${runId}`)).data as Run;
    const final = await inDefaultOrg(() => buildTimeline(run, { canSeeEntity: async () => true, at: Date.now() + SETTLE_MS + 5_000 }));
    expect(final).toMatchObject({ terminal: true, cached: false });
    expect(await inDefaultOrg(() => all('SELECT run_id FROM run_timelines WHERE run_id = ?', runId))).toHaveLength(1);
    const calls = lokiCalls;
    const again = (await admin.get(`/api/v1/runs/${runId}/timeline`)).data;
    expect(again).toMatchObject({ cached: true, terminal: true });
    expect(again.events).toEqual(final.events);
    expect(lokiCalls).toBe(calls); // served from the cache
  });

  it('works without Loki and Tempo, and hides runs from people who cannot see them', async () => {
    delete process.env.LOKI_URL;
    delete process.env.TEMPO_URL;
    const created = await admin.post('/api/v1/actions/create-platform-service/runs', { inputs: { name: 'billing' } });
    await finished(created.data.id);
    const t = (await admin.get(`/api/v1/runs/${created.data.id}/timeline`)).data;
    expect(t.sources.map((s: { name: string; status: string }) => `${s.name}:${s.status}`)).toEqual([
      'portal:ok',
      'catalog:ok',
      'loki:unconfigured',
      'tempo:unconfigured',
    ]);
    expect(t.events.length).toBeGreaterThan(1);
    const stranger = client(app, (await register(app, 'stranger@example.com')).token);
    expect((await stranger.get(`/api/v1/runs/${created.data.id}/timeline`)).status).toBe(404);
    expect((await admin.get('/api/v1/runs/nope/timeline')).status).toBe(404);
  });
});

describe('timeline building blocks', () => {
  const base = { id: 'r1', status: 'SUCCESS' as const, createdAt: '2026-11-08T09:40:00.000Z', endedAt: '2026-11-08T09:41:02.000Z' };
  const at = Date.parse('2026-11-08T10:30:00.000Z');

  it('decides when a timeline is final', () => {
    const e = (properties: Record<string, unknown>, updatedAt = '2026-11-08T09:45:00.000Z') => ({ properties, updatedAt });
    expect(isTerminal({ ...base, status: 'IN_PROGRESS' }, null, at)).toBe(false);
    expect(isTerminal(base, null, at)).toBe(true);
    expect(isTerminal(base, null, Date.parse(base.endedAt) + 1_000)).toBe(false); // logs still settling
    expect(isTerminal(base, e({ lifecycle: 'Ready', lastRunId: 'r1', observedRunId: 'r1' }), at)).toBe(true);
    expect(isTerminal(base, e({ lifecycle: 'Ready', lastRunId: 'r1', observedRunId: 'r0' }), at)).toBe(false); // the cluster still shows the previous run
    expect(isTerminal(base, e({ lifecycle: 'Reconciling', lastRunId: 'r1' }), at)).toBe(false);
    expect(isTerminal(base, e({ lifecycle: 'Rejected', lastRunId: 'r1' }), at)).toBe(true);
    expect(isTerminal(base, e({ lifecycle: 'Degraded', lastRunId: 'r1' }, '2026-11-08T10:20:00.000Z'), at)).toBe(false);
    expect(isTerminal(base, e({ lifecycle: 'Degraded', lastRunId: 'r1' }, '2026-11-08T09:50:00.000Z'), at)).toBe(true);
    expect(isTerminal(base, e({ lifecycle: 'Reconciling', lastRunId: 'r2' }), at)).toBe(true); // superseded
    expect(isTerminal({ ...base, status: 'FAILURE' }, e({ lifecycle: 'Requested', lastRunId: 'r1' }), at)).toBe(true);
  });

  it('orders events by time, the portal first at equal times, without duplicates', () => {
    const merged = mergeEvents(
      tempoEvents({ traces: [{ traceID: 't', rootTraceName: 'span', startTimeUnixNano: `${BigInt(Date.parse('2026-11-08T09:42:00Z')) * 1_000_000n}` }] }),
      lokiEvents({
        data: {
          result: [
            {
              stream: { source: 'k8s_events', step: 'Project' },
              values: [
                [`${BigInt(Date.parse('2026-11-08T09:41:48Z')) * 1_000_000n}`, 'CreatedExternalResource: ok'],
                [`${BigInt(Date.parse('2026-11-08T09:42:31Z')) * 1_000_000n}`, '{"level":"warn","msg":"quality gate \'acme-default\' not found"}'],
              ],
            },
          ],
        },
      }),
      [{ time: '2026-11-08T09:41:48.000Z', step: 'Committed', status: 'info', symbol: '·', source: 'portal' }],
      [{ time: '2026-11-08T09:41:48.000Z', step: 'Committed', status: 'info', symbol: '·', source: 'portal' }],
    );
    expect(merged.map((e) => `${e.time.slice(11, 19)} ${e.step} ${e.symbol}`)).toEqual([
      '09:41:48 Committed ·',
      '09:41:48 Project ✓',
      '09:42:00 span ·',
      '09:42:31 Project ✗',
    ]);
    expect(merged[3]!.message).toBe("quality gate 'acme-default' not found");
  });

  it('reads lifecycle and resource transitions from the entity history, until a newer run takes over', () => {
    const v = (at: string, properties: Record<string, unknown>) => ({ at, properties });
    const events = catalogEvents('r1', [
      v('2026-11-08T09:41:02Z', { lifecycle: 'Committed', lastRunId: 'r1' }),
      v('2026-11-08T09:41:20Z', { lifecycle: 'Synced', lastRunId: 'r1', observedRunId: 'r1' }),
      v('2026-11-08T09:41:48Z', { lifecycle: 'Reconciling', lastRunId: 'r1', resources: [{ kind: 'Project', name: 'p', ready: true, synced: true }] }),
      v('2026-11-08T09:42:31Z', {
        lifecycle: 'Degraded',
        lastRunId: 'r1',
        resources: [
          { kind: 'Project', name: 'p', ready: true, synced: true },
          { kind: 'SonarProject', name: 's', ready: false, synced: false, message: "quality gate 'acme-default' not found" },
        ],
      }),
      v('2026-11-08T10:00:00Z', { lifecycle: 'Committed', lastRunId: 'r2' }),
    ]);
    expect(events.map((e) => `${e.step} ${e.symbol}${e.message ? ` ${e.message}` : ''}`)).toEqual([
      'Committed ·',
      'Synced · applied by Argo CD',
      'Reconciling …',
      'Project p ✓',
      'Degraded ✗',
      "SonarProject s ✗ quality gate 'acme-default' not found → retrying",
    ]);
  });

  it('lists the run itself: request, steps and end', () => {
    const events = portalEvents({
      ...base,
      action: 'a',
      actionTitle: 'Create',
      blueprint: null,
      entity: null,
      inputs: {},
      statusLabel: null,
      link: null,
      triggeredBy: { id: 'u', name: 'Jane', email: 'jane@asterius.fr' },
      approvals: [{ userId: 'u2', userName: 'Bob', decision: 'approved', comment: '', at: '2026-11-08T09:40:30.000Z' }],
      result: null,
      startedAt: base.createdAt,
      steps: [
        {
          id: 'commit',
          name: 'Commit the spec',
          status: 'SUCCESS',
          endedAt: '2026-11-08T09:41:02.000Z',
          startedAt: '2026-11-08T09:40:50.000Z',
          approvals: [],
        } as never,
      ],
    });
    expect(events.map((e) => `${e.step} ${e.symbol}`)).toEqual(['Requested ·', 'Approval ✓', 'Commit the spec ✓', 'Run success ✓']);
  });

  it('escapes the run id in the LogQL selector', () => {
    expect(runSelector('r-"1\\')).toBe('{run_id="r-\\"1\\\\"}');
  });
});
