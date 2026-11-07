import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { readConfigDir } from '../src/config-loader.js';
import { ingest } from '../src/integrations/sync.js';
import { getIntegrationRow } from '../src/integrations/integrations.js';
import { client, register, testApp, type Api } from './helpers.js';
import { DEFAULT_ORG, withOrg } from '../src/orgs/context.js';
import { mapItem } from '../src/integrations/mapping.js';
import { evaluate } from '../src/lib/expr.js';

const dir = path.resolve(__dirname, '../../../examples/demo-config');
const loaded = readConfigDir(dir, { platform: false });
const integration = (id: string) => loaded.data.integrations.find((i) => i.identifier === id)!;
const bindings = (id: string) => ({ integration: { identifier: id, config: integration(id).config } });

const bom = (service: string, components: string[], vulnerabilities: unknown[] = []) => ({
  bomFormat: 'CycloneDX',
  specVersion: '1.5',
  metadata: { component: { type: 'application', name: service } },
  components: components.map((n) => ({ type: 'library', name: n, version: '1.0.0', purl: `pkg:npm/${n}@1.0.0`, 'bom-ref': `ref-${n}` })),
  vulnerabilities,
});
const vuln = (id: string, ref: string, severity = 'High', extra: Record<string, unknown> = {}) => ({
  id,
  ratings: [{ severity }],
  affects: [{ ref }],
  advisories: [{ url: `https://example.test/${id}` }],
  ...extra,
});

