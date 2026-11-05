import client from 'prom-client';
import { all } from './db.js';

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

export const metrics = {
  runFinished: (action: string, status: string, invoker: string, seconds: number | null) => {
    c.runsFinished.inc({ action, status });
    if (seconds !== null) c.runDuration.observe({ invoker }, seconds);
  },
  sync: (integration: string, status: string, upserted: number, deleted: number) => {
    c.syncs.inc({ integration, status });
    if (upserted) c.syncEntities.inc({ integration, op: 'upsert' }, upserted);
    if (deleted) c.syncEntities.inc({ integration, op: 'delete' }, deleted);
  },
  delivery: (result: 'success' | 'retry' | 'failed') => c.deliveries.inc({ result }),
  event: (type: string) => c.events.inc({ type }),
  stepFinished: (type: string, status: string) => c.steps.inc({ type, status }),
  llmTokens: (model: string, input: number, output: number) => {
    c.llmTokens.inc({ model, kind: 'input' }, input);
    c.llmTokens.inc({ model, kind: 'output' }, output);
  },
};
