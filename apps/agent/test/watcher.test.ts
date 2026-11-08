import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Informer } from '../src/informer.ts';
import { watcherMetrics } from '../src/metrics.ts';
import { OtlpExporter } from '../src/otlp.ts';
import type { Payload, PortalClient } from '../src/portal.ts';
import type { ServiceStatus } from '../src/state.ts';
import { Watcher } from '../src/watcher.ts';
import { cond, mr, READY, xr } from './fixtures.ts';
import { FakeKube, until } from './fake-kube.ts';

const XR = 'platform.asterius.io/Service';
const PROJECT = 'azuredevops.upbound.io/Project';
const EVENTS = '/Event';

function setup() {
  const kube = new FakeKube();
  kube.crds = [
    FakeKube.crd('platform.asterius.io', 'Service', 'services'),
    FakeKube.crd('azuredevops.upbound.io', 'Project', 'projects', { categories: ['crossplane', 'managed', 'azuredevops'], scope: 'Cluster' }),
    FakeKube.crd('constraints.gatekeeper.sh', 'PlatformRule', 'platformrules', { scope: 'Cluster', version: 'v1beta1' }),
    FakeKube.crd('apiextensions.crossplane.io', 'Composition', 'compositions', { scope: 'Cluster', version: 'v1' }),
    FakeKube.crd('argoproj.io', 'Application', 'applications'),
    FakeKube.crd('example.io', 'Widget', 'widgets'), // not watched
  ];
  const sent: { mode: Payload['mode']; services: ServiceStatus[] }[] = [];
  let failNext = 0;
  const portal: PortalClient = {
    async send(services, mode) {
      if (failNext > 0) {
        failNext--;
        throw new Error('portal down');
      }
      sent.push({ mode, services: structuredClone(services) });
    },
  };
  const otlp: unknown[] = [];
  const exporter = new OtlpExporter('http://collector/v1/logs', () => undefined, (async (_u: string, init: RequestInit) => {
    otlp.push(JSON.parse(String(init.body)));
    return new Response('{}');
  }) as typeof fetch);
  const metrics = watcherMetrics();
  const w = new Watcher({ kube: kube.asKube(), portal, exporter, metrics, log: () => undefined, debounceMs: 20, maxDelayMs: 100, resyncMs: 3_600_000 });
  return { kube, w, sent, otlp, exporter, metrics, failPortal: (n: number) => (failNext = n) };
}

let current: Watcher | undefined;
afterEach(() => current?.stop());

