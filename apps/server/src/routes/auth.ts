import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Meta } from '@asterius/shared';
import { config } from '../config.js';
import { one } from '../db.js';
import { audit } from '../audit.js';
import { forbidden } from '../lib/errors.js';
import {
  assertPassword,
  bearer,
  csrfFor,
  sessionCookie,
  sessionToken,
  createLocalUser,
  createSession,
  deleteSession,
  listSessions,
  revokeAllSessions,
  revokeSession,
  getUser,
  publicUser,
  requireUser,
  setTourCompleted,
  verifyPassword,
  type UserRow,
} from '../auth/users.js';
import { entraRoutes } from '../auth/entra.js';
import { clearFailures, isLocked, recordFailure } from '../auth/lockout.js';
import { oidcRoutes } from '../auth/oidc.js';
import { githubRoutes } from '../auth/github.js';
import { samlRoutes } from '../auth/saml.js';
import { effectivePermissions } from '../auth/access.js';
import { invokerInfos } from '../actions/invokers/index.js';
import { MODELS } from '../actions/models.js';
import { sourceInfos } from '../integrations/sources/index.js';

const VERSION = process.env.APP_VERSION ?? '0.1.0';

/** Password / registration sign-in result: a token for API-style clients, an httpOnly cookie in SESSION_COOKIE mode. */
async function localSession(req: FastifyRequest, reply: FastifyReply, user: UserRow) {
  const token = await createSession(user.id, { ip: req.ip, userAgent: req.headers['user-agent'] });
  if (!config.SESSION_COOKIE) return { token, user: await publicUser(user) };
  reply.header('set-cookie', sessionCookie(token));
  return { token: 'cookie', csrfToken: csrfFor(token), user: await publicUser(user) };
}

export async function authRoutes(app: FastifyInstance) {
  app.get('/api/meta', async (): Promise<Meta> => ({
    name: config.BRAND_NAME,
    logo: config.BRAND_LOGO ?? null,
    version: VERSION,
    authProviders: config.AUTH_PROVIDERS,
    ...(config.AUTH_PROVIDERS.includes('oidc') ? { oidcTitle: config.OIDC_TITLE } : {}),
    ...(config.AUTH_PROVIDERS.includes('saml') ? { samlTitle: config.SAML_TITLE } : {}),
    allowRegistration: config.AUTH_PROVIDERS.includes('local') && config.ALLOW_REGISTRATION,
    invokers: invokerInfos(),
    sources: sourceInfos(),
    models: MODELS,
    sessionCookie: config.SESSION_COOKIE,
  }));

  const rateLimit = { rateLimit: { max: 10, timeWindow: '1 minute' } };

  app.post('/api/auth/login', { config: rateLimit }, async (req, reply) => {
    if (!config.AUTH_PROVIDERS.includes('local')) throw forbidden('Password sign-in is disabled');
    const body = z.object({ email: z.string().email(), password: z.string().min(1) }).parse(req.body);
    const email = body.email.toLowerCase();
    const key = `${email}|${req.ip}`; // per account AND client: a stranger cannot lock someone else out
    if (await isLocked(key)) return reply.code(429).send({ error: 'Too many failed attempts, try again in 15 minutes' });
    const user = await one<UserRow>("SELECT * FROM users WHERE provider = 'local' AND email = ?", email);
    if (!user || !verifyPassword(body.password, user.password_hash) || user.active !== 1) {
      await recordFailure(key);
      await audit({ id: user?.id ?? null, email }, 'auth.login_failed', null, {
        ip: req.ip,
        reason: !user ? 'unknown account' : user.active === 1 ? 'bad password' : 'disabled',
      });
      return reply.code(401).send({ error: 'Invalid email or password' });
    }
    await clearFailures(key);
    await audit({ id: user.id, email: user.email }, 'auth.login', null, { provider: 'local' });
    return localSession(req, reply, user);
  });

  app.post('/api/auth/register', { config: rateLimit }, async (req, reply) => {
    if (!config.AUTH_PROVIDERS.includes('local') || !config.ALLOW_REGISTRATION) throw forbidden('Registration is disabled');
    const body = z
      .object({ email: z.string().email(), name: z.string().min(1).max(100), password: z.string(), bootstrapToken: z.string().max(200).optional() })
      .parse(req.body);
    assertPassword(body.password);
    const user = await createLocalUser(body.email, body.name, body.password, body.bootstrapToken);
    await audit({ id: user.id, email: user.email }, 'auth.registered', null, { role: user.role });
    return localSession(req, reply, user);
  });

  app.post('/api/auth/logout', async (req, reply) => {
    const token = sessionToken(req);
    if (token) await deleteSession(token);
    if (config.SESSION_COOKIE) reply.header('set-cookie', sessionCookie(null));
    return { ok: true };
  });

  app.get('/api/auth/me', { preHandler: requireUser }, async (req) => ({
    ...(await publicUser((await getUser(req.principal.id))!)),
    ...(config.SESSION_COOKIE && !bearer(req) ? { csrfToken: csrfFor(sessionToken(req)!) } : {}),
    permissions: await effectivePermissions(req.principal),
  }));
  // Sessions of the caller: list, revoke one, or sign out everywhere (keeping this one with ?others=true).
  app.get('/api/auth/sessions', { preHandler: requireUser }, async (req) => listSessions(req.principal.id, sessionToken(req)));
  app.delete('/api/auth/sessions/:id', { preHandler: requireUser }, async (req) => {
    const { id } = z.object({ id: z.string().min(8).max(64) }).parse(req.params);
    await revokeSession(req.principal.id, id);
    await audit({ id: req.principal.id, email: req.principal.email }, 'auth.session_revoked', id);
    return { ok: true };
  });
  app.post('/api/auth/sessions/revoke-all', { preHandler: requireUser }, async (req) => {
    const { others } = z.object({ others: z.boolean().default(false) }).parse(req.body ?? {});
    const revoked = await revokeAllSessions(req.principal.id, others ? sessionToken(req) : undefined);
    await audit({ id: req.principal.id, email: req.principal.email }, 'auth.sessions_revoked', null, { revoked, keptCurrent: others });
    return { revoked };
  });
  app.put('/api/auth/me/tour', { preHandler: requireUser }, async (req) => {
    const { completed } = z.object({ completed: z.boolean() }).parse(req.body);
    await setTourCompleted(req.principal.id, completed);
    return publicUser((await getUser(req.principal.id))!);
  });

  if (config.AUTH_PROVIDERS.includes('entra')) await app.register(entraRoutes);
  if (config.AUTH_PROVIDERS.includes('oidc')) await app.register(oidcRoutes);
  if (config.AUTH_PROVIDERS.includes('github')) await app.register(githubRoutes);
  if (config.AUTH_PROVIDERS.includes('saml')) await app.register(samlRoutes);
}
