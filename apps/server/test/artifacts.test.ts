import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { client, fakeServer, register, silentLog, testApp, waitFor, type Api } from './helpers.js';
import { startRunWorker } from '../src/actions/worker.js';
import { stepToken } from '../src/secrets.js';
import { config } from '../src/config.js';
import { one, run as sql } from '../src/db.js';

let app: FastifyInstance;
let admin: Api;
let alice: Api;
let bob: Api;
let ext: Awaited<ReturnType<typeof fakeServer>>;
let stop: () => unknown;

type Artifact = { id: string; stepId: string; name: string; contentType: string; size: number; sha256: string };
type RunView = { id: string; status: string; artifacts: Artifact[]; steps: { id: string; status: string; output: Record<string, unknown> | null }[] };
const view = async (api: Api, id: string) => (await api.get(`/api/v1/runs/${id}`)).data as RunView;
const form = { type: 'form', on: 'create', inputs: { properties: {} } };
const b64 = (s: string | Buffer) => Buffer.from(s).toString('base64');
const upload = (runId: string, step: string, body: unknown, token: string) =>
  app.inject({
    method: 'POST',
    url: `/api/v1/runs/${runId}/steps/${step}/artifacts`,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    payload: JSON.stringify(body),
  });

beforeAll(async () => {
  app = await testApp();
  admin = client(app, (await register(app, 'admin@example.com')).token);
  alice = client(app, (await register(app, 'alice@example.com')).token);
  bob = client(app, (await register(app, 'bob@example.com')).token);
  ext = await fakeServer((r) =>
    r.url.includes('report')
      ? {
          body: {
            ok: true,
            artifacts: [
              { name: 'report.txt', contentType: 'text/plain', content: b64('all green') },
              { name: 'evil.html', contentType: 'text/html', content: b64('<script>') },
            ],
          },
        }
      : { body: { accepted: true } },
  );
  stop = startRunWorker(silentLog);
});
afterAll(async () => {
  await stop();
  await ext.close();
  await app.close();
});

