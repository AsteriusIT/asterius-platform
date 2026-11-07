// k6 scenarios for the sizing profile in docs/PERFORMANCE.md (100k entities, 500 users, 1k runs per hour).
//
//   k6 run -e BASE_URL=http://localhost:8080 -e TOKEN=<from loadtest/seed.mts> -e SINK_URL=http://localhost:9099 loadtest/k6/scenarios.js
//
// Env: SCENARIOS (comma list of browse,search,runs,ingest,fanout; default all), USERS (500), DURATION (5m),
//      ENTITIES (100000, as seeded), SINK_URL (enables fanout; a loadtest/sink.mts reachable from the platform
//      as SINK_PUBLIC_URL, default SINK_URL).
// Thresholds come from loadtest/budget.json: the run exits non-zero when one is crossed.
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend } from 'k6/metrics';

const budget = JSON.parse(open('../budget.json'));
const BASE = (__ENV.BASE_URL || 'http://localhost:8080').replace(/\/$/, '');
const API = `${BASE}/api/v1`;
const TOKEN = __ENV.TOKEN;
const USERS = Number(__ENV.USERS || 500);
const DURATION = __ENV.DURATION || '5m';
const ENTITIES = Number(__ENV.ENTITIES || 100000);
const BLUEPRINTS = 20;
const PER_BP = Math.ceil(ENTITIES / BLUEPRINTS);
const SINK = __ENV.SINK_URL || '';
const SINK_PUBLIC = __ENV.SINK_PUBLIC_URL || SINK;
const WANTED = (__ENV.SCENARIOS || 'browse,search,runs,ingest,fanout').split(',');
const WORDS = ['payments', 'orders', 'billing', 'catalog', 'search', 'auth', 'gateway', 'inventory', 'shipping', 'reports', 'ledger', 'mailer'];

const t = {
  browse: new Trend('catalog_browse_ms', true),
  search: new Trend('catalog_search_ms', true),
  detail: new Trend('entity_detail_ms', true),
  trigger: new Trend('run_trigger_ms', true),
  completion: new Trend('run_completion_s'),
  bulk: new Trend('bulk_ingest_ms', true),
  delivery: new Trend('webhook_delivery_ms'),
};

const FANOUT_BP = 'lt-19';
const FANOUT_HOOKS = 2;
const FANOUT_BATCH = 10;
const FANOUT_ITERATIONS = 60;

const all = {
  browse: {
    executor: 'ramping-vus',
    exec: 'browse',
    startVUs: 0,
    stages: [
      { duration: '1m', target: USERS },
      { duration: DURATION, target: USERS },
      { duration: '30s', target: 0 },
    ],
  },
  search: {
    executor: 'ramping-vus',
    exec: 'search',
    startVUs: 0,
    stages: [
      { duration: '1m', target: Math.ceil(USERS / 5) },
      { duration: DURATION, target: Math.ceil(USERS / 5) },
      { duration: '30s', target: 0 },
    ],
  },
  runs: { executor: 'constant-arrival-rate', exec: 'runs', rate: 1000, timeUnit: '1h', duration: DURATION, preAllocatedVUs: 5, maxVUs: 50 },
  ingest: { executor: 'constant-arrival-rate', exec: 'ingest', rate: 1, timeUnit: '1s', duration: DURATION, preAllocatedVUs: 5, maxVUs: 20 },
  fanout: { executor: 'constant-arrival-rate', exec: 'fanout', rate: 1, timeUnit: '1s', duration: `${FANOUT_ITERATIONS}s`, preAllocatedVUs: 2, maxVUs: 5 },
};

export const options = {
  scenarios: Object.fromEntries(Object.entries(all).filter(([name]) => WANTED.includes(name) && (name !== 'fanout' || SINK))),
  thresholds: {
    http_req_failed: [`rate<${budget.error_rate_max}`],
    checks: [`rate>${1 - budget.error_rate_max}`],
    catalog_browse_ms: [`p(95)<${budget.catalog_browse_p95_ms}`],
    catalog_search_ms: [`p(95)<${budget.catalog_search_p95_ms}`],
    entity_detail_ms: [`p(95)<${budget.entity_detail_p95_ms}`],
    run_trigger_ms: [`p(95)<${budget.run_trigger_p95_ms}`],
    run_completion_s: [`p(95)<${budget.run_completion_p95_seconds}`],
    bulk_ingest_ms: [`p(95)<${budget.bulk_ingest_p95_ms}`],
    webhook_delivery_ms: [`max<${budget.webhook_delivery_p95_ms}`],
  },
  summaryTrendStats: ['avg', 'med', 'p(90)', 'p(95)', 'max'],
};

// The API rate-limits per client IP (trustProxy): give every virtual user its own address, as real users have.
const headers = () => {
  const n = __VU;
  return { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}`, 'x-forwarded-for': `10.${(n >> 16) & 255}.${(n >> 8) & 255}.${n & 255}` };
};
const get = (path, trend, name) => {
  const res = http.get(`${API}${path}`, { headers: headers(), tags: { name } });
  if (trend) trend.add(res.timings.duration);
  check(res, { [`${name} 200`]: (r) => r.status === 200 });
  return res;
};
const pad = (n) => String(n).padStart(6, '0');
const rnd = (n) => Math.floor(Math.random() * n);
const bp = () => `lt-${String(rnd(BLUEPRINTS)).padStart(2, '0')}`;

export function setup() {
  if (!TOKEN) throw new Error('TOKEN is required (printed by loadtest/seed.mts)');
  if (SINK && WANTED.includes('fanout')) {
    for (let i = 0; i < FANOUT_HOOKS; i++) {
      const res = http.put(
        `${API}/webhooks/lt-sink-${i}`,
        JSON.stringify({ title: `Load test sink ${i}`, url: `${SINK_PUBLIC}/hook/${i}`, events: ['entity.updated'], blueprints: [FANOUT_BP] }),
        { headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` } },
      );
      check(res, { 'webhook created': (r) => r.status === 200 });
    }
    http.post(`${SINK}/reset`);
  }
}

