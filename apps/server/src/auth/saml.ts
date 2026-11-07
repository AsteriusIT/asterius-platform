import type { FastifyInstance } from 'fastify';
import { SAML, ValidateInResponseTo, type CacheItem, type CacheProvider, type Profile } from '@node-saml/node-saml';
import { config } from '../config.js';
import { audit } from '../audit.js';
import { one, run } from '../db.js';
import { failUrl, safeReturnTo, finishLogin } from './oauth.js';
import { upsertExternalUser } from './users.js';

/**
 * SAML 2.0 service provider (HTTP-Redirect AuthnRequest, HTTP-POST response) on @node-saml/node-saml, which performs
 * XML signature verification (with wrapping-attack protections), audience, conditions and InResponseTo checks.
 *  - Only SP-initiated sign-in: the response must answer a request this platform issued (InResponseTo is required),
 *    and each request id is consumed once, which also prevents replay of a captured response.
 *  - Request ids live in the database (oauth_states) so any replica can validate the response.
 *  - Identities are keyed by `idpIssuer|NameID`; the assertion signature must verify against SAML_IDP_CERT.
 */

/** CacheProvider on the shared database instead of process memory. */
const dbCache: CacheProvider = {
  async saveAsync(key, value): Promise<CacheItem | null> {
    await run('DELETE FROM oauth_states WHERE expires_at < ?', new Date().toISOString());
    await run(
      'INSERT INTO oauth_states (state, nonce, code_verifier, return_to, expires_at) VALUES (?, ?, ?, ?, ?)',
      `saml:${key}`,
      value,
      '',
      '/',
      new Date(Date.now() + 10 * 60_000).toISOString(),
    );
    return { value, createdAt: Date.now() };
  },
  async getAsync(key) {
    const r = await one<{ nonce: string; expires_at: string }>('SELECT nonce, expires_at FROM oauth_states WHERE state = ?', `saml:${key}`);
    return r && r.expires_at >= new Date().toISOString() ? r.nonce : null;
  },
  async removeAsync(key) {
    // Atomic consume: only the caller that actually deleted the row proceeds (no double use across replicas).
    const { changes } = await run('DELETE FROM oauth_states WHERE state = ?', `saml:${key}`);
    return changes ? (key ?? null) : null;
  },
};

let saml: SAML | undefined;
const sp = () =>
  (saml ??= new SAML({
    entryPoint: config.SAML_ENTRY_POINT!,
    idpCert: config.SAML_IDP_CERT!.replace(/\\n/g, '\n'),
    issuer: config.SAML_ISSUER ?? `${config.PUBLIC_URL}/api/auth/saml/metadata`,
    callbackUrl: config.SAML_CALLBACK_URL ?? `${config.PUBLIC_URL}/api/auth/saml/acs`,
    audience: config.SAML_AUDIENCE ?? config.SAML_ISSUER ?? `${config.PUBLIC_URL}/api/auth/saml/metadata`,
    idpIssuer: config.SAML_IDP_ISSUER,
    wantAssertionsSigned: config.SAML_WANT_ASSERTIONS_SIGNED,
    wantAuthnResponseSigned: config.SAML_WANT_RESPONSE_SIGNED,
    validateInResponseTo: ValidateInResponseTo.always,
    requestIdExpirationPeriodMs: 10 * 60_000,
    acceptedClockSkewMs: 60_000,
    cacheProvider: dbCache,
    disableRequestedAuthnContext: true,
    identifierFormat: null,
  }));

const attr = (p: Profile, name: string): string | string[] | undefined => {
  const v = (p as unknown as Record<string, unknown>)[name] ?? (p.attributes as Record<string, unknown> | undefined)?.[name];
  return Array.isArray(v) ? v.map(String) : v == null ? undefined : String(v as string);
};
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/** Map a validated SAML profile to a platform identity. */
export function identityOf(p: Profile) {
  const nameId = String(p.nameID ?? '');
  if (!nameId) throw new Error('the assertion has no NameID');
  const email = (first(attr(p, config.SAML_EMAIL_ATTR)) ?? (nameId.includes('@') ? nameId : '')).toLowerCase();
  if (!email) throw new Error(`the assertion has no "${config.SAML_EMAIL_ATTR}" attribute`);
  const groups = attr(p, config.SAML_GROUPS_ATTR);
  return {
    externalId: `${p.issuer ?? config.SAML_IDP_ISSUER ?? 'idp'}|${nameId}`,
    email,
    emailVerified: true, // the IdP is the trust root for its own users
    name: first(attr(p, config.SAML_NAME_ATTR)) ?? email,
    groups: Array.isArray(groups) ? groups : groups ? [groups] : [],
  };
}

export async function samlRoutes(app: FastifyInstance) {
  if (!config.SAML_ENTRY_POINT || !config.SAML_IDP_CERT) throw new Error('AUTH_PROVIDERS includes saml: set SAML_ENTRY_POINT and SAML_IDP_CERT');

  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, body, done) => {
    done(null, Object.fromEntries(new URLSearchParams(body as string)));
  });

  app.get('/api/auth/saml/metadata', async (_req, reply) => reply.type('application/samlmetadata+xml').send(sp().generateServiceProviderMetadata(null, null)));

  app.get('/api/auth/saml/login', async (req, reply) => {
    const relay = safeReturnTo((req.query as { returnTo?: string }).returnTo);
    const url = await sp().getAuthorizeUrlAsync(relay, new URL(config.PUBLIC_URL).host, {});
    return reply.redirect(url);
  });

  app.post('/api/auth/saml/acs', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
    const body = (req.body ?? {}) as { SAMLResponse?: string; RelayState?: string };
    if (typeof body.SAMLResponse !== 'string' || !body.SAMLResponse) return reply.redirect(failUrl('Invalid sign-in response'), 303);
    try {
      const { profile } = await sp().validatePostResponseAsync({ SAMLResponse: body.SAMLResponse, RelayState: body.RelayState ?? '' });
      if (!profile) throw new Error('empty assertion');
      const id = identityOf(profile);
      if (config.SAML_ALLOWED_DOMAINS.length && !config.SAML_ALLOWED_DOMAINS.includes(id.email.split('@')[1] ?? ''))
        return reply.redirect(failUrl('Your email domain is not allowed'), 303);
      const user = await upsertExternalUser('saml', { ...id, adminGroups: config.SAML_ADMIN_GROUPS });
      if (user.active !== 1) return reply.redirect(failUrl('Your account is disabled'), 303);
      await audit({ id: user.id, email: user.email }, 'auth.login', null, { provider: 'saml' });
      return finishLogin(req, reply, user.id, safeReturnTo(body.RelayState), 303);
    } catch (err) {
      req.log.warn({ err: (err as Error).message }, 'saml sign-in failed');
      await audit({ id: null, email: null }, 'auth.login_failed', null, { provider: 'saml', ip: req.ip, reason: (err as Error).message.slice(0, 200) });
      return reply.redirect(failUrl('SAML sign-in failed'), 303);
    }
  });
}