describe('run artifacts', () => {
  let runId = '';

  it('accepts uploads from the step callback, lists and serves them safely', async () => {
    const saved = await admin.put('/api/v1/actions/build', {
      title: 'Build',
      trigger: form,
      steps: [
        { id: 'build', type: 'invoke', invoker: { type: 'webhook', url: `${ext.url}/build`, mode: 'async' } },
        {
          id: 'summary',
          type: 'transform',
          output: { files: '$count(steps.build.artifacts)', first: 'steps.build.artifacts[0].name', url: 'steps.build.artifacts[0].url' },
        },
      ],
    });
    expect(saved.status, JSON.stringify(saved.data)).toBe(200);
    runId = (await alice.post('/api/v1/actions/build/runs', { inputs: {} })).data.id;
    await waitFor(async () => (await view(alice, runId)).steps[0]?.status === 'RUNNING');
    const token = stepToken(runId, 'build');

    const res = await upload(runId, 'build', { name: '../../plan.json', contentType: 'application/json; charset=utf-8', content: b64('{"add":3}') }, token);
    expect(res.statusCode, res.body).toBe(201);
    const a = res.json() as Artifact;
    expect(a).toMatchObject({ name: 'plan.json', contentType: 'application/json', size: 9, stepId: 'build' });
    expect(a.sha256).toBe(createHash('sha256').update('{"add":3}').digest('hex'));

    // Content type allow-list, base64 check, unknown step.
    expect((await upload(runId, 'build', { name: 'x.html', contentType: 'text/html', content: b64('<b>') }, token)).statusCode).toBe(400);
    expect((await upload(runId, 'build', { name: 'x.txt', contentType: 'text/plain', content: '***' }, token)).statusCode).toBe(400);
    expect((await upload(runId, 'nope', { name: 'x.txt', contentType: 'text/plain', content: b64('x') }, stepToken(runId, 'nope'))).statusCode).toBe(404);
    // Another step's token does not work for this step.
    expect((await upload(runId, 'build', { name: 'x.txt', contentType: 'text/plain', content: b64('x') }, stepToken(runId, 'summary'))).statusCode).toBe(401);

    const r = await view(alice, runId);
    expect(r.artifacts.map((x) => x.name)).toEqual(['plan.json']);
    const dl = await app.inject({
      method: 'GET',
      url: `/api/v1/runs/${runId}/artifacts/${a.id}`,
      headers: { authorization: `Bearer ${(await register(app, 'carol@example.com')).token}` },
    });
    expect(dl.statusCode).toBe(404); // someone who cannot see the run
    const anonymous = await app.inject({ method: 'GET', url: `/api/v1/runs/${runId}/artifacts/${a.id}` });
    expect(anonymous.statusCode).toBe(401);
  });

  it('downloads with attachment and nosniff headers, for those who can see the run', async () => {
    const list = (await alice.get(`/api/v1/runs/${runId}/artifacts`)).data as Artifact[];
    const token = (
      await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'alice@example.com', password: 'correct-horse-battery' } })
    ).json().token as string;
    const dl = await app.inject({ method: 'GET', url: `/api/v1/runs/${runId}/artifacts/${list[0]!.id}`, headers: { authorization: `Bearer ${token}` } });
    expect(dl.statusCode).toBe(200);
    expect(dl.body).toBe('{"add":3}');
    expect(dl.headers['content-disposition']).toBe(`attachment; filename="plan.json"; filename*=UTF-8''plan.json`);
    expect(dl.headers['x-content-type-options']).toBe('nosniff');
    expect(dl.headers['content-type']).toMatch(/^application\/json/);
    expect((await bob.get(`/api/v1/runs/${runId}/artifacts`)).status).toBe(404);
  });

  it('lets the requester attach files, not other members, and enforces the caps', async () => {
    expect((await bob.post(`/api/v1/runs/${runId}/steps/build/artifacts`, { name: 'b.txt', contentType: 'text/plain', content: b64('b') })).status).toBe(403);
    const mine = await alice.post(`/api/v1/runs/${runId}/steps/build/artifacts`, { name: 'notes.txt', contentType: 'text/plain', content: b64('hello') });
    expect(mine.status, JSON.stringify(mine.data)).toBe(201);
    expect(mine.data.createdBy).toBe('alice@example.com');

    const max = config.ARTIFACT_MAX_BYTES;
    config.ARTIFACT_MAX_BYTES = 1024;
    try {
      const big = await upload(
        runId,
        'build',
        { name: 'big.bin', contentType: 'application/octet-stream', content: b64(Buffer.alloc(2000)) },
        stepToken(runId, 'build'),
      );
      expect(big.statusCode).toBe(413);
    } finally {
      config.ARTIFACT_MAX_BYTES = max;
    }
    const cap = config.RUN_ARTIFACTS_MAX;
    config.RUN_ARTIFACTS_MAX = 2;
    try {
      const third = await upload(runId, 'build', { name: 'c.txt', contentType: 'text/plain', content: b64('c') }, stepToken(runId, 'build'));
      expect(third.statusCode).toBe(409);
    } finally {
      config.RUN_ARTIFACTS_MAX = cap;
    }
  });

  it('exposes steps.<id>.artifacts to later steps', async () => {
    const done = await app.inject({
      method: 'PATCH',
      url: `/api/v1/runs/${runId}/steps/build`,
      headers: { authorization: `Bearer ${stepToken(runId, 'build')}`, 'content-type': 'application/json' },
      payload: JSON.stringify({ status: 'SUCCESS', result: { ok: true } }),
    });
    expect(done.statusCode, done.body).toBe(200);
    const r = await waitFor(async () => {
      const v = await view(alice, runId);
      return v.status === 'SUCCESS' && v;
    });
    const out = r.steps.find((s) => s.id === 'summary')!.output!;
    expect(out.files).toBe(2);
    expect(out.first).toBe('plan.json');
    expect(String(out.url)).toMatch(new RegExp(`/api/v1/runs/${runId}/artifacts/`));
    // Finished run: the callback token can no longer attach files.
    expect((await upload(runId, 'build', { name: 'late.txt', contentType: 'text/plain', content: b64('x') }, stepToken(runId, 'build'))).statusCode).toBe(409);
  });

  it('stores the artifacts of a webhook sync answer (rejecting disallowed ones) outside the output', async () => {
    await admin.put('/api/v1/actions/report', {
      title: 'Report',
      trigger: form,
      steps: [{ id: 'call', type: 'invoke', invoker: { type: 'webhook', url: `${ext.url}/report`, mode: 'sync' } }],
    });
    const id = (await alice.post('/api/v1/actions/report/runs', { inputs: {} })).data.id as string;
    const r = await waitFor(async () => {
      const v = await view(alice, id);
      return v.status === 'SUCCESS' && v;
    });
    expect(r.artifacts.map((a) => a.name)).toEqual(['report.txt']);
    expect(r.steps[0]!.output).toEqual({ ok: true });
  });

  it('is deleted with its run (retention)', async () => {
    expect(Number((await one<{ n: number }>('SELECT count(*) AS n FROM run_artifacts WHERE run_id = ?', runId))?.n)).toBe(2);
    await sql('DELETE FROM runs WHERE id = ?', runId);
    expect(Number((await one<{ n: number }>('SELECT count(*) AS n FROM run_artifacts WHERE run_id = ?', runId))?.n)).toBe(0);
  });
});
