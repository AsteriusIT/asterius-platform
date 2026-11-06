import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import fs from 'node:fs';
import { timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { ZodError } from 'zod';
import { config } from './config.js';
import { DatabaseRateLimitStore } from './lib/rate-limit-store.js';
import { HttpError } from './lib/errors.js';
import { ready, stuckLoops } from './health.js';
import { registry } from './metrics.js';
import { authRoutes } from './routes/auth.js';
import { catalogRoutes } from './routes/catalog.js';
import { actionRoutes } from './routes/actions.js';
import { integrationRoutes } from './routes/integrations.js';
import { adminRoutes } from './routes/admin.js';
import { migrateLiteralWebhookSecrets } from './webhooks/webhooks.js';

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

export interface AppOptions {
  reloadConfig?: () => Promise<void>;
  logger?: boolean;
}

/** HTTP application (no listen, no background workers): used by index.ts and by tests through `inject`. */
export async function buildApp(opts: AppOptions = {}): Promise<FastifyInstance> {
  await migrateLiteralWebhookSecrets();
  registerTriggerListeners();
  registerNotificationListeners();
  const app = Fastify({
    logger: opts.logger === false ? false : { level: config.LOG_LEVEL, redact: ['req.headers.authorization', 'req.headers["x-asterius-token"]'] },
    bodyLimit: 5 * 1024 * 1024,
    trustProxy: trustProxy(config.TRUST_PROXY), // behind the ingress controller: client IPs for rate limiting and lockout
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
  app.get('/metrics', { config: { rateLimit: false } }, async (req, reply) => {
    if (config.METRICS_TOKEN) {
      const got = Buffer.from(req.headers.authorization ?? '');
      const want = Buffer.from(`Bearer ${config.METRICS_TOKEN}`);
      if (got.length !== want.length || !timingSafeEqual(got, want)) return reply.code(401).send({ error: 'unauthorized' });
    } else if (req.headers['x-forwarded-for'] || req.headers.forwarded || req.headers['x-real-ip']) {
      // No token configured: scrapers inside the cluster reach the pod directly; anything that came through the ingress is refused.
      return reply.code(404).send({ error: 'not found' });
    }
    return reply.type(registry.contentType).send(await registry.metrics());
  });

  await app.register(authRoutes);
  await app.register(
    async (v1) => {
      await v1.register(catalogRoutes);
      await v1.register(actionRoutes);
      await v1.register(integrationRoutes);
      await v1.register(notificationRoutes);
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