// ~500 concurrent users with think time: home, list a page of a blueprint, open an entity and its relations.
export function browse() {
  get('/home', t.browse, 'home');
  const b = bp();
  const page = rnd(Math.floor(PER_BP / 50));
  get(`/blueprints/${b}/entities?limit=50&offset=${page * 50}`, t.browse, 'list');
  get(`/blueprints/${b}/entities?limit=50&tier=gold&sort=updated`, t.browse, 'filter');
  const id = `e-${pad(rnd(PER_BP))}`;
  get(`/blueprints/${b}/entities/${id}`, t.detail, 'detail');
  get(`/blueprints/${b}/entities/${id}/related`, t.detail, 'related');
  sleep(3 + Math.random() * 5);
}

export function search() {
  get(`/entities?search=${WORDS[rnd(WORDS.length)]}&limit=25`, t.search, 'search');
  get(`/entities?search=${rnd(ENTITIES)}&limit=25`, t.search, 'search-number');
  sleep(2 + Math.random() * 4);
}

// Self-service run: trigger, approve (the platform approver), wait for completion.
export function runs() {
  const name = `lt-run-${__VU}-${__ITER}-${Date.now()}`;
  const res = http.post(`${API}/actions/loadtest-provision/runs`, JSON.stringify({ inputs: { name } }), { headers: headers(), tags: { name: 'run-trigger' } });
  t.trigger.add(res.timings.duration);
  if (!check(res, { 'run created': (r) => r.status === 201 })) return;
  const id = res.json('id');
  const started = Date.now();
  // The step exists once a worker has picked the run up: retry until the approval can be given.
  let approved = false;
  for (let i = 0; i < 30 && !approved; i++) {
    const approve = http.post(`${API}/runs/${id}/steps/approval/approve`, JSON.stringify({}), {
      headers: headers(),
      tags: { name: 'run-approve' },
      responseCallback: http.expectedStatuses(200, 409, 404),
    });
    approved = approve.status === 200;
    if (!approved) sleep(0.5);
  }
  check(null, { 'run approved': () => approved });
  for (let i = 0; i < 120; i++) {
    const r = http.get(`${API}/runs/${id}`, { headers: headers(), tags: { name: 'run-poll' } });
    const status = r.json('status');
    if (['SUCCESS', 'FAILURE', 'REJECTED', 'CANCELLED'].includes(status)) {
      t.completion.add((Date.now() - started) / 1000);
      check(r, { 'run succeeded': () => status === 'SUCCESS' });
      return;
    }
    sleep(1);
  }
  check(null, { 'run finished in time': () => false });
}

// Bulk ingestion as an integration would do it: 200 entities per call, mostly new values.
export function ingest() {
  const b = bp();
  const base = rnd(PER_BP - 200);
  const entities = [];
  for (let i = 0; i < 200; i++)
    entities.push({
      identifier: `e-${pad(base + i)}`,
      title: `ingested ${__ITER}-${i}`,
      properties: { tier: 'silver', monthlyCost: rnd(5000), description: `ingested at ${Date.now()}` },
    });
  const res = http.post(`${API}/blueprints/${b}/entities/bulk`, JSON.stringify({ entities, merge: true }), { headers: headers(), tags: { name: 'bulk' } });
  t.bulk.add(res.timings.duration);
  check(res, { 'bulk 200': (r) => r.status === 200 && r.json('errors').length === 0 });
}

// Events -> outbound webhooks: every changed entity of FANOUT_BP is delivered to each sink.
export function fanout() {
  const entities = [];
  for (let i = 0; i < FANOUT_BATCH; i++) entities.push({ identifier: `e-${pad(i)}`, properties: { monthlyCost: Date.now() % 1000000 } });
  const res = http.post(`${API}/blueprints/${FANOUT_BP}/entities/bulk`, JSON.stringify({ entities, merge: true }), {
    headers: headers(),
    tags: { name: 'fanout' },
  });
  check(res, { 'fanout 200': (r) => r.status === 200 });
}

export function teardown() {
  if (!SINK || !WANTED.includes('fanout')) return;
  const expected = FANOUT_ITERATIONS * FANOUT_BATCH * FANOUT_HOOKS;
  let stats = http.get(`${SINK}/stats`).json();
  for (let i = 0; i < 180 && stats.received < expected * 0.99; i++) {
    sleep(1);
    stats = http.get(`${SINK}/stats`).json();
  }
  // A missing delivery counts as the worst case: the threshold below then fails the run.
  t.delivery.add(stats.received >= expected * 0.99 ? stats.p95 : 10 * budget.webhook_delivery_p95_ms);
  console.log(`fan-out: ${stats.received}/${expected} deliveries, p50 ${stats.p50} ms, p95 ${stats.p95} ms`);
}
