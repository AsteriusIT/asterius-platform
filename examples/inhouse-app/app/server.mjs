#!/usr/bin/env node
// A tiny in-house "database as a service" API, the reference of docs/PLATFORM-READY.md: what an internal application
// exposes so the platform can list its resources and act on them through a connector definition. No dependencies,
// state in memory (restarting resets it).
//
//   PORT=8090 API_KEY=dev-key node server.mjs
//
//   GET   /healthz                       liveness, no authentication (Kubernetes probes)
//   GET   /api/v1/health                 authenticated health: "Test connection" checks the URL and the key
//   GET   /api/v1/databases              paged list: ?limit=&cursor=&updatedSince=<ISO 8601> → { items, nextCursor }
//   GET   /api/v1/databases/:id          one database
//   POST  /api/v1/databases              { name, engine, size, team } → 202 { jobId, status, statusUrl } (Idempotency-Key)
//   PATCH /api/v1/databases/:id          { size } → 202 { jobId, … } (resize; Idempotency-Key)
//   GET   /api/v1/jobs/:id               { id, status: queued|running|succeeded|failed, resourceId, error? }
//
// Authentication: `Authorization: Bearer <API_KEY>` or `X-Api-Key: <API_KEY>`. Errors: { error: { code, message } }.
/* global process, console, Buffer, URL, setTimeout */
import http from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';

const PORT = Number(process.env.PORT ?? 8090);
const API_KEY = process.env.API_KEY ?? '';
const JOB_SECONDS = Number(process.env.JOB_SECONDS ?? 6);
if (!API_KEY) {
  console.error('API_KEY is required');
  process.exit(1);
}

const ENGINES = { postgres: '16', mysql: '8.4', redis: '7.4' };
const SIZES = ['S', 'M', 'L'];
const now = () => new Date().toISOString();
const ago = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString();

/** id → database. Ids are stable: the platform uses them as entity identifiers. */
const databases = new Map();
/** id → job. */
const jobs = new Map();
/** Idempotency-Key → { status, body } of the first answer. */
const replies = new Map();

for (const [name, engine, size, minutes] of [
  ['orders', 'postgres', 'M', 600],
  ['payments', 'postgres', 'L', 420],
  ['sessions', 'redis', 'S', 300],
  ['catalog', 'mysql', 'S', 120],
  ['analytics', 'postgres', 'L', 30],
]) {
  const id = `db-${name}`;
  databases.set(id, {
    id,
    name,
    engine,
    version: ENGINES[engine],
    size,
    team: 'platform',
    status: 'available',
    host: `${name}.db.internal`,
    createdAt: ago(minutes + 60),
    updatedAt: ago(minutes),
  });
}

const send = (res, status, body, headers = {}) => {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(body === undefined ? '' : JSON.stringify(body));
};
const fail = (res, status, code, message) => send(res, status, { error: { code, message } });

function authorized(req) {
  const given = req.headers['x-api-key'] ?? /^Bearer (.+)$/i.exec(req.headers.authorization ?? '')?.[1] ?? '';
  const a = Buffer.from(String(given));
  const b = Buffer.from(API_KEY);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function readJson(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 64_000) throw Object.assign(new Error('body too large'), { status: 413 });
  }
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw Object.assign(new Error('the body is not JSON'), { status: 400, code: 'invalid_json' });
  }
}

/** Start a job: it runs for JOB_SECONDS, then applies `change` (or fails with its error). */
function startJob(kind, resourceId, change) {
  const job = { id: `job-${randomUUID()}`, kind, status: 'queued', resourceId, createdAt: now(), updatedAt: now() };
  jobs.set(job.id, job);
  setTimeout(() => Object.assign(job, { status: 'running', updatedAt: now() }), 1000);
  setTimeout(() => {
    try {
      change();
      Object.assign(job, { status: 'succeeded', updatedAt: now() });
    } catch (err) {
      Object.assign(job, { status: 'failed', error: { code: 'job_failed', message: err.message }, updatedAt: now() });
    }
  }, JOB_SECONDS * 1000);
  return job;
}
const accepted = (job) => ({ jobId: job.id, status: job.status, resourceId: job.resourceId, statusUrl: `/api/v1/jobs/${job.id}` });

/** Replays the first answer for a repeated Idempotency-Key (retries never start a second job). */
async function idempotent(req, res, handler) {
  const key = req.headers['idempotency-key'];
  if (key && replies.has(key)) {
    const r = replies.get(key);
    return send(res, r.status, r.body, { 'idempotent-replayed': 'true' });
  }
  const { status, body } = await handler();
  if (key && status < 500) replies.set(key, { status, body });
  send(res, status, body);
}

