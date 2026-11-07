/**
 * Seed a running platform with a synthetic catalog and the load-test fixtures.
 *
 *   BASE_URL=http://localhost:8080 ENTITIES=100000 npx tsx loadtest/seed.mts
 *
 * Signs in (registering the admin on a fresh instance when needed), creates teams, 20 blueprints, the entities
 * (bulk API, 1000 per call), the `loadtest-provision` action (approval + catalog upsert, no external system) and prints
 * `TOKEN=<session token>` as the last line for the k6 scenarios.
 */
import { BLUEPRINTS, entityAt, blueprintDef, blueprintId, teamDefs } from '../apps/server/src/loadtest/seed-data.js';

const BASE = (process.env.BASE_URL ?? 'http://localhost:8080').replace(/\/$/, '');
const TOTAL = Number(process.env.ENTITIES ?? 100_000);
const BATCH = 1000;
const PARALLEL = Number(process.env.SEED_PARALLEL ?? 4);
const EMAIL = process.env.ADMIN_EMAIL ?? 'loadtest@example.com';
const PASSWORD = process.env.ADMIN_PASSWORD ?? 'correct-horse-battery';

async function call<T = unknown>(method: string, path: string, body?: unknown, token?: string): Promise<{ status: number; data: T }> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, data: (text ? JSON.parse(text) : undefined) as T };
}

async function signIn(): Promise<string> {
  const creds = { email: EMAIL, name: 'Load test', password: PASSWORD };
  for (const path of ['/api/auth/register', '/api/auth/login']) {
    const r = await call<{ token: string }>('POST', path, creds);
    if (r.status === 200) return r.data.token;
  }
  throw new Error('Cannot sign in: set ADMIN_EMAIL / ADMIN_PASSWORD of an existing admin (or enable local registration)');
}

async function put(token: string, path: string, body: unknown) {
  const r = await call<{ error?: string }>('PUT', path, body, token);
  if (r.status !== 200) throw new Error(`PUT ${path}: ${r.status} ${JSON.stringify(r.data)}`);
}

const token = await signIn();
for (const t of teamDefs()) await put(token, `/api/v1/teams/${t.identifier}`, t);
// Relations may only target existing blueprints: create them bare first, then add the relations.
for (let i = 0; i < BLUEPRINTS; i++) await put(token, `/api/v1/blueprints/${blueprintId(i)}`, { ...blueprintDef(i), relations: {} });
for (let i = 0; i < BLUEPRINTS; i++) await put(token, `/api/v1/blueprints/${blueprintId(i)}`, blueprintDef(i));

// Provisioning workflow for the "runs" scenario: approval by an admin (self approval allowed: one token drives the test), then a catalog write.
await put(token, '/api/v1/actions/loadtest-provision', {
  title: 'Load test provisioning',
  trigger: {
    type: 'form',
    on: 'create',
    blueprint: blueprintId(0),
    inputs: { properties: { name: { type: 'string' } }, required: ['name'] },
  },
  steps: [
    { id: 'approval', type: 'approval', approvers: { roles: ['admin'] }, allowSelfApproval: true, message: 'Load test approval' },
    {
      id: 'register',
      type: 'invoke',
      invoker: {
        type: 'catalog',
        operation: 'upsert',
        blueprint: blueprintId(0),
        identifier: '{{ inputs.name }}',
        title: '{{ inputs.name }}',
        properties: { tier: 'bronze' },
      },
    },
  ],
});

const perBlueprint = Math.ceil(TOTAL / BLUEPRINTS);
const started = Date.now();
let next = 0;
let done = 0;
const worker = async () => {
  while (next < TOTAL) {
    const from = next;
    next = Math.min(TOTAL, next + BATCH);
    const byBlueprint = new Map<string, unknown[]>();
    for (let n = from; n < next; n++) {
      const { blueprint, entity } = entityAt(n, BLUEPRINTS, perBlueprint);
      byBlueprint.set(blueprint, [...(byBlueprint.get(blueprint) ?? []), entity]);
    }
    for (const [bp, entities] of byBlueprint) {
      const r = await call<{ errors: { error: string }[] }>('POST', `/api/v1/blueprints/${bp}/entities/bulk`, { entities }, token);
      if (r.status !== 200 || r.data.errors.length) throw new Error(`bulk ${bp}: ${r.status} ${JSON.stringify(r.data).slice(0, 300)}`);
    }
    done = next;
    console.error(`seeded ${done}/${TOTAL} entities (${Math.round((Date.now() - started) / 1000)}s)`);
  }
};
await Promise.all(Array.from({ length: PARALLEL }, worker));
console.error(`done in ${Math.round((Date.now() - started) / 1000)}s`);
console.log(`TOKEN=${token}`);
