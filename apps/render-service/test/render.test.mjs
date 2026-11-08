import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { after, before, describe, it } from 'node:test';
const { fetch } = globalThis;
import { fileURLToPath } from 'node:url';
import { functionTargets, parseRenderOutput, selectInputs } from '../src/render.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

const xrd = {
  apiVersion: 'apiextensions.crossplane.io/v2',
  kind: 'CompositeResourceDefinition',
  metadata: { name: 'services.platform.asterius.io' },
  spec: { group: 'platform.asterius.io', names: { kind: 'Service', plural: 'services' }, versions: [] },
};
const composition = {
  apiVersion: 'apiextensions.crossplane.io/v1',
  kind: 'Composition',
  metadata: { name: 'java-api-v3' },
  spec: {
    mode: 'Pipeline',
    pipeline: [
      { step: 'render', functionRef: { name: 'function-go-templating' } },
      { step: 'ready', functionRef: { name: 'function-auto-ready' } },
    ],
  },
};
const fn = (name) => ({ apiVersion: 'pkg.crossplane.io/v1', kind: 'Function', metadata: { name }, spec: { package: `xpkg/${name}:v1` } });
const service = (name = 'payments-api') => ({
  apiVersion: 'platform.asterius.io/v1alpha1',
  kind: 'Service',
  metadata: { name, namespace: 'team-payments' },
  spec: { owner: 'payments', crossplane: { compositionRef: { name: 'java-api-v3' } } },
});
const bundle = { docs: [xrd, composition, fn('function-go-templating'), fn('function-auto-ready'), fn('function-patch-and-transform')] };

describe('selectInputs', () => {
  it('picks the composition by compositionRef and annotates only its functions for the Development runtime', () => {
    const s = selectInputs(bundle, service(), {});
    assert.equal(s.composition.metadata.name, 'java-api-v3');
    assert.deepEqual(
      s.functions.map((f) => [
        f.metadata.name,
        f.metadata.annotations['render.crossplane.io/runtime'],
        f.metadata.annotations['render.crossplane.io/runtime-development-target'],
      ]),
      [
        ['function-go-templating', 'Development', 'localhost:9444'],
        ['function-auto-ready', 'Development', 'localhost:9443'],
      ],
    );
    assert.equal(s.xrd.metadata.name, 'services.platform.asterius.io');
  });
  it('rejects unknown compositions, missing functions and bad bodies', () => {
    assert.throws(
      () => selectInputs(bundle, { ...service(), spec: { crossplane: { compositionRef: { name: 'nope' } } } }, {}),
      (e) => e.status === 422,
    );
    assert.throws(() => selectInputs({ docs: [composition] }, service(), {}), /not in the bundle/);
    assert.throws(
      () => selectInputs(bundle, { kind: 'Service' }, {}),
      (e) => e.status === 400,
    );
    assert.throws(
      () => selectInputs({ docs: [] }, service(), {}),
      (e) => e.status === 503,
    );
  });
});

describe('functionTargets', () => {
  it('uses FUNCTION_TARGETS, then the Function annotation, then base port + sorted index', () => {
    const fns = [fn('b'), { ...fn('a'), metadata: { name: 'a', annotations: { 'render.crossplane.io/runtime-development-target': 'side:1' } } }, fn('c')];
    assert.deepEqual(functionTargets(fns, { FUNCTION_TARGETS: 'c=other:7', FUNCTION_BASE_PORT: '9000' }), { a: 'side:1', b: 'localhost:9001', c: 'other:7' });
  });
});

describe('parseRenderOutput', () => {
  it('separates the XR, the composed resources and the results', () => {
    const out = `apiVersion: platform.asterius.io/v1alpha1
kind: Service
metadata: { name: payments-api }
---
apiVersion: example.org/v1
kind: Project
metadata:
  generateName: payments-api-
  annotations: { crossplane.io/composition-resource-name: project, crossplane.io/external-name: payments-payments-api }
---
apiVersion: render.crossplane.io/v1beta1
kind: Result
message: hi
`;
    const r = parseRenderOutput(out, service());
    assert.deepEqual(r.resources, [
      { apiVersion: 'example.org/v1', kind: 'Project', name: 'project', externalName: 'payments-payments-api', resourceName: 'project' },
    ]);
    assert.equal(r.results.length, 1);
    assert.equal(r.raw.length, 3);
  });
});

describe('server', () => {
  let dir;
  let base;
  let server;
  before(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bundle-'));
    const YAML = (await import('yaml')).default;
    await fs.writeFile(path.join(dir, 'bundle.yaml'), bundle.docs.map((d) => YAML.stringify(d)).join('---\n'));
    await fs.writeFile(path.join(dir, 'xrd.yaml'), YAML.stringify(xrd));
    process.env.COMPOSITIONS_DIR = dir;
    process.env.CROSSPLANE_BIN = path.join(here, 'fake-crossplane.mjs');
    process.env.RENDER_MODE = 'crossplane';
    ({ server } = await import('../src/server.mjs'));
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(async () => {
    server.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  const post = (body) => fetch(`${base}/render`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  it('renders through the crossplane CLI and returns the contract shape', async () => {
    const res = await post({ service: service() });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.composition, 'java-api-v3');
    assert.deepEqual(
      body.resources.map((r) => [r.kind, r.name, r.externalName]),
      [
        ['Thing', 'function-go-templating', 'payments-payments-api'],
        ['Thing', 'function-auto-ready', 'payments-payments-api'],
      ],
    );
    assert.ok(Array.isArray(body.raw));
  });
  it('answers 422 with the CLI error when the render fails, 400 on bad input', async () => {
    const res = await post({ service: service('boom') });
    assert.equal(res.status, 422);
    assert.match((await res.json()).error, /cannot run pipeline step/);
    assert.equal((await post({})).status, 400);
  });
  it('serves the XRD of the bundle', async () => {
    const res = await fetch(`${base}/xrd?kind=Service`);
    assert.equal(res.status, 200);
    assert.match(await res.text(), /services\.platform\.asterius\.io/);
  });
});
