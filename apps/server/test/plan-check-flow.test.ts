import fs from 'node:fs';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { client, fakeServer, inDefaultOrg, register, silentLog, testApp, waitFor, type Api } from './helpers.js';
import { startRunWorker } from '../src/actions/worker.js';
import { applyConfig, readConfigDir } from '../src/config-loader.js';

/**
 * plan-check steps in a self-service workflow: the plan comes from a pipeline (here a fake answering with a plan.json
 * artifact, or an Azure DevOps build artifact), the estimate and the policy findings are shown before the approval,
 * a critical finding stops the run, and the estimate is written onto the resulting entity.
 */

let app: FastifyInstance;
let admin: Api;
let alice: Api;
let ext: Awaited<ReturnType<typeof fakeServer>>;
let stop: () => unknown;

const fixture = (name: string) => fs.readFileSync(path.join(import.meta.dirname, 'fixtures', 'plans', `${name}.json`), 'utf8');
const b64 = (s: string) => Buffer.from(s).toString('base64');
type Step = { id: string; status: string; statusLabel: string | null; message: string | null; output: Record<string, unknown> | null };
type RunView = { id: string; status: string; steps: Step[]; artifacts: { name: string; stepId: string }[] };
const view = async (id: string) => (await alice.get(`/api/v1/runs/${id}`)).data as RunView;
const step = (r: RunView, id: string) => r.steps.find((s) => s.id === id)!;
const finished = (id: string) => waitFor(async () => ((r) => (['SUCCESS', 'FAILURE', 'CANCELLED'].includes(r.status) ? r : undefined))(await view(id)));
const form = { type: 'form', on: 'create', inputs: { properties: { name: { type: 'string' }, fixture: { type: 'string' } }, required: ['name', 'fixture'] } };

beforeAll(async () => {
  app = await testApp();
  admin = client(app, (await register(app, 'admin@example.com')).token);
  alice = client(app, (await register(app, 'alice@example.com')).token);
  ext = await fakeServer((r) => {
    // The plan stage of a pipeline: answers with plan.json as a run artifact.
    const m = /^\/plan\/(\w+)/.exec(r.url);
    if (m) return { body: { ok: true, artifacts: [{ name: 'plan.json', contentType: 'application/json', content: b64(fixture(m[1]!)) }] } };
    // Azure DevOps: the artifact of build 42, then one file of it.
    if (r.url.startsWith('/org/proj/_apis/build/builds/42/artifacts'))
      return { body: { resource: { downloadUrl: `${ext.url}/org/_apis/resources/Containers/1?itemPath=plan` } } };
    if (r.url.startsWith('/org/_apis/resources/Containers/1')) return { body: JSON.parse(fixture('replace')) };
    // OPA: POST /v1/data/terraform/analysis.
    if (r.url === '/v1/data/terraform/analysis') return { body: { result: { deny: [], warn: ['aws_instance.app: m5.large is above the approved sizes'] } } };
    return { status: 404, body: {} };
  });
  stop = startRunWorker(silentLog);
  const bp = await admin.put('/api/v1/blueprints/service', {
    title: 'Service',
    schema: { properties: { monthlyCost: { type: 'number' }, costCurrency: { type: 'string' }, co2eKgMonth: { type: 'number' } } },
  });
  expect(bp.status, JSON.stringify(bp.data)).toBe(200);
  const saved = await admin.put('/api/v1/actions/create-service', {
    title: 'Create a service',
    trigger: form,
    steps: [
      { id: 'tfplan', name: 'Plan (tofu plan)', type: 'invoke', invoker: { type: 'webhook', url: `${ext.url}/plan/{{ inputs.fixture }}`, mode: 'sync' } },
      {
        id: 'plan',
        name: 'Plan check',
        type: 'invoke',
        invoker: {
          type: 'plan-check',
          planArtifact: { step: 'tfplan', name: 'plan.json' },
          budget: { maxDelta: 100, severity: 'warning' },
          policies: [
            {
              id: 'tags',
              severity: 'advisory',
              expression: '[changes[action = "create" and type = "azurerm_linux_virtual_machine" and $not($exists(after.tags.costCenter))].address]',
              message: 'Missing costCenter tag',
            },
          ],
          maxResources: 3,
        },
      },
      {
        id: 'override',
        type: 'approval',
        if: 'steps.plan.output.requiresOverride',
        approvers: { roles: ['admin'] },
        message:
          'Estimated **{{ steps.plan.output.cost.monthly }} {{ steps.plan.output.cost.currency }}/month** (+{{ steps.plan.output.cost.delta }}).\n\n{{ steps.plan.output.summary }}',
      },
      {
        id: 'register',
        type: 'invoke',
        invoker: {
          type: 'catalog',
          operation: 'upsert',
          blueprint: 'service',
          identifier: '{{ inputs.name }}',
          merge: true,
          properties: {
            monthlyCost: '{{ steps.plan.output.cost.monthly }}',
            costCurrency: '{{ steps.plan.output.cost.currency }}',
            co2eKgMonth: '{{ steps.plan.output.carbon.monthlyKg }}',
          },
        },
      },
    ],
  });
  expect(saved.status, JSON.stringify(saved.data)).toBe(200);
});
afterAll(async () => {
  await stop();
  await ext.close();
  await app.close();
});

