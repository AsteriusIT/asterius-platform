import { Informer, type ChangeType } from './informer.ts';
import { discover, typeKey, type Discovered, type Kube, type ResourceType } from './kube.ts';
import { providerOf, type WatcherMetrics } from './metrics.ts';
import { occurrenceOf, toLogRecord, type KubeEvent, type OtlpExporter, type Subject } from './otlp.ts';
import type { PortalClient } from './portal.ts';
import {
  computeAll,
  fingerprint,
  goneStatus,
  groupOf,
  identifierOf,
  LABEL,
  rejectionsOf,
  XR_GROUP,
  XR_KIND,
  type K8sObject,
  type ServiceStatus,
  type Snapshot,
} from './state.ts';
import { BoundedSet, ReadyTracker, RejectionTracker } from './trackers.ts';

export type Log = (level: 'info' | 'warn' | 'error', msg: string, extra?: Record<string, unknown>) => void;

export interface WatcherOptions {
  kube: Kube;
  portal: PortalClient;
  exporter: OtlpExporter;
  metrics: WatcherMetrics;
  log: Log;
  /** Quiet period before changes are sent (changes are batched). */
  debounceMs?: number;
  /** Changes are sent at the latest this long after the first one, even if more keep coming. */
  maxDelayMs?: number;
  /** Full resync (re-list every type, re-send every service): the backstop for anything a watch or a delivery lost. */
  resyncMs?: number;
  /** Longest wait for the initial lists before the first delivery. */
  syncTimeoutMs?: number;
}

const EVENTS: ResourceType = { group: '', version: 'v1', plural: 'events', kind: 'Event' };
const FALLBACK_XR: ResourceType = { group: XR_GROUP, version: 'v1alpha1', plural: 'services', kind: XR_KIND, namespaced: true };

/**
 * The catalog watcher: mirrors Service XRs, their managed resources, Gatekeeper audit results and Argo CD sync
 * failures into `platform-service` entities (through the portal ingest webhook), forwards Kubernetes events as OTLP
 * logs carrying the run id, and keeps the platform SLO metrics.
 */
export class Watcher {
  readonly informers = new Map<string, Informer>();
  private xrKey = typeKey(FALLBACK_XR);
  private compositionsKey?: string;
  private appsKey?: string;
  private managedKeys = new Set<string>();
  private constraintKeys = new Set<string>();
  /** What was last delivered per service: its fingerprint and observation time (kept while nothing changes). */
  private sent = new Map<string, { fp: string; at: string }>();
  private gone: ServiceStatus[] = [];
  private seenEvents = new BoundedSet(50_000);
  private readyTracker = new ReadyTracker();
  private rejectionTracker = new RejectionTracker();
  private timer: NodeJS.Timeout | undefined;
  private firstDirtyAt = 0;
  private flushing: Promise<void> | undefined;
  private failures = 0;
  private resyncTimer: NodeJS.Timeout | undefined;
  private o: Required<WatcherOptions>;
  ready = false;
  lastFlushAt = 0;

  constructor(opts: WatcherOptions) {
    this.o = { debounceMs: 2_000, maxDelayMs: 10_000, resyncMs: 5 * 60_000, syncTimeoutMs: 60_000, ...opts };
  }

  private add(type: ResourceType) {
    const key = typeKey(type);
    if (this.informers.has(key)) return;
    const inf = new Informer(this.o.kube, type, (t, obj, i, initial) => this.onChange(t, obj, i, initial), {
      log: (msg, extra) => this.o.log('warn', msg, extra),
      onRestart: (reason) => this.o.metrics.watchRestarts.inc({ resource: key, reason }),
    });
    this.informers.set(key, inf);
    void inf.run().finally(() => {
      if (this.informers.get(key) === inf) this.informers.delete(key); // stopped (CRD removed): rediscovery may add it back
    });
  }

  /** Start informers for the types found (new Crossplane providers and Gatekeeper templates appear at runtime). */
  ensure(d: Discovered) {
    const xr = d.xr ?? FALLBACK_XR;
    this.xrKey = typeKey(xr);
    this.add(xr);
    if (d.compositions) this.add(d.compositions);
    this.compositionsKey = d.compositions && typeKey(d.compositions);
    if (d.applications) this.add(d.applications);
    this.appsKey = d.applications && typeKey(d.applications);
    for (const t of d.managed) {
      this.managedKeys.add(typeKey(t));
      this.add(t);
    }
    for (const t of d.constraints) {
      this.constraintKeys.add(typeKey(t));
      this.add(t);
    }
    this.add(EVENTS);
  }

