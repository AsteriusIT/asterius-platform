import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Meta } from '@asterius/shared';
import { config } from '../config.js';
import { one } from '../db.js';
import { audit } from '../audit.js';
import { forbidden } from '../lib/errors.js';
import {
  assertPassword,
  bearer,
  createLocalUser,
  createSession,
  deleteSession,
  getUser,
  publicUser,
  requireUser,
  setTourCompleted,
  verifyPassword,
  type UserRow,
} from '../auth/users.js';
import { clearFailures, isLocked, recordFailure } from '../auth/lockout.js';
import { entraRoutes } from '../auth/entra.js';
import { invokerInfos } from '../actions/invokers/index.js';
import { sourceInfos } from '../integrations/sources/index.js';

const VERSION = process.env.APP_VERSION ?? '0.1.0';

export async function authRoutes(app: FastifyInstance) {
  app.get('/api/meta', async (): Promise<Meta> => ({
    name: 'Asterius Platform',
    version: VERSION,
    authProviders: config.AUTH_PROVIDERS,
    allowRegistration: config.AUTH_PROVIDERS.includes('local') && config.ALLOW_REGISTRATION,
    invokers: invokerInfos(),
    sources: sourceInfos(),
  }));

  const rateLimit = { rateLimit: { max: 10, timeWindow: '1 minute' } };

  app.post('/api/auth/login', { config: rateLimit }, async (req, reply) => {
    if (!config.AUTH_PROVIDERS.includes('local')) throw forbidden('Password sign-in is disabled');
    const body = z.object({ email: z.string().email(), password: z.string().min(1) }).parse(req.body);
    const email = body.email.toLowerCase();
    if (await isLocked(email)) return reply.code(429).send({ error: 'Too many failed attempts, try again in 15 minutes' });
    const user = await one<UserRow>("SELECT * FROM users WHERE provider = 'local' AND email = ?", email);
    if (!user || !verifyPassword(body.password, user.password_hash) || user.active !== 1) {
      await recordFailure(email);
      return reply.code(401).send({ error: 'Invalid email or password' });
    }
    await clearFailures(email);
    await audit({ id: user.id, email: user.email }, 'auth.login', null, { provider: 'local' });
    return { token: await createSession(user.id), user: await publicUser(user) };
  });

  app.post('/api/auth/register', { config: rateLimit }, async (req) => {
    if (!config.AUTH_PROVIDERS.includes('local') || !config.ALLOW_REGISTRATION) throw forbidden('Registration is disabled');
    const body = z.object({ email: z.string().email(), name: z.string().min(1).max(100), password: z.string() }).parse(req.body);
    assertPassword(body.password);
    const user = await createLocalUser(body.email, body.name, body.password);
    await audit({ id: user.id, email: user.email }, 'auth.registered', null, { role: user.role });
    return { token: await createSession(user.id), user: await publicUser(user) };
  });

  app.post('/api/auth/logout', async (req) => {
    const token = bearer(req);
    if (token) await deleteSession(token);
    return { ok: true };
  });

  app.get('/api/auth/me', { preHandler: requireUser }, async (req) => publicUser((await getUser(req.principal.id))!));
  app.put('/api/auth/me/tour', { preHandler: requireUser }, async (req) => {
    const { completed } = z.object({ completed: z.boolean() }).parse(req.body);
    await setTourCompleted(req.principal.id, completed);
    return publicUser((await getUser(req.principal.id))!);
  });

  if (config.AUTH_PROVIDERS.includes('entra')) await app.register(entraRoutes);
}