describe('plan-check in a self-service workflow', () => {
  it('shows the estimate and the findings before the approval, then stores the estimate on the entity', async () => {
    const id = (await alice.post('/api/v1/actions/create-service/runs', { inputs: { name: 'payments', fixture: 'update' } })).data.id as string;
    const waiting = await waitFor(async () => ((r) => (step(r, 'override')?.status === 'WAITING_APPROVAL' ? r : undefined))(await view(id)));
    const check = step(waiting, 'plan');
    expect(check.status).toBe('SUCCESS');
    expect(check.output).toMatchObject({
      kind: 'plan-check',
      gate: 'override',
      requiresOverride: true,
      cost: { monthly: 350.4, delta: 179.87, currency: 'USD' },
      counts: { warning: 1 },
    });
    expect(check.statusLabel).toMatch(/350\.40 USD\/month.*override required/);
    const message = step(waiting, 'override').message!;
    expect(message).toContain('Estimated **350.4 USD/month** (+179.87)');
    expect(message).toContain('exceeds the allowed 100.00 USD');
    expect(waiting.artifacts.map((a) => a.name).sort()).toEqual(['plan-check.json', 'plan.json']);

    expect((await admin.post(`/api/v1/runs/${id}/steps/override/approve`, { comment: 'FinOps ok' })).status).toBe(200);
    expect((await finished(id)).status).toBe('SUCCESS');
    const entity = (await admin.get('/api/v1/blueprints/service/entities/payments')).data;
    expect(entity.properties).toMatchObject({ monthlyCost: 350.4, costCurrency: 'USD' });
    expect(entity.properties.co2eKgMonth).toBeGreaterThan(0);
  });

  it('skips the override within budget and notifies the requester of advisories', async () => {
    const id = (await alice.post('/api/v1/actions/create-service/runs', { inputs: { name: 'ledger', fixture: 'create' } })).data.id as string;
    const r = await finished(id);
    expect(r.status).toBe('SUCCESS');
    expect(step(r, 'override').status).toBe('SKIPPED');
    const out = step(r, 'plan').output!;
    expect(out).toMatchObject({
      gate: 'pass',
      cost: { monthly: 49.57, complete: false, unmatched: ['module.monitoring.azurerm_dashboard_grafana.main'] },
      counts: { advisory: 2 },
    });
    const inbox = (await alice.get('/api/v1/notifications')).data.items as { kind: string; title: string; link: string }[];
    expect(inbox.find((n) => n.kind === 'plan-check.advisory')).toMatchObject({ title: 'Create a service: 2 advisory plan finding(s)', link: `/runs/${id}` });
    expect((await admin.get('/api/v1/blueprints/service/entities/ledger')).data.properties.monthlyCost).toBe(49.57);
  });

  it('stops the run on a critical finding of an organization plan policy', async () => {
    const pol = await admin.put('/api/v1/policies/no-db-destroy', {
      title: 'Databases are never destroyed from self-service',
      target: 'plan',
      severity: 'critical',
      match: { actions: ['create-service'] },
      expression: '[changes[action in ["delete", "replace"] and type = "aws_db_instance"].address]',
      message: 'Open a change request to delete a database',
    });
    expect(pol.status, JSON.stringify(pol.data)).toBe(200);
    expect(pol.data).toMatchObject({ target: 'plan', severity: 'critical' });
    // Plan policies never gate run submission or entity writes.
    const id = (await alice.post('/api/v1/actions/create-service/runs', { inputs: { name: 'orders', fixture: 'delete' } })).data.id as string;
    const r = await finished(id);
    expect(r.status).toBe('FAILURE');
    const check = step(r, 'plan');
    expect(check.status).toBe('FAILURE');
    expect(check.statusLabel).toMatch(/^Blocked: 1 critical finding\(s\) — Databases are never destroyed/);
    expect(check.output).toMatchObject({ gate: 'blocked', cost: { delta: -77.92 } });
    expect((check.output!.violations as { policy: string; address?: string }[])[0]).toMatchObject({
      policy: 'no-db-destroy',
      address: 'aws_db_instance.orders',
    });
    expect(step(r, 'register').status).not.toBe('SUCCESS');
    expect((await admin.get('/api/v1/blueprints/service/entities/orders')).status).toBe(404);
    await admin.del('/api/v1/policies/no-db-destroy');
  });

  it('reads plan.json from an Azure DevOps build artifact and asks OPA', async () => {
    const saved = await admin.put('/api/v1/actions/resize', {
      title: 'Resize',
      trigger: { type: 'form', on: 'create', inputs: { properties: {} } },
      steps: [
        {
          id: 'plan',
          type: 'invoke',
          invoker: {
            type: 'plan-check',
            ado: { organization: `${ext.url}/org`, project: 'proj', token: 'pat-123456789', buildId: '42', artifact: 'plan' },
            opa: { url: ext.url, path: 'terraform.analysis' },
            onWarning: 'fail',
            report: false,
          },
        },
      ],
    });
    expect(saved.status, JSON.stringify(saved.data)).toBe(200);
    const id = (await alice.post('/api/v1/actions/resize/runs', { inputs: {} })).data.id as string;
    const r = await finished(id);
    const check = step(r, 'plan');
    expect(check.status).toBe('FAILURE'); // a warning with onWarning: fail
    expect(check.output).toMatchObject({ gate: 'blocked', cost: { monthly: 78.72, delta: 42.71 }, counts: { warning: 1 } });
    expect(r.artifacts).toEqual([]);
    const meta = ext.received.find((x) => x.url.startsWith('/org/proj/_apis/build/builds/42'))!;
    expect(meta.headers.authorization).toBe(`Basic ${b64(':pat-123456789')}`);
    const file = ext.received.find((x) => x.url.startsWith('/org/_apis/resources'))!;
    expect(new URL(file.url, ext.url).searchParams.get('subPath')).toBe('/plan.json');
    const opa = ext.received.find((x) => x.url === '/v1/data/terraform/analysis')!;
    expect(JSON.parse(opa.body).input.resource_changes).toHaveLength(2); // input = the plan
  });

  it('validates the step configuration when the workflow is saved', async () => {
    const bad = (invoker: object) =>
      admin.put('/api/v1/actions/bad', { title: 'Bad', trigger: form, steps: [{ id: 'p', type: 'invoke', invoker: { type: 'plan-check', ...invoker } }] });
    expect((await bad({})).status).toBe(400);
    expect((await bad({ plan: '{{ inputs.x }}', planUrl: 'https://x' })).status).toBe(400);
    expect((await bad({ plan: '{{ inputs.x }}', policies: [{ id: 'x', expression: 'a +' }] })).status).toBe(400);
    expect((await bad({ plan: '{{ inputs.x }}', policies: [{ id: 'x', expression: 'true', severity: 'fatal' }] })).status).toBe(400);
    expect((await bad({ plan: '{{ inputs.x }}', onWarning: 'maybe' })).status).toBe(400);
    expect((await bad({ plan: '{{ inputs.x }}', opa: { url: 'http://opa' } })).status).toBe(400);
    expect((await bad({ plan: '{{ inputs.x }}', budget: {} })).status).toBe(400);
    expect((await bad({ plan: '{{ inputs.x }}' })).status).toBe(200);
  });
});

