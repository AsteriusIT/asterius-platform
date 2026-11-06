import type { FastifyInstance } from 'fastify';
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { config } from '../config.js';
import { audit } from '../audit.js';
import { assertSecureUrl, consumeFlow, failUrl, newFlow, successUrl } from './oauth.js';
import { createSession, upsertExternalUser } from './users.js';

/**
 * Generic OpenID Connect sign-in (Okta, Keycloak, Google, Auth0, …): discovery document, authorization-code flow with
 * PKCE and nonce, confidential client. ID tokens are verified (signature, issuer, audience, nonce, expiry); identities
 * are keyed by `issuer|sub`, never by email, so a changed or recycled email cannot take over an account.
 */

interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
}

let discovery: { at: number; doc: Discovery; keys: JWTVerifyGetKey } | undefined;

async function provider() {
  if (discovery && Date.now() - discovery.at < 3600_000) return discovery;
  const issuer = config.OIDC_ISSUER!.replace(/\/$/, '');
  assertSecureUrl(issuer, 'OIDC_ISSUER');
  const res = await fetch(`${issuer}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(config.HTTP_TIMEOUT_SECONDS * 1000) });
  if (!res.ok) throw new Error(`OIDC discovery failed (${res.status})`);
  const doc = (await res.json()) as Discovery;
  // The issuer in the document must be the one we trust (mix-up protection).
  if (doc.issuer?.replace(/\/$/, '') !== issuer) throw new Error('OIDC discovery issuer mismatch');
  for (const u of [doc.authorization_endpoint, doc.token_endpoint, doc.jwks_uri]) assertSecureUrl(u, 'OIDC endpoint');
  discovery = { at: Date.now(), doc, keys: createRemoteJWKSet(new URL(doc.jwks_uri)) };
  return discovery;
}

const redirectUri = () => config.OIDC_REDIRECT_URI ?? `${config.PUBLIC_URL}/api/auth/oidc/callback`;

/** Verify an ID token and extract the identity using the configured claim names. */
export async function checkOidcIdToken(idToken: string, nonce: string, keySet: JWTVerifyGetKey) {
  const { payload } = await jwtVerify(idToken, keySet, { issuer: config.OIDC_ISSUER!.replace(/\/$/, ''), audience: config.OIDC_CLIENT_ID });
  if (payload.nonce !== nonce) throw new Error('nonce mismatch');
  const sub = String(payload.sub ?? '');
  if (!sub) throw new Error('missing sub claim');
  const email = String(payload[config.OIDC_EMAIL_CLAIM] ?? '').toLowerCase();
  if (!email) throw new Error(`the ID token has no "${config.OIDC_EMAIL_CLAIM}" claim`);
  const raw = payload[config.OIDC_GROUPS_CLAIM];
  const groups = Array.isArray(raw) ? raw.map(String) : typeof raw === 'string' ? [raw] : [];
  return {
    externalId: `${config.OIDC_ISSUER!.replace(/\/$/, '')}|${sub}`,
    email,
    emailVerified: payload.email_verified === true,
    name: String(payload[config.OIDC_NAME_CLAIM] || email),
    groups,
  };
}

export async function oidcRoutes(app: FastifyInstance) {
  if (!config.OIDC_ISSUER || !config.OIDC_CLIENT_ID || !config.OIDC_CLIENT_SECRET)
    throw new Error('AUTH_PROVIDERS includes oidc: set OIDC_ISSUER, OIDC_CLIENT_ID and OIDC_CLIENT_SECRET');

  app.get('/api/auth/oidc/login', async (req, reply) => {
    let p;
    try {
      p = await provider();
    } catch (err) {
      req.log.error({ err }, 'oidc discovery failed');
      return reply.redirect(failUrl('The identity provider is unreachable'));
    }
    const flow = await newFlow((req.query as { returnTo?: string }).returnTo);
    const params = new URLSearchParams({
      client_id: config.OIDC_CLIENT_ID!,
      response_type: 'code',
      redirect_uri: redirectUri(),
      scope: config.OIDC_SCOPES,
      state: flow.state,
      nonce: flow.nonce,
      code_challenge: flow.challenge,
      code_challenge_method: 'S256',
    });
    return reply.redirect(`${p.doc.authorization_endpoint}?${params}`);
  });

  app.get('/api/auth/oidc/callback', async (req, reply) => {
    const q = req.query as { code?: string; state?: string; error?: string; error_description?: string };
    if (q.error) return reply.redirect(failUrl(q.error_description?.split('\n')[0]?.slice(0, 200) ?? q.error));
    if (!q.code || !q.state) return reply.redirect(failUrl('Invalid sign-in response'));
    const st = await consumeFlow(q.state);
    if (!st) return reply.redirect(failUrl('Your sign-in expired, please try again'));

    try {
      const p = await provider();
      const res = await fetch(p.doc.token_endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: new URLSearchParams({
          client_id: config.OIDC_CLIENT_ID!,
          client_secret: config.OIDC_CLIENT_SECRET!,
          grant_type: 'authorization_code',
          code: q.code,
          redirect_uri: redirectUri(),
          code_verifier: st.code_verifier,
        }),
        signal: AbortSignal.timeout(config.HTTP_TIMEOUT_SECONDS * 1000),
      });
      const tokens = (await res.json()) as { id_token?: string; error?: string; error_description?: string };
      if (!res.ok || !tokens.id_token) throw new Error(tokens.error_description?.split('\n')[0] ?? tokens.error ?? `token endpoint ${res.status}`);

      const id = await checkOidcIdToken(tokens.id_token, st.nonce, p.keys);
      if (config.OIDC_ALLOWED_DOMAINS.length && !config.OIDC_ALLOWED_DOMAINS.includes(id.email.split('@')[1] ?? ''))
        return reply.redirect(failUrl('Your email domain is not allowed'));
      const user = await upsertExternalUser('oidc', { ...id, adminGroups: config.OIDC_ADMIN_GROUPS });
      if (user.active !== 1) return reply.redirect(failUrl('Your account is disabled'));
      await audit({ id: user.id, email: user.email }, 'auth.login', null, { provider: 'oidc' });
      const token = await createSession(user.id, { ip: req.ip, userAgent: req.headers['user-agent'] });
      return reply.redirect(successUrl(token, st.return_to));
    } catch (err) {
      req.log.warn({ err }, 'oidc sign-in failed');
      return reply.redirect(failUrl(`Sign-in failed: ${(err as Error).message.slice(0, 200)}`));
    }
  });
}
