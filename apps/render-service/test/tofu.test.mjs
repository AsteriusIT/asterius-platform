import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { after, before, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { mapPlan, plan, redact, resetRepo, tofuSettings } from '../src/tofu.mjs';

const { fetch } = globalThis;
const here = path.dirname(fileURLToPath(import.meta.url));
const FAKE = path.join(here, 'fake-tofu.mjs');

const service = (name = 'payments-api', environments = ['dev']) => ({
  apiVersion: 'platform.asterius.io/v1alpha1',
  kind: 'Service',
  metadata: { name, namespace: 'team-payments', labels: { 'portal.asterius.io/team': 'payments', 'portal.asterius.io/service': name } },
  spec: { owner: 'payments', goldenPath: { name: 'java-api', version: '3' }, environments, crossplane: { compositionRef: { name: 'java-api-v3' } } },
});

describe('mapPlan', () => {
  it('maps resource changes to the preview contract (import = exists, will be adopted)', () => {
    const r = mapPlan({
      resource_changes: [
        { address: 'data.x.y', mode: 'data', type: 'x', change: { actions: ['read'] } },
        { address: 'a.p', mode: 'managed', type: 'azuredevops_project', change: { actions: ['create'], after: { name: 't-s' } } },
        {
          address: 'a.q',
          mode: 'managed',
          type: 'azuredevops_project',
          change: { actions: ['no-op'], before: { name: 'old' }, after: { name: 'old' }, importing: { id: 'g' } },
        },
        { address: 'a.r', mode: 'managed', type: 't', change: { actions: ['update'], before: { name: 'r' }, after: { name: 'r' } } },
        { address: 'a.s', mode: 'managed', type: 't', change: { actions: ['delete'], before: { name: 's' }, after: null } },
        { address: 'a.t', mode: 'managed', type: 't', change: { actions: ['delete', 'create'], before: { name: 't' }, after: { name: 't2' } } },
        { address: 'a.u', mode: 'managed', type: 't', change: { actions: ['no-op'], before: {}, after: {} } },
        { address: 'a.v', mode: 'managed', type: 't', change: { actions: ['create'], after: {}, after_unknown: { name: true } } },
      ],
    });
    assert.deepEqual(r, [
      { kind: 'azuredevops_project', name: 'a.p', externalName: 't-s', action: 'create' },
      { kind: 'azuredevops_project', name: 'a.q', externalName: 'old', action: 'import', importId: 'g' },
      { kind: 't', name: 'a.r', externalName: 'r', action: 'update' },
      { kind: 't', name: 'a.s', externalName: 's', action: 'delete' },
      { kind: 't', name: 'a.t', externalName: 't2', action: 'update', replace: true },
      { kind: 't', name: 'a.u', externalName: null, action: 'no-op' },
      { kind: 't', name: 'a.v', externalName: null, action: 'create' },
    ]);
    assert.deepEqual(mapPlan({}), []);
  });
  it('masks the PAT (and its Basic form) in messages', () => {
    const s = { pat: 'sekret' };
    assert.equal(redact(`x sekret y ${Buffer.from(':sekret').toString('base64')}`, s), 'x *** y ***');
  });
});

describe('plan (fake tofu)', () => {
  let repo;
  let log;
  before(async () => {
    repo = await fs.mkdtemp(path.join(os.tmpdir(), 'portal-resources-'));
    await fs.mkdir(path.join(repo, 'tofu/service'), { recursive: true });
    await fs.writeFile(path.join(repo, 'tofu/service/main.tf'), 'terraform {\n  backend "azurerm" {}\n}\n');
    await fs.mkdir(path.join(repo, 'schema'), { recursive: true });
    await fs.writeFile(path.join(repo, 'schema/service-xrd.yaml'), 'openAPIV3Schema:\n  properties:\n    spec: { type: object }\n');
  });
  beforeEach(async () => {
    log = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'tofu-log-')), 'calls.jsonl');
    Object.assign(process.env, { TOFU_BIN: FAKE, REPO_DIR: repo, FAKE_TOFU_LOG: log, ADO_PAT: 'pat-123', ADO_ORG_URL: 'https://dev.azure.com/Org/' });
    delete process.env.PLAN_TIMEOUT_SECONDS;
  });
  after(async () => {
    await fs.rm(repo, { recursive: true, force: true });
  });
  const calls = async () =>
    (await fs.readFile(log, 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));

  it('runs init + plan + show with a local backend override and the ADO credentials, then cleans up', async () => {
    const out = await plan(service());
    assert.equal(out.mode, 'tofu');
    assert.deepEqual(
      out.resources.map((r) => [r.kind, r.externalName, r.action]),
      [
        ['azuredevops_project', 'payments-payments-api', 'create'],
        ['azuredevops_git_repository', 'payments-api', 'create'],
        ['azuredevops_build_definition', null, 'create'],
        ['azuredevops_environment', 'dev', 'create'],
      ],
    );
    assert.equal(out.raw.length, 5);
    const c = await calls();
    assert.deepEqual(
      c.map((x) => x.args[0]),
      ['init', 'plan', 'show'],
    );
    assert.ok(c[0].args.includes('-input=false'));
    assert.ok(!c.some((x) => x.args.includes('apply')), 'never applies');
    const plan_ = c[1];
    assert.ok(plan_.args.includes('-lock=false'));
    const specVar = plan_.args[plan_.args.indexOf('-var') + 1];
    assert.match(specVar, /^spec_path=.*services\/team-payments\/payments-api\.yaml$/);
    assert.equal(plan_.pat, 'pat-123');
    assert.equal(plan_.org, 'https://dev.azure.com/Org');
    assert.match(plan_.cwd, /tofu\/service$/);
    // The temp copy is gone, the checkout untouched.
    await assert.rejects(fs.stat(plan_.cwd));
    await assert.rejects(fs.stat(path.join(repo, 'tofu/service/zz_plan_service_override.tf')));
    await assert.rejects(fs.stat(path.join(repo, 'services')));
  });

  it('reports existing resources as import (adopted) and replacements as update', async () => {
    const out = await plan(service('existing', ['dev', 'prod']));
    assert.deepEqual(
      out.resources.map((r) => r.action),
      ['import', 'import', 'create', 'update', 'update'],
    );
  });

  it('fails with the CLI error (PAT masked), refuses bad manifests, and times out', async () => {
    await assert.rejects(plan(service('boom')), (e) => e.status === 422 && /tofu plan failed/.test(e.message) && !e.message.includes('pat-123'));
    await assert.rejects(plan({ kind: 'Service' }), (e) => e.status === 400);
    await assert.rejects(plan({ ...service(), metadata: { ...service().metadata, name: '../x' } }), (e) => e.status === 400);
    process.env.PLAN_TIMEOUT_SECONDS = '1';
    await assert.rejects(plan(service('slow')), (e) => e.status === 504);
  });

  it('answers 503 when the checkout has no root module', async () => {
    await assert.rejects(plan(service(), { ...tofuSettings(), root: 'nope' }), (e) => e.status === 503);
  });
});

