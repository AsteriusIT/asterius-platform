import { describe, expect, it } from 'vitest';
import YAML from 'yaml';
import { isLabelValue, labelSafeRunId } from '../src/v2/labels.js';
import {
  commitMessage,
  compositionRefOf,
  editSpec,
  pauseExpiry,
  renderServiceSpec,
  renderTeamFile,
  specFromInputs,
  toYaml,
  type ServiceManifest,
} from '../src/v2/spec.js';

const RUN = '0b3c4a52-8f2c-4e6f-9a51-7d2b1c3e4f50';
const inputs = {
  name: 'payments-api',
  team: 'payments',
  goldenPath: 'java-api',
  goldenPathVersion: 3,
  repositoryTemplate: 'java-spring-api',
  sonarqube: false,
  qualityGate: 'acme-default',
  vaultSecrets: true,
  environments: ['dev', 'staging', 'prod'],
  costCenter: 'CC-4711',
  onCall: 'payments-oncall',
};
const spec = (over: Partial<typeof inputs> = {}) =>
  renderServiceSpec({ team: 'payments', service: 'payments-api', inputs: { ...inputs, ...over }, runId: RUN, requestedBy: 'jane@asterius.fr' });

describe('Service spec rendering (docs/V2-KIND.md contract)', () => {
  it('renders the contract shape, in the contract key order', () => {
    const m = spec();
    expect(m).toEqual({
      apiVersion: 'platform.asterius.io/v1alpha1',
      kind: 'Service',
      metadata: {
        name: 'payments-api',
        namespace: 'team-payments',
        annotations: { 'portal.asterius.io/run-id': RUN, 'portal.asterius.io/requested-by': 'jane@asterius.fr' },
        labels: {
          'portal.asterius.io/team': 'payments',
          'portal.asterius.io/service': 'payments-api',
          'portal.asterius.io/run-id': RUN,
          protected: 'true',
        },
      },
      spec: {
        owner: 'payments',
        goldenPath: { name: 'java-api', version: '3' },
        repository: { template: 'java-spring-api' },
        quality: { sonarqube: false, qualityGate: 'acme-default' },
        secrets: { vault: true },
        environments: ['dev', 'staging', 'prod'],
        costCenter: 'CC-4711',
        onCall: 'payments-oncall',
        crossplane: { compositionRef: { name: 'java-api-v3' }, compositionUpdatePolicy: 'Manual' },
      },
    });
    expect(Object.keys(m.spec)).toEqual(['owner', 'goldenPath', 'repository', 'quality', 'secrets', 'environments', 'costCenter', 'onCall', 'crossplane']);
    // Quoted where Kubernetes needs strings
    const text = toYaml(m);
    expect(text).toContain('protected: "true"');
    expect(text).toContain('version: "3"');
  });

  it('marks the XR protected only when prod is in environments', () => {
    expect(spec({ environments: ['dev'] }).metadata.labels).not.toHaveProperty('protected');
    expect(spec({ environments: ['dev', 'prod'] }).metadata.labels.protected).toBe('true');
  });

  it('derives compositionRef from the golden path, ignoring any requested one', () => {
    expect(compositionRefOf('java-api', '4')).toBe('java-api-v4');
    const m = spec({ goldenPathVersion: '4' as never });
    expect(m.spec.crossplane).toEqual({ compositionRef: { name: 'java-api-v4' }, compositionUpdatePolicy: 'Manual' });
    const forced = renderServiceSpec({
      team: 't1',
      service: 's1',
      inputs: { goldenPath: 'java-api', goldenPathVersion: '3', spec__crossplane__compositionRef__name: 'evil' },
      runId: RUN,
      requestedBy: 'x@y',
    });
    expect((forced.spec.crossplane as { compositionRef: { name: string } }).compositionRef.name).toBe('java-api-v3');
  });

  it('maps spec__ inputs generated from the XRD back to their path, and skips empty values', () => {
    expect(specFromInputs({ goldenPath: 'java-api', goldenPathVersion: '3', spec__adopt__projectId: 'abc', costCenter: '', onCall: null })).toEqual({
      goldenPath: { name: 'java-api', version: '3' },
      adopt: { projectId: 'abc' },
    });
  });

  it('rejects names that are not DNS labels and a missing golden path', () => {
    expect(() => renderServiceSpec({ team: 'Pay_ments', service: 'x', inputs, runId: RUN, requestedBy: '' })).toThrow(/team/);
    expect(() => renderServiceSpec({ team: 'payments', service: 'api.v1', inputs, runId: RUN, requestedBy: '' })).toThrow(/service/);
    expect(() => renderServiceSpec({ team: 'payments', service: 'api', inputs: { environments: ['dev'] }, runId: RUN, requestedBy: '' })).toThrow(/goldenPath/);
  });

  it('builds the commit message with the audit trailers', () => {
    expect(commitMessage('create', 'payments', 'payments-api', RUN, 'jane@asterius.fr')).toBe(
      `Create payments/payments-api\n\nRun-Id: ${RUN}\nOn-Behalf-Of: jane@asterius.fr`,
    );
  });

  it('renders the team folder from the template, or a default Namespace + ResourceQuota', () => {
    expect(renderTeamFile('payments', 'kind: Namespace\nmetadata:\n  name: team-<team>\n  labels: { portal.asterius.io/team: <team> }\n')).toBe(
      'kind: Namespace\nmetadata:\n  name: team-payments\n  labels: { portal.asterius.io/team: payments }\n',
    );
    const docs = YAML.parseAllDocuments(renderTeamFile('payments', null)).map((d) => d.toJS());
    expect(docs.map((d) => d.kind)).toEqual(['Namespace', 'ResourceQuota']);
    expect(docs[0].metadata).toEqual({ name: 'team-payments', labels: { 'portal.asterius.io/team': 'payments' } });
  });
});

