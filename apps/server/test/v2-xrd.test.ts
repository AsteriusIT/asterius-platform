import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { client, fakeServer, register, testApp, type Api } from './helpers.js';
import { mergeInputs, parseXrd, xrdToInputs } from '../src/v2/xrd.js';
import { specFromInputs } from '../src/v2/spec.js';

/** Trimmed copy of platform/xrds/service.yaml (Portal repo). */
export const XRD = `# Service API
apiVersion: apiextensions.crossplane.io/v2
kind: CompositeResourceDefinition
metadata:
  name: services.platform.asterius.io
spec:
  group: platform.asterius.io
  names: { kind: Service, plural: services }
  scope: Namespaced
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
                owner: { type: string, pattern: "^[a-z][a-z0-9-]{1,19}$" }
                goldenPath:
                  type: object
                  required: [name, version]
                  properties:
                    name: { type: string, title: Golden path, description: The golden path the service follows., enum: [java-api], default: java-api }
                    version: { type: string, title: Golden-path version, enum: ["3", "4"], default: "3" }
                repository:
                  type: object
                  default: {}
                  properties:
                    template: { type: string, title: Repository template, enum: [java-spring-api], default: java-spring-api }
                quality:
                  type: object
                  properties:
                    sonarqube: { type: boolean, title: SonarQube project, default: false }
                    qualityGate: { type: string, title: Quality gate, enum: [acme-default, acme-strict], default: acme-default }
                secrets:
                  type: object
                  properties:
                    vault: { type: boolean, title: Secrets from Vault (OpenBao), default: true }
                environments:
                  type: array
                  title: Environments
                  minItems: 1
                  maxItems: 3
                  default: [dev]
                  items: { type: string, enum: [dev, staging, prod] }
                costCenter: { type: string, title: Cost centre, pattern: "^CC-[0-9]+$", maxLength: 16 }
                onCall: { type: string, title: On-call group }
                adopt:
                  type: object
                  properties:
                    projectId: { type: string, title: Existing project id, pattern: "^[0-9a-f-]{36}$" }
                tags: { type: array, items: { type: object } }
            status: { type: object }
`;

describe('XRD → form mapping', () => {
  it('maps the spec schema to inputs: contract names, enums, defaults, descriptions, bounds, required', () => {
    const { version, spec } = parseXrd(XRD);
    expect(version).toBe('v1alpha1');
    const f = xrdToInputs(spec);
    expect(f.order).toEqual([
      'goldenPath',
      'goldenPathVersion',
      'repositoryTemplate',
      'sonarqube',
      'qualityGate',
      'vaultSecrets',
      'environments',
      'costCenter',
      'onCall',
      'spec__adopt__projectId',
    ]);
    expect(f.properties.goldenPath).toEqual({
      type: 'string',
      title: 'Golden path',
      description: 'The golden path the service follows.',
      enum: ['java-api'],
      default: 'java-api',
    });
    expect(f.properties.goldenPathVersion).toMatchObject({ enum: ['3', '4'], default: '3' });
    expect(f.properties.environments).toEqual({
      type: 'array',
      title: 'Environments',
      items: { type: 'string', enum: ['dev', 'staging', 'prod'] },
      minItems: 1,
      maxItems: 3,
      default: ['dev'],
    });
    expect(f.properties.costCenter).toMatchObject({ pattern: '^CC-[0-9]+$', maxLength: 16 });
    expect(f.properties.spec__adopt__projectId).toMatchObject({ type: 'string', title: 'Existing project id' });
    // owner and crossplane are derived by the portal; arrays of objects are not form fields
    expect(Object.keys(f.properties)).not.toContain('owner');
    expect(Object.keys(f.properties).some((k) => k.includes('tags'))).toBe(false);
    // required follows the nesting: goldenPath (required) → name, version (required); quality is optional
    expect(f.required!.sort()).toEqual(['environments', 'goldenPath', 'goldenPathVersion']);
  });

  it('round-trips: the generated inputs render back into the spec', () => {
    const f = xrdToInputs(parseXrd(XRD).spec);
    const values = Object.fromEntries(Object.entries(f.properties).map(([k, p]) => [k, (p as { default?: unknown }).default]));
    expect(specFromInputs({ ...values, spec__adopt__projectId: 'p1' })).toEqual({
      goldenPath: { name: 'java-api', version: '3' },
      repository: { template: 'java-spring-api' },
      quality: { sonarqube: false, qualityGate: 'acme-default' },
      secrets: { vault: true },
      environments: ['dev'],
      adopt: { projectId: 'p1' },
    });
  });

  it('honours fields, others: false and exclude', () => {
    const { spec } = parseXrd(XRD);
    expect(Object.keys(xrdToInputs(spec, { fields: { target: 'goldenPath.version' }, others: false }).properties)).toEqual(['target']);
    expect(Object.keys(xrdToInputs(spec, { exclude: ['quality', 'adopt'] }).properties)).not.toContain('qualityGate');
  });

  it('overlays the XRD on the declared schema: XRD types/enums/defaults win, declared titles and extra fields stay', () => {
    const declared = {
      properties: {
        name: { type: 'string' as const, title: 'Service name' },
        qualityGate: { type: 'string' as const, title: 'Gate', enum: ['old'], format: 'text' },
      },
      required: ['name', 'qualityGate'],
    };
    const m = mergeInputs(declared, xrdToInputs(parseXrd(XRD).spec));
    expect(m.properties.name).toEqual(declared.properties.name);
    expect(m.properties.qualityGate).toMatchObject({ title: 'Gate', enum: ['acme-default', 'acme-strict'], default: 'acme-default', format: 'text' });
    expect(m.required).toContain('name');
    expect(m.required).not.toContain('qualityGate'); // the XRD says optional
    expect(m.order![0]).toBe('name');
  });

  it('reports XRDs it cannot use', () => {
    expect(() => parseXrd('kind: ConfigMap')).toThrow(/CompositeResourceDefinition/);
    expect(() => parseXrd(XRD, { version: 'v9' })).toThrow(/v9/);
  });
});