describe('Portal repo checkout (git)', () => {
  let origin;
  let cache;
  const gitc = (cwd, ...a) =>
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd, stdio: 'pipe' })
      .toString()
      .trim();
  before(async () => {
    origin = await fs.mkdtemp(path.join(os.tmpdir(), 'origin-'));
    gitc(origin, 'init', '-q', '-b', 'main');
    await fs.mkdir(path.join(origin, 'tofu/service'), { recursive: true });
    await fs.writeFile(path.join(origin, 'tofu/service/main.tf'), '# v1\n');
    gitc(origin, 'add', '.');
    gitc(origin, 'commit', '-q', '-m', 'v1');
    cache = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'cache-')), 'portal-resources');
  });
  after(async () => {
    await fs.rm(origin, { recursive: true, force: true });
    await fs.rm(path.dirname(cache), { recursive: true, force: true });
  });

  it('clones once, serves the cached checkout within the refresh interval, then fetches the new head', async () => {
    resetRepo();
    Object.assign(process.env, { TOFU_BIN: FAKE, REPO_URL: `file://${origin}`, REPO_CACHE_DIR: cache, REPO_REFRESH_SECONDS: '3600', FAKE_TOFU_LOG: '' });
    delete process.env.REPO_DIR;
    const first = await plan(service());
    assert.equal(first.commit, gitc(origin, 'rev-parse', 'HEAD'));
    await fs.writeFile(path.join(origin, 'tofu/service/main.tf'), '# v2\n');
    gitc(origin, 'commit', '-q', '-am', 'v2');
    assert.equal((await plan(service())).commit, first.commit, 'cached within REPO_REFRESH_SECONDS');
    process.env.REPO_REFRESH_SECONDS = '0';
    const third = await plan(service());
    assert.equal(third.commit, gitc(origin, 'rev-parse', 'HEAD'));
    assert.notEqual(third.commit, first.commit);
    assert.equal(await fs.readFile(path.join(cache, 'tofu/service/main.tf'), 'utf8'), '# v2\n');
  });
});

describe('server (tofu mode)', () => {
  let server;
  let base;
  let repo;
  before(async () => {
    repo = await fs.mkdtemp(path.join(os.tmpdir(), 'portal-resources-'));
    await fs.mkdir(path.join(repo, 'tofu/service'), { recursive: true });
    await fs.writeFile(path.join(repo, 'tofu/service/main.tf'), '');
    await fs.mkdir(path.join(repo, 'schema'));
    await fs.writeFile(path.join(repo, 'schema/service-xrd.yaml'), 'kind: CompositeResourceDefinition\n');
    Object.assign(process.env, { RENDER_MODE: 'tofu', TOFU_BIN: FAKE, REPO_DIR: repo, FAKE_TOFU_LOG: '' });
    delete process.env.PLAN_TIMEOUT_SECONDS;
    ({ server } = await import('../src/server.mjs'));
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(async () => {
    server.close();
    await fs.rm(repo, { recursive: true, force: true });
  });
  const post = (body) => fetch(`${base}/render`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  it('POST /render answers the shared preview contract with actions', async () => {
    const res = await post({ service: service() });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.mode, 'tofu');
    assert.deepEqual(body.resources[0], {
      kind: 'azuredevops_project',
      name: 'module.golden_path.azuredevops_project.this',
      externalName: 'payments-payments-api',
      action: 'create',
    });
    assert.ok(Array.isArray(body.raw));
    assert.equal((await post({ service: service('boom') })).status, 422);
    assert.equal((await post({})).status, 400);
  });
  it('readiness reports the tofu version; /xrd serves the schema file of the Portal repo', async () => {
    const r = await (await fetch(`${base}/readyz`)).json();
    assert.equal(r.ok, true);
    assert.equal(r.tofu, '1.10.8');
    const x = await fetch(`${base}/xrd`);
    assert.equal(x.status, 200);
    assert.match(await x.text(), /CompositeResourceDefinition/);
    assert.equal((await fetch(`${base}/compositions`)).status, 404);
  });
});
