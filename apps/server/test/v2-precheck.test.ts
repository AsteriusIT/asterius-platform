import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import YAML from 'yaml';
import { client, fakeServer, register, silentLog, testApp, waitFor, type Api } from './helpers.js';
import { startRunWorker } from '../src/actions/worker.js';
import { evaluatePolicy, renderResources } from '../src/v2/checks.js';
import { renderServiceSpec } from '../src/v2/spec.js';
import { fakeAdoGit } from './v2-fake-ado.js';
import { fakeAdoPipelines } from './v2-fake-pipelines.js';

delete process.env.ADO_PAT; // the example actions read the real Portal repo with it: keep them offline

const service = renderServiceSpec({
  team: 'payments',
  service: 'payments-api',
  inputs: { goldenPath: 'java-api', goldenPathVersion: '3', environments: ['dev'] },
  runId: 'r1',
  requestedBy: 'x@y',
});

/** OPA with the platform.portal adapter: cost-center-required and prod-requires-oncall. */
let opaMode: 'rules' | 'down' | 'empty' = 'rules';
const opaHandler = (r: { url: string; body: string }) => {
  if (opaMode === 'down') return { status: 503, body: { code: 'unavailable' } };
  if (opaMode === 'empty') return { body: {} };
  if (r.url !== '/v1/data/platform/portal/result') return { status: 404, body: {} };
  const s = (JSON.parse(r.body) as { input: { service: typeof service } }).input.service;
  const v: { policy: string; msg: string }[] = [];
  if (!/^CC-[0-9]+$/.test(String(s.spec.costCenter ?? ''))) v.push({ policy: 'cost-center-required', msg: 'costCenter is required (CC-<digits>)' });
  if ((s.spec.environments as string[]).includes('prod') && !s.spec.onCall) v.push({ policy: 'prod-requires-oncall', msg: 'prod needs onCall' });
  return { body: { result: { allowed: v.length === 0, violations: v } } };
};

describe('OPA adapter', () => {
  let opa: Awaited<ReturnType<typeof fakeServer>>;
  beforeAll(async () => {
    opa = await fakeServer(opaHandler);
  });
  afterAll(async () => {
    await opa.close();
  });

  it('posts {input: {service}} to the platform.portal entry point', async () => {
    opaMode = 'rules';
    const r = await evaluatePolicy(opa.url, service);
    expect(r).toEqual({ status: 'denied', allowed: false, violations: [{ policy: 'cost-center-required', msg: 'costCenter is required (CC-<digits>)' }] });
    expect(JSON.parse(opa.received.at(-1)!.body)).toEqual({ input: { service } });
    const ok = await evaluatePolicy(opa.url, { ...service, spec: { ...service.spec, costCenter: 'CC-1' } });
    expect(ok).toEqual({ status: 'allowed', allowed: true, violations: [] });
  });

  it('is never "allowed" when OPA cannot answer (callers fail closed)', async () => {
    opaMode = 'down';
    expect(await evaluatePolicy(opa.url, service)).toMatchObject({ status: 'unavailable', allowed: null });
    opaMode = 'empty'; // policies not loaded yet: undefined document
    expect(await evaluatePolicy(opa.url, service)).toMatchObject({
      status: 'unavailable',
      allowed: null,
      error: expect.stringMatching(/no platform.portal result/),
    });
    expect(await evaluatePolicy('http://127.0.0.1:1', service)).toMatchObject({ status: 'unavailable', error: expect.stringMatching(/unreachable/) });
    expect(await evaluatePolicy('', service)).toMatchObject({ status: 'unavailable' });
    opaMode = 'rules';
  });

  it('render adapter: resources, render errors and an unreachable service', async () => {
    const render = await fakeServer((r) =>
      JSON.parse(r.body).service.metadata.name === 'bad'
        ? { status: 422, body: { error: 'Composition "x" not found' } }
        : { body: { resources: [{ apiVersion: 'v1', kind: 'Project', name: 'project', externalName: 'payments-payments-api' }], raw: [] } },
    );
    expect(await renderResources(render.url, service)).toMatchObject({ status: 'ok', resources: [{ kind: 'Project' }] });
    expect(await renderResources(render.url, { ...service, metadata: { ...service.metadata, name: 'bad' } })).toMatchObject({
      status: 'error',
      error: expect.stringMatching(/not found/),
    });
    expect(await renderResources('http://127.0.0.1:1', service)).toMatchObject({ status: 'unavailable' });
    await render.close();
  });
});

