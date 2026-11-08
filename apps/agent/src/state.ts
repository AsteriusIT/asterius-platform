/**
 * Pure state computation of the catalog watcher: Kubernetes objects in, one status document per service out.
 * Nothing here talks to the network, so every rule is unit tested (test/state.test.ts).
 *
 * Contract: docs/V2-KIND.md (labels, identifier `<team>/<service>`, lifecycle) and docs/V2.md §6.2.
 */

export const LABEL = {
  runId: 'portal.asterius.io/run-id',
  team: 'portal.asterius.io/team',
  service: 'portal.asterius.io/service',
  goldenPath: 'platform.asterius.io/golden-path',
  version: 'platform.asterius.io/version',
  policy: 'platform.asterius.io/policy',
  composite: 'crossplane.io/composite',
  externalName: 'crossplane.io/external-name',
} as const;

export const XR_GROUP = 'platform.asterius.io';
export const XR_KIND = 'Service';

export interface Metadata {
  name: string;
  namespace?: string;
  uid?: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
  creationTimestamp?: string;
  deletionTimestamp?: string;
  resourceVersion?: string;
}

export interface K8sObject {
  apiVersion?: string;
  kind?: string;
  metadata: Metadata;
  // Kubernetes objects are open-ended documents: read them defensively.
  spec?: Record<string, unknown>;
  status?: Record<string, unknown>;
}

export interface Condition {
  type: string;
  status: string;
  reason?: string;
  message?: string;
  lastTransitionTime?: string;
}

export type Lifecycle = 'Synced' | 'Reconciling' | 'Ready' | 'Degraded' | 'Deleting' | 'Rejected';

export interface ResourceStatus {
  apiVersion: string;
  kind: string;
  name: string;
  namespace?: string;
  externalName?: string;
  ready: boolean;
  synced: boolean;
  message?: string;
  runId?: string;
}

export interface Violation {
  policy: string;
  message: string;
  /** `<Kind>/<name>` of the object the violation is about. */
  resource: string;
  enforcementAction?: string;
  /** `audit` (Constraint status) or `admission` (Argo CD sync denied). */
  source: 'audit' | 'admission';
}

export interface Rejection {
  message: string;
  app: string;
  at?: string;
}

/** What the watcher reports for one service (the item of the ingest payload; see examples/v2/config/watcher.yaml). */
export interface ServiceStatus {
  identifier: string;
  team: string;
  service: string;
  namespace: string;
  name: string;
  /** False when the XR does not exist (admission denied, or deleted). */
  exists: boolean;
  lifecycle: Lifecycle;
  managedBy: 'crossplane';
  xrReady: boolean;
  xrSynced: boolean;
  conditions: Condition[];
  resources: ResourceStatus[];
  violations: Violation[];
  goldenPath?: string;
  goldenPathVersion?: string;
  compositionRef?: string;
  observedRunId?: string;
  observedAt: string;
}

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

export const groupOf = (apiVersion = '') => (apiVersion.includes('/') ? apiVersion.split('/')[0]! : '');
export const keyOf = (o: { metadata: Metadata }) => `${o.metadata.namespace ?? ''}/${o.metadata.name}`;

export function conditionsOf(o: K8sObject | undefined): Condition[] {
  return arr(o?.status?.conditions)
    .map(obj)
    .filter((c) => typeof c.type === 'string' && typeof c.status === 'string')
    .map((c) => ({
      type: c.type as string,
      status: c.status as string,
      ...(str(c.reason) ? { reason: str(c.reason) } : {}),
      ...(str(c.message) ? { message: str(c.message) } : {}),
      ...(str(c.lastTransitionTime) ? { lastTransitionTime: str(c.lastTransitionTime) } : {}),
    }));
}
export const condition = (o: K8sObject | undefined, type: string) => conditionsOf(o).find((c) => c.type === type);

export const isXR = (o: K8sObject) => groupOf(o.apiVersion) === XR_GROUP && o.kind === XR_KIND;

