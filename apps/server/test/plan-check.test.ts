import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Policy } from '@asterius/shared';
import { parsePlan, getPath } from '../src/plan/plan.js';
import { estimate } from '../src/plan/pricing.js';
import { BUILTIN_CATALOG } from '../src/plan/builtin-prices.js';
import { buildOutput, opaViolations, runChecks } from '../src/plan/checks.js';
import { priceCatalogDef } from '../src/schemas.js';

/** Plans in the format of `terraform show -json` / `tofu show -json` (test/fixtures/plans). */
const fixture = (name: string) => JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'fixtures', 'plans', `${name}.json`), 'utf8')) as unknown;
const builtin = [BUILTIN_CATALOG];
const byAddress = (e: ReturnType<typeof estimate>, a: string) => e.resources.find((r) => r.address === a)!;
const ctx = { inputs: { environments: ['prod'] }, action: { identifier: 'create-service' }, principal: { id: 'u1' }, entity: null };
const policy = (o: Partial<Policy>): Policy => ({
  identifier: 'p',
  title: 'Policy',
  description: '',
  enabled: true,
  target: 'plan',
  severity: 'critical',
  match: {},
  expression: 'true',
  message: 'Denied by policy',
  managed: false,
  ...o,
});

describe('plan parsing', () => {
  it('keeps managed changes, normalises actions, providers and regions', () => {
    const p = parsePlan(JSON.stringify(fixture('create')));
    expect(p.terraformVersion).toBe('1.8.3');
    expect(p.resources.map((r) => r.address)).not.toContain('data.azurerm_client_config.current');
    const vm = p.resources.find((r) => r.type === 'azurerm_linux_virtual_machine')!;
    expect(vm).toMatchObject({ provider: 'azurerm', action: 'create', region: 'westeurope', before: null });
    expect(p.resources.find((r) => r.type === 'azurerm_dashboard_grafana')!.module).toBe('module.monitoring');
    const replace = parsePlan(fixture('replace'));
    expect(replace.resources.map((r) => r.action)).toEqual(['replace', 'replace']);
    expect(replace.resources[1]!.region).toBe('eu-west-3'); // from the provider configuration
    const del = parsePlan(fixture('delete'));
    expect(del.resources.map((r) => [r.action, r.region])).toEqual([
      ['delete', 'eu-west-1'],
      ['delete', 'eu-west-1'], // availability zone eu-west-1b
      ['delete', 'eu-west-1'],
    ]);
    expect(del.resources[0]!.after).toBeNull();
  });

  it('rejects what is not a plan and accepts an empty one', () => {
    expect(() => parsePlan('{oops')).toThrow(/not valid JSON/);
    expect(() => parsePlan({ resources: [] })).toThrow(/resource_changes is missing/);
    expect(() => parsePlan([1])).toThrow(/JSON object/);
    expect(parsePlan({ format_version: '1.2' }).resources).toEqual([]);
  });

  it('reads nested block paths', () => {
    expect(getPath({ a: [{ b: 3 }] }, 'a.0.b')).toBe(3);
    expect(getPath({ a: null }, 'a.0.b')).toBeUndefined();
  });
});

