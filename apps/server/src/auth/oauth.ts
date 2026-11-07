import { createHash, randomBytes } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config.js';
import { createSession, sessionCookie } from './users.js';
import { one, run } from '../db.js';

/** Helpers shared by the OAuth/OIDC sign-in flows (state, PKCE, redirects). */

export const b64url = (buf: Buffer) => buf.toString('base64url');

/** Only same-origin relative paths, to avoid open redirects. */
export function safeReturnTo(v: unknown) {
  return typeof v === 'string' && v.startsWith('/') && !v.startsWith('//') && !v.startsWith('/\\') && !v.startsWith('/api/') ? v.slice(0, 500) : '/';
}

export const failUrl = (message: string) => `${config.PUBLIC_URL.replace(/\/$/, '')}/login?error=${encodeURIComponent(message)}`;

export const successUrl = (token: string, returnTo: string) =>
  // Fragment: never sent to servers or written to access logs.
  `${config.PUBLIC_URL.replace(/\/$/, '')}/auth/callback#${new URLSearchParams({ token, returnTo })}`;

/** Start a flow: persist state/nonce/PKCE verifier (single use, 10 minutes). */
export async function newFlow(returnTo: unknown) {
  const state = b64url(randomBytes(24));
  const nonce = b64url(randomBytes(24));
  const verifier = b64url(randomBytes(48));
  await run('DELETE FROM oauth_states WHERE expires_at < ?', new Date().toISOString());
  await run(
    'INSERT INTO oauth_states (state, nonce, code_verifier, return_to, expires_at) VALUES (?, ?, ?, ?, ?)',
    state,
    nonce,
    verifier,
    safeReturnTo(returnTo),
    new Date(Date.now() + 10 * 60_000).toISOString(),
  );
  return { state, nonce, verifier, challenge: b64url(createHash('sha256').update(verifier).digest()) };
}

/** Finish a flow: the state is consumed whether or not it is valid. */
export async function consumeFlow(state: string) {
  const st = await one<{ nonce: string; code_verifier: string; return_to: string; expires_at: string }>('SELECT * FROM oauth_states WHERE state = ?', state);
  await run('DELETE FROM oauth_states WHERE state = ?', state);
  return st && st.expires_at >= new Date().toISOString() ? st : undefined;
}

/** HTTPS is mandatory except for loopback (local development and tests). */
export function assertSecureUrl(url: string, what: string) {
  const u = new URL(url);
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && loopback)) throw new Error(`${what} must use https`);
}

/**
 * End of an SSO flow: open the session and send the browser back to the app. Cookie mode sets the httpOnly cookie
 * (nothing secret in the URL); otherwise the token travels in the URL fragment. `idToken`: the identity provider's ID
 * token, kept for single sign-out (Keycloak).
 */
export async function finishLogin(req: FastifyRequest, reply: FastifyReply, userId: string, returnTo: string, status: 302 | 303 = 302, idToken?: string) {
  const token = await createSession(userId, { ip: req.ip, userAgent: req.headers['user-agent'], idToken });
  if (!config.SESSION_COOKIE) return reply.redirect(successUrl(token, returnTo), status);
  reply.header('set-cookie', sessionCookie(token));
  return reply.redirect(successUrl('cookie', returnTo), status);
}
