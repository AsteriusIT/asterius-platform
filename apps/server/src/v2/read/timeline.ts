import type { Entity, Run } from '@asterius/shared';
import { all, json, now, one, run as exec } from '../../db.js';
import { errorMessage } from '../../lib/errors.js';
import { orgId } from '../../orgs/context.js';
import { findEntity, searchEntities } from '../../catalog/entities.js';
import { componentLogger } from '../../logger.js';
import { http } from '../../lib/http.js';
import { render } from '../../lib/expr.js';
import { getRunRow } from '../../actions/runs.js';
import { stepDefs } from '../../actions/steps.js';
import { resolverFor } from '../../actions/limits.js';
import { adoAuth } from '../../actions/invokers/ado.js';

/**
 * Run timeline (V2.md §9 "Example run page"): one ordered list of what happened for a run, merged from
 *   portal    the run itself (request, approvals, steps, end)
 *   catalog   lifecycle and managed-resource transitions of the platform-service entity (entity history, i.e. what
 *             the catalog watcher reported), from the run's start until a newer run takes over the entity
 *   loki      log records labelled run_id (Kubernetes events forwarded by the watcher, provider logs, action runner)
 *   tempo     traces tagged run_id (action runner, custom providers)
 *   ado       the Azure DevOps pipeline runs started by the run's `azure-pipeline` steps (lean path: the apply
 *             pipeline): stages, jobs and tasks of the build timeline
 * Loki and Tempo are queried on demand (LOKI_URL, TEMPO_URL; absent = skipped). Once the run and the service reached a
 * terminal state the timeline is stored in `run_timelines` and served from there.
 */

export const SERVICE_BLUEPRINT = 'platform-service';
const log = componentLogger('timeline');

export type EventStatus = 'success' | 'failure' | 'running' | 'info';
const SYMBOLS: Record<EventStatus, string> = { success: '✓', failure: '✗', running: '…', info: '·' };

export interface TimelineEvent {
  time: string;
  step: string;
  status: EventStatus;
  symbol: string;
  message?: string;
  /** portal | catalog | ado | k8s_events | provider | argocd | action-runner | tempo (the Loki `source` label when known). */
  source: string;
  traceId?: string;
}

export interface SourceReport {
  name: 'portal' | 'catalog' | 'ado' | 'loki' | 'tempo';
  status: 'ok' | 'unconfigured' | 'error';
  count: number;
  error?: string;
}

export interface Timeline {
  runId: string;
  events: TimelineEvent[];
  sources: SourceReport[];
  entity: { blueprint: string; identifier: string; lifecycle?: string } | null;
  /** The run and its service reached a terminal state: the timeline will not change anymore. */
  terminal: boolean;
  cached: boolean;
  cachedAt?: string;
}

const ev = (time: string, step: string, status: EventStatus, source: string, message?: string, extra: Partial<TimelineEvent> = {}): TimelineEvent => ({
  time,
  step,
  status,
  symbol: SYMBOLS[status],
  ...(message ? { message: message.slice(0, 1000) } : {}),
  source,
  ...extra,
});

// ---------- portal (the run) ----------
const STEP_STATUS: Record<string, EventStatus> = {
  SUCCESS: 'success',
  FAILURE: 'failure',
  CANCELLED: 'failure',
  SKIPPED: 'info',
  RUNNING: 'running',
  WAITING: 'running',
  WAITING_APPROVAL: 'running',
};

export function portalEvents(r: Run): TimelineEvent[] {
  const out: TimelineEvent[] = [ev(r.createdAt, 'Requested', 'info', 'portal', `${r.actionTitle} by ${r.triggeredBy.email || r.triggeredBy.name}`)];
  for (const a of r.approvals ?? [])
    out.push(
      ev(a.at, 'Approval', a.decision === 'approved' ? 'success' : 'failure', 'portal', `${a.decision} by ${a.userName}${a.comment ? `: ${a.comment}` : ''}`),
    );
  for (const s of r.steps ?? []) {
    for (const a of s.approvals ?? [])
      out.push(ev(a.at, `${s.name} (approval)`, a.decision === 'approved' ? 'success' : 'failure', 'portal', `${a.decision} by ${a.userName}`));
    if (s.endedAt) out.push(ev(s.endedAt, s.name, STEP_STATUS[s.status] ?? 'info', 'portal', s.statusLabel ?? undefined));
    else if (s.startedAt) out.push(ev(s.startedAt, s.name, 'running', 'portal', s.statusLabel ?? undefined));
  }
  if (r.endedAt) out.push(ev(r.endedAt, `Run ${r.status.toLowerCase()}`, r.status === 'SUCCESS' ? 'success' : 'failure', 'portal', r.statusLabel ?? undefined));
  return out;
}

