import type { Condition, K8sObject } from '../src/state.ts';

export const cond = (type: string, status: string, reason?: string, message?: string): Condition => ({
  type,
  status,
  ...(reason ? { reason } : {}),
  ...(message ? { message } : {}),
});

export function xr(
  name: string,
  opts: { team?: string; runId?: string; conditions?: Condition[]; composition?: string; deleting?: boolean; rv?: string } = {},
): K8sObject {
  const team = opts.team ?? 'payments';
  return {
    apiVersion: 'platform.asterius.io/v1alpha1',
    kind: 'Service',
    metadata: {
      name,
      namespace: `team-${team}`,
      resourceVersion: opts.rv ?? '1',
      labels: { 'portal.asterius.io/team': team, 'portal.asterius.io/service': name, ...(opts.runId ? { 'portal.asterius.io/run-id': opts.runId } : {}) },
      annotations: opts.runId ? { 'portal.asterius.io/run-id': opts.runId } : {},
      ...(opts.deleting ? { deletionTimestamp: '2026-11-08T10:00:00Z' } : {}),
    },
    spec: { crossplane: { compositionRef: { name: opts.composition ?? 'java-api-v3' } } },
    status: { conditions: opts.conditions ?? [] },
  };
}

export function mr(
  kind: string,
  name: string,
  service: string,
  opts: { team?: string; conditions?: Condition[]; externalName?: string; apiVersion?: string; runId?: string; rv?: string } = {},
): K8sObject {
  const team = opts.team ?? 'payments';
  return {
    apiVersion: opts.apiVersion ?? 'azuredevops.upbound.io/v1alpha1',
    kind,
    metadata: {
      name,
      namespace: `team-${team}`,
      resourceVersion: opts.rv ?? '1',
      labels: {
        'portal.asterius.io/team': team,
        'portal.asterius.io/service': service,
        'crossplane.io/composite': service,
        ...(opts.runId ? { 'portal.asterius.io/run-id': opts.runId } : {}),
      },
      annotations: opts.externalName ? { 'crossplane.io/external-name': opts.externalName } : {},
    },
    spec: {},
    status: { conditions: opts.conditions ?? [] },
  };
}

export function constraint(name: string, violations: { kind: string; name: string; namespace?: string; message: string }[]): K8sObject {
  return {
    apiVersion: 'constraints.gatekeeper.sh/v1beta1',
    kind: 'PlatformRule',
    metadata: { name },
    spec: { enforcementAction: 'deny' },
    status: { totalViolations: violations.length, violations: violations.map((v) => ({ enforcementAction: 'deny', ...v })) },
  };
}

export function app(name: string, resources: { kind: string; name: string; namespace: string; status: string; message?: string; group?: string }[]): K8sObject {
  return {
    apiVersion: 'argoproj.io/v1alpha1',
    kind: 'Application',
    metadata: { name, namespace: 'argocd', resourceVersion: '1' },
    spec: { destination: { namespace: 'team-payments' } },
    status: {
      operationState: {
        phase: resources.some((r) => r.status === 'SyncFailed') ? 'Failed' : 'Succeeded',
        message: 'one or more objects failed to apply',
        finishedAt: '2026-11-08T09:41:20Z',
        syncResult: { revision: 'abc', resources: resources.map((r) => ({ group: 'platform.asterius.io', ...r })) },
      },
    },
  };
}

export const READY = [cond('Synced', 'True', 'ReconcileSuccess'), cond('Ready', 'True', 'Available')];