/** Owner team: the `portal.asterius.io/team` label, else the namespace without its `team-` prefix. */
export function teamOf(o: K8sObject): string {
  return o.metadata.labels?.[LABEL.team] ?? (o.metadata.namespace ?? '').replace(/^team-/, '');
}
export const serviceOf = (o: K8sObject) => o.metadata.labels?.[LABEL.service] ?? o.metadata.name;
export const identifierOf = (o: K8sObject) => `${teamOf(o)}/${serviceOf(o)}`;
/** The run that last changed the object: annotation first (the spec carries it), label as a fallback. */
export const runIdOf = (o: K8sObject | undefined) => o?.metadata.annotations?.[LABEL.runId] ?? o?.metadata.labels?.[LABEL.runId];

/** The managed resources composed for this XR: `resourceRefs`, the composite label, or the service labels. */
export function composedBy(xr: K8sObject, mr: K8sObject): boolean {
  const ns = xr.metadata.namespace;
  if (mr.metadata.namespace && mr.metadata.namespace !== ns) return false;
  const crossplane = obj(xr.spec?.crossplane);
  const refs = arr(crossplane.resourceRefs ?? xr.spec?.resourceRefs).map(obj);
  if (refs.some((r) => r.kind === mr.kind && r.name === mr.metadata.name && groupOf(str(r.apiVersion)) === groupOf(mr.apiVersion))) return true;
  const l = mr.metadata.labels ?? {};
  if (l[LABEL.composite] === xr.metadata.name) return true;
  return l[LABEL.service] === serviceOf(xr) && (l[LABEL.team] ?? teamOf(xr)) === teamOf(xr);
}

export function resourceOf(mr: K8sObject): ResourceStatus {
  const ready = condition(mr, 'Ready');
  const synced = condition(mr, 'Synced');
  const problem = [synced, ready].find((c) => c && c.status !== 'True' && c.message);
  return {
    apiVersion: mr.apiVersion ?? '',
    kind: mr.kind ?? '',
    name: mr.metadata.name,
    ...(mr.metadata.namespace ? { namespace: mr.metadata.namespace } : {}),
    ...(mr.metadata.annotations?.[LABEL.externalName] ? { externalName: mr.metadata.annotations[LABEL.externalName] } : {}),
    ready: ready?.status === 'True',
    synced: synced?.status === 'True',
    ...(problem?.message ? { message: problem.message.slice(0, 500) } : {}),
    ...(runIdOf(mr) ? { runId: runIdOf(mr) } : {}),
  };
}

/** A managed resource that failed to reconcile (`Synced=False`, e.g. ReconcileError). */
export const mrFailing = (mr: K8sObject) => condition(mr, 'Synced')?.status === 'False';

/**
 * Lifecycle observed in the cluster (V2.md §6.2). Requested / Committed are the portal's; Rejected comes from the
 * Argo CD application (admission denied) and wins until a later sync of that resource succeeds.
 */
export function lifecycleOf(xr: K8sObject | undefined, mrs: K8sObject[], rejection?: Rejection): Lifecycle {
  if (!xr) return rejection ? 'Rejected' : 'Deleting';
  if (xr.metadata.deletionTimestamp) return 'Deleting';
  if (rejection) return 'Rejected';
  const ready = condition(xr, 'Ready');
  const synced = condition(xr, 'Synced');
  if (synced?.status === 'False' || mrs.some(mrFailing)) return 'Degraded';
  if (ready?.status === 'True') return 'Ready';
  if (!ready && !synced && !mrs.length) return 'Synced'; // applied by Argo CD, not picked up by Crossplane yet
  return 'Reconciling';
}