// ---------- catalog (entity history) ----------
interface VersionRow {
  snapshot: string;
  at: string;
}
interface ResourceProp {
  kind?: string;
  name?: string;
  ready?: boolean;
  synced?: boolean;
  message?: string;
}

const LIFECYCLE_STATUS: Record<string, EventStatus> = {
  Ready: 'success',
  Rejected: 'failure',
  Degraded: 'failure',
  Reconciling: 'running',
  Synced: 'info',
  Committed: 'info',
  Requested: 'info',
  Deleting: 'running',
};

/**
 * Transitions recorded in the entity history: lifecycle changes and managed resources becoming ready or failing.
 * Versions written after another run took the entity over (`lastRunId` changed) are not this run's.
 */
export function catalogEvents(runId: string, versions: { at: string; properties: Record<string, unknown> }[]): TimelineEvent[] {
  const out: TimelineEvent[] = [];
  let lifecycle: unknown;
  const resources = new Map<string, string>();
  let mine = false;
  for (const v of versions) {
    const p = v.properties;
    if (p.lastRunId === runId || p.observedRunId === runId) mine = true;
    else if (mine && p.lastRunId && p.lastRunId !== runId) break; // superseded by a newer run
    if (p.lifecycle !== lifecycle && typeof p.lifecycle === 'string') {
      lifecycle = p.lifecycle;
      const admission = (Array.isArray(p.conditions) ? (p.conditions as { type?: string; message?: string }[]) : []).find((c) => c.type === 'Admission');
      const msg = lifecycle === 'Rejected' ? admission?.message : lifecycle === 'Synced' ? 'applied by Argo CD' : undefined;
      out.push(ev(v.at, p.lifecycle, LIFECYCLE_STATUS[p.lifecycle] ?? 'info', 'catalog', msg));
    }
    for (const r of Array.isArray(p.resources) ? (p.resources as ResourceProp[]) : []) {
      const key = `${r.kind}/${r.name}`;
      const state = r.synced === false ? `failing:${r.message ?? ''}` : r.ready ? 'ready' : 'pending';
      if (resources.get(key) === state) continue;
      const was = resources.get(key);
      resources.set(key, state);
      if (state === 'ready') out.push(ev(v.at, `${r.kind} ${r.name}`, 'success', 'catalog'));
      else if (state.startsWith('failing'))
        out.push(ev(v.at, `${r.kind} ${r.name}`, 'failure', 'catalog', r.message ? `${r.message} → retrying` : 'reconcile error'));
      else if (was === undefined) out.push(ev(v.at, `${r.kind} ${r.name}`, 'running', 'catalog', 'creating'));
    }
  }
  return out;
}

async function entityVersions(e: Entity, since: string) {
  const rows = await all<VersionRow>(
    'SELECT snapshot, at FROM entity_versions WHERE org_id = ? AND blueprint = ? AND entity = ? AND at >= ? ORDER BY version LIMIT 500',
    orgId(),
    e.blueprint,
    e.identifier,
    since,
  );
  return rows.map((r) => ({ at: r.at, properties: json<{ properties?: Record<string, unknown> }>(r.snapshot, {}).properties ?? {} }));
}

// ---------- Loki ----------
interface LokiResponse {
  data?: { result?: { stream?: Record<string, string>; values?: [string, string][] }[] };
}

const nsToIso = (ns: string) => new Date(Number(BigInt(ns) / 1_000_000n)).toISOString();
const isoToNs = (iso: string) => `${BigInt(Date.parse(iso)) * 1_000_000n}`;

const SUCCESS_RE = /\b(Ready|Available|Synced|Created\w*|Updated\w*|ReconcileSuccess|Succeeded|Healthy|Completed|OperationCompleted)\b/;
const FAILURE_RE = /\b(error|failed|failure|denied|cannot|invalid|Unavailable|ReconcileError|SyncFailed|Degraded)\b/i;