/** The Service schema of the Portal repo (an XRD; its spec part is what the pre-check validates). */
const SCHEMA = `apiVersion: apiextensions.crossplane.io/v2
kind: CompositeResourceDefinition
metadata: { name: services.platform.asterius.io }
spec:
  group: platform.asterius.io
  names: { kind: Service, plural: services }
  versions:
    - name: v1alpha1
      served: true
      referenceable: true
      schema:
        openAPIV3Schema:
          type: object
          properties:
            spec:
              type: object
              required: [owner, goldenPath, environments]
              properties:
                owner: { type: string, pattern: "^[a-z][a-z0-9-]{1,19}$", maxLength: 20 }
                goldenPath:
                  type: object
                  properties:
                    name: { type: string, enum: [java-api], default: java-api }
                    version: { type: string, enum: ["3"], default: "3" }
                environments: { type: array, minItems: 1, maxItems: 3, x-kubernetes-list-type: set, default: [dev], items: { type: string, enum: [dev, staging, prod] } }
                costCenter: { type: string, pattern: "^CC-[0-9]+$", maxLength: 16 }
                onCall: { type: string }
`;

type RunView = { id: string; status: string; logs: { message: string }[]; steps: { id: string; status: string; output: unknown; link: string | null }[] };

describe('pre-check step and form preview', () => {
  let app: FastifyInstance;
  let admin: Api;
  let alice: Api;
  let bob: Api;
  let opa: Awaited<ReturnType<typeof fakeServer>>;
  let render: Awaited<ReturnType<typeof fakeServer>>;
  let ado: Awaited<ReturnType<typeof fakeAdoGit>>;
  let pipes: Awaited<ReturnType<typeof fakeAdoPipelines>>;
  let stop: () => unknown;

  const finished = (id: string) =>
    waitFor(async () => {
      const r = (await alice.get(`/api/v1/runs/${id}`)).data as RunView;
      return ['SUCCESS', 'FAILURE', 'CANCELLED', 'REJECTED'].includes(r.status) && r;
    }, 25_000);
  const entity = async (id: string) => (await admin.get(`/api/v1/blueprints/platform-service/entities/${encodeURIComponent(id)}`)).data;

  beforeAll(async () => {
    app = await testApp();
    admin = client(app, (await register(app, 'admin@example.com')).token);
    const a = await register(app, 'alice@example.com');
    alice = client(app, a.token);
    bob = client(app, (await register(app, 'bob@example.com')).token);
    opa = await fakeServer(opaHandler);
    render = await fakeServer(() => ({
      body: { resources: [{ apiVersion: 'core.azuredevops.upbound.io/v1alpha1', kind: 'Project', name: 'project', externalName: 'payments-payments-api' }] },
    }));
    ado = await fakeAdoGit({ 'services/_templates/team.yaml': 'kind: Namespace\nmetadata: { name: team-<team> }\n', 'schema/service-xrd.yaml': SCHEMA });
    pipes = await fakeAdoPipelines();
    await admin.put('/api/v1/teams/payments', { title: 'Payments' });
    await admin.patch(`/api/v1/users/${a.user.id}`, { teams: ['payments'] });

    // The V2 example configuration loads as is (blueprint + every action, fully validated).
    const dir = path.resolve(__dirname, '../../../examples/v2/config');
    for (const f of ['platform-service.yaml', 'actions.yaml']) {
      const res = await admin.post('/api/v1/config/import', { yaml: fs.readFileSync(path.join(dir, f), 'utf8') });
      expect(res.status, `${f}: ${JSON.stringify(res.data)}`).toBe(200);
    }

    // The example workflows, pointed at the fakes.
    const all = (YAML.parse(fs.readFileSync(path.join(dir, 'actions.yaml'), 'utf8'), { merge: true }) as { actions: Record<string, unknown>[] }).actions;
    for (const [from, to] of [
      ['create-platform-service', 'v2-create'],
      ['update-platform-service', 'v2-update'],
      ['pause-platform-service', 'v2-pause'],
      ['upgrade-platform-service', 'v2-upgrade'],
      ['decommission-platform-service', 'v2-decommission'],
      ['grant-temporary-access', 'v2-grant'],
    ]) {
      const example = all.find((x) => x.identifier === from) as {
        trigger: { inputs: Record<string, unknown> };
        steps: { id: string; invoker?: Record<string, unknown> }[];
      };
      delete example.trigger.inputs.fromXrd;
      const steps = example.steps.map((s) =>
        s.invoker && ['service-precheck', 'service-spec'].includes(String(s.invoker.type))
          ? { ...s, invoker: { ...s.invoker, repository: ado.url, token: 'pat', opaUrl: opa.url, renderUrl: render.url, argocd: undefined } }
          : s.invoker?.type === 'azure-pipeline'
            ? { ...s, invoker: { ...s.invoker, organization: pipes.org, token: 'pat' } }
            : s,
      );
      const res = await admin.put(`/api/v1/actions/${to}`, { ...example, identifier: to, secrets: undefined, steps });
      expect(res.status, JSON.stringify(res.data)).toBe(200);
    }
    await admin.put('/api/v1/actions/plain', { title: 'Plain', trigger: { type: 'form' }, steps: [{ id: 't', type: 'transform', output: { v: '1' } }] });
    stop = startRunWorker(silentLog);
  });
  afterAll(async () => {
    await stop();
    await Promise.all([opa.close(), render.close(), ado.close(), pipes.close()]);
    await app.close();
  });

  const inputs = { name: 'payments-api', team: 'payments', goldenPath: 'java-api', goldenPathVersion: '3', environments: ['dev'], costCenter: 'CC-4711' };

  it('previews the spec, the policy verdict and the resources without writing anything', async () => {
    const res = await alice.post('/api/v1/actions/v2-create/preview', { inputs });
    expect(res.status, JSON.stringify(res.data)).toBe(200);
    const p = res.data;
    expect(p).toMatchObject({
      supported: true,
      step: 'precheck',
      canSubmit: true,
      allowed: true,
      inputErrors: [],
      specPath: 'services/team-payments/payments-api.yaml',
    });
    expect(p.policy).toEqual({ status: 'allowed', allowed: true, violations: [] });
    expect(p.render.resources).toEqual([expect.objectContaining({ kind: 'Project', externalName: 'payments-payments-api' })]);
    expect(p.specYaml).toContain('compositionRef:');
    expect(p.service.metadata.annotations['portal.asterius.io/requested-by']).toBe('alice@example.com');
    expect(p.service.metadata.labels['portal.asterius.io/run-id']).toBe('preview');
    // XRD defaults applied as the run would (form defaults)
    expect(p.service.spec.quality).toEqual({ sonarqube: false, qualityGate: 'acme-default' });
    expect(ado.pushes).toHaveLength(0);
    expect(JSON.stringify(p)).not.toContain('pat');
  });

  it('shows policy denials (and blocks the confirmation)', async () => {
    const p = (await alice.post('/api/v1/actions/v2-create/preview', { inputs: { ...inputs, costCenter: undefined, environments: ['dev', 'prod'] } })).data;
    expect(p.canSubmit).toBe(false);
    expect(p.policy.status).toBe('denied');
    expect(p.policy.violations.map((v: { policy: string }) => v.policy).sort()).toEqual(['cost-center-required', 'prod-requires-oncall']);
    expect(p.service.metadata.labels.protected).toBe('true');
  });

  it('degrades gracefully when OPA is down (the run checks again)', async () => {
    opaMode = 'down';
    const p = (await alice.post('/api/v1/actions/v2-create/preview', { inputs })).data;
    opaMode = 'rules';
    expect(p.policy.status).toBe('unavailable');
    expect(p.canSubmit).toBe(true);
  });

  it('reports input errors and refuses users who cannot run the action', async () => {
    const p = (await alice.post('/api/v1/actions/v2-create/preview', { inputs: { ...inputs, name: undefined } })).data;
    expect(p.inputErrors.join()).toMatch(/name/);
    expect(p.canSubmit).toBe(false);
    expect((await alice.post('/api/v1/actions/plain/preview', { inputs: {} })).data).toEqual({ supported: false });
    void bob;
  });

  it('a denied request fails the run and marks the entity Rejected; nothing is committed', async () => {
    const run = (await alice.post('/api/v1/actions/v2-create/runs', { inputs: { ...inputs, name: 'denied-api', costCenter: undefined } })).data;
    const r = await finished(run.id);
    expect(r.status).toBe('FAILURE');
    expect(r.steps.find((s) => s.id === 'precheck')!.status).toBe('FAILURE');
    expect(r.steps.find((s) => s.id === 'commit')!.status).toBe('SKIPPED');
    expect(r.logs.map((l) => l.message).join('\n')).toMatch(/Denied by cost-center-required/);
    expect((await entity('payments/denied-api')).properties).toMatchObject({ lifecycle: 'Rejected', lastRunId: run.id });
    expect(ado.pushes).toHaveLength(0);
  });

  it('fails closed when OPA is unreachable during the run', async () => {
    opaMode = 'down';
    const run = (await alice.post('/api/v1/actions/v2-create/runs', { inputs: { ...inputs, name: 'closed-api' } })).data;
    const r = await finished(run.id);
    opaMode = 'rules';
    expect(r.status).toBe('FAILURE');
    expect(r.logs.map((l) => l.message).join('\n')).toMatch(/failing closed/);
    expect(ado.pushes).toHaveLength(0);
  });

  it('an allowed request is committed with the run id everywhere, applied by the pipeline, and the entity becomes Ready', async () => {
    const run = (await alice.post('/api/v1/actions/v2-create/runs', { inputs })).data;
    const r = await finished(run.id);
    expect(r.status, JSON.stringify(r.logs)).toBe('SUCCESS');
    expect(r.steps.find((s) => s.id === 'approval')!.status).toBe('SKIPPED'); // no prod
    const spec = YAML.parse(ado.file('services/team-payments/payments-api.yaml')!);
    expect(spec.metadata.annotations['portal.asterius.io/run-id']).toBe(run.id);
    expect(spec.metadata.labels['portal.asterius.io/run-id']).toBe(run.id);
    expect(spec.metadata.annotations['portal.asterius.io/requested-by']).toBe('alice@example.com');
    expect(ado.commit(ado.head())!.message).toBe(`Create payments/payments-api\n\nRun-Id: ${run.id}\nOn-Behalf-Of: alice@example.com`);
    // The apply pipeline was found by name and queued with the contract parameters.
    const queued = pipes.runs.find((x) => x.templateParameters.runId === run.id)!;
    expect(queued).toMatchObject({
      project: 'Platform',
      pipelineId: 11,
      templateParameters: { service: 'payments/payments-api', runId: run.id, operation: 'apply' },
    });
    expect(pipes.calls.some((c) => c.includes('/_apis/build/definitions?name=portal-services-apply'))).toBe(true);
    const e = await entity('payments/payments-api');
    expect(e.team).toBe('payments');
    expect(e.properties).toMatchObject({
      lifecycle: 'Ready',
      managedBy: 'opentofu',
      goldenPathVersion: '3',
      lastRunId: run.id,
      specPath: 'services/team-payments/payments-api.yaml',
      lastCommit: ado.head(),
      requestedBy: 'alice@example.com',
      goldenPath: 'java-api',
      goldenPathRequested: '3',
      costCenter: 'CC-4711',
      lastApplyResult: 'succeeded',
      lastApplyUrl: `${pipes.org}/Platform/_build/results?buildId=${queued.id}`,
      // outputs.json of the apply run
      adoProjectUrl: 'https://dev.azure.com/AsteriusIT/payments-payments-api',
      repoUrl: 'https://dev.azure.com/AsteriusIT/payments-payments-api/_git/payments-api',
      pipelineId: '77',
    });
    expect(e.properties.specUrl).toContain('_git/portal-resources?path=');
    expect(r.steps.find((s) => s.id === 'degraded')!.status).toBe('SKIPPED');
    expect(r.steps.find((s) => s.id === 'outcome')!.status).toBe('SKIPPED');
    // Lifecycle transitions of the run, in order (entity history).
    const history = (await admin.get(`/api/v1/blueprints/platform-service/entities/${encodeURIComponent('payments/payments-api')}/history?limit=200`)).data;
    const lifecycles = (history.items as { version: number; snapshot: { properties: { lifecycle?: string } } }[])
      .sort((a, b) => a.version - b.version)
      .map((v) => v.snapshot.properties.lifecycle)
      .filter((l, i, a) => l && l !== a[i - 1]);
    expect(lifecycles).toEqual(['Requested', 'Committed', 'Reconciling', 'Ready']);

    // The run timeline holds the portal steps and the pipeline's stages, jobs and tasks.
    const t = (await alice.get(`/api/v1/runs/${run.id}/timeline`)).data;
    expect(t.sources).toContainEqual({ name: 'ado', status: 'ok', count: 3 });
    expect(t.events.filter((x: { source: string }) => x.source === 'ado').map((x: { step: string; status: string }) => `${x.step}:${x.status}`)).toEqual([
      'Job plan:success',
      'Stage plan:success',
      'Task tofu apply:success',
    ]);
  });

  it('a failed apply marks the service Degraded with the pipeline link, and the run fails', async () => {
    pipes.setOutcome((x) => (x.templateParameters.service === 'payments/failing-api' ? 'failed' : 'succeeded'));
    const run = (await alice.post('/api/v1/actions/v2-create/runs', { inputs: { ...inputs, name: 'failing-api' } })).data;
    const r = await finished(run.id);
    pipes.setOutcome(() => 'succeeded');
    expect(r.status).toBe('FAILURE');
    expect(Object.fromEntries(r.steps.map((s) => [s.id, s.status]))).toMatchObject({
      apply: 'FAILURE',
      ready: 'SKIPPED',
      degraded: 'SUCCESS',
      outcome: 'FAILURE',
    });
    expect(r.logs.map((l) => l.message).join('\n')).toMatch(/The apply pipeline did not succeed \(failed\)/);
    const e = await entity('payments/failing-api');
    expect(e.properties).toMatchObject({
      lifecycle: 'Degraded',
      lastRunId: run.id,
      lastApplyResult: 'failed',
      lastApplyUrl: expect.stringContaining('buildId='),
    });
    expect(e.properties.managedBy).toBeUndefined();
    const t = (await alice.get(`/api/v1/runs/${run.id}/timeline`)).data;
    expect(t.events).toContainEqual(
      expect.objectContaining({ source: 'ado', step: 'Task tofu apply', status: 'failure', message: expect.stringMatching(/TF401019/) }),
    );
  });

  it('validates the spec against the Service schema and the name limits in the preview', async () => {
    const p = (await alice.post('/api/v1/actions/v2-create/preview', { inputs: { ...inputs, name: 'schema-api', costCenter: 'CC-12345678901234567' } })).data;
    expect(p.schema).toMatchObject({ status: 'invalid', version: 'v1alpha1' });
    expect(p.policy.status).toBe('denied');
    expect(p.policy.violations).toContainEqual({
      policy: 'service-schema',
      msg: expect.stringMatching(/^spec\.costCenter: must NOT have more than 16 characters/),
    });
    expect(p.canSubmit).toBe(false);
    const ok = (await alice.post('/api/v1/actions/v2-create/preview', { inputs: { ...inputs, name: 'fresh-api' } })).data;
    expect(ok.schema.status).toBe('valid');
    // Team limit of the schema (20 characters): reported before anything is committed.
    const long = (await alice.post('/api/v1/actions/v2-create/preview', { inputs: { ...inputs, team: 'a-very-long-team-name-x' } })).data;
    expect(long.canSubmit).toBe(false);
    expect(long.inputErrors.join()).toMatch(/team/);
    expect(long.policy.violations).toContainEqual({ policy: 'portal-spec', msg: expect.stringMatching(/team "a-very-long-team-name-x": 2–20/) });
    const longService = (await alice.post('/api/v1/actions/v2-create/preview', { inputs: { ...inputs, name: 'a'.repeat(31) } })).data;
    expect(longService.policy.violations[0].msg).toMatch(/2–30/);
  });

  it('day-2: update commits the changed fields only and applies them', async () => {
    const before = YAML.parse(ado.file('services/team-payments/payments-api.yaml')!);
    const run = (await alice.post('/api/v1/actions/v2-update/runs', { entity: 'payments/payments-api', inputs: { costCenter: 'CC-99' } })).data;
    const r = await finished(run.id);
    expect(r.status, JSON.stringify(r.logs)).toBe('SUCCESS');
    const spec = YAML.parse(ado.file('services/team-payments/payments-api.yaml')!);
    expect(spec.spec).toEqual({ ...before.spec, costCenter: 'CC-99' });
    expect(pipes.runs.at(-1)!.templateParameters).toEqual({ service: 'payments/payments-api', runId: run.id, operation: 'apply' });
    expect((await entity('payments/payments-api')).properties).toMatchObject({ lifecycle: 'Ready', costCenter: 'CC-99', lastRunId: run.id });
  });

  it('grant temporary access queues portal-operations with the contract parameters', async () => {
    const run = (
      await alice.post('/api/v1/actions/v2-grant/runs', {
        entity: 'payments/payments-api',
        inputs: { user: 'bob@example.com', group: 'Readers', duration: '1h', justification: 'incident' },
      })
    ).data;
    // Approved by the owning team (alice is in payments, but cannot approve her own request): an admin approves.
    await waitFor(async () => (await admin.post(`/api/v1/runs/${run.id}/approve`, { comment: 'ok' })).status === 200, 10_000);
    const r = await finished(run.id);
    expect(r.status, JSON.stringify(r.logs)).toBe('SUCCESS');
    expect(pipes.runs.at(-1)).toMatchObject({
      pipelineId: 12,
      templateParameters: {
        operation: 'grant-temporary-access',
        service: 'payments/payments-api',
        runId: run.id,
        user: 'bob@example.com',
        group: 'Readers',
        duration: '1h',
      },
    });
  });

  it('a second create of the same service is rejected by the pre-check without touching the live entity', async () => {
    const run = (await alice.post('/api/v1/actions/v2-create/runs', { inputs })).data;
    const r = await finished(run.id);
    expect(r.status).toBe('FAILURE');
    expect(r.logs.map((l) => l.message).join('\n')).toMatch(/already exists/);
    expect((await entity('payments/payments-api')).properties.lifecycle).toBe('Ready');
  });

  it('day-2: pause commits the expiry and reason, and the entity shows them', async () => {
    const run = (await alice.post('/api/v1/actions/v2-pause/runs', { entity: 'payments/payments-api', inputs: { duration: '4h', reason: 'incident INC-7' } }))
      .data;
    const r = await finished(run.id);
    expect(r.status, JSON.stringify(r.logs)).toBe('SUCCESS');
    const spec = YAML.parse(ado.file('services/team-payments/payments-api.yaml')!);
    expect(spec.metadata.annotations['portal.asterius.io/paused-reason']).toBe('incident INC-7');
    expect(spec.metadata.annotations['portal.asterius.io/run-id']).toBe(run.id);
    expect(ado.commit(ado.head())!.message).toMatch(/^Pause payments\/payments-api/);
    const e = await entity('payments/payments-api');
    expect(e.properties).toMatchObject({ paused: spec.metadata.annotations['portal.asterius.io/paused'], pausedReason: 'incident INC-7', lastRunId: run.id });
    expect(pipes.runs.at(-1)!.templateParameters).toEqual({ service: 'payments/payments-api', runId: run.id, operation: 'apply' });
  });

  it('day-2: the upgrade preview evaluates the edited spec read from the repo', async () => {
    const p = (await alice.post('/api/v1/actions/v2-upgrade/preview', { entity: 'payments/payments-api', inputs: { goldenPathVersion: '3' } })).data;
    expect(p).toMatchObject({ supported: true, operation: 'upgrade', canSubmit: true });
    expect(p.service.spec.crossplane.compositionRef.name).toBe('java-api-v3');
    expect(p.service.metadata.annotations['portal.asterius.io/paused-reason']).toBe('incident INC-7'); // read from the repo
  });

  it('decommission: approval, annotation, decommission pipeline (deleteData), spec removed, entity removed', async () => {
    const run = (await alice.post('/api/v1/actions/v2-decommission/runs', { entity: 'payments/payments-api', inputs: { reason: 'retired', deleteData: true } }))
      .data;
    await waitFor(async () => (await admin.post(`/api/v1/runs/${run.id}/approve`, { comment: 'ok' })).status === 200, 10_000);
    const r = await finished(run.id);
    expect(r.status, JSON.stringify(r.logs)).toBe('SUCCESS');
    const queued = pipes.runs.find((x) => x.templateParameters.runId === run.id)!;
    expect(queued.templateParameters).toEqual({ service: 'payments/payments-api', runId: run.id, operation: 'decommission', deleteData: 'true' });
    // The annotation was committed before the pipeline ran, the file removed after it.
    const msgs: string[] = [];
    for (let c = ado.commit(ado.head()); c; c = c.parent ? ado.commit(c.parent) : undefined) msgs.push(c.message.split('\n')[0]!);
    expect(msgs.slice(0, 2)).toEqual(['Decommission payments/payments-api', 'Mark for decommission payments/payments-api']);
    expect(ado.file('services/team-payments/payments-api.yaml')).toBeUndefined();
    expect((await admin.get(`/api/v1/blueprints/platform-service/entities/${encodeURIComponent('payments/payments-api')}`)).status).toBe(404);
    expect(r.steps.find((s) => s.id === 'degraded')!.status).toBe('SKIPPED');
  });
});