/** Gatekeeper audit results (`Constraint.status.violations`) about the XR or one of its managed resources. */
export function violationsFor(xr: K8sObject, mrs: K8sObject[], constraints: K8sObject[]): Violation[] {
  const targets = new Set([
    `${XR_KIND}/${xr.metadata.namespace ?? ''}/${xr.metadata.name}`,
    ...mrs.map((m) => `${m.kind}/${m.metadata.namespace ?? ''}/${m.metadata.name}`),
  ]);
  const out: Violation[] = [];
  for (const c of constraints) {
    const policy = c.metadata.labels?.[LABEL.policy] ?? c.metadata.name;
    for (const v of arr(c.status?.violations).map(obj)) {
      const key = `${str(v.kind) ?? ''}/${str(v.namespace) ?? ''}/${str(v.name) ?? ''}`;
      if (!targets.has(key)) continue;
      out.push({
        policy,
        message: (str(v.message) ?? '').slice(0, 500),
        resource: `${str(v.kind)}/${str(v.name)}`,
        ...(str(v.enforcementAction) || str(c.spec?.enforcementAction)
          ? { enforcementAction: str(v.enforcementAction) ?? str(c.spec?.enforcementAction) }
          : {}),
        source: 'audit',
      });
    }
  }
  return out.sort((a, b) => a.policy.localeCompare(b.policy) || a.resource.localeCompare(b.resource));
}

/**
 * Service XRs whose last Argo CD sync failed (admission denied by Gatekeeper, invalid spec…), by `<namespace>/<name>`.
 * Only the latest operation counts: a later successful sync of the resource clears the rejection.
 */
export function rejectionsOf(apps: K8sObject[]): Map<string, Rejection> {
  const out = new Map<string, Rejection>();
  for (const app of apps) {
    const op = obj(app.status?.operationState);
    const defaultNs = str(obj(obj(app.spec).destination).namespace);
    for (const r of arr(obj(op.syncResult).resources).map(obj)) {
      if (r.group !== XR_GROUP || r.kind !== XR_KIND || r.status !== 'SyncFailed') continue;
      const ns = str(r.namespace) ?? defaultNs ?? '';
      out.set(`${ns}/${str(r.name)}`, {
        message: (str(r.message) ?? str(op.message) ?? 'sync failed').slice(0, 1000),
        app: app.metadata.name,
        ...(str(op.finishedAt) || str(op.startedAt) ? { at: str(op.finishedAt) ?? str(op.startedAt) } : {}),
      });
    }
  }
  return out;
}

/** Policy ids quoted by Gatekeeper in a denial (`[prod-requires-oncall] prod needs an on-call group`). */
export function deniedPolicies(message: string): { policy: string; message: string }[] {
  const out: { policy: string; message: string }[] = [];
  const re = /\[([a-z0-9][a-z0-9.-]*)\]\s*([^[]*)/g;
  for (let m = re.exec(message); m; m = re.exec(message)) out.push({ policy: m[1]!, message: m[2]!.trim().replace(/[,;]$/, '') });
  return out;
}

/** Golden path and version of the Composition the XR selected: its labels, else `<name>-v<version>`. */
export function goldenPathOf(xr: K8sObject, compositions: Map<string, K8sObject>) {
  const crossplane = obj(xr.spec?.crossplane);
  const ref = str(obj(crossplane.compositionRef ?? xr.spec?.compositionRef).name);
  if (!ref) return {};
  const labels = compositions.get(ref)?.metadata.labels ?? {};
  const parsed = /^(.*)-v(\d+)$/.exec(ref);
  const goldenPath = labels[LABEL.goldenPath] ?? parsed?.[1];
  const version = labels[LABEL.version] ?? parsed?.[2];
  return { compositionRef: ref, ...(goldenPath ? { goldenPath } : {}), ...(version ? { goldenPathVersion: version } : {}) };
}

export interface Snapshot {
  xrs: K8sObject[];
  mrs: K8sObject[];
  constraints: K8sObject[];
  apps: K8sObject[];
  compositions: Map<string, K8sObject>;
}

/** The status of one service from what the cluster holds now. */
export function serviceStatus(xr: K8sObject, snap: Snapshot, rejections: Map<string, Rejection>, at = new Date().toISOString()): ServiceStatus {
  const mrs = snap.mrs.filter((m) => composedBy(xr, m));
  const rejection = rejections.get(keyOf(xr));
  const ready = condition(xr, 'Ready');
  const synced = condition(xr, 'Synced');
  const violations = violationsFor(xr, mrs, snap.constraints);
  const conditions = conditionsOf(xr);
  if (rejection) {
    conditions.push({
      type: 'Admission',
      status: 'False',
      reason: 'SyncFailed',
      message: rejection.message,
      ...(rejection.at ? { lastTransitionTime: rejection.at } : {}),
    });
    violations.push(...admissionViolations(xr, rejection));
  }
  return {
    identifier: identifierOf(xr),
    team: teamOf(xr),
    service: serviceOf(xr),
    namespace: xr.metadata.namespace ?? '',
    name: xr.metadata.name,
    exists: true,
    lifecycle: lifecycleOf(xr, mrs, rejection),
    managedBy: 'crossplane',
    xrReady: ready?.status === 'True',
    xrSynced: synced?.status === 'True',
    conditions,
    resources: mrs.map(resourceOf).sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name)),
    violations,
    ...goldenPathOf(xr, snap.compositions),
    ...(runIdOf(xr) ? { observedRunId: runIdOf(xr) } : {}),
    observedAt: at,
  };
}

