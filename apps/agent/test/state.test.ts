import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  composedBy,
  computeAll,
  deniedPolicies,
  goldenPathOf,
  identifierOf,
  lifecycleOf,
  rejectionsOf,
  runIdOf,
  serviceStatus,
  teamOf,
  violationsFor,
  type Snapshot,
} from '../src/state.ts';
import { app, cond, constraint, mr, READY, xr } from './fixtures.ts';

const snap = (s: Partial<Snapshot>): Snapshot => ({ xrs: [], mrs: [], constraints: [], apps: [], compositions: new Map(), ...s });

describe('identity', () => {
  it('derives team from the label, else from the namespace minus team-', () => {
    assert.equal(teamOf(xr('api', { team: 'payments' })), 'payments');
    const noLabel = xr('api');
    noLabel.metadata.labels = {};
    noLabel.metadata.namespace = 'team-checkout';
    assert.equal(teamOf(noLabel), 'checkout');
    assert.equal(identifierOf(noLabel), 'checkout/api');
  });

  it('reads the run id from the annotation first, the label second', () => {
    const o = xr('api', { runId: 'r-1' });
    assert.equal(runIdOf(o), 'r-1');
    o.metadata.annotations = { 'portal.asterius.io/run-id': 'r-2' };
    assert.equal(runIdOf(o), 'r-2');
    o.metadata.annotations = {};
    assert.equal(runIdOf(o), 'r-1');
    assert.equal(runIdOf(xr('other')), undefined);
  });

  it('matches managed resources by resourceRefs, composite label or service labels, never across namespaces', () => {
    const x = xr('api');
    assert.ok(composedBy(x, mr('Project', 'payments-api', 'api')));
    const other = mr('Project', 'p', 'web');
    other.metadata.labels = {};
    assert.ok(!composedBy(x, other));
    (x.spec!.crossplane as Record<string, unknown>).resourceRefs = [{ apiVersion: 'azuredevops.upbound.io/v1alpha1', kind: 'Project', name: 'p' }];
    assert.ok(composedBy(x, other));
    assert.ok(!composedBy(x, mr('Project', 'payments-api', 'api', { team: 'checkout' })));
  });
});

describe('lifecycle (V2.md §6.2)', () => {
  it('is Synced when Crossplane has not picked the XR up yet', () => {
    assert.equal(lifecycleOf(xr('api'), []), 'Synced');
  });
  it('is Reconciling while resources are being created', () => {
    assert.equal(
      lifecycleOf(xr('api', { conditions: [cond('Synced', 'True'), cond('Ready', 'False', 'Creating')] }), [mr('Project', 'p', 'api')]),
      'Reconciling',
    );
  });
  it('is Ready when the XR is Ready', () => {
    assert.equal(lifecycleOf(xr('api', { conditions: READY }), [mr('Project', 'p', 'api', { conditions: READY })]), 'Ready');
  });
  it('is Degraded when the XR or a managed resource fails to reconcile', () => {
    assert.equal(lifecycleOf(xr('api', { conditions: [cond('Synced', 'False', 'ReconcileError', 'boom')] }), []), 'Degraded');
    const failing = mr('Repository', 'api', 'api', { conditions: [cond('Synced', 'False', 'ReconcileError', 'quota'), cond('Ready', 'False')] });
    assert.equal(lifecycleOf(xr('api', { conditions: READY }), [failing]), 'Degraded');
  });
  it('is Deleting when the XR has a deletion timestamp or is gone', () => {
    assert.equal(lifecycleOf(xr('api', { conditions: READY, deleting: true }), []), 'Deleting');
    assert.equal(lifecycleOf(undefined, []), 'Deleting');
  });
  it('is Rejected when Argo CD failed to sync the Service', () => {
    assert.equal(lifecycleOf(xr('api', { conditions: READY }), [], { message: 'denied', app: 'team-payments' }), 'Rejected');
    assert.equal(lifecycleOf(undefined, [], { message: 'denied', app: 'team-payments' }), 'Rejected');
  });
});