describe('run id as a label value', () => {
  it('keeps portal run ids (UUIDs) as they are', () => {
    expect(labelSafeRunId(RUN)).toBe(RUN);
    expect(isLabelValue(RUN)).toBe(true);
  });
  it('derives a deterministic label-safe value from other ids', () => {
    const long = `run/${'x'.repeat(80)}`;
    const l = labelSafeRunId(long);
    expect(isLabelValue(l)).toBe(true);
    expect(l).toBe(labelSafeRunId(long));
    expect(l).toMatch(/^run-x+-[0-9a-f]{10}$/);
    expect(isLabelValue(labelSafeRunId('--//--'))).toBe(true);
  });
});

describe('day-2 edits', () => {
  const RUN2 = '11111111-2222-4333-8444-555555555555';
  const base = `# owned by the portal\n${toYaml(spec())}`;
  const e = { runId: RUN2, requestedBy: 'bob@asterius.fr' };
  const parse = (t: string | null) => YAML.parse(t!) as ServiceManifest;

  it('pauses with an RFC 3339 expiry and a reason, then resumes; keeps comments and stamps the run id', () => {
    const paused = editSpec(base, 'pause', { ...e, pause: { until: '4h', reason: 'incident INC-42' } })!;
    expect(paused.startsWith('# owned by the portal')).toBe(true);
    const m = parse(paused);
    expect(m.metadata.annotations['portal.asterius.io/paused']).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
    expect(Date.parse(m.metadata.annotations['portal.asterius.io/paused']!) - Date.now()).toBeGreaterThan(3.9 * 3600_000);
    expect(m.metadata.annotations['portal.asterius.io/paused-reason']).toBe('incident INC-42');
    expect(m.metadata.annotations['portal.asterius.io/run-id']).toBe(RUN2);
    expect(m.metadata.labels['portal.asterius.io/run-id']).toBe(RUN2);
    expect(m.metadata.annotations['portal.asterius.io/requested-by']).toBe('jane@asterius.fr'); // the original requester stays
    const resumed = parse(editSpec(paused, 'resume', e));
    expect(resumed.metadata.annotations).not.toHaveProperty('portal.asterius.io/paused');
    expect(resumed.metadata.annotations).not.toHaveProperty('portal.asterius.io/paused-reason');
  });

  it('validates the pause expiry', () => {
    const now = Date.parse('2026-11-08T10:00:00Z');
    expect(pauseExpiry('2026-11-09T10:00:00Z', now)).toBe('2026-11-09T10:00:00Z');
    expect(pauseExpiry('2d', now)).toBe('2026-11-10T10:00:00Z');
    expect(() => pauseExpiry('2026-11-01T00:00:00Z', now)).toThrow(/future/);
    expect(() => pauseExpiry('31d', now)).toThrow(/30 days/);
    expect(() => pauseExpiry('soon', now)).toThrow(/RFC 3339/);
    expect(() => editSpec(base, 'pause', { ...e, pause: { until: '1h', reason: ' ' } })).toThrow(/reason/);
  });

  it('upgrades the golden path: version and compositionRef together', () => {
    const m = parse(editSpec(base, 'upgrade', { ...e, goldenPath: { version: '4' } }));
    expect(m.spec.goldenPath).toEqual({ name: 'java-api', version: '4' });
    expect(m.spec.crossplane).toEqual({ compositionRef: { name: 'java-api-v4' }, compositionUpdatePolicy: 'Manual' });
    expect(m.spec.costCenter).toBe('CC-4711');
    expect(() => editSpec(base, 'upgrade', e)).toThrow(/version/);
  });

  it('updates the intent from inputs and recomputes the protected label', () => {
    const m = parse(editSpec(base, 'update', { ...e, inputs: { environments: ['dev'], costCenter: 'CC-1' } }));
    expect(m.spec.environments).toEqual(['dev']);
    expect(m.spec.costCenter).toBe('CC-1');
    expect(m.spec.goldenPath).toEqual({ name: 'java-api', version: '3' });
    expect(m.metadata.labels).not.toHaveProperty('protected');
  });

  it('decommissions only after the decommission run id annotation was committed', () => {
    expect(() => editSpec(base, 'decommission', e)).toThrow(/decommission-run-id/);
    const marked = editSpec(base, 'mark-decommission', e)!;
    expect(parse(marked).metadata.annotations['portal.asterius.io/decommission-run-id']).toBe(RUN2);
    expect(editSpec(marked, 'decommission', e)).toBeNull();
  });

  it('refuses files that are not Service manifests', () => {
    expect(() => editSpec('kind: ConfigMap\n', 'pause', e)).toThrow(/Service/);
    expect(() => editSpec('a: [', 'pause', e)).toThrow(/YAML/);
  });
});