const admissionViolations = (xr: { metadata: Metadata }, r: Rejection): Violation[] =>
  deniedPolicies(r.message).map((p) => ({ policy: p.policy, message: p.message, resource: `${XR_KIND}/${xr.metadata.name}`, source: 'admission' as const }));

/** A Service that Argo CD could not apply (no XR in the cluster): reported as Rejected with the denial. */
export function rejectedStatus(key: string, r: Rejection, at = new Date().toISOString()): ServiceStatus {
  const [namespace = '', name = ''] = key.split('/');
  const stub: K8sObject = { apiVersion: `${XR_GROUP}/v1alpha1`, kind: XR_KIND, metadata: { name, namespace } };
  return {
    identifier: identifierOf(stub),
    team: teamOf(stub),
    service: name,
    namespace,
    name,
    exists: false,
    lifecycle: 'Rejected',
    managedBy: 'crossplane',
    xrReady: false,
    xrSynced: false,
    conditions: [{ type: 'Admission', status: 'False', reason: 'SyncFailed', message: r.message, ...(r.at ? { lastTransitionTime: r.at } : {}) }],
    resources: [],
    violations: admissionViolations(stub, r),
    observedAt: at,
  };
}

/** A Service that disappeared from the cluster (deleted): the last report before the watcher forgets it. */
export function goneStatus(xr: K8sObject, at = new Date().toISOString()): ServiceStatus {
  return {
    identifier: identifierOf(xr),
    team: teamOf(xr),
    service: serviceOf(xr),
    namespace: xr.metadata.namespace ?? '',
    name: xr.metadata.name,
    exists: false,
    lifecycle: 'Deleting',
    managedBy: 'crossplane',
    xrReady: false,
    xrSynced: false,
    conditions: [],
    resources: [],
    violations: [],
    ...(runIdOf(xr) ? { observedRunId: runIdOf(xr) } : {}),
    observedAt: at,
  };
}

/** Every service of the snapshot: the XRs, plus the Services Argo CD failed to create. */
export function computeAll(snap: Snapshot, at = new Date().toISOString()): ServiceStatus[] {
  const rejections = rejectionsOf(snap.apps);
  const out = snap.xrs.map((xr) => serviceStatus(xr, snap, rejections, at));
  const present = new Set(snap.xrs.map(keyOf));
  for (const [key, r] of rejections) if (!present.has(key)) out.push(rejectedStatus(key, r, at));
  return out;
}

/** Comparable form of a status (without the observation time): unchanged services are not re-sent. */
export const fingerprint = (s: ServiceStatus) => JSON.stringify({ ...s, observedAt: undefined });
