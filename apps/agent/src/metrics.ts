/**
 * A minimal Prometheus registry (counters, gauges, histograms with labels) rendered in the text exposition format.
 * The watcher has no dependencies, so this replaces prom-client for the handful of series it exports.
 */

type Labels = Record<string, string>;
const keyOf = (l: Labels) => JSON.stringify(Object.entries(l).sort(([a], [b]) => a.localeCompare(b)));
const escape = (v: string) => v.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
const fmt = (l: Labels, extra: Labels = {}) => {
  const all = { ...l, ...extra };
  const parts = Object.entries(all).map(([k, v]) => `${k}="${escape(v)}"`);
  return parts.length ? `{${parts.join(',')}}` : '';
};

interface Metric {
  render(): string;
}

export class Counter implements Metric {
  private values = new Map<string, { labels: Labels; v: number }>();
  readonly name: string;
  readonly help: string;
  constructor(name: string, help: string) {
    this.name = name;
    this.help = help;
  }
  inc(labels: Labels = {}, by = 1) {
    const k = keyOf(labels);
    const cur = this.values.get(k) ?? { labels, v: 0 };
    cur.v += by;
    this.values.set(k, cur);
  }
  get(labels: Labels = {}) {
    return this.values.get(keyOf(labels))?.v ?? 0;
  }
  render() {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} counter`];
    for (const { labels, v } of this.values.values()) lines.push(`${this.name}${fmt(labels)} ${v}`);
    return lines.join('\n');
  }
}

export class Gauge implements Metric {
  private values = new Map<string, { labels: Labels; v: number }>();
  readonly name: string;
  readonly help: string;
  constructor(name: string, help: string) {
    this.name = name;
    this.help = help;
  }
  set(labels: Labels, v: number) {
    this.values.set(keyOf(labels), { labels, v });
  }
  /** Replace every series at once (gauges recomputed from a snapshot: series that vanished must go). */
  reset(entries: [Labels, number][]) {
    this.values.clear();
    for (const [l, v] of entries) this.set(l, v);
  }
  get(labels: Labels = {}) {
    return this.values.get(keyOf(labels))?.v;
  }
  render() {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} gauge`];
    for (const { labels, v } of this.values.values()) lines.push(`${this.name}${fmt(labels)} ${v}`);
    return lines.join('\n');
  }
}

export class Histogram implements Metric {
  private values = new Map<string, { labels: Labels; counts: number[]; sum: number; count: number }>();
  readonly name: string;
  readonly help: string;
  readonly buckets: number[];
  constructor(name: string, help: string, buckets: number[]) {
    this.name = name;
    this.help = help;
    this.buckets = buckets;
  }
  observe(labels: Labels, v: number) {
    const k = keyOf(labels);
    const cur = this.values.get(k) ?? { labels, counts: this.buckets.map(() => 0), sum: 0, count: 0 };
    this.buckets.forEach((b, i) => {
      if (v <= b) cur.counts[i]!++;
    });
    cur.sum += v;
    cur.count++;
    this.values.set(k, cur);
  }
  count(labels: Labels) {
    return this.values.get(keyOf(labels))?.count ?? 0;
  }
  render() {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} histogram`];
    for (const { labels, counts, sum, count } of this.values.values()) {
      this.buckets.forEach((b, i) => lines.push(`${this.name}_bucket${fmt(labels, { le: String(b) })} ${counts[i]}`));
      lines.push(`${this.name}_bucket${fmt(labels, { le: '+Inf' })} ${count}`);
      lines.push(`${this.name}_sum${fmt(labels)} ${sum}`);
      lines.push(`${this.name}_count${fmt(labels)} ${count}`);
    }
    return lines.join('\n');
  }
}

export class Registry {
  private metrics: Metric[] = [];
  register<T extends Metric>(m: T): T {
    this.metrics.push(m);
    return m;
  }
  render() {
    return `${this.metrics.map((m) => m.render()).join('\n')}\n`;
  }
}

/** The watcher's series (platform SLOs of V2.md §9). */
export function watcherMetrics() {
  const registry = new Registry();
  return {
    registry,
    timeToReady: registry.register(
      new Histogram(
        'asterius_watcher_time_to_ready_seconds',
        'Seconds from the first observation of a run id on a Service XR to the XR being Ready, by golden path and version',
        [30, 60, 120, 180, 300, 600, 900, 1800, 3600, 7200],
      ),
    ),
    reconcileErrors: registry.register(
      new Counter('asterius_watcher_reconcile_errors_total', 'Managed resources turning Synced=False and warning events about them, by provider and kind'),
    ),
    rejections: registry.register(
      new Counter('asterius_watcher_admission_rejections_total', 'Service syncs rejected by Argo CD (admission denied), by policy'),
    ),
    services: registry.register(new Gauge('asterius_watcher_services', 'Services observed in the cluster, by lifecycle')),
    managed: registry.register(new Gauge('asterius_watcher_managed_resources', 'Managed resources composed for Services, by provider, kind and state')),
    violations: registry.register(
      new Gauge('asterius_watcher_policy_violations', 'Gatekeeper audit violations on Services and their managed resources, by policy'),
    ),
    posts: registry.register(new Counter('asterius_watcher_ingest_posts_total', 'Deliveries to the portal ingest webhook, by result')),
    events: registry.register(new Counter('asterius_watcher_otlp_log_records_total', 'Kubernetes events exported as OTLP log records, by source and result')),
    watchRestarts: registry.register(new Counter('asterius_watcher_watch_restarts_total', 'Watch streams restarted, by resource and reason')),
    lastResync: registry.register(new Gauge('asterius_watcher_last_full_resync_timestamp_seconds', 'Time of the last successful full resync')),
  };
}
export type WatcherMetrics = ReturnType<typeof watcherMetrics>;

/** Provider of a managed resource from its API group (`project.azuredevops.upbound.io` → azuredevops). */
export function providerOf(apiVersion = ''): string {
  const group = apiVersion.includes('/') ? apiVersion.split('/')[0]! : '';
  const parts = group.split('.').filter((p) => p !== 'm'); // Crossplane v2 namespaced MRs: <kind>.<provider>.m.upbound.io
  if (parts.length >= 3) return parts[parts.length - 3]!;
  return parts[0] || 'core';
}