describe('forms with inputs.fromXrd', () => {
  let app: FastifyInstance;
  let admin: Api;
  let xrdServer: Awaited<ReturnType<typeof fakeServer>>;
  let served = XRD;

  beforeAll(async () => {
    app = await testApp();
    admin = client(app, (await register(app, 'admin@example.com')).token);
    xrdServer = await fakeServer((r) => (r.url.startsWith('/xrd') ? { body: served } : { status: 404, body: { error: 'no' } }));
    const form = (url: string) => ({
      type: 'form',
      on: 'create',
      inputs: {
        fromXrd: { source: 'url', url, ttlSeconds: 10 },
        properties: { name: { type: 'string', title: 'Name' }, goldenPathVersion: { type: 'string', enum: ['3'] } },
        required: ['name'],
      },
    });
    for (const [id, url] of [
      ['xrd-form', `${xrdServer.url}/xrd`],
      ['xrd-broken', `${xrdServer.url}/missing`],
    ])
      expect(
        (await admin.put(`/api/v1/actions/${id}`, { title: id, trigger: form(url), steps: [{ id: 't', type: 'transform', output: { v: '1' } }] })).status,
      ).toBe(200);
  });
  afterAll(async () => {
    await xrdServer.close();
    await app.close();
  });

  it('serves the form generated from the XRD, and validates runs against it', async () => {
    const a = (await admin.get('/api/v1/actions/xrd-form')).data;
    const inputs = a.trigger.inputs;
    expect(inputs.xrd).toMatchObject({ status: 'loaded', version: 'v1alpha1' });
    expect(inputs.properties.goldenPathVersion.enum).toEqual(['3', '4']); // the XRD, not the declared fallback
    expect(inputs.properties.qualityGate.enum).toEqual(['acme-default', 'acme-strict']);
    expect(inputs.properties.name.title).toBe('Name');
    expect(inputs.required).toEqual(expect.arrayContaining(['name', 'environments']));
    const bad = await admin.post('/api/v1/actions/xrd-form/runs', { inputs: { name: 'x', environments: ['qa'] } });
    expect(bad.status).toBe(400);
    expect(JSON.stringify(bad.data)).toMatch(/environments/);
    const ok = await admin.post('/api/v1/actions/xrd-form/runs', {
      inputs: { name: 'x', environments: ['dev'], goldenPath: 'java-api', goldenPathVersion: '4' },
    });
    expect(ok.status, JSON.stringify(ok.data)).toBe(201);
  });

  it('falls back to the declared properties while the XRD cannot be read', async () => {
    const a = (await admin.get('/api/v1/actions/xrd-broken')).data;
    expect(a.trigger.inputs.xrd).toMatchObject({ status: 'unavailable' });
    expect(a.trigger.inputs.properties.goldenPathVersion.enum).toEqual(['3']);
    expect(Object.keys(a.trigger.inputs.properties)).toEqual(['name', 'goldenPathVersion']);
  });

  it('follows XRD changes (admin refresh) and exposes the mapping to admins', async () => {
    served = XRD.replace('enum: ["3", "4"]', 'enum: ["3", "4", "5"]');
    const r = await admin.get('/api/v1/v2/xrd-form?action=xrd-form&refresh=true');
    expect(r.status).toBe(200);
    expect(r.data.inputs.properties.goldenPathVersion.enum).toEqual(['3', '4', '5']);
    const adhoc = await admin.post('/api/v1/v2/xrd-form', { fromXrd: { source: 'url', url: `${xrdServer.url}/xrd`, others: false } });
    expect(Object.keys(adhoc.data.inputs.properties)).toContain('environments');
    expect(Object.keys(adhoc.data.inputs.properties)).not.toContain('spec__adopt__projectId');
  });

  it('validates the fromXrd source', async () => {
    const res = await admin.put('/api/v1/actions/xrd-bad', {
      title: 'bad',
      trigger: { type: 'form', inputs: { fromXrd: { source: 'ado', token: 'literal-token' } } },
      steps: [{ id: 't', type: 'transform', output: { v: '1' } }],
    });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.data)).toMatch(/repository/);
    expect(JSON.stringify(res.data)).toMatch(/reference/);
  });
});
