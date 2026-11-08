import { LABEL, groupOf, type K8sObject } from './state.ts';
import { providerOf } from './metrics.ts';

/**
 * Kubernetes Events about Service XRs, their managed resources and Argo CD applications, exported as OTLP log
 * records (OTLP/HTTP JSON, `POST <endpoint>/v1/logs`). Upstream providers emit no spans and do not know the run id:
 * the watcher knows which run labelled each object, so the events it forwards carry `run_id` and the run page can
 * show provider activity (V2.md §9 "honest limits"). Attributes follow docs/V2-KIND.md "Telemetry".
 */

export interface KubeEvent {
  metadata: { name: string; namespace?: string; uid?: string; resourceVersion?: string };
  involvedObject?: { apiVersion?: string; kind?: string; name?: string; namespace?: string; uid?: string };
  regarding?: { apiVersion?: string; kind?: string; name?: string; namespace?: string; uid?: string };
  reason?: string;
  message?: string;
  note?: string;
  type?: string;
  count?: number;
  firstTimestamp?: string;
  lastTimestamp?: string;
  eventTime?: string;
  series?: { count?: number; lastObservedTime?: string };
  source?: { component?: string };
  reportingController?: string;
  reportingComponent?: string;
}

/** What an event is about, as far as the watcher's caches can tell. */
export interface Subject {
  /** k8s_events (Crossplane XR / MR), argocd (application). */
  source: 'k8s_events' | 'argocd';
  object: K8sObject;
}

export interface LogRecord {
  timeUnixNano: string;
  observedTimeUnixNano: string;
  severityNumber: number;
  severityText: string;
  body: { stringValue: string };
  attributes: { key: string; value: { stringValue: string } }[];
}

const nanos = (iso: string | undefined, fallback: number) => {
  const ms = iso ? Date.parse(iso) : NaN;
  return `${BigInt(Number.isFinite(ms) ? ms : fallback) * 1_000_000n}`;
};

/** Identity of one occurrence of an event (a repeated event bumps its count): exported once. */
export const occurrenceOf = (e: KubeEvent) => `${e.metadata.uid ?? `${e.metadata.namespace}/${e.metadata.name}`}#${e.series?.count ?? e.count ?? 1}`;

export const eventTime = (e: KubeEvent) => e.series?.lastObservedTime ?? e.lastTimestamp ?? e.eventTime ?? e.firstTimestamp;

/** One OTLP log record for an event about a known subject. */
export function toLogRecord(e: KubeEvent, subject: Subject, now = Date.now()): LogRecord {
  const o = subject.object;
  const io = e.involvedObject ?? e.regarding ?? {};
  const warning = e.type === 'Warning';
  const labels = o.metadata.labels ?? {};
  const isApp = o.kind === 'Application';
  const attrs: Record<string, string | undefined> = {
    run_id: o.metadata.annotations?.[LABEL.runId] ?? labels[LABEL.runId],
    service: isApp ? undefined : (labels[LABEL.service] ?? (o.kind === 'Service' ? o.metadata.name : undefined)),
    team: isApp ? undefined : (labels[LABEL.team] ?? (o.metadata.namespace ?? '').replace(/^team-/, '')),
    namespace: io.namespace ?? o.metadata.namespace,
    source: subject.source,
    step: io.kind ?? o.kind,
    provider: subject.source === 'argocd' ? 'argocd' : o.kind === 'Service' ? 'crossplane' : providerOf(o.apiVersion),
    'k8s.event.reason': e.reason,
    'k8s.event.type': e.type,
    'k8s.object.kind': io.kind,
    'k8s.object.name': io.name,
    'k8s.object.api_group': groupOf(io.apiVersion ?? o.apiVersion),
    'k8s.event.controller': e.reportingController ?? e.reportingComponent ?? e.source?.component,
  };
  if (attrs.team === '') attrs.team = undefined;
  return {
    timeUnixNano: nanos(eventTime(e), now),
    observedTimeUnixNano: nanos(undefined, now),
    severityNumber: warning ? 13 : 9,
    severityText: warning ? 'WARN' : 'INFO',
    body: { stringValue: `${e.reason ?? 'Event'}: ${e.message ?? e.note ?? ''}`.slice(0, 4000) },
    attributes: Object.entries(attrs)
      .filter((a): a is [string, string] => typeof a[1] === 'string' && a[1] !== '')
      .map(([key, v]) => ({ key, value: { stringValue: v } })),
  };
}

export function otlpBody(records: LogRecord[]) {
  return {
    resourceLogs: [
      {
        resource: {
          attributes: [
            { key: 'service.name', value: { stringValue: 'catalog-watcher' } },
            { key: 'k8s.namespace.name', value: { stringValue: process.env.POD_NAMESPACE ?? 'portal-agent' } },
          ],
        },
        scopeLogs: [{ scope: { name: 'asterius.catalog-watcher' }, logRecords: records }],
      },
    ],
  };
}

/** `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT` is used as is; `OTEL_EXPORTER_OTLP_ENDPOINT` gets `/v1/logs` unless it has it. */
export function logsEndpoint(env: Record<string, string | undefined>): string | undefined {
  if (env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT) return env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT;
  const base = env.OTEL_EXPORTER_OTLP_ENDPOINT?.replace(/\/$/, '');
  if (!base) return undefined;
  return base.endsWith('/v1/logs') ? base : `${base}/v1/logs`;
}

/** Buffers records and ships them in batches (best effort: telemetry never blocks the catalog feed). */
export class OtlpExporter {
  private buffer: LogRecord[] = [];
  private timer: NodeJS.Timeout | undefined;
  private endpoint: string | undefined;
  private onResult: (ok: boolean, n: number) => void;
  private f: typeof fetch;
  private flushMs: number;
  private maxBuffer: number;
  constructor(
    endpoint: string | undefined,
    onResult: (ok: boolean, n: number) => void = () => undefined,
    f: typeof fetch = fetch,
    flushMs = 2_000,
    maxBuffer = 5_000,
  ) {
    this.endpoint = endpoint;
    this.onResult = onResult;
    this.f = f;
    this.flushMs = flushMs;
    this.maxBuffer = maxBuffer;
  }
  get enabled() {
    return !!this.endpoint;
  }
  add(r: LogRecord) {
    if (!this.endpoint) return;
    if (this.buffer.length >= this.maxBuffer) this.buffer.shift(); // collector down: keep the newest
    this.buffer.push(r);
    if (this.buffer.length >= 200) void this.flush();
    else this.timer ??= setTimeout(() => void this.flush(), this.flushMs);
  }
  async flush() {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.endpoint || !this.buffer.length) return;
    const records = this.buffer.splice(0, this.buffer.length);
    try {
      const res = await this.f(this.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(otlpBody(records)),
        signal: AbortSignal.timeout(10_000),
      });
      this.onResult(res.ok, records.length);
    } catch {
      this.onResult(false, records.length);
    }
  }
}
