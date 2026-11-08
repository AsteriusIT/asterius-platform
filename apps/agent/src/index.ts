import http from 'node:http';
import { Kube, kubeConfig } from './kube.ts';
import { watcherMetrics } from './metrics.ts';
import { logsEndpoint, OtlpExporter } from './otlp.ts';
import { portalClient } from './portal.ts';
import { Watcher, type Log } from './watcher.ts';

/**
 * Catalog watcher (docs/V2-READ-SIDE.md). Environment:
 *   PORTAL_URL                    portal base URL (http://asterius-platform.asterius-platform.svc:8080)
 *   CROSSPLANE_WATCHER_SECRET     HMAC secret shared with the portal integration `crossplane-watcher`
 *   PORTAL_ORG                    organization slug (default: the default organization's /ingest/<integration> route)
 *   OTEL_EXPORTER_OTLP_ENDPOINT   OTLP/HTTP collector (…:4318, `/v1/logs` appended); unset: no event export
 *   RESYNC_MINUTES (5) · DEBOUNCE_MS (2000) · MAX_DELAY_MS (10000) · METRICS_PORT (9464)
 *   KUBE_API_URL / KUBE_TOKEN     outside a cluster only (e.g. kubectl proxy)
 */

const env = process.env;
const level = { info: 1, warn: 2, error: 3 } as const;
const minLevel = level[(env.LOG_LEVEL as keyof typeof level) ?? 'info'] ?? 1;
const log: Log = (lvl, msg, extra = {}) => {
  if (level[lvl] < minLevel) return;
  process.stdout.write(`${JSON.stringify({ time: new Date().toISOString(), level: lvl, component: 'catalog-watcher', msg, ...extra })}\n`);
};

function required(name: string) {
  const v = env[name];
  if (!v) {
    log('error', `${name} is required`);
    process.exit(2);
  }
  return v;
}

const num = (name: string, def: number) => {
  const n = Number(env[name]);
  return Number.isFinite(n) && n > 0 ? n : def;
};

const metrics = watcherMetrics();
const portal = portalClient({
  url: required('PORTAL_URL'),
  secret: required('CROSSPLANE_WATCHER_SECRET'),
  org: env.PORTAL_ORG || undefined,
  onResult: (ok, status) => metrics.posts.inc({ result: ok ? 'success' : status ? `http_${status}` : 'network_error' }),
});
const exporter = new OtlpExporter(logsEndpoint(env), (ok, n) => metrics.events.inc({ result: ok ? 'success' : 'failure' }, n));
if (!exporter.enabled) log('warn', 'OTEL_EXPORTER_OTLP_ENDPOINT is not set: Kubernetes events are not exported');
if (env.KUBERNETES_SERVICE_HOST && !env.NODE_EXTRA_CA_CERTS && !env.KUBE_API_URL)
  log('warn', 'NODE_EXTRA_CA_CERTS is not set: the API server certificate will not be trusted (set it to the ServiceAccount ca.crt)');

const watcher = new Watcher({
  kube: new Kube(kubeConfig(env)),
  portal,
  exporter,
  metrics,
  log,
  debounceMs: num('DEBOUNCE_MS', 2_000),
  maxDelayMs: num('MAX_DELAY_MS', 10_000),
  resyncMs: num('RESYNC_MINUTES', 5) * 60_000,
});

const server = http.createServer((req, res) => {
  const url = (req.url ?? '/').split('?')[0];
  if (url === '/metrics') {
    res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' });
    res.end(metrics.registry.render());
  } else if (url === '/healthz') {
    res.writeHead(200).end('ok');
  } else if (url === '/readyz') {
    res.writeHead(watcher.ready ? 200 : 503).end(watcher.ready ? 'ready' : 'syncing');
  } else res.writeHead(404).end();
});
server.listen(num('METRICS_PORT', 9464), () => log('info', 'metrics listening', { port: num('METRICS_PORT', 9464) }));

const shutdown = () => {
  log('info', 'shutting down');
  watcher.stop();
  void exporter.flush().finally(() => server.close(() => process.exit(0)));
  setTimeout(() => process.exit(0), 5_000).unref();
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

watcher.start().catch((err) => {
  log('error', 'start failed', { error: (err as Error).message });
  process.exit(1);
});
