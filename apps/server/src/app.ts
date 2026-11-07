import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import fs from 'node:fs';
import { context, SpanStatusCode, trace, type Span } from '@opentelemetry/api';
import path from 'node:path';
import { ZodError } from 'zod';
import { config } from './config.js';
import { DatabaseRateLimitStore } from './lib/rate-limit-store.js';
import { HttpError } from './lib/errors.js';
import { ready, stuckLoops } from './health.js';
import { loggerOptions } from './logger.js';
import { startRequestSpan } from './tracing.js';
import { metrics, registerMetricsRoute } from './metrics.js';
import { authRoutes } from './routes/auth.js';
import { catalogRoutes } from './routes/catalog.js';
import { actionRoutes } from './routes/actions.js';
import { integrationRoutes } from './routes/integrations.js';
import { adminRoutes } from './routes/admin.js';
import { policyRoutes } from './routes/policies.js';
import { orgRoutes } from './routes/orgs.js';
import { migrateLiteralWebhookSecrets } from './webhooks/webhooks.js';
import { openRequestContext } from './orgs/context.js';

function trustProxy(v: string): boolean | string[] | ((address: string, hop: number) => boolean) {
  const t = v.trim().toLowerCase();
  if (t === 'true') return true;
  if (t === '' || t === 'false') return false;
  if (/^\d+$/.test(t)) return (_address, hop) => hop < Number(t); // trust the last N hops
  return t
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
}
import { registerTriggerListeners } from './actions/triggers.js';
import { registerNotificationListeners } from './notifications/dispatch.js';
import { notificationRoutes } from './routes/notifications.js';
import { scimRoutes } from './auth/scim.js';
import { collectRoutes, registerOpenApi } from './openapi.js';

const VERSION = process.env.APP_VERSION ?? '0.1.0';
import { aiRoutes } from './routes/ai.js';
import { mcpRoutes } from './routes/mcp.js';

export interface AppOptions {
  reloadConfig?: (org?: string) => Promise<void>;
  logger?: boolean;
}

/** HTTP application (no listen, no background workers): used by index.ts and by tests through `inject`. */
export async function buildApp(opts: AppOptions = {}): Promise<FastifyInstance> {
  await migrateLiteralWebhookSecrets();
  registerTriggerListeners();
  registerNotificationListeners();
  const app = Fastify({
    logger: opts.logger === false ? false : loggerOptions,
    bodyLimit: 5 * 1024 * 1024,
    trustProxy: trustProxy(config.TRUST_PROXY), // behind the ingress controller: client IPs for rate limiting and lockout
  });

  // HTTP metrics: route pattern (never the raw URL) keeps label cardinality bounded.
  const SKIP = new Set(['/metrics', '/healthz', '/readyz']);
  // Tracing: one server span per request (continues an inbound traceparent); handlers and logs run inside it.
  const spans = new WeakMap<object, Span>();
  app.addHook('onRequest', (req, _reply, done) => {
    const route = req.url.split('?')[0] ?? '';
    if (SKIP.has(route)) return done();
    const span = startRequestSpan(req.method, route, req.headers);
    spans.set(req, span);
    context.with(trace.setSpan(context.active(), span), done);
  });
  app.addHook('onResponse', async (req, reply) => {
    const route = req.routeOptions.url ?? 'unmatched';
    const span = spans.get(req);
    if (span) {
      span.updateName(`${req.method} ${route}`);
      span.setAttributes({ 'http.route': route, 'http.response.status_code': reply.statusCode });
      if (reply.statusCode >= 500) span.setStatus({ code: SpanStatusCode.ERROR });
      span.end();
    }
    if (SKIP.has(route)) return;
    metrics.httpRequest(req.method, route, reply.statusCode, reply.elapsedTime / 1000);
  });

  // Keep the raw body: inbound webhooks verify HMAC signatures over the exact bytes.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    req.rawBody = body as string;
    try {
      done(null, body ? JSON.parse(body as string) : undefined);
    } catch {
      done(Object.assign(new Error('Invalid JSON body'), { statusCode: 400 }), undefined);
    }
  });

  // Organization context of the request (filled in by authentication, read by every org-scoped query).
  app.addHook('onRequest', (_req, _reply, done) => openRequestContext(done));

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ZodError)
      return reply.code(400).send({ error: err.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '), issues: err.issues });
    if (err instanceof HttpError) {
      const d = err.details as { policy?: string; message?: string } | undefined;
      // A policy denial names the policy (and its message) so clients can show why.
      return reply
        .code(err.statusCode)
        .send(err.statusCode === 403 && d?.policy ? { error: err.message, policy: d.policy, message: d.message } : { error: err.message });
    }
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    if (status >= 500) req.log.error({ err }, 'request failed');
    return reply.code(status).send({ error: status >= 500 ? 'Internal error' : (err as Error).message });
  });

  const https = config.PUBLIC_URL.startsWith('https://');
  await app.register(helmet, {
    hsts: https,
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"], // Mantine injects CSS variables at runtime
        imgSrc: ["'self'", 'data:', 'https:'],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'", 'https://login.microsoftonline.com'],
        frameAncestors: ["'none'"],
        upgradeInsecureRequests: https ? [] : null,
      },
    },
  });
  await app.register(rateLimit, {
    global: true,
    max: 600,
    timeWindow: '1 minute',
    ...(config.RATE_LIMIT_STORE === 'database' ? { store: DatabaseRateLimitStore as never } : {}),
  });

  app.get('/healthz', { config: { rateLimit: false } }, async (_req, reply) => {
    const stuck = stuckLoops(); // a worker loop that stopped iterating: let the orchestrator restart the pod
    return reply.code(stuck.length ? 503 : 200).send(stuck.length ? { ok: false, stuck } : { ok: true });
  });
  app.get('/readyz', { config: { rateLimit: false } }, async (_req, reply) => {
    const r = await ready();
    return reply.code(r.ok ? 200 : 503).send(r);
  });
  // With METRICS_PORT the endpoint lives on its own listener (metrics-server.ts), unreachable through the ingress.
  if (!config.METRICS_PORT) registerMetricsRoute(app);

  const routes = collectRoutes(app);
  await app.register(authRoutes);
  await app.register(scimRoutes);
  await app.register(orgRoutes, { reloadConfig: opts.reloadConfig ?? (async () => undefined) });
  await app.register(mcpRoutes, { prefix: '/api' }); // documented address; also under /api/v1
  await app.register(
    async (v1) => {
      await v1.register(catalogRoutes);
      await v1.register(policyRoutes);
      await v1.register(actionRoutes);
      await v1.register(integrationRoutes);
      await v1.register(notificationRoutes);
      await v1.register(aiRoutes);
      await v1.register(mcpRoutes);
      await v1.register(adminRoutes, { reloadConfig: opts.reloadConfig ?? (async () => undefined) });
    },
    { prefix: '/api/v1' },
  );

  registerOpenApi(app, routes, VERSION);

  if (config.WEB_DIST_DIR && fs.existsSync(config.WEB_DIST_DIR)) {
    await app.register(fastifyStatic, { root: path.resolve(config.WEB_DIST_DIR), wildcard: false, maxAge: '1h' });
    app.setNotFoundHandler((req, reply) =>
      req.url.startsWith('/api/') ? reply.code(404).send({ error: 'not found' }) : reply.sendFile('index.html', { maxAge: 0 }),
    );
  }
  return app;
}