/** LogQL selector for a run id (quotes and backslashes escaped). */
export const runSelector = (runId: string) => `{run_id="${runId.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"}`;

export function lokiEvents(res: LokiResponse): TimelineEvent[] {
  const out: TimelineEvent[] = [];
  for (const stream of res.data?.result ?? []) {
    const l = stream.stream ?? {};
    for (const [ns, line] of stream.values ?? []) {
      let message = line;
      let level = l.detected_level ?? l.level ?? l.severity_text ?? '';
      try {
        const j = JSON.parse(line) as Record<string, unknown>;
        if (j && typeof j === 'object') {
          message = String(j.body ?? j.msg ?? j.message ?? line);
          level = String(j.level ?? j.severity ?? level);
        }
      } catch {
        // plain text line
      }
      const warn = /^(warn|warning|error|err|fatal)$/i.test(level);
      const status: EventStatus = warn || FAILURE_RE.test(message) ? 'failure' : SUCCESS_RE.test(message) ? 'success' : 'info';
      const step = l.step || l.provider || l.source || 'log';
      out.push(ev(nsToIso(ns), step, status, l.source || 'loki', message.trim(), l.trace_id ? { traceId: l.trace_id } : {}));
    }
  }
  return out;
}

// ---------- Tempo ----------
interface TempoResponse {
  traces?: { traceID: string; rootServiceName?: string; rootTraceName?: string; startTimeUnixNano?: string; durationMs?: number }[];
}

export function tempoEvents(res: TempoResponse): TimelineEvent[] {
  return (res.traces ?? [])
    .filter((t) => t.startTimeUnixNano)
    .map((t) =>
      ev(
        nsToIso(t.startTimeUnixNano!),
        t.rootTraceName || 'trace',
        'info',
        'tempo',
        `${t.rootServiceName ?? 'trace'}${t.durationMs !== undefined ? ` · ${t.durationMs} ms` : ''}`,
        { traceId: t.traceID },
      ),
    );
}

// ---------- Azure DevOps pipeline runs ----------
/** A record of `GET _apis/build/builds/{id}/timeline`. */
export interface AdoTimelineRecord {
  id?: string;
  parentId?: string | null;
  type?: string;
  name?: string;
  state?: 'pending' | 'inProgress' | 'completed';
  result?: 'succeeded' | 'succeededWithIssues' | 'failed' | 'canceled' | 'skipped' | 'abandoned' | null;
  startTime?: string | null;
  finishTime?: string | null;
  order?: number;
  issues?: { type?: string; message?: string }[] | null;
}

const ADO_TYPES = new Set(['Stage', 'Job', 'Task']);
const ADO_RESULT: Record<string, EventStatus> = {
  succeeded: 'success',
  succeededWithIssues: 'success',
  failed: 'failure',
  canceled: 'failure',
  abandoned: 'failure',
  skipped: 'info',
};

/**
 * Stages, jobs and tasks of a pipeline run as timeline events: at their end (result) or, while they run, at their
 * start. Pending and skipped records are left out; the first error of a failed record is the message.
 */
export function adoEvents(stepName: string, records: AdoTimelineRecord[]): TimelineEvent[] {
  const out: TimelineEvent[] = [];
  const sorted = [...records].sort((a, b) => Date.parse(a.startTime ?? '') - Date.parse(b.startTime ?? '') || (a.order ?? 0) - (b.order ?? 0));
  for (const r of sorted) {
    if (!r.type || !ADO_TYPES.has(r.type) || !r.startTime || r.result === 'skipped') continue;
    const done = r.state === 'completed' && !!r.finishTime;
    const status: EventStatus = done ? (ADO_RESULT[r.result ?? ''] ?? 'info') : 'running';
    const secs = done ? Math.round((Date.parse(r.finishTime!) - Date.parse(r.startTime)) / 1000) : null;
    const error = (r.issues ?? []).find((i) => i.type === 'error')?.message;
    const parts = [stepName, done ? (r.result ?? 'completed') : 'running', secs !== null && Number.isFinite(secs) ? `${secs}s` : null, error ?? null];
    out.push(ev(done ? r.finishTime! : r.startTime, `${r.type} ${r.name ?? ''}`.trim(), status, 'ado', parts.filter(Boolean).join(' · ')));
  }
  return out;
}