describe('violations', () => {
  it('keeps the audit violations about the XR and its managed resources only', () => {
    const x = xr('api');
    const mine = mr('Project', 'payments-api', 'api');
    const v = violationsFor(
      x,
      [mine],
      [
        constraint('prod-requires-oncall', [
          { kind: 'Service', name: 'api', namespace: 'team-payments', message: 'prod needs onCall' },
          { kind: 'Service', name: 'web', namespace: 'team-payments', message: 'not mine' },
        ]),
        constraint('mr-has-service-label', [{ kind: 'Project', name: 'payments-api', namespace: 'team-payments', message: 'missing label' }]),
        constraint('other-namespace', [{ kind: 'Service', name: 'api', namespace: 'team-checkout', message: 'other team' }]),
      ],
    );
    assert.deepEqual(
      v.map((x) => [x.policy, x.resource, x.message, x.source]),
      [
        ['mr-has-service-label', 'Project/payments-api', 'missing label', 'audit'],
        ['prod-requires-oncall', 'Service/api', 'prod needs onCall', 'audit'],
      ],
    );
    assert.equal(v[0]!.enforcementAction, 'deny');
  });

  it('parses the policies of a Gatekeeper denial', () => {
    assert.deepEqual(
      deniedPolicies(
        'admission webhook "validation.gatekeeper.sh" denied the request: [prod-requires-oncall] prod needs an on-call group, [cost-center-required] bad CC',
      ),
      [
        { policy: 'prod-requires-oncall', message: 'prod needs an on-call group' },
        { policy: 'cost-center-required', message: 'bad CC' },
      ],
    );
  });
});

describe('Argo CD rejections', () => {
  it('reports Services whose last sync failed, by namespace/name', () => {
    const r = rejectionsOf([
      app('team-payments', [
        { kind: 'Service', name: 'api', namespace: 'team-payments', status: 'SyncFailed', message: 'denied: [prod-requires-oncall] onCall missing' },
        { kind: 'Service', name: 'web', namespace: 'team-payments', status: 'Synced' },
        { kind: 'ConfigMap', name: 'x', namespace: 'team-payments', status: 'SyncFailed', group: '' },
      ]),
    ]);
    assert.deepEqual([...r.keys()], ['team-payments/api']);
    assert.equal(r.get('team-payments/api')!.app, 'team-payments');
  });

  it('a Service that never reached the cluster is reported as Rejected with the denial as a violation', () => {
    const all = computeAll(
      snap({
        apps: [
          app('team-payments', [
            { kind: 'Service', name: 'api', namespace: 'team-payments', status: 'SyncFailed', message: '[prod-requires-oncall] onCall missing' },
          ]),
        ],
      }),
      'T',
    );
    assert.equal(all.length, 1);
    const s = all[0]!;
    assert.equal(s.identifier, 'payments/api');
    assert.equal(s.lifecycle, 'Rejected');
    assert.equal(s.exists, false);
    assert.deepEqual(s.violations, [{ policy: 'prod-requires-oncall', message: 'onCall missing', resource: 'Service/api', source: 'admission' }]);
    assert.equal(s.conditions[0]!.type, 'Admission');
  });
});

describe('service status', () => {
  it('assembles resources, golden path, run id and conditions', () => {
    const x = xr('api', { runId: 'r-8f2c', conditions: READY });
    const comps = new Map([
      ['java-api-v3', { metadata: { name: 'java-api-v3', labels: { 'platform.asterius.io/golden-path': 'java-api', 'platform.asterius.io/version': '3' } } }],
    ]);
    const s = serviceStatus(
      x,
      snap({
        xrs: [x],
        compositions: comps,
        mrs: [
          mr('Repository', 'api', 'api', { conditions: [cond('Synced', 'True'), cond('Ready', 'False', 'Creating', 'waiting for project')] }),
          mr('Project', 'payments-api', 'api', { conditions: READY, externalName: '6f1c', runId: 'r-8f2c' }),
          mr('Project', 'checkout-web', 'web', { team: 'checkout' }),
        ],
      }),
      new Map(),
      '2026-11-08T10:00:00Z',
    );
    assert.equal(s.identifier, 'payments/api');
    assert.equal(s.lifecycle, 'Ready');
    assert.equal(s.xrReady, true);
    assert.equal(s.xrSynced, true);
    assert.equal(s.goldenPath, 'java-api');
    assert.equal(s.goldenPathVersion, '3');
    assert.equal(s.observedRunId, 'r-8f2c');
    assert.equal(s.managedBy, 'crossplane');
    assert.deepEqual(
      s.resources.map((r) => [r.kind, r.name, r.ready, r.synced, r.externalName ?? null, r.message ?? null]),
      [
        ['Project', 'payments-api', true, true, '6f1c', null],
        ['Repository', 'api', false, true, null, 'waiting for project'],
      ],
    );
    assert.equal(s.observedAt, '2026-11-08T10:00:00Z');
  });

  it('falls back to the composition name for the golden-path version', () => {
    assert.deepEqual(goldenPathOf(xr('api', { composition: 'java-api-v4' }), new Map()), {
      compositionRef: 'java-api-v4',
      goldenPath: 'java-api',
      goldenPathVersion: '4',
    });
  });
});