describe('watcher', () => {
  it('discovers the types to watch (managed category, Gatekeeper constraints) and sends a full snapshot first', async () => {
    const t = setup();
    current = t.w;
    t.kube.set(XR, [xr('api', { runId: 'r-1', conditions: [cond('Ready', 'False', 'Creating')] })]);
    t.kube.set(PROJECT, [mr('Project', 'payments-api', 'api', { conditions: READY })]);
    await t.w.start();
    assert.deepEqual([...t.w.informers.keys()].sort(), [
      '/Event',
      'apiextensions.crossplane.io/Composition',
      'argoproj.io/Application',
      'azuredevops.upbound.io/Project',
      'constraints.gatekeeper.sh/PlatformRule',
      'platform.asterius.io/Service',
    ]);
    assert.equal(t.sent.length, 1);
    assert.equal(t.sent[0]!.mode, 'full');
    assert.equal(t.sent[0]!.services[0]!.identifier, 'payments/api');
    assert.equal(t.sent[0]!.services[0]!.lifecycle, 'Reconciling');
    assert.equal(t.sent[0]!.services[0]!.resources.length, 1);
  });

  it('debounces changes into deltas with only the services that changed, and measures time to Ready', async () => {
    const t = setup();
    current = t.w;
    t.kube.set(XR, [xr('api', { runId: 'r-1', conditions: [cond('Ready', 'False', 'Creating')] }), xr('web', { runId: 'r-0', conditions: READY })]);
    await t.w.start();
    await until(() => t.kube.watching(XR));
    t.kube.emit(XR, 'MODIFIED', xr('api', { runId: 'r-1', conditions: [cond('Synced', 'True'), cond('Ready', 'False', 'Creating')] }));
    t.kube.emit(XR, 'MODIFIED', xr('api', { runId: 'r-1', conditions: READY }));
    await until(() => t.sent.length === 2);
    assert.equal(t.sent[1]!.mode, 'delta');
    assert.deepEqual(
      t.sent[1]!.services.map((s) => [s.identifier, s.lifecycle]),
      [['payments/api', 'Ready']],
    );
    // r-1 was first seen not Ready, then Ready: one observation; r-0 was already Ready at start: not measured.
    assert.equal(t.metrics.timeToReady.count({ golden_path: 'java-api', version: '3' }), 1);
    assert.match(t.metrics.registry.render(), /asterius_watcher_services\{lifecycle="Ready"\} 2/);
    // A full resync re-sends everything, unchanged services with their original observation time.
    const before = t.sent[1]!.services[0]!.observedAt;
    await new Promise((r) => setTimeout(r, 5));
    await t.w.flush('full');
    const api = t.sent[2]!.services.find((s) => s.identifier === 'payments/api')!;
    assert.equal(t.sent[2]!.mode, 'full');
    assert.equal(t.sent[2]!.services.length, 2);
    assert.equal(api.observedAt, before);
  });

  it('reports a deleted XR once as Deleting, then forgets it', async () => {
    const t = setup();
    current = t.w;
    t.kube.set(XR, [xr('api', { conditions: READY })]);
    await t.w.start();
    await until(() => t.kube.watching(XR));
    t.kube.emit(XR, 'DELETED', xr('api', { conditions: READY }));
    await until(() => t.sent.length === 2);
    assert.deepEqual(
      t.sent[1]!.services.map((s) => [s.identifier, s.lifecycle, s.exists]),
      [['payments/api', 'Deleting', false]],
    );
  });

  it('retries a failed delivery', async () => {
    const t = setup();
    current = t.w;
    t.kube.set(XR, [xr('api', { conditions: READY })]);
    await t.w.start();
    await until(() => t.kube.watching(XR));
    t.failPortal(1);
    t.kube.emit(XR, 'MODIFIED', xr('api', { conditions: [cond('Synced', 'False', 'ReconcileError', 'boom')] }));
    await until(() => t.sent.length === 2, 5_000);
    assert.equal(t.sent[1]!.services[0]!.lifecycle, 'Degraded');
  });

  it('exports events about known objects as OTLP logs with the run id, and counts provider warnings', async () => {
    const t = setup();
    current = t.w;
    t.kube.set(XR, [xr('api', { runId: 'r-8f2c' })]);
    t.kube.set(PROJECT, [mr('Project', 'payments-api', 'api', { runId: 'r-8f2c' })]);
    t.kube.set(EVENTS, [
      {
        metadata: { name: 'old', namespace: 'team-payments', uid: 'e0' },
        involvedObject: { kind: 'Service', apiVersion: 'platform.asterius.io/v1alpha1', name: 'api', namespace: 'team-payments' },
      } as never,
    ]);
    await t.w.start();
    await until(() => t.kube.watching(EVENTS));
    const ev = (uid: string, kind: string, apiVersion: string, name: string, type: string, reason: string) =>
      ({
        metadata: { name: uid, namespace: 'team-payments', uid },
        involvedObject: { kind, apiVersion, name, namespace: 'team-payments' },
        type,
        reason,
        message: `${reason} happened`,
        lastTimestamp: '2026-11-08T09:41:48Z',
        count: 1,
      }) as never;
    t.kube.emit(EVENTS, 'ADDED', ev('e1', 'Project', 'azuredevops.upbound.io/v1alpha1', 'payments-api', 'Warning', 'CannotCreateExternalResource'));
    t.kube.emit(EVENTS, 'ADDED', ev('e2', 'Service', 'platform.asterius.io/v1alpha1', 'api', 'Normal', 'SelectComposition'));
    t.kube.emit(EVENTS, 'ADDED', ev('e3', 'Pod', 'v1', 'unrelated', 'Normal', 'Pulled'));
    await t.exporter.flush();
    const records = t.otlp.flatMap(
      (b) =>
        (b as { resourceLogs: { scopeLogs: { logRecords: { attributes: { key: string; value: { stringValue: string } }[] }[] }[] }[] }).resourceLogs[0]!
          .scopeLogs[0]!.logRecords,
    );
    assert.equal(records.length, 2); // e0 predates the watcher, e3 is about an unrelated object
    const attrs = records.map((r) => Object.fromEntries(r.attributes.map((a) => [a.key, a.value.stringValue])));
    assert.equal(attrs[0]!.run_id, 'r-8f2c');
    assert.equal(attrs[0]!.step, 'Project');
    assert.equal(attrs[0]!.provider, 'azuredevops');
    assert.equal(attrs[0]!.service, 'api');
    assert.equal(attrs[0]!.source, 'k8s_events');
    assert.equal(attrs[1]!.step, 'Service');
    assert.equal(t.metrics.reconcileErrors.get({ provider: 'azuredevops', kind: 'Project', reason: 'CannotCreateExternalResource' }), 1);
  });
});

describe('informer', () => {
  it('re-lists on 410 Gone and emits only the differences', async () => {
    const kube = new FakeKube();
    const type = { group: 'platform.asterius.io', version: 'v1alpha1', plural: 'services', kind: 'Service' };
    kube.set(XR, [xr('a'), xr('b')]);
    const changes: string[] = [];
    const inf = new Informer(kube.asKube(), type, (t, o, _i, initial) => changes.push(`${t}:${o.metadata.name}${initial ? ':initial' : ''}`));
    kube.goneNext(XR);
    void inf.run();
    await until(() => (kube.lists.get(XR) ?? 0) >= 2 && kube.watching(XR));
    // The first list is the initial one; the 410 re-list finds nothing new.
    assert.deepEqual(changes, ['ADDED:a:initial', 'ADDED:b:initial']);
    // Changes made while no watch runs show up as a diff on the next re-list.
    kube.set(XR, [xr('a', { rv: '7' }), xr('c')]);
    inf.resync();
    await until(() => changes.length >= 5);
    inf.stop();
    assert.deepEqual(changes.slice(2).sort(), ['ADDED:c', 'DELETED:b', 'MODIFIED:a']);
  });
});
