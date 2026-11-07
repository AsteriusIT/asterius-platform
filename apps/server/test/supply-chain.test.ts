import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { readConfigDir } from '../src/config-loader.js';
import { mapItem } from '../src/integrations/mapping.js';
import { evaluate } from '../src/lib/expr.js';

const dir = path.resolve(__dirname, '../../../examples/demo-config');
const loaded = readConfigDir(dir, { platform: false });
const integration = (id: string) => loaded.data.integrations.find((i) => i.identifier === id)!;
const bindings = (id: string) => ({ integration: { identifier: id, config: integration(id).config } });

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
    const [m] = integration('sbom').mappings;
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
});