/** `https://dev.azure.com/<org>/<project>/_build/results?buildId=<id>` → the project API base and the build id. */
export function adoBuildOf(link: string | null | undefined): { base: string; buildId: number } | null {
  if (!link) return null;
  try {
    const u = new URL(link);
    const i = u.pathname.indexOf('/_build/');
    const id = Number(u.searchParams.get('buildId'));
    if (i < 0 || !Number.isInteger(id) || id <= 0) return null;
    return { base: `${u.origin}${u.pathname.slice(0, i)}`, buildId: id };
  } catch {
    return null;
  }
}

/** The `azure-pipeline` steps of a run that started a pipeline run (their link is the run's web page). */
async function pipelineSteps(r: Run) {
  const defs = stepDefs(await getRunRow(r.id));
  return (r.steps ?? []).flatMap((s) => {
    const def = defs.find((d) => d.id === s.id);
    if (def?.type !== 'invoke' || def.invoker.type !== 'azure-pipeline') return [];
    const build = adoBuildOf(s.link);
    return build ? [{ step: s, invoker: def.invoker as Record<string, unknown>, build }] : [];
  });
}

async function fromAdo(r: Run): Promise<{ report: SourceReport | null; events: TimelineEvent[] }> {
  let steps: Awaited<ReturnType<typeof pipelineSteps>>;
  try {
    steps = await pipelineSteps(r);
  } catch (err) {
    return { report: { name: 'ado', status: 'error', count: 0, error: errorMessage(err) }, events: [] };
  }
  if (!steps.length) return { report: null, events: [] };
  const row = await getRunRow(r.id);
  const events: TimelineEvent[] = [];
  const errors: string[] = [];
  for (const { step, invoker, build } of steps) {
    try {
      // Only the credential and the organization are needed: references are resolved with the run's allow-list.
      const v = (await render({ token: invoker.token, organization: invoker.organization }, {}, resolverFor(row))).value as {
        token?: unknown;
        organization?: unknown;
      };
      const org = typeof v.organization === 'string' ? v.organization.replace(/\/+$/, '') : '';
      // The credential only goes to the organization the step was configured with.
      if (!org || !build.base.toLowerCase().startsWith(`${org.toLowerCase()}/`))
        throw new Error(`${step.name}: the run link is not in ${org || 'the configured organization'}`);
      const res = await http<{ records?: AdoTimelineRecord[] }>(`${build.base}/_apis/build/builds/${build.buildId}/timeline?api-version=7.1`, {
        headers: typeof v.token === 'string' && v.token ? adoAuth({ token: v.token }) : {},
        timeoutMs: Number(env('TIMELINE_TIMEOUT_MS') ?? 8_000),
        retry: false,
      });
      events.push(...adoEvents(step.name, res.data?.records ?? []));
    } catch (err) {
      errors.push(errorMessage(err));
    }
  }
  return {
    report: { name: 'ado', status: errors.length ? 'error' : 'ok', count: events.length, ...(errors.length ? { error: errors.join('; ').slice(0, 500) } : {}) },
    events,
  };
}

// ---------- merge ----------
const SOURCE_ORDER = ['portal', 'catalog', 'ado', 'argocd', 'k8s_events', 'provider', 'action-runner', 'tempo'];

