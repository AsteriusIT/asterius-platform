import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import client from 'prom-client';
import { config } from './config.js';
import { all, poolStats } from './db.js';

/**
 * Prometheus metrics (/metrics). Counters are per process (sum across pods); the gauges prefixed with
 * `asterius_queue_` are read from the database at scrape time and are cluster-wide (use max()).
 */
export const registry = new client.Registry();
client.collectDefaultMetrics({ register: registry, prefix: 'asterius_process_' });

const c = {
  runsFinished: new client.Counter({
    name: 'asterius_runs_finished_total',
    help: 'Action runs finished, by action and status',
    labelNames: ['action', 'status'],
    registers: [registry],
  }),
  runDuration: new client.Histogram({
    name: 'asterius_run_duration_seconds',
    help: 'Duration of action runs from start to end',
    labelNames: ['invoker'],
    buckets: [1, 5, 15, 60, 300, 900, 1800, 3600, 4 * 3600],
    registers: [registry],
  }),
  auditFailures: new client.Counter({
    name: 'asterius_audit_write_failures_total',
    help: 'Audit entries that could not be written (retried in memory)',
    registers: [registry],
  }),
  syncs: new client.Counter({
    name: 'asterius_syncs_total',
    help: 'Integration syncs, by integration and status',
    labelNames: ['integration', 'status'],
    registers: [registry],
  }),
  syncEntities: new client.Counter({
    name: 'asterius_sync_entities_total',
    help: 'Entities written or deleted by syncs',
    labelNames: ['integration', 'op'],
    registers: [registry],
  }),
  deliveries: new client.Counter({
    name: 'asterius_webhook_deliveries_total',
    help: 'Outbound webhook delivery attempts, by result',
    labelNames: ['result'],
    registers: [registry],
  }),
  steps: new client.Counter({
    name: 'asterius_workflow_steps_finished_total',
    help: 'Workflow steps finished, by step type and status',
    labelNames: ['type', 'status'],
    registers: [registry],
  }),
  llmTokens: new client.Counter({
    name: 'asterius_llm_tokens_total',
    help: 'Claude tokens used by agent steps, by model and direction',
    labelNames: ['model', 'kind'],
    registers: [registry],
  }),
  purged: new client.Counter({
    name: 'asterius_retention_purged_total',
    help: 'Rows removed or expired by the retention job, by table',
    labelNames: ['table'],
    registers: [registry],
  }),
  httpRetries: new client.Counter({
    name: 'asterius_http_retries_total',
    help: 'Outbound HTTP retries, by upstream host and reason',
    labelNames: ['host', 'reason'],
    registers: [registry],
  }),
  httpRateLimitWait: new client.Counter({
    name: 'asterius_http_rate_limit_wait_seconds_total',
    help: 'Seconds spent waiting for upstream rate limits (Retry-After / X-RateLimit-Reset)',
    labelNames: ['host'],
    registers: [registry],
  }),
  httpCircuitOpened: new client.Counter({
    name: 'asterius_http_circuit_opened_total',
    help: 'Times the circuit of an integration was opened after repeated upstream failures',
    labelNames: ['circuit'],
    registers: [registry],
  }),
  httpRequests: new client.Histogram({
    name: 'asterius_http_request_duration_seconds',
    help: 'Inbound HTTP request duration, by method, route pattern and status code (rate = _count)',
    labelNames: ['method', 'route', 'status'],
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    registers: [registry],
  }),
  syncDuration: new client.Histogram({
    name: 'asterius_sync_duration_seconds',
    help: 'Duration of integration syncs, by integration',
    labelNames: ['integration'],
    buckets: [1, 5, 15, 60, 300, 900, 1800, 3600],
    registers: [registry],
  }),
  deliveryLatency: new client.Histogram({
    name: 'asterius_webhook_delivery_latency_seconds',
    help: 'Time from event creation to successful webhook delivery',
    buckets: [0.1, 0.5, 1, 5, 30, 120, 600, 3600, 6 * 3600],
    registers: [registry],
  }),
  upstream: new client.Counter({
    name: 'asterius_upstream_responses_total',
    help: 'Outbound HTTP responses from invokers, sources and webhooks, by host and status class',
    labelNames: ['host', 'class'],
    registers: [registry],
  }),
  upstreamRateLimited: new client.Counter({
    name: 'asterius_upstream_rate_limited_total',
    help: 'Outbound HTTP calls answered 429 Too Many Requests, by upstream host',
    labelNames: ['host'],
    registers: [registry],
  }),
  slaBreaches: new client.Counter({
    name: 'asterius_sla_breaches_total',
    help: 'Runs and steps still not finished after their SLA (slaMinutes), by kind (run | step) and action',
    labelNames: ['kind', 'action'],
    registers: [registry],
  }),
  events: new client.Counter({ name: 'asterius_events_total', help: 'Domain events emitted', labelNames: ['type'], registers: [registry] }),
};

