import { initTracing } from './tracing.js';
import { config, isApi, isWorker } from './config.js';

initTracing(config.PLATFORM_ROLE);

const { buildApp } = await import('./app.js');
const { closeDb } = await import('./db.js');
const { startConfigLoader } = await import('./config-loader.js');
const { startRunWorker, WORKER_ID } = await import('./actions/worker.js');
const { startSyncScheduler } = await import('./integrations/sync.js');
const { startDeliveryWorker } = await import('./webhooks/webhooks.js');
const { startMaintenance } = await import('./maintenance.js');

/**
 * Roles (PLATFORM_ROLE):
 *   all     API + workers in one process (local development, small installs)
 *   api     HTTP only: stateless, scale horizontally (HPA)
 *   worker  action runs, integration syncs, webhook deliveries, housekeeping (any number of replicas)
 * Workers still listen for /healthz, /readyz and /metrics.
 */
// reloadConfig is only called by HTTP requests, after the loader exists.
const app = await buildApp({ reloadConfig: () => loader.reload() });
const loader = await startConfigLoader(app.log);

const stops: (() => unknown)[] = [loader.stop];
if (isWorker) {
  stops.push(startRunWorker(app.log), startSyncScheduler(app.log), startDeliveryWorker(app.log), startMaintenance(app.log));
  app.log.info({ component: 'worker', workerId: WORKER_ID, concurrency: config.WORKER_CONCURRENCY }, 'worker started');
}

await app.listen({ port: config.PORT, host: '0.0.0.0' });
if (config.METRICS_PORT) {
  const { startMetricsServer } = await import('./metrics-server.js');
  stops.push(await startMetricsServer(app.log, config.METRICS_PORT));
}
app.log.info(
  { component: 'main', role: config.PLATFORM_ROLE, api: isApi, db: config.DATABASE_URL ? 'postgres' : 'sqlite', configDir: config.CONFIG_DIR },
  'Asterius Platform started',
);

// Graceful shutdown (SIGTERM from Kubernetes): stop taking work, drain HTTP, let in-flight run starts finish.
let closing = false;
for (const signal of ['SIGTERM', 'SIGINT'] as const)
  process.on(signal, async () => {
    if (closing) return;
    closing = true;
    app.log.info({ component: 'main', signal }, 'shutting down');
    await Promise.allSettled(stops.map((s) => s()));
    await app.close();
    await closeDb();
    process.exit(0);
  });