describe('cost estimate (built-in sample catalog)', () => {
  it('create: prices each resource, reports unmatched, free and usage-based ones', () => {
    const e = estimate(parsePlan(fixture('create')), builtin);
    expect(e.currency).toBe('USD');
    expect(byAddress(e, 'azurerm_linux_virtual_machine.api')).toMatchObject({ pricing: 'priced', monthly: 30.37, before: 0, delta: 30.37 });
    expect(byAddress(e, 'azurerm_managed_disk.data')).toMatchObject({ monthly: 19.2 });
    expect(byAddress(e, 'azurerm_resource_group.svc')).toMatchObject({ pricing: 'free', monthly: 0 });
    expect(byAddress(e, 'random_string.suffix').pricing).toBe('free'); // free provider
    expect(byAddress(e, 'azurerm_storage_account.logs')).toMatchObject({ pricing: 'usage-based', monthly: 0 });
    expect(e.unmatched).toEqual(['module.monitoring.azurerm_dashboard_grafana.main']);
    expect(e.usageBased).toEqual(['azurerm_storage_account.logs']);
    expect(e).toMatchObject({ monthly: 49.57, before: 0, delta: 49.57 });
  });

  it('update: delta between the current and the planned attributes (size change, node count)', () => {
    const e = estimate(parsePlan(fixture('update')), builtin);
    expect(byAddress(e, 'azurerm_linux_virtual_machine.api')).toMatchObject({ before: 30.37, monthly: 140.16, delta: 109.79 });
    expect(byAddress(e, 'azurerm_kubernetes_cluster.aks')).toMatchObject({ before: 140.16, monthly: 210.24, delta: 70.08 });
    expect(byAddress(e, 'azurerm_resource_group.svc')).toMatchObject({ action: 'no-op', delta: 0 });
    expect(e).toMatchObject({ monthly: 350.4, before: 170.53, delta: 179.87 });
  });

  it('delete: the current cost goes away', () => {
    const e = estimate(parsePlan(fixture('delete')), builtin);
    expect(byAddress(e, 'aws_db_instance.orders')).toMatchObject({ before: 61.14, monthly: 0, delta: -61.14 });
    expect(byAddress(e, 'aws_instance.worker[0]')).toMatchObject({ before: 16.78, delta: -16.78 });
    expect(e).toMatchObject({ monthly: 0, before: 77.92, delta: -77.92 });
    expect(e.carbon.deltaKg).toBeLessThan(0);
  });

  it('replace: before and after are priced separately', () => {
    const e = estimate(parsePlan(fixture('replace')), builtin);
    expect(byAddress(e, 'aws_ebs_volume.data')).toMatchObject({ action: 'replace', before: 5, monthly: 8, delta: 3 });
    expect(byAddress(e, 'aws_instance.app')).toMatchObject({ before: 31.01, monthly: 70.72, delta: 39.71 });
    expect(e).toMatchObject({ monthly: 78.72, before: 36.01, delta: 42.71 });
  });

  it('carbon: power × hours × PUE × the grid factor of the region', () => {
    const e = estimate(parsePlan(fixture('create')), builtin);
    // B2s: 2 vCPU × 2.27 W + 4 GB × 0.392 W = 6.108 W; × 730 h = 4.459 kWh; × PUE 1.185 × westeurope 0.328.
    expect(byAddress(e, 'azurerm_linux_virtual_machine.api').co2eKg).toBeCloseTo(1.733, 2);
    const aks = estimate(parsePlan(fixture('update')), builtin);
    // francecentral is low-carbon: the same VM size costs far less carbon than in westeurope.
    expect(byAddress(aks, 'azurerm_kubernetes_cluster.aks').co2eKg).toBeLessThan(byAddress(aks, 'azurerm_linux_virtual_machine.api').co2eKg);
  });

  it('an organization catalog wins over what it extends; the most specific entry wins', () => {
    const acme = priceCatalogDef.parse({
      identifier: 'acme',
      title: 'Acme',
      extends: 'builtin',
      prices: [
        { provider: 'azurerm', type: 'azurerm_linux_virtual_machine', match: { size: 'Standard_B*' }, monthly: 10 },
        { provider: 'azurerm', type: 'azurerm_linux_virtual_machine', match: { size: 'Standard_B2s', region: 'westeurope' }, monthly: 25, note: 'EA price' },
        {
          provider: 'azurerm',
          type: 'azurerm_dashboard_grafana',
          match: { sku: ['Standard', 'Essential'] },
          hourly: 0.1,
          quantity: { attribute: 'replicas', default: 2 },
        },
      ],
    });
    const e = estimate(parsePlan(fixture('create')), [acme, BUILTIN_CATALOG]);
    expect(byAddress(e, 'azurerm_linux_virtual_machine.api')).toMatchObject({ monthly: 25, note: 'EA price' });
    expect(byAddress(e, 'module.monitoring.azurerm_dashboard_grafana.main').monthly).toBe(146); // 0.1 × 730 × 2
    expect(byAddress(e, 'azurerm_managed_disk.data').monthly).toBe(19.2); // from builtin
    expect(e.unmatched).toEqual([]);
  });
});

