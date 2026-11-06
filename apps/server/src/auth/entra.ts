import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { config } from '../config.js';
import { one, run } from '../db.js';
import { createSession, upsertEntraUser } from './users.js';
import { audit } from '../audit.js';

/**
 * Microsoft Entra ID sign-in: OpenID Connect authorization-code flow with PKCE, confidential client.
 * Tokens from Microsoft never reach the browser; the browser only receives a platform session token.
 */

const b64url = (buf: Buffer) => buf.toString('base64url');
const authority = () => `https://login.microsoftonline.com/${config.ENTRA_TENANT_ID}`;
const redirectUri = () => config.ENTRA_REDIRECT_URI ?? `${config.PUBLIC_URL.replace(/\/$/, '')}/api/auth/entra/callback`;

let jwks: ReturnType<typeof createRemoteJWKSet> | undefined;
const keys = () => (jwks ??= createRemoteJWKSet(new URL(`${authority()}/discovery/v2.0/keys`)));

/** Only same-origin relative paths, to avoid open redirects. */
function safeReturnTo(v: unknown) {
  return typeof v === 'string' && v.startsWith('/') && !v.startsWith('//') && !v.startsWith('/api/') ? v.slice(0, 500) : '/';
}

function fail(message: string) {
  return `${config.PUBLIC_URL.replace(/\/$/, '')}/login?error=${encodeURIComponent(message)}`;
}

/** Verify a Microsoft ID token (signature, issuer, audience, nonce, tenant) and extract the identity. */
export async function checkIdToken(idToken: string, nonce: string, keySet: JWTVerifyGetKey) {
  const { payload } = await jwtVerify(idToken, keySet, { issuer: `${authority()}/v2.0`, audience: config.ENTRA_CLIENT_ID });
  if (payload.nonce !== nonce) throw new Error('nonce mismatch');
  if (payload.tid !== config.ENTRA_TENANT_ID) throw new Error('wrong tenant');
  const oid = String(payload.oid ?? '');
  if (!oid) throw new Error('missing oid claim');
  const email = String(payload.email ?? payload.preferred_username ?? '').toLowerCase();
  // `groups` is present when the app registration emits group claims (scripts/entra-app.sh sets SecurityGroup):
  // they map to teams (teams.entraGroupId) and to the admin role (ENTRA_ADMIN_GROUPS).
  const groups = Array.isArray(payload.groups) ? payload.groups.map(String) : [];
  return { externalId: `${payload.tid}:${oid}`, email, name: String(payload.name || email || 'User'), groups };
}

export async function entraRoutes(app: FastifyInstance) {
  app.get('/api/auth/entra/login', async (req, reply) => {
    const state = b64url(randomBytes(24));
    const nonce = b64url(randomBytes(24));
    const verifier = b64url(randomBytes(48));
    const challenge = b64url(createHash('sha256').update(verifier).digest());
    await run('DELETE FROM oauth_states WHERE expires_at < ?', new Date().toISOString());
    await run(
      'INSERT INTO oauth_states (state, nonce, code_verifier, return_to, expires_at) VALUES (?, ?, ?, ?, ?)',
      state,
      nonce,
      verifier,
      safeReturnTo((req.query as { returnTo?: string }).returnTo),
      new Date(Date.now() + 10 * 60_000).toISOString(),
    );
    const params = new URLSearchParams({
      client_id: config.ENTRA_CLIENT_ID!,
      response_type: 'code',
      redirect_uri: redirectUri(),
      response_mode: 'query',
      scope: 'openid profile email',
      state,
      nonce,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      prompt: 'select_account',
    });
    return reply.redirect(`${authority()}/oauth2/v2.0/authorize?${params}`);
  });

  app.get('/api/auth/entra/callback', async (req, reply) => {
    const q = req.query as { code?: string; state?: string; error?: string; error_description?: string };
    if (q.error) return reply.redirect(fail(q.error_description?.split('\n')[0] ?? q.error));
    if (!q.code || !q.state) return reply.redirect(fail('Invalid sign-in response'));

    const st = await one<{ nonce: string; code_verifier: string; return_to: string; expires_at: string }>(
      'SELECT * FROM oauth_states WHERE state = ?',
      q.state,
    );
    await run('DELETE FROM oauth_states WHERE state = ?', q.state); // single use
    if (!st || st.expires_at < new Date().toISOString()) return reply.redirect(fail('Your sign-in expired, please try again'));

    try {
      const res = await fetch(`${authority()}/oauth2/v2.0/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: config.ENTRA_CLIENT_ID!,
          client_secret: config.ENTRA_CLIENT_SECRET!,
          grant_type: 'authorization_code',
          code: q.code,
          redirect_uri: redirectUri(),
          code_verifier: st.code_verifier,
          scope: 'openid profile email',
        }),
      });
      const tokens = (await res.json()) as { id_token?: string; error?: string; error_description?: string };
      if (!res.ok || !tokens.id_token) throw new Error(tokens.error_description?.split('\n')[0] ?? tokens.error ?? `token endpoint ${res.status}`);

      const { externalId, email, name, groups } = await checkIdToken(tokens.id_token, st.nonce, keys());

      const user = await upsertEntraUser({ externalId, email, name, groups });
      if (user.active !== 1) return reply.redirect(fail('Your account is disabled'));
      await audit({ id: user.id, email: user.email }, 'auth.login', null, { provider: 'entra' });

      const token = await createSession(user.id, { ip: req.ip, userAgent: req.headers['user-agent'] });
      // Fragment: never sent to servers or written to access logs.
      const hash = new URLSearchParams({ token, returnTo: st.return_to });
      return reply.redirect(`${config.PUBLIC_URL.replace(/\/$/, '')}/auth/callback#${hash}`);
    } catch (err) {
      req.log.warn({ err }, 'entra sign-in failed');
      return reply.redirect(fail(`Microsoft sign-in failed: ${(err as Error).message}`));
    }
  });
}