new client.Gauge({
  name: 'asterius_queue_runs',
  help: 'Action runs by non-final status (cluster-wide)',
  labelNames: ['status'],
  registers: [registry],
  async collect() {
    this.reset();
    for (const s of ['PENDING_APPROVAL', 'QUEUED', 'IN_PROGRESS']) this.set({ status: s }, 0);
    for (const r of await all<{ status: string; n: number }>(
      "SELECT status, count(*) AS n FROM runs WHERE status IN ('PENDING_APPROVAL', 'QUEUED', 'IN_PROGRESS') GROUP BY status",
    ))
      this.set({ status: r.status }, Number(r.n));
  },
});
new client.Gauge({
  name: 'asterius_queue_deliveries_pending',
  help: 'Outbound webhook deliveries waiting (cluster-wide)',
  registers: [registry],
  async collect() {
    const [r] = await all<{ n: number }>("SELECT count(*) AS n FROM deliveries WHERE status = 'pending'");
    this.set(Number(r?.n ?? 0));
  },
});
new client.Gauge({
  name: 'asterius_queue_oldest_run_age_seconds',
  help: 'Age of the oldest QUEUED action run, 0 when none (cluster-wide): workers are not keeping up',
  registers: [registry],
  async collect() {
    const [r] = await all<{ at: string | null }>("SELECT min(created_at) AS at FROM runs WHERE status = 'QUEUED'");
    this.set(r?.at ? Math.max(0, (Date.now() - Date.parse(r.at)) / 1000) : 0);
  },
});
new client.Gauge({
  name: 'asterius_queue_oldest_delivery_age_seconds',
  help: 'Age of the oldest pending webhook delivery that is due now, 0 when none (cluster-wide)',
  registers: [registry],
  async collect() {
    const [r] = await all<{ at: string | null }>(
      "SELECT min(next_attempt_at) AS at FROM deliveries WHERE status = 'pending' AND next_attempt_at <= ?",
      new Date().toISOString(),
    );
    this.set(r?.at ? Math.max(0, (Date.now() - Date.parse(r.at)) / 1000) : 0);
  },
});
const loopTicks = new client.Gauge({
  name: 'asterius_worker_loop_last_success_timestamp_seconds',
  help: 'Unix time of the last successful iteration of each worker loop in this process (runs, deliveries, syncs)',
  labelNames: ['loop'],
  registers: [registry],
});
new client.Gauge({
  name: 'asterius_catalog_entities',
  help: 'Catalog entities by blueprint (cluster-wide)',
  labelNames: ['blueprint'],
  registers: [registry],
  async collect() {
    this.reset();
    for (const r of await all<{ blueprint: string; n: number }>('SELECT blueprint, count(*) AS n FROM entities GROUP BY blueprint'))
      this.set({ blueprint: r.blueprint }, Number(r.n));
  },
});