/** One ordered list: by time, then by source (the portal first at equal times), duplicates removed. */
export function mergeEvents(...lists: TimelineEvent[][]): TimelineEvent[] {
  const seen = new Set<string>();
  const order = (s: string) => (SOURCE_ORDER.includes(s) ? SOURCE_ORDER.indexOf(s) : SOURCE_ORDER.length);
  return lists
    .flat()
    .filter((e) => Number.isFinite(Date.parse(e.time)))
    .sort((a, b) => Date.parse(a.time) - Date.parse(b.time) || order(a.source) - order(b.source))
    .filter((e) => {
      const k = `${e.time.slice(0, 19)}|${e.step}|${e.status}|${e.message ?? ''}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .slice(0, 1000);
}

// ---------- terminal state ----------
const FINAL_RUN = ['SUCCESS', 'FAILURE', 'REJECTED', 'CANCELLED'];
/** Late log lines (collector batching) settle within this delay after the last change. */
export const SETTLE_MS = 60_000;
/** A service still Degraded this long after its last change is considered final for this run. */
export const DEGRADED_FINAL_MS = 30 * 60_000;

/**
 * The timeline can be cached when the run is finished and the service reached a terminal state for this run:
 * Ready (observed with this run id), Rejected, Degraded for DEGRADED_FINAL_MS, superseded by a newer run, or never
 * committed (the run failed before). Runs without a platform-service entity: once finished.
 */
export function isTerminal(
  r: Pick<Run, 'id' | 'status' | 'createdAt' | 'endedAt'>,
  e: Pick<Entity, 'properties' | 'updatedAt'> | null,
  at = Date.now(),
  /** Lean path: the run's own pipeline decided Ready / Degraded (no watcher will change it later). */
  pipelineDriven = false,
): boolean {
  if (!FINAL_RUN.includes(r.status)) return false;
  const ended = Date.parse(r.endedAt ?? r.createdAt);
  if (!e) return at - ended > SETTLE_MS;
  const settled = at - Math.max(ended, Date.parse(e.updatedAt)) > SETTLE_MS;
  const p = e.properties;
  const lifecycle = p.lifecycle as string | undefined;
  if (p.lastRunId && p.lastRunId !== r.id) return at - ended > SETTLE_MS; // a newer run took over
  if (lifecycle === 'Rejected') return settled;
  if (lifecycle === 'Ready') return settled && (!p.observedRunId || p.observedRunId === r.id);
  if (lifecycle === 'Degraded') return pipelineDriven ? settled : at - Date.parse(e.updatedAt) > DEGRADED_FINAL_MS;
  if (r.status !== 'SUCCESS' && (!lifecycle || lifecycle === 'Requested')) return settled; // nothing was committed
  return false;
}

// ---------- assembling ----------
const env = (name: string) => process.env[name]?.trim() || undefined;

async function getJson<T>(url: string, headers: Record<string, string> = {}): Promise<T> {
  // Operator-configured in-cluster endpoints (LOKI_URL / TEMPO_URL), not user input: no SSRF guard.
  const res = await fetch(url, {
    headers: { accept: 'application/json', ...headers },
    signal: AbortSignal.timeout(Number(env('TIMELINE_TIMEOUT_MS') ?? 8_000)),
  });
  if (!res.ok) throw new Error(`${new URL(url).host} answered ${res.status}`);
  return (await res.json()) as T;
}

async function fromLoki(runId: string, start: string, end: string) {
  const base = env('LOKI_URL');
  if (!base) return { report: { name: 'loki', status: 'unconfigured', count: 0 } as SourceReport, events: [] };
  const q = new URLSearchParams({ query: runSelector(runId), start: isoToNs(start), end: isoToNs(end), limit: '1000', direction: 'forward' });
  const tenant = env('LOKI_TENANT');
  try {
    const events = lokiEvents(
      await getJson<LokiResponse>(`${base.replace(/\/$/, '')}/loki/api/v1/query_range?${q}`, tenant ? { 'x-scope-orgid': tenant } : {}),
    );
    return { report: { name: 'loki', status: 'ok', count: events.length } as SourceReport, events };
  } catch (err) {
    return { report: { name: 'loki', status: 'error', count: 0, error: errorMessage(err) } as SourceReport, events: [] };
  }
}

async function fromTempo(runId: string, start: string, end: string) {
  const base = env('TEMPO_URL');
  if (!base) return { report: { name: 'tempo', status: 'unconfigured', count: 0 } as SourceReport, events: [] };
  const q = new URLSearchParams({
    tags: `run_id=${runId}`,
    start: String(Math.floor(Date.parse(start) / 1000)),
    end: String(Math.ceil(Date.parse(end) / 1000)),
    limit: '50',
  });
  try {
    const events = tempoEvents(await getJson<TempoResponse>(`${base.replace(/\/$/, '')}/api/search?${q}`));
    return { report: { name: 'tempo', status: 'ok', count: events.length } as SourceReport, events };
  } catch (err) {
    return { report: { name: 'tempo', status: 'error', count: 0, error: errorMessage(err) } as SourceReport, events: [] };
  }
}

/** The platform-service entity of a run: its target, else the entity whose lastRunId / observedRunId is the run. */
export async function serviceEntityOf(r: Pick<Run, 'id' | 'blueprint' | 'entity'>): Promise<Entity | null> {
  if (r.blueprint === SERVICE_BLUEPRINT && r.entity) {
    const e = await findEntity(SERVICE_BLUEPRINT, r.entity);
    if (e) return e;
  }
  for (const property of ['lastRunId', 'observedRunId']) {
    const page = await searchEntities({ blueprint: SERVICE_BLUEPRINT, filters: [{ property, op: 'eq', value: r.id }], limit: 1, offset: 0, count: false });
    if (page.items[0]) return page.items[0];
  }
  return null;
}

interface CacheRow {
  events: string;
  sources: string;
  entity: string | null;
  cached_at: string;
}

export async function cachedTimeline(runId: string): Promise<Timeline | undefined> {
  const row = await one<CacheRow>('SELECT events, sources, entity, cached_at FROM run_timelines WHERE run_id = ? AND org_id = ?', runId, orgId());
  if (!row) return undefined;
  return {
    runId,
    events: json(row.events, []),
    sources: json(row.sources, []),
    entity: json(row.entity, null),
    terminal: true,
    cached: true,
    cachedAt: row.cached_at,
  };
}

export const dropCachedTimeline = (runId: string) => exec('DELETE FROM run_timelines WHERE run_id = ? AND org_id = ?', runId, orgId());

/**
 * Build the timeline of a run the caller may see (`r` comes from getRun, which checked access). `canSeeEntity`
 * decides whether the correlated entity's history may be shown to this caller.
 */
export async function buildTimeline(r: Run, opts: { canSeeEntity: (e: Entity) => Promise<boolean>; at?: number }): Promise<Timeline> {
  const cached = await cachedTimeline(r.id);
  if (cached) {
    if (!cached.entity) return cached;
    const e = await findEntity(cached.entity.blueprint, cached.entity.identifier);
    if (!e || (await opts.canSeeEntity(e))) return cached; // deleted since (decommission): the cached history stays
    // The entity is not visible to this caller: its history is not shown.
    return {
      ...cached,
      entity: null,
      events: cached.events.filter((x) => x.source !== 'catalog'),
      sources: cached.sources.filter((x) => x.name !== 'catalog'),
    };
  }
  const at = opts.at ?? Date.now();
  const found = await serviceEntityOf(r);
  const entity = found && (await opts.canSeeEntity(found)) ? found : null;
  const start = new Date(Date.parse(r.createdAt) - 60_000).toISOString();
  const end = new Date(at + 60_000).toISOString();
  const portal = portalEvents(r);
  let catalog: TimelineEvent[] = [];
  let catalogReport: SourceReport = { name: 'catalog', status: 'ok', count: 0 };
  if (entity) {
    try {
      catalog = catalogEvents(r.id, await entityVersions(entity, r.createdAt));
      catalogReport = { name: 'catalog', status: 'ok', count: catalog.length };
    } catch (err) {
      catalogReport = { name: 'catalog', status: 'error', count: 0, error: errorMessage(err) };
    }
  }
  const [loki, tempo, ado] = await Promise.all([fromLoki(r.id, start, end), fromTempo(r.id, start, end), fromAdo(r)]);
  const sources = [
    { name: 'portal', status: 'ok', count: portal.length } as SourceReport,
    catalogReport,
    ...(ado.report ? [ado.report] : []),
    loki.report,
    tempo.report,
  ];
  const timeline: Timeline = {
    runId: r.id,
    events: mergeEvents(portal, catalog, ado.events, loki.events, tempo.events),
    sources,
    entity: entity ? { blueprint: entity.blueprint, identifier: entity.identifier, lifecycle: entity.properties.lifecycle as string | undefined } : null,
    terminal: isTerminal(r, found, at, !!ado.report),
    cached: false,
  };
  // Cache only a complete picture: terminal, every configured source answered, and the entity visible to everyone
  // who can see the run (otherwise a cached copy would leak it or lack it).
  if (timeline.terminal && sources.every((s) => s.status !== 'error') && (!found || entity)) {
    const t = now();
    await exec(
      'INSERT INTO run_timelines (run_id, org_id, events, sources, entity, cached_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (run_id) DO NOTHING',
      r.id,
      orgId(),
      JSON.stringify(timeline.events),
      JSON.stringify(timeline.sources),
      timeline.entity ? JSON.stringify(timeline.entity) : null,
      t,
    ).catch((err) => log.warn({ err, run: r.id }, 'timeline cache write failed'));
  }
  return timeline;
}