describe('plan policies', () => {
  const plan = parsePlan(fixture('delete'));
  const est = estimate(plan, builtin);
  const check = (o: Partial<Parameters<typeof runChecks>[2]>) => runChecks(plan, est, { rules: [], policies: [], context: ctx, unpriced: 'ignore', ...o });

  it('true complies, a list gives one violation per item, anything else and errors are violations', async () => {
    expect(await check({ policies: [policy({ expression: 'true' })] })).toEqual([]);
    expect(await check({ policies: [policy({ expression: '[changes[type = "nothing"].address]' })] })).toEqual([]);
    const list = await check({
      policies: [
        policy({ identifier: 'no-db-destroy', title: 'No database destroy', expression: '[changes[action = "delete" and type = "aws_db_instance"].address]' }),
      ],
    });
    expect(list).toEqual([
      {
        policy: 'no-db-destroy',
        title: 'No database destroy',
        severity: 'critical',
        source: 'policy',
        message: 'Denied by policy: aws_db_instance.orders',
        address: 'aws_db_instance.orders',
      },
    ]);
    const tpl = await check({
      rules: [{ id: 'r', severity: 'warning', expression: 'cost.delta > -10', message: 'Saves {{ $abs(cost.delta) }} {{ cost.currency }}' }],
    });
    expect(tpl).toMatchObject([{ policy: 'r', severity: 'warning', source: 'rule', message: 'Saves 77.92 USD' }]);
    const failed = await check({ rules: [{ id: 'bad', expression: '$undefinedFn()', severity: 'advisory' }] });
    expect(failed[0]).toMatchObject({ severity: 'advisory' });
    expect(failed[0]!.message).toMatch(/evaluation failed/);
    // The run context is available.
    expect(await check({ rules: [{ id: 'prod', expression: '"prod" in inputs.environments' }] })).toEqual([]);
  });

  it('budget and unpriced resources', async () => {
    const created = parsePlan(fixture('create'));
    const e = estimate(created, builtin);
    const v = await runChecks(created, e, { rules: [], policies: [], context: ctx, budget: { maxMonthly: 40, maxDelta: 100, severity: 'warning' } });
    expect(v.map((x) => [x.policy, x.severity])).toEqual([
      ['budget:monthly', 'warning'],
      ['pricing:unmatched', 'advisory'],
    ]);
    expect(v[1]!.message).toMatch(/module\.monitoring\.azurerm_dashboard_grafana\.main/);
  });

  it('reads OPA decisions in the usual shapes', () => {
    const d = { severity: 'critical' as const, path: 'terraform/deny' };
    expect(opaViolations(['no public IP'], d)).toMatchObject([{ severity: 'critical', message: 'no public IP', source: 'opa' }]);
    expect(opaViolations({ deny: ['a'], warn: [{ msg: 'b', address: 'x.y' }], info: ['c'] }, d).map((v) => [v.severity, v.message, v.address])).toEqual([
      ['critical', 'a', undefined],
      ['warning', 'b', 'x.y'],
      ['advisory', 'c', undefined],
    ]);
    expect(opaViolations([{ message: 'tagged', severity: 'advisory' }], d)[0]!.severity).toBe('advisory');
    expect(opaViolations(true, d)).toEqual([]);
    expect(opaViolations([], d)).toEqual([]);
    expect(opaViolations({ allow: false }, d)).toHaveLength(1);
  });
});

describe('step output', () => {
  it('gates on severities and summarises for approvers', async () => {
    const plan = parsePlan(fixture('update'));
    const est = estimate(plan, builtin);
    const warn = [{ policy: 'b', title: 'Budget', severity: 'warning' as const, message: 'too much', source: 'budget' as const }];
    const o = buildOutput(plan, est, warn, { onWarning: 'override', maxResources: 1 });
    expect(o).toMatchObject({ kind: 'plan-check', gate: 'override', requiresOverride: true, counts: { critical: 0, warning: 1, advisory: 0 }, truncated: 2 });
    expect(o.changes).toMatchObject({ update: 2, 'no-op': 1, create: 0 });
    expect(o.resources.map((r) => r.address)).toEqual(['azurerm_linux_virtual_machine.api']); // biggest change first
    expect(o.summary).toContain('**Estimated cost:** 350.40 USD/month (+179.87 USD/month)');
    expect(o.summary).toContain('| `azurerm_kubernetes_cluster.aks` | update | 210.24 USD | +70.08 USD |');
    expect(o.summary).toContain('⚠️ **warning** Budget: too much');
    expect(buildOutput(plan, est, warn, { onWarning: 'fail', maxResources: 5 }).gate).toBe('blocked');
    expect(buildOutput(plan, est, warn, { onWarning: 'ignore', maxResources: 5 }).gate).toBe('pass');
    expect(buildOutput(plan, est, [{ ...warn[0]!, severity: 'critical' }], { onWarning: 'ignore', maxResources: 5 }).gate).toBe('blocked');
    expect(buildOutput(plan, est, [], { onWarning: 'override', maxResources: 5 }).summary).toContain('**Policy findings:** none');
  });
});