new client.Gauge({
  name: 'asterius_integration_last_success_timestamp_seconds',
  help: 'Unix time of the last successful sync per integration (cluster-wide; alert on time() - value)',
  labelNames: ['integration'],
  registers: [registry],
  async collect() {
    this.reset();
    for (const r of await all<{ integration: string; at: string }>(
      "SELECT integration, max(ended_at) AS at FROM sync_runs WHERE status = 'success' AND trigger <> 'webhook' GROUP BY integration",
    ))
      if (r.at) this.set({ integration: r.integration }, Date.parse(r.at) / 1000);
  },
});
const poolGauge = (name: string, help: string, key: 'total' | 'idle' | 'waiting') =>
  new client.Gauge({
    name,
    help,
    registers: [registry],
    collect() {
      this.set(poolStats()?.[key] ?? 0);
    },
  });
poolGauge('asterius_db_pool_connections', 'Open connections in this process pool (0 on SQLite)', 'total');
poolGauge('asterius_db_pool_idle_connections', 'Idle connections in this process pool', 'idle');
poolGauge('asterius_db_pool_waiting_requests', 'Queries waiting for a free pool connection (saturation signal)', 'waiting');

export const metrics = {
  loopTick: (loop: string) => loopTicks.set({ loop }, Date.now() / 1000),
  httpRequest: (method: string, route: string, status: number, seconds: number) => c.httpRequests.observe({ method, route, status: String(status) }, seconds),
  deliveryLatency: (seconds: number) => c.deliveryLatency.observe(seconds),
  upstream: (host: string, status: number) => {
    c.upstream.inc({ host, class: `${Math.floor(status / 100)}xx` });
    if (status === 429) c.upstreamRateLimited.inc({ host });
  },
  runFinished: (action: string, status: string, invoker: string, seconds: number | null) => {
    c.runsFinished.inc({ action, status });
    if (seconds !== null) c.runDuration.observe({ invoker }, seconds);
  },
  sync: (integration: string, status: string, upserted: number, deleted: number, seconds?: number) => {
    if (seconds !== undefined) c.syncDuration.observe({ integration }, seconds);
    c.syncs.inc({ integration, status });
    if (upserted) c.syncEntities.inc({ integration, op: 'upsert' }, upserted);
    if (deleted) c.syncEntities.inc({ integration, op: 'delete' }, deleted);
  },
  auditFailure: () => c.auditFailures.inc(),
  delivery: (result: 'success' | 'retry' | 'failed') => c.deliveries.inc({ result }),
  purged: (table: string, rows: number) => rows && c.purged.inc({ table }, rows),
  httpRetry: (host: string, reason: string) => c.httpRetries.inc({ host, reason }),
  httpRateLimitWait: (host: string, seconds: number) => c.httpRateLimitWait.inc({ host }, seconds),
  httpCircuitOpened: (circuit: string) => c.httpCircuitOpened.inc({ circuit }),
  event: (type: string) => c.events.inc({ type }),
  stepFinished: (type: string, status: string) => c.steps.inc({ type, status }),
  slaBreached: (kind: 'run' | 'step', action: string) => c.slaBreaches.inc({ kind, action }),
  llmTokens: (model: string, input: number, output: number) => {
    c.llmTokens.inc({ model, kind: 'input' }, input);
    c.llmTokens.inc({ model, kind: 'output' }, output);
  },
};

/**
 * GET /metrics (Prometheus text format). With METRICS_TOKEN a bearer token is required (compared in constant time).
 * Without one, the endpoint on the public listener refuses requests that came through the ingress (forwarding headers);
 * the dedicated METRICS_PORT listener (`dedicated`) is never exposed by the ingress and needs no such check.
 */
export function registerMetricsRoute(app: FastifyInstance, dedicated = false) {
  app.get('/metrics', { config: { rateLimit: false } }, async (req, reply) => {
    if (config.METRICS_TOKEN) {
      const got = Buffer.from(req.headers.authorization ?? '');
      const want = Buffer.from(`Bearer ${config.METRICS_TOKEN}`);
      if (got.length !== want.length || !timingSafeEqual(got, want)) return reply.code(401).send({ error: 'unauthorized' });
    } else if (!dedicated && (req.headers['x-forwarded-for'] || req.headers.forwarded || req.headers['x-real-ip'])) {
      return reply.code(404).send({ error: 'not found' });
    }
    return reply.type(registry.contentType).send(await registry.metrics());
  });
}
