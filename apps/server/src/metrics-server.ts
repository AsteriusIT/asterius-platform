import Fastify from 'fastify';
import type { FastifyBaseLogger } from 'fastify';
import { registerMetricsRoute } from './metrics.js';

/** Separate listener for /metrics (METRICS_PORT): scraped through the Service, never exposed by the ingress. */
export async function startMetricsServer(log: FastifyBaseLogger, port: number) {
  const app = Fastify({ loggerInstance: log.child({ component: 'metrics' }), disableRequestLogging: true });
  registerMetricsRoute(app);
  await app.listen({ port, host: '0.0.0.0' });
  return () => app.close();
}