describe('price catalogs', () => {
  it('lists the built-in sample, stores organization catalogs and estimates a plan with them', async () => {
    const list = (await admin.get('/api/v1/price-catalogs')).data as { identifier: string; builtin?: boolean }[];
    expect(list[0]).toMatchObject({ identifier: 'builtin', builtin: true });
    expect((await alice.get('/api/v1/price-catalogs')).status).toBe(403);
    expect((await admin.put('/api/v1/price-catalogs/builtin', { title: 'x' })).status).toBe(400);
    expect((await admin.put('/api/v1/price-catalogs/eur', { title: 'Euro', currency: 'EUR', extends: 'builtin' })).status).toBe(200);
    // Currencies cannot be mixed along the chain.
    expect((await admin.post('/api/v1/price-catalogs/eur/estimate', { plan: JSON.parse(fixture('create')) })).status).toBe(400);
    const put = await admin.put('/api/v1/price-catalogs/acme', {
      title: 'Acme negotiated prices',
      extends: 'builtin',
      prices: [{ provider: 'azurerm', type: 'azurerm_dashboard_grafana', monthly: 12 }],
    });
    expect(put.status, JSON.stringify(put.data)).toBe(200);
    const est = await admin.post('/api/v1/price-catalogs/acme/estimate', { plan: JSON.parse(fixture('create')) });
    expect(est.status, JSON.stringify(est.data)).toBe(200);
    expect(est.data).toMatchObject({ cost: { monthly: 61.57, complete: true, catalog: 'acme' }, gate: 'pass' });
    expect((await admin.post('/api/v1/price-catalogs/acme/estimate', { plan: { nope: 1 } })).status).toBe(400);
    expect((await admin.put('/api/v1/price-catalogs/child', { title: 'Child', extends: 'acme' })).status).toBe(200);
    expect((await admin.del('/api/v1/price-catalogs/acme')).status).toBe(409);
    expect((await admin.del('/api/v1/price-catalogs/child')).status).toBe(200);
    expect((await admin.del('/api/v1/price-catalogs/acme')).status).toBe(200);
    expect((await admin.del('/api/v1/price-catalogs/builtin')).status).toBe(400);
  });

  it('declares catalogs and plan policies as configuration (managed, read-only, removed with the files)', async () => {
    const dir = fs.mkdtempSync(path.join(process.env.DATA_DIR!, 'cfg-'));
    fs.writeFileSync(
      path.join(dir, 'finops.yaml'),
      [
        'priceCatalogs:',
        '  - identifier: finops',
        '    title: FinOps prices',
        '    currency: EUR',
        '    prices:',
        '      - { provider: azurerm, type: azurerm_linux_virtual_machine, match: { size: Standard_B2s }, monthly: 28 }',
        'policies:',
        '  - { identifier: budget-cap, title: Budget cap, target: plan, severity: warning, expression: "cost.monthly < 1000" }',
      ].join('\n'),
    );
    expect(await inDefaultOrg(() => applyConfig(readConfigDir(dir), silentLog))).toEqual([]);
    expect((await admin.get('/api/v1/price-catalogs/finops')).data).toMatchObject({ managed: true, currency: 'EUR' });
    expect((await admin.put('/api/v1/price-catalogs/finops', { title: 'x' })).status).toBe(409);
    expect((await admin.get('/api/v1/policies/budget-cap')).data).toMatchObject({ target: 'plan', severity: 'warning', managed: true });
    expect((await admin.get('/api/v1/config/export')).data).toContain('finops');
    fs.rmSync(path.join(dir, 'finops.yaml'));
    await inDefaultOrg(() => applyConfig(readConfigDir(dir), silentLog));
    expect((await admin.get('/api/v1/price-catalogs/finops')).status).toBe(404);
  });

  it('applies examples/plan-check and passes its workflow tests', async () => {
    const dir = path.resolve(import.meta.dirname, '../../../examples/plan-check/config');
    const empty = fs.mkdtempSync(path.join(process.env.DATA_DIR!, 'empty-'));
    try {
      expect(await inDefaultOrg(() => applyConfig(readConfigDir(dir), silentLog))).toEqual([]);
      const res = await admin.post('/api/v1/actions/create-app-environment/tests/run', {});
      expect(res.status, JSON.stringify(res.data)).toBe(200);
      expect((res.data.results as { name: string; passed: boolean }[]).map((t) => [t.name, t.passed])).toEqual([
        ['a dev environment within budget skips the approval', true],
        ['a critical finding stops the run before the apply', true],
      ]);
      // The example's catalog prices the Grafana instance the built-in sample does not know.
      const est = await admin.post('/api/v1/price-catalogs/default/estimate', { plan: JSON.parse(fixture('create')) });
      expect(est.data.cost).toMatchObject({ complete: true, monthly: 97.57 });
      expect((est.data.violations as { policy: string }[]).map((v) => v.policy)).toEqual(['plan-cost-center-tag']);
      const del = await admin.post('/api/v1/price-catalogs/default/estimate', { plan: JSON.parse(fixture('delete')) });
      expect((del.data.violations as { policy: string; severity: string }[]).map((v) => [v.policy, v.severity])).toEqual([
        ['plan-no-database-destroy', 'critical'],
      ]);
    } finally {
      // Removed with the files (managed resources).
      await inDefaultOrg(() => applyConfig(readConfigDir(empty), silentLog));
    }
    expect((await admin.get('/api/v1/price-catalogs/default')).status).toBe(404);
    expect((await admin.get('/api/v1/policies/plan-regions')).status).toBe(404);
  });

  it('uses the catalog "default" when a step names none', async () => {
    await admin.put('/api/v1/price-catalogs/default', {
      title: 'Default',
      extends: 'builtin',
      prices: [{ provider: 'azurerm', type: 'azurerm_linux_virtual_machine', match: { size: 'Standard_B2s' }, monthly: 1 }],
    });
    const id = (await alice.post('/api/v1/actions/create-service/runs', { inputs: { name: 'cheap', fixture: 'create' } })).data.id as string;
    const out = step(await finished(id), 'plan').output!;
    expect(out).toMatchObject({ cost: { catalog: 'default', monthly: 20.2 } });
    await admin.del('/api/v1/price-catalogs/default');
  });
});