describe('supply chain examples (examples/demo-config)', () => {
  it('declares the scaffolder golden-path action with valid step references', () => {
    const action = loaded.data.actions.find((a) => a.identifier === 'scaffold-service-template')!;
    const steps = (action.steps ?? []) as { id: string; invoker?: Record<string, unknown> }[];
    expect(steps.map((s) => s.id)).toEqual(['create', 'register']);
    expect(steps[0]!.invoker).toMatchObject({ type: 'scaffolder', provider: 'github', mode: 'new-repository' });
    expect(JSON.stringify(steps[1]!.invoker)).toContain('steps.create.output.repoUrl');
  });

  it('declares the blueprints and the scorecard', () => {
    const ids = loaded.data.blueprints.map((b) => b.identifier);
    expect(ids).toEqual(expect.arrayContaining(['vulnerability', 'sbom-component']));
    expect(loaded.data.scorecards.map((s) => s.identifier)).toContain('supply-chain-security');
  });

  it('maps Snyk issues to vulnerabilities', async () => {
    const issue = (over: Record<string, unknown>) => ({
      id: 'i1',
      type: 'issue',
      attributes: {
        key: 'SNYK-JS-LODASH-1',
        title: 'Prototype Pollution',
        type: 'package_vulnerability',
        effective_severity_level: 'high',
        status: 'open',
        ignored: false,
        created_at: '2025-01-02T03:04:05Z',
        problems: [{ id: 'CVE-2021-23337', source: 'NVD', url: 'https://nvd.nist.gov/vuln/detail/CVE-2021-23337' }],
        coordinates: [
          {
            remedies: [{ details: { upgrade_package: 'lodash@4.17.21' } }],
            representations: [{ dependency: { package_name: 'lodash', package_version: '4.17.20' } }],
          },
        ],
        ...over,
      },
      relationships: { scan_item: { data: { id: '11111111-1111-1111-1111-111111111111', type: 'project' } } },
    });
    const [m] = integration('snyk-issues').mappings;
    const run = async (over: Record<string, unknown>) => (await mapItem(m, issue(over), bindings('snyk-issues'))).mapped[0];

    const open = await run({});
    expect(open).toMatchObject({
      blueprint: 'vulnerability',
      identifier: '11111111-1111-1111-1111-111111111111:SNYK-JS-LODASH-1',
      title: 'Prototype Pollution',
      properties: {
        cve: 'CVE-2021-23337',
        severity: 'high',
        package: 'lodash',
        version: '4.17.20',
        fixedIn: 'lodash@4.17.21',
        status: 'open',
        firstSeen: '2025-01-02T03:04:05Z',
      },
      relations: { service: 'payment-api' },
    });
    expect((await run({ status: 'resolved' })).properties.status).toBe('fixed');
    expect((await run({ ignored: true })).properties.status).toBe('ignored');
    // non-vulnerability issues (licenses, code) are filtered out
    expect((await mapItem(m, issue({ type: 'license' }), bindings('snyk-issues'))).mapped).toEqual([]);
  });

  it('maps a CycloneDX SBOM to components of the service', async () => {
    const bom = {
      bomFormat: 'CycloneDX',
      specVersion: '1.5',
      metadata: { component: { type: 'application', name: 'payment-api' } },
      components: [
        {
          type: 'library',
          name: 'lodash',
          version: '4.17.21',
          purl: 'pkg:npm/lodash@4.17.21',
          licenses: [{ license: { id: 'MIT' } }],
          supplier: { name: 'Lodash team' },
        },
        { type: 'library', name: 'left-pad', version: '1.0.0', licenses: [{ expression: 'MIT OR Apache-2.0' }] },
      ],
    };
    const [, m] = integration('sbom').mappings;
    const { mapped } = await mapItem(m, bom, bindings('sbom'));
    expect(mapped).toHaveLength(2);
    expect(mapped[0]).toMatchObject({
      blueprint: 'sbom-component',
      identifier: 'payment-api/pkg:npm/lodash@4.17.21',
      title: 'lodash@4.17.21',
      properties: { purl: 'pkg:npm/lodash@4.17.21', name: 'lodash', version: '4.17.21', type: 'library', license: 'MIT', supplier: 'Lodash team' },
      relations: { service: 'payment-api' },
    });
    expect(mapped[1].properties).toMatchObject({ purl: 'pkg:generic/left-pad@1.0.0', license: 'MIT OR Apache-2.0' });
    // not a CycloneDX document
    expect((await mapItem(m, { components: [] }, bindings('sbom'))).mapped).toEqual([]);
  });

  it('scores a service from its vulnerabilities and SBOM', async () => {
    const sc = loaded.data.scorecards.find((s) => s.identifier === 'supply-chain-security')!;
    const vuln = (severity: string, status: string, firstSeen: string) => ({ properties: { severity, status, firstSeen } });
    const old = new Date(Date.now() - 45 * 86400_000).toISOString();
    const recent = new Date(Date.now() - 2 * 86400_000).toISOString();
    const passed = async (incoming: Record<string, unknown[]>) =>
      Object.fromEntries(await Promise.all(sc.rules.map(async (r) => [r.identifier, !!(await evaluate(r.expression, { incoming }))])));

    expect(await passed({})).toEqual({ has_sbom: false, no_open_critical: true, no_stale_high: true });
    expect(
      await passed({
        'sbom-component.service': [{ properties: { name: 'lodash' } }],
        'vulnerability.service': [vuln('critical', 'open', recent), vuln('high', 'open', old), vuln('critical', 'fixed', old)],
      }),
    ).toEqual({ has_sbom: true, no_open_critical: false, no_stale_high: false });
    expect(await passed({ 'vulnerability.service': [vuln('high', 'open', recent), vuln('high', 'ignored', old)] })).toMatchObject({
      no_open_critical: true,
      no_stale_high: true,
    });
  });

  it('maps CycloneDX vulnerabilities and links the affected components', async () => {
    const doc = bom(
      'payment-api',
      ['lodash', 'left-pad'],
      [vuln('CVE-2021-23337', 'ref-lodash', 'High'), vuln('GHSA-xxxx', 'ref-lodash', 'bogus', { analysis: { state: 'false_positive' } })],
    );
    const [v, c] = integration('sbom').mappings;
    const vulns = (await mapItem(v, doc, bindings('sbom'))).mapped;
    expect(vulns).toHaveLength(2);
    expect(vulns[0]).toMatchObject({
      blueprint: 'vulnerability',
      identifier: 'payment-api:CVE-2021-23337',
      properties: { cve: 'CVE-2021-23337', severity: 'high', package: 'lodash', version: '1.0.0', status: 'open', url: 'https://example.test/CVE-2021-23337' },
      relations: { service: 'payment-api' },
    });
    expect(vulns[1]!.properties).toMatchObject({ severity: 'low', status: 'ignored' });
    expect(vulns[1]!.properties.cve).toBeUndefined();
    const comps = (await mapItem(c, doc, bindings('sbom'))).mapped;
    expect(comps[0]!.relations.vulnerabilities).toEqual(['payment-api:CVE-2021-23337', 'payment-api:GHSA-xxxx']);
    expect(comps[1]!.relations.vulnerabilities).toBeNull();
  });
});