  async start() {
    this.ensure(await discover(this.o.kube));
    this.o.log('info', 'watching', { types: [...this.informers.keys()] });
    // Wait for the first list of every type (bounded: a type that keeps failing must not hold the others back).
    const deadline = Date.now() + this.o.syncTimeoutMs;
    while (![...this.informers.values()].every((i) => i.synced) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
    const unsynced = [...this.informers.values()].filter((i) => !i.synced).map((i) => i.key);
    if (unsynced.length) this.o.log('warn', 'starting before every type was listed', { unsynced });
    this.ready = true;
    await this.flush('full');
    this.resyncTimer = setInterval(() => void this.resync(), this.o.resyncMs);
    this.resyncTimer.unref?.();
  }

  stop() {
    clearInterval(this.resyncTimer);
    clearTimeout(this.timer);
    for (const i of this.informers.values()) i.stop();
  }

  async resync() {
    try {
      this.ensure(await discover(this.o.kube));
    } catch (err) {
      this.o.log('warn', 'discovery failed', { error: (err as Error).message });
    }
    for (const i of this.informers.values()) i.resync();
    await this.flush('full');
  }

  private items(key: string | undefined) {
    return key ? (this.informers.get(key)?.items() ?? []) : [];
  }

  snapshot(): Snapshot {
    const pick = (keys: Set<string>) => [...keys].flatMap((k) => this.items(k));
    return {
      xrs: this.items(this.xrKey),
      mrs: pick(this.managedKeys),
      constraints: pick(this.constraintKeys),
      apps: this.items(this.appsKey),
      compositions: new Map(this.items(this.compositionsKey).map((c) => [c.metadata.name, c])),
    };
  }

  onChange(type: ChangeType, obj: K8sObject, inf: Informer, initial: boolean) {
    if (inf.key === typeKey(EVENTS)) return this.onEvent(type, obj as unknown as KubeEvent, initial);
    if (inf.key === this.xrKey && type === 'DELETED') {
      const g = goneStatus(obj);
      this.gone.push(g);
      this.readyTracker.observe(g);
    }
    this.schedule();
  }

  private schedule(delay = this.o.debounceMs) {
    if (!this.ready) return; // the first full flush follows the initial lists
    const t = Date.now();
    if (!this.firstDirtyAt) this.firstDirtyAt = t;
    clearTimeout(this.timer);
    const wait = Math.max(0, Math.min(delay, this.firstDirtyAt + this.o.maxDelayMs - t));
    this.timer = setTimeout(() => void this.flush('delta'), wait);
  }

  /** Recompute every service; send the ones that changed (all of them in `full` mode). */
  async flush(mode: 'full' | 'delta') {
    if (this.flushing) {
      await this.flushing;
      if (mode === 'delta') return; // the previous flush saw the latest caches, or scheduled another
    }
    clearTimeout(this.timer);
    this.timer = undefined;
    this.firstDirtyAt = 0;
    this.flushing = this.doFlush(mode).finally(() => (this.flushing = undefined));
    return this.flushing;
  }

  private async doFlush(mode: 'full' | 'delta') {
    const statuses = computeAll(this.snapshot());
    this.observe(statuses);
    const current = new Set(statuses.map((s) => s.identifier));
    const gone = this.gone.splice(0).filter((g) => !current.has(g.identifier)); // re-created since: the new XR wins
    // An unchanged service keeps its observation time: a full resync then rewrites nothing in the catalog.
    for (const s of statuses) {
      const prev = this.sent.get(s.identifier);
      if (prev && prev.fp === fingerprint(s)) s.observedAt = prev.at;
    }
    const changed = statuses.filter((s) => mode === 'full' || this.sent.get(s.identifier)?.fp !== fingerprint(s));
    const out = [...changed, ...gone];
    if (out.length) {
      try {
        await this.o.portal.send(out, mode);
        for (const s of changed) this.sent.set(s.identifier, { fp: fingerprint(s), at: s.observedAt });
        for (const g of gone) this.sent.delete(g.identifier);
        this.failures = 0;
        this.o.log('info', 'sent to the portal', { mode, services: out.length });
      } catch (err) {
        this.gone.unshift(...gone);
        this.failures++;
        this.o.log('error', 'portal delivery failed, will retry', { error: (err as Error).message, attempt: this.failures });
        this.schedule(Math.min(60_000, 1_000 * 2 ** this.failures));
        return;
      }
    }
    for (const id of [...this.sent.keys()]) if (!current.has(id)) this.sent.delete(id);
    this.lastFlushAt = Date.now();
    if (mode === 'full') this.o.metrics.lastResync.set({}, Math.floor(Date.now() / 1000));
  }

  /** SLO metrics from a fresh computation. */
  private observe(statuses: ServiceStatus[]) {
    const m = this.o.metrics;
    const byLifecycle = new Map<string, number>();
    const managed = new Map<string, { labels: Record<string, string>; n: number }>();
    const violations = new Map<string, number>();
    for (const s of statuses) {
      byLifecycle.set(s.lifecycle, (byLifecycle.get(s.lifecycle) ?? 0) + 1);
      for (const r of s.resources) {
        const labels = { provider: providerOf(r.apiVersion), kind: r.kind, state: !r.synced ? 'failing' : r.ready ? 'ready' : 'pending' };
        const k = JSON.stringify(labels);
        managed.set(k, { labels, n: (managed.get(k)?.n ?? 0) + 1 });
      }
      for (const v of s.violations) if (v.source === 'audit') violations.set(v.policy, (violations.get(v.policy) ?? 0) + 1);
      const secs = this.readyTracker.observe(s);
      if (secs !== undefined) m.timeToReady.observe({ golden_path: s.goldenPath ?? 'unknown', version: s.goldenPathVersion ?? 'unknown' }, secs);
      for (const policy of this.rejectionTracker.observe(s)) m.rejections.inc({ policy });
    }
    m.services.reset([...byLifecycle].map(([lifecycle, n]) => [{ lifecycle }, n]));
    m.managed.reset([...managed.values()].map((x) => [x.labels, x.n]));
    m.violations.reset([...violations].map(([policy, n]) => [{ policy }, n]));
  }

  // ---------- events → OTLP logs ----------
  private onEvent(type: ChangeType, e: KubeEvent, initial: boolean) {
    if (type === 'DELETED') return;
    const occ = occurrenceOf(e);
    if (initial || this.seenEvents.has(occ)) {
      this.seenEvents.add(occ); // already happened before the watcher started: the collector's own receiver has it
      return;
    }
    this.seenEvents.add(occ);
    for (const subject of this.subjectsOf(e)) {
      const isMr = subject.source === 'k8s_events' && !(groupOf(subject.object.apiVersion) === XR_GROUP && subject.object.kind === XR_KIND);
      if (isMr && e.type === 'Warning')
        this.o.metrics.reconcileErrors.inc({ provider: providerOf(subject.object.apiVersion), kind: subject.object.kind ?? '', reason: e.reason ?? '' });
      if (this.o.exporter.enabled) this.o.exporter.add(toLogRecord(e, subject));
    }
  }

  /** The cached objects an event is about (an Argo CD event also names the services its failed sync rejected). */
  subjectsOf(e: KubeEvent): Subject[] {
    const io = e.involvedObject ?? e.regarding;
    if (!io?.name || !io.kind) return [];
    const group = groupOf(io.apiVersion);
    const key = `${io.namespace ?? ''}/${io.name}`;
    const typeK = typeKey({ group, kind: io.kind });
    if (typeK === this.xrKey) {
      const xr = this.informers.get(this.xrKey)?.store.get(key);
      return xr ? [{ source: 'k8s_events', object: xr }] : [];
    }
    if (typeK === this.appsKey) {
      const app = this.informers.get(this.appsKey)?.store.get(key);
      if (!app) return [];
      const out: Subject[] = [{ source: 'argocd', object: app }];
      const xrs = this.informers.get(this.xrKey)?.store;
      for (const [svcKey, r] of rejectionsOf([app])) {
        const [namespace = '', name = ''] = svcKey.split('/');
        if (r.app !== app.metadata.name || !(e.message ?? '').includes(name)) continue;
        const existing = xrs?.get(svcKey);
        const labels = { [LABEL.service]: name, [LABEL.team]: namespace.replace(/^team-/, '') };
        out.push({
          source: 'argocd',
          object: existing ?? { apiVersion: `${XR_GROUP}/v1alpha1`, kind: XR_KIND, metadata: { name, namespace, labels } },
        });
      }
      return out; // the application record, plus one per rejected service it names (with service / team / run id)
    }
    if (this.managedKeys.has(typeK)) {
      const mr = this.informers.get(typeK)?.store.get(key);
      return mr ? [{ source: 'k8s_events', object: mr }] : [];
    }
    return [];
  }

  /** For tests and /debug: the current service statuses. */
  statuses() {
    return computeAll(this.snapshot());
  }
  identifiers() {
    return this.items(this.xrKey).map(identifierOf);
  }
}