// ---------- a real OPA server (when the binary is installed) ----------
const OPA_BIN = process.env.OPA_BIN ?? path.join(process.env.HOME ?? '', '.local/bin/opa');
const freePort = () =>
  new Promise<number>((resolve) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });

describe.skipIf(!fs.existsSync(OPA_BIN))('with opa run --server', () => {
  let opa: ChildProcess;
  let url = '';
  beforeAll(async () => {
    const dir = fs.mkdtempSync(path.join(process.env.DATA_DIR!, 'opa-'));
    fs.writeFileSync(
      path.join(dir, 'terraform.rego'),
      `package terraform

deny contains msg if {
  some rc in input.resource_changes
  rc.type == "aws_db_instance"
  "delete" in rc.change.actions
  msg := sprintf("%s: databases are not deleted from self-service", [rc.address])
}

warn contains msg if {
  some rc in input.resource_changes
  rc.type == "aws_instance"
  "delete" in rc.change.actions
  msg := sprintf("%s is deleted", [rc.address])
}
`,
    );
    const port = await freePort();
    url = `http://127.0.0.1:${port}`;
    opa = spawn(OPA_BIN, ['run', '--server', '--addr', `127.0.0.1:${port}`, dir], { stdio: 'ignore' });
    await waitFor(async () => (await fetch(`${url}/health`).catch(() => null))?.ok);
    await admin.put('/api/v1/actions/opa-check', {
      title: 'OPA check',
      trigger: form,
      steps: [
        { id: 'tfplan', type: 'invoke', invoker: { type: 'webhook', url: `${ext.url}/plan/{{ inputs.fixture }}`, mode: 'sync' } },
        { id: 'plan', type: 'invoke', invoker: { type: 'plan-check', planArtifact: { step: 'tfplan' }, opa: { url, path: 'terraform' }, report: false } },
      ],
    });
  });
  afterAll(() => opa?.kill());

  it('deny is critical, warn is a warning', async () => {
    const id = (await alice.post('/api/v1/actions/opa-check/runs', { inputs: { name: 'x', fixture: 'delete' } })).data.id as string;
    const out = step(await finished(id), 'plan').output!;
    expect(out).toMatchObject({ gate: 'blocked', counts: { critical: 1, warning: 1 } });
    expect((out.violations as { message: string }[]).map((v) => v.message).sort()).toEqual([
      'aws_db_instance.orders: databases are not deleted from self-service',
      'aws_instance.worker[0] is deleted',
    ]);
  });
});
