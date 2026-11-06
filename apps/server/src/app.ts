import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import fs from 'node:fs';
import { context, SpanStatusCode, trace, type Span } from '@opentelemetry/api';
import path from 'node:path';
import { ZodError } from 'zod';
import { config } from './config.js';
import { HttpError } from './lib/errors.js';
import { ready } from './health.js';
import { loggerOptions } from './logger.js';
import { startRequestSpan } from './tracing.js';
import { metrics, registry } from './metrics.js';
import { authRoutes } from './routes/auth.js';
import { catalogRoutes } from './routes/catalog.js';
import { actionRoutes } from './routes/actions.js';
import { integrationRoutes } from './routes/integrations.js';
import { adminRoutes } from './routes/admin.js';

export interface AppOptions {
  reloadConfig?: () => Promise<void>;
  logger?: boolean;
}

/** HTTP application (no listen, no background workers): used by index.ts and by tests through `inject`. */
export async function buildApp(opts: AppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.logger === false ? false : loggerOptions,
    bodyLimit: 5 * 1024 * 1024,
    trustProxy: true, // behind the ingress controller: client IPs for rate limiting
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

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ZodError)
      return reply.code(400).send({ error: err.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '), issues: err.issues });
    if (err instanceof HttpError) return reply.code(err.statusCode).send({ error: err.message });
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
  await app.register(rateLimit, { global: true, max: 600, timeWindow: '1 minute' });

  app.get('/healthz', { config: { rateLimit: false } }, async () => ({ ok: true }));
  app.get('/readyz', { config: { rateLimit: false } }, async (_req, reply) => {
    const r = await ready();
    return reply.code(r.ok ? 200 : 503).send(r);
  });
  app.get('/metrics', { config: { rateLimit: false } }, async (req, reply) => {
    if (config.METRICS_TOKEN && req.headers.authorization !== `Bearer ${config.METRICS_TOKEN}`) return reply.code(401).send({ error: 'unauthorized' });
    return reply.type(registry.contentType).send(await registry.metrics());
  });

  await app.register(authRoutes);
  await app.register(
    async (v1) => {
      await v1.register(catalogRoutes);
      await v1.register(actionRoutes);
      await v1.register(integrationRoutes);
      await v1.register(adminRoutes, { reloadConfig: opts.reloadConfig ?? (async () => undefined) });
    },
    { prefix: '/api/v1' },
  );

  if (config.WEB_DIST_DIR && fs.existsSync(config.WEB_DIST_DIR)) {
    await app.register(fastifyStatic, { root: path.resolve(config.WEB_DIST_DIR), wildcard: false, maxAge: '1h' });
    app.setNotFoundHandler((req, reply) =>
      req.url.startsWith('/api/') ? reply.code(404).send({ error: 'not found' }) : reply.sendFile('index.html', { maxAge: 0 }),
    );
  }
  return app;
}