function list(url, res) {
  const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? 50) || 50, 1), 200);
  const since = url.searchParams.get('updatedSince');
  if (since && Number.isNaN(Date.parse(since))) return fail(res, 400, 'invalid_parameter', 'updatedSince must be an ISO 8601 date');
  const cursor = url.searchParams.get('cursor');
  // Stable order (by id) and an opaque cursor: the id after which the next page starts.
  const after = cursor ? Buffer.from(cursor, 'base64url').toString() : '';
  const all = [...databases.values()]
    .filter((d) => !since || Date.parse(d.updatedAt) >= Date.parse(since))
    .sort((a, b) => a.id.localeCompare(b.id))
    .filter((d) => d.id > after);
  const items = all.slice(0, limit);
  const nextCursor = all.length > limit ? Buffer.from(items.at(-1).id).toString('base64url') : null;
  send(res, 200, { items, nextCursor });
}

async function create(req) {
  const b = await readJson(req);
  if (typeof b.name !== 'string' || !/^[a-z][a-z0-9-]{1,30}$/.test(b.name))
    return { status: 400, body: { error: { code: 'invalid_parameter', message: 'name: 2-31 lowercase letters, digits and -' } } };
  if (!(b.engine in ENGINES))
    return { status: 400, body: { error: { code: 'invalid_parameter', message: `engine: one of ${Object.keys(ENGINES).join(', ')}` } } };
  const size = b.size ?? 'S';
  if (!SIZES.includes(size)) return { status: 400, body: { error: { code: 'invalid_parameter', message: `size: one of ${SIZES.join(', ')}` } } };
  if (typeof b.team !== 'string' || !b.team) return { status: 400, body: { error: { code: 'invalid_parameter', message: 'team is required' } } };
  const id = `db-${b.name}`;
  if (databases.has(id)) return { status: 409, body: { error: { code: 'conflict', message: `database ${b.name} already exists` } } };
  const db = {
    id,
    name: b.name,
    engine: b.engine,
    version: ENGINES[b.engine],
    size,
    team: b.team,
    status: 'creating',
    host: `${b.name}.db.internal`,
    createdAt: now(),
    updatedAt: now(),
  };
  databases.set(id, db);
  const job = startJob('create', id, () => Object.assign(db, { status: 'available', updatedAt: now() }));
  return { status: 202, body: accepted(job) };
}

async function resize(req, id) {
  const db = databases.get(id);
  if (!db) return { status: 404, body: { error: { code: 'not_found', message: `database ${id} not found` } } };
  const b = await readJson(req);
  if (!SIZES.includes(b.size)) return { status: 400, body: { error: { code: 'invalid_parameter', message: `size: one of ${SIZES.join(', ')}` } } };
  if (db.status !== 'available') return { status: 409, body: { error: { code: 'busy', message: `database ${db.name} is ${db.status}` } } };
  Object.assign(db, { status: 'resizing', updatedAt: now() });
  const job = startJob('resize', id, () => Object.assign(db, { size: b.size, status: 'available', updatedAt: now() }));
  return { status: 202, body: accepted(job) };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://app');
  const path = url.pathname.replace(/\/$/, '') || '/';
  try {
    if (path === '/healthz') return send(res, 200, { status: 'ok' });
    if (!path.startsWith('/api/v1/')) return fail(res, 404, 'not_found', 'no such endpoint');
    if (!authorized(req)) return fail(res, 401, 'unauthorized', 'missing or invalid API key');
    let m;
    if (path === '/api/v1/health' && req.method === 'GET') return send(res, 200, { status: 'ok', databases: databases.size });
    if (path === '/api/v1/databases' && req.method === 'GET') return list(url, res);
    if (path === '/api/v1/databases' && req.method === 'POST') return await idempotent(req, res, () => create(req));
    if ((m = /^\/api\/v1\/databases\/([^/]+)$/.exec(path))) {
      const id = decodeURIComponent(m[1]);
      if (req.method === 'GET') return databases.has(id) ? send(res, 200, databases.get(id)) : fail(res, 404, 'not_found', `database ${id} not found`);
      if (req.method === 'PATCH') return await idempotent(req, res, () => resize(req, id));
    }
    if ((m = /^\/api\/v1\/jobs\/([^/]+)$/.exec(path)) && req.method === 'GET') {
      const job = jobs.get(decodeURIComponent(m[1]));
      return job ? send(res, 200, job) : fail(res, 404, 'not_found', 'no such job');
    }
    fail(res, 404, 'not_found', 'no such endpoint');
  } catch (err) {
    fail(res, err.status ?? 500, err.code ?? 'internal', err.message);
  }
});
server.listen(PORT, () => console.log(`in-house DBaaS listening on :${PORT}`));
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => server.close(() => process.exit(0)));