describe('SBOM deliveries (pruning of removed components)', () => {
  let app: FastifyInstance;
  let admin: Api;
  beforeAll(async () => {
    app = await testApp();
    admin = client(app, (await register(app, 'admin@example.com')).token);
    await admin.put('/api/v1/blueprints/service', { title: 'Service', schema: { properties: {} } });
    for (const b of loaded.data.blueprints.filter((x) => ['vulnerability', 'sbom-component'].includes(x.identifier))) {
      const r = await admin.put(`/api/v1/blueprints/${b.identifier}`, b);
      expect(r.status, JSON.stringify(r.data)).toBe(200);
    }
    for (const s of ['payment-api', 'other-api']) await admin.put(`/api/v1/blueprints/service/entities/${s}`, { title: s });
    const sbom = integration('sbom');
    const saved = await admin.put('/api/v1/integrations/sbom', { title: sbom.title, type: 'webhook', config: { secret: 's3cret' }, mappings: sbom.mappings });
    expect(saved.status, JSON.stringify(saved.data)).toBe(200);
  });
  afterAll(() => app.close());

  const deliver = (doc: unknown) => withOrg(DEFAULT_ORG, async () => ingest(await getIntegrationRow('sbom'), doc, {}));
  const ids = async (bp: string) =>
    ((await admin.get(`/api/v1/blueprints/${bp}/entities?limit=100`)).data.items as { identifier: string }[]).map((e) => e.identifier).sort();

  it('prunes what the latest delivery of a service no longer contains, and nothing else', async () => {
    await admin.put('/api/v1/blueprints/sbom-component/entities/manual-one', {
      title: 'manual',
      properties: { purl: 'pkg:x/y', name: 'y' },
      relations: { service: 'payment-api' },
    });
    await deliver(bom('other-api', ['express']));
    const first = await deliver(bom('payment-api', ['lodash', 'left-pad'], [vuln('CVE-2021-23337', 'ref-lodash')]));
    expect(first.errors.join('\n')).not.toMatch(/error/i);
    expect(first).toMatchObject({ failed: 0, deleted: 0 });
    expect(await ids('sbom-component')).toEqual([
      'manual-one',
      'other-api/pkg:npm/express@1.0.0',
      'payment-api/pkg:npm/left-pad@1.0.0',
      'payment-api/pkg:npm/lodash@1.0.0',
    ]);
    const lodash = (await admin.get('/api/v1/blueprints/sbom-component/entities/payment-api%2Fpkg%3Anpm%2Flodash%401.0.0')).data;
    expect(lodash.relations.vulnerabilities).toEqual(['payment-api:CVE-2021-23337']);
    expect(await ids('vulnerability')).toEqual(['payment-api:CVE-2021-23337']);

    const second = await deliver(bom('payment-api', ['lodash']));
    expect(second).toMatchObject({ failed: 0, deleted: 2 }); // left-pad and the vulnerability that is gone
    expect(await ids('sbom-component')).toEqual(['manual-one', 'other-api/pkg:npm/express@1.0.0', 'payment-api/pkg:npm/lodash@1.0.0']);
    expect(await ids('vulnerability')).toEqual([]);
    const after = (await admin.get('/api/v1/blueprints/sbom-component/entities/payment-api%2Fpkg%3Anpm%2Flodash%401.0.0')).data;
    expect(after.relations.vulnerabilities ?? null).toBeNull();
  });

  it('never prunes entities of another source', async () => {
    const saved = await admin.put('/api/v1/integrations/other-scanner', {
      title: 'Other scanner',
      type: 'webhook',
      config: { secret: 's3cret' },
      mappings: [
        {
          kind: 'finding',
          entity: {
            blueprint: 'vulnerability',
            identifier: '"snyk-proj:" & id',
            properties: { severity: '"high"', status: '"open"' },
            relations: { service: '"payment-api"' },
          },
        },
      ],
    });
    expect(saved.status, JSON.stringify(saved.data)).toBe(200);
    await withOrg(DEFAULT_ORG, async () => ingest(await getIntegrationRow('other-scanner'), { id: 'K1' }, {}));
    await admin.put('/api/v1/blueprints/sbom-component/entities/ui-made', {
      title: 'ui',
      properties: { purl: 'pkg:x/z', name: 'z' },
      relations: { service: 'payment-api' },
    });
    await deliver(bom('payment-api', ['lodash']));
    expect(await ids('vulnerability')).toEqual(['snyk-proj:K1']);
    expect(await ids('sbom-component')).toContain('ui-made');
  });
});
