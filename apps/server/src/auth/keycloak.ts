import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import type { SsoProvider, SsoProviderInput } from '@asterius/shared';
import { config } from '../config.js';
import { all, newId, now, one, run } from '../db.js';
import { audit } from '../audit.js';
import { badRequest, conflict, HttpError } from '../lib/errors.js';
import { addMember, findOrg, listOrgRows, membership, orgsForDomain, settingsOf, verifiedDomains, type OrgRow } from '../orgs/orgs.js';
import { getUser, initialRole, joinInitialOrgs, type UserRow } from './users.js';
import { finishLogin } from './oauth.js';

/**
 * Keycloak: registration, sign-in and per-organization SSO.
 *
 * Sign-in is a standard OIDC authorization-code flow with PKCE against one realm (confidential client). Each platform
 * organization maps to a Keycloak Organization with the same alias: Keycloak routes people to their company's identity
 * provider by email domain, and the `organization` claim of the ID token tells the platform which organizations the
 * person belongs to (memberships with via = 'sso' follow it). Organization admins manage those identity providers
 * and invitations from the platform, which drives the Keycloak admin REST API with the client's service account.
 */

export const keycloakEnabled = () => config.AUTH_PROVIDERS.includes('keycloak') && !!config.KEYCLOAK_URL;

const trim = (u: string) => u.replace(/\/$/, '');
const publicBase = () => trim(config.KEYCLOAK_URL!);
const backBase = () => trim(config.KEYCLOAK_INTERNAL_URL ?? config.KEYCLOAK_URL!);
const realmPath = () => `/realms/${encodeURIComponent(config.KEYCLOAK_REALM)}`;
export const issuer = () => `${publicBase()}${realmPath()}`;
const oidc = (base: string) => `${base}${realmPath()}/protocol/openid-connect`;
const adminApi = () => `${backBase()}/admin${realmPath()}`;
const redirectUri = () => `${trim(config.PUBLIC_URL)}/api/auth/keycloak/callback`;
/** Account console: password, MFA, passkeys, linked identities. */
export const accountUrl = () => (keycloakEnabled() ? `${issuer()}/account` : null);

/** Back-channel JWKS URL of the realm (verifies tokens issued by `issuer()`). */
export const keycloakJwksUrl = () => `${oidc(backBase())}/certs`;

let jwks: JWTVerifyGetKey | undefined;
const keys = () => (jwks ??= createRemoteJWKSet(new URL(`${oidc(backBase())}/certs`)));

const b64url = (buf: Buffer) => buf.toString('base64url');
const safeReturnTo = (v: unknown) => (typeof v === 'string' && v.startsWith('/') && !v.startsWith('//') && !v.startsWith('/api/') ? v.slice(0, 500) : '/');
const fail = (message: string) => `${trim(config.PUBLIC_URL)}/login?error=${encodeURIComponent(message)}`;

/** Organization aliases from the `organization` claim: a list of aliases, or an object keyed by alias. */
export function orgAliasesOf(claim: unknown): string[] {
  if (Array.isArray(claim)) return claim.map(String);
  if (claim && typeof claim === 'object') return Object.keys(claim);
  if (typeof claim === 'string' && claim) return [claim];
  return [];
}

/** Verify a Keycloak ID token and extract the identity. */
export async function checkKeycloakIdToken(idToken: string, nonce: string, keySet: JWTVerifyGetKey = keys()) {
  const { payload } = await jwtVerify(idToken, keySet, { issuer: issuer(), audience: config.KEYCLOAK_CLIENT_ID });
  if (payload.nonce !== nonce) throw new Error('nonce mismatch');
  const sub = String(payload.sub ?? '');
  if (!sub) throw new Error('missing sub claim');
  const email = String(payload.email ?? '').toLowerCase();
  if (!email) throw new Error('your account has no email address');
  return {
    sub,
    email,
    emailVerified: payload.email_verified === true,
    name: String(payload.name || payload.preferred_username || email),
    orgs: orgAliasesOf(payload.organization),
  };
}

/**
 * Upsert the Keycloak user and align memberships. A sign-in never joins an organization by itself, except:
 * - `sso`: organizations whose identity provider the person came through (their Keycloak account is linked to it) and
 *   whose verified domains include the email: the company IdP vouches for its people, nobody is added in Keycloak;
 * - the `organization` claim: Keycloak Organizations the person was invited to or added to.
 * SSO memberships of Keycloak-linked organizations that neither lists any more are removed; manual ones stay.
 * `sso` undefined (the admin API could not be asked): memberships are added from the claim but none is removed.
 */
export async function upsertKeycloakUser(id: {
  sub: string;
  email: string;
  emailVerified: boolean;
  name: string;
  orgs: string[];
  sso?: string[];
}): Promise<UserRow> {
  let user = await one<UserRow>("SELECT * FROM users WHERE provider = 'keycloak' AND external_id = ?", id.sub);
  if (user) {
    await run('UPDATE users SET email = ?, name = ?, last_login_at = ? WHERE id = ?', id.email, id.name, now(), user.id);
  } else {
    const uid = newId();
    const superadmin = (await initialRole(id.email)) === 'admin';
    await run(
      "INSERT INTO users (id, provider, external_id, email, name, role, superadmin, last_login_at, created_at) VALUES (?, 'keycloak', ?, ?, ?, ?, ?, ?, ?)",
      uid,
      id.sub,
      id.email,
      id.name,
      superadmin ? 'admin' : 'member',
      superadmin ? 1 : 0,
      now(),
      now(),
    );
    await joinInitialOrgs(uid, superadmin ? 'admin' : 'member');
    user = await getUser(uid);
  }
  const domain = id.email.split('@')[1];
  const keep = new Set(id.orgs);
  for (const slug of id.sso ?? []) {
    const org = await findOrg(slug);
    if (org && verifiedDomains(org).includes(domain)) keep.add(org.slug);
  }
  for (const slug of keep) {
    const org = await findOrg(slug);
    if (org) await addMember(org.id, user!.id, 'member', 'sso');
  }
  if (id.sso) {
    const ssoMemberships = await all<OrgRow>(
      "SELECT o.* FROM memberships m JOIN organizations o ON o.id = m.org_id WHERE m.user_id = ? AND m.via = 'sso'",
      user!.id,
    );
    for (const o of ssoMemberships)
      if (settingsOf(o).keycloakOrgId && !keep.has(o.slug)) await run('DELETE FROM memberships WHERE org_id = ? AND user_id = ?', o.id, user!.id);
  }
  return (await getUser(user!.id))!;
}

/**
 * Organizations whose identity provider this Keycloak user is linked to (signed in or registered through it). Provider
 * aliases are `<slug>-<alias>`; the link to the Keycloak Organization is checked, so similar slugs cannot be confused.
 */
export async function kcSsoOrgs(sub: string): Promise<string[]> {
  const { data } = await kc<{ identityProvider: string }[]>('GET', `/users/${encodeURIComponent(sub)}/federated-identity`);
  const orgs = (await listOrgRows()).filter((o) => settingsOf(o).keycloakOrgId);
  const out = new Set<string>();
  for (const { identityProvider: alias } of data ?? [])
    for (const o of orgs.filter((x) => alias.startsWith(`${x.slug}-`))) {
      const path = `/organizations/${encodeURIComponent(settingsOf(o).keycloakOrgId!)}/identity-providers/${encodeURIComponent(alias)}`;
      if (
        await kc('GET', path).then(
          () => true,
          () => false,
        )
      ) {
        out.add(o.slug);
        break;
      }
    }
  return [...out];
}

const routeCache = new Map<string, { at: number; route: { org: string; alias: string } | null }>();

/**
 * Identity provider for an email: the organization that verified its domain, and the provider it connected for that
 * domain (or its only provider). Null: sign in on Keycloak's page. Cached for a minute (one admin API call per org).
 */
export async function ssoRouteFor(email: string): Promise<{ org: string; alias: string } | null> {
  const domain = email.split('@')[1]?.toLowerCase();
  if (!domain) return null;
  const c = routeCache.get(domain);
  if (c && c.at > Date.now() - 60_000) return c.route;
  let route: { org: string; alias: string } | null = null;
  for (const org of await orgsForDomain(email)) {
    const id = settingsOf(org).keycloakOrgId;
    if (!id) continue;
    const { data } = await kc<KcIdp[]>('GET', `/organizations/${encodeURIComponent(id)}/identity-providers`);
    const enabled = (data ?? []).filter((i) => i.enabled);
    const pick = enabled.find((i) => i.config?.['kc.org.domain'] === domain) ?? (enabled.length === 1 ? enabled[0] : undefined);
    if (pick) {
      route = { org: org.slug, alias: pick.alias };
      break;
    }
  }
  routeCache.set(domain, { at: Date.now(), route });
  return route;
}

/** Forget routing decisions (a provider was connected or removed). */
export const clearSsoRoutes = () => routeCache.clear();

export async function keycloakRoutes(app: FastifyInstance) {
  /**
   * Start sign-in (or registration with ?register=1). ?org=<slug> asks Keycloak for that organization (its identity
   * provider), ?email= pre-fills the identity-first form so the email domain routes to the right provider.
   */
  app.get('/api/auth/keycloak/login', async (req, reply) => {
    if (!keycloakEnabled()) return reply.code(404).send({ error: 'Keycloak sign-in is not enabled' });
    const q = req.query as { returnTo?: string; org?: string; email?: string; register?: string };
    const state = b64url(randomBytes(24));
    const nonce = b64url(randomBytes(24));
    const verifier = b64url(randomBytes(48));
    const email = typeof q.email === 'string' && q.email.includes('@') ? q.email.trim().toLowerCase().slice(0, 200) : null;
    // Home realm discovery: an email whose verified domain belongs to an organization with a connected identity
    // provider goes straight to that provider (kc_idp_hint), without Keycloak's own sign-in page.
    const route = email && q.register !== '1' ? await ssoRouteFor(email).catch(() => null) : null;
    const org = route?.org ?? (q.org && /^[a-z][a-z0-9_-]{0,63}$/.test(q.org) ? q.org : null);
    await run('DELETE FROM oauth_states WHERE expires_at < ?', now());
    await run(
      'INSERT INTO oauth_states (state, nonce, code_verifier, return_to, org, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
      state,
      nonce,
      verifier,
      safeReturnTo(q.returnTo),
      org,
      new Date(Date.now() + 10 * 60_000).toISOString(),
    );
    const params = new URLSearchParams({
      client_id: config.KEYCLOAK_CLIENT_ID,
      response_type: 'code',
      redirect_uri: redirectUri(),
      // Routed sign-ins must not be refused for not being a Keycloak member yet: membership comes from the domain.
      scope: `openid profile email ${org && !route ? `organization:${org}` : 'organization'}`,
      state,
      nonce,
      code_challenge: b64url(createHash('sha256').update(verifier).digest()),
      code_challenge_method: 'S256',
    });
    if (email) params.set('login_hint', email);
    if (route) params.set('kc_idp_hint', route.alias);
    const endpoint = q.register === '1' ? 'registrations' : 'auth';
    return reply.redirect(`${oidc(publicBase())}/${endpoint}?${params}`);
  });

  app.get('/api/auth/keycloak/callback', async (req, reply) => {
    const q = req.query as { code?: string; state?: string; error?: string; error_description?: string };
    if (q.error) return reply.redirect(fail(q.error_description ?? q.error));
    if (!q.code || !q.state) return reply.redirect(fail('Invalid sign-in response'));
    const st = await one<{ nonce: string; code_verifier: string; return_to: string; org: string | null; expires_at: string }>(
      'SELECT * FROM oauth_states WHERE state = ?',
      q.state,
    );
    await run('DELETE FROM oauth_states WHERE state = ?', q.state); // single use
    if (!st || st.expires_at < now()) return reply.redirect(fail('Your sign-in expired, please try again'));
    try {
      const res = await fetch(`${oidc(backBase())}/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: config.KEYCLOAK_CLIENT_ID,
          client_secret: config.KEYCLOAK_CLIENT_SECRET ?? '',
          grant_type: 'authorization_code',
          code: q.code,
          redirect_uri: redirectUri(),
          code_verifier: st.code_verifier,
        }),
      });
      const tokens = (await res.json()) as { id_token?: string; error?: string; error_description?: string };
      if (!res.ok || !tokens.id_token) throw new Error(tokens.error_description ?? tokens.error ?? `token endpoint ${res.status}`);
      const identity = await checkKeycloakIdToken(tokens.id_token, st.nonce);
      const sso = await kcSsoOrgs(identity.sub).catch((err: unknown) => {
        req.log.warn({ err }, 'keycloak: could not read the identity provider links of the user');
        return undefined;
      });
      const user = await upsertKeycloakUser({ ...identity, sso });
      if (user.active !== 1) return reply.redirect(fail('Your account is disabled'));
      // Mirror SSO memberships in the Keycloak Organization, so both sides list the same people.
      for (const slug of sso ?? []) {
        const org = await findOrg(slug);
        const kcOrg = org && settingsOf(org).keycloakOrgId;
        if (kcOrg && !identity.orgs.includes(slug) && (await membership(org.id, user.id)))
          await kcAddMember(kcOrg, identity.sub).catch((err: unknown) => req.log.warn({ err }, 'keycloak: could not add the organization member'));
      }
      const landing = (st.org && (await findOrg(st.org))) || (sso?.[0] ? await findOrg(sso[0]) : undefined);
      if (landing && (await membership(landing.id, user.id))) await run('UPDATE users SET last_org_id = ? WHERE id = ?', landing.id, user.id);
      await audit({ id: user.id, email: user.email }, 'auth.login', null, { provider: 'keycloak' }, null);
      return finishLogin(req, reply, user.id, st.return_to, 302, tokens.id_token);
    } catch (err) {
      req.log.warn({ err }, 'keycloak sign-in failed');
      return reply.redirect(fail(`Sign-in failed: ${(err as Error).message}`));
    }
  });

  /** Fallback sign-out without an ID token (Keycloak asks for a confirmation); POST /api/auth/logout returns a hinted URL. */
  app.get('/api/auth/keycloak/logout', async (_req, reply) => {
    if (!keycloakEnabled()) return reply.redirect(`${trim(config.PUBLIC_URL)}/login`);
    const params = new URLSearchParams({ client_id: config.KEYCLOAK_CLIENT_ID, post_logout_redirect_uri: `${trim(config.PUBLIC_URL)}/login` });
    return reply.redirect(`${oidc(publicBase())}/logout?${params}`);
  });
}

/** Keycloak end-session URL for a signed-out platform session: no confirmation page with the ID token as hint. */
export const keycloakLogoutUrl = (idToken: string) =>
  `${oidc(publicBase())}/logout?${new URLSearchParams({ id_token_hint: idToken, post_logout_redirect_uri: `${trim(config.PUBLIC_URL)}/login`, client_id: config.KEYCLOAK_CLIENT_ID })}`;

// ---------- admin REST API (service account of the client) ----------

let adminToken: { value: string; until: number } | undefined;

async function serviceToken(): Promise<string> {
  if (adminToken && adminToken.until > Date.now()) return adminToken.value;
  const res = await fetch(`${oidc(backBase())}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: config.KEYCLOAK_CLIENT_ID, client_secret: config.KEYCLOAK_CLIENT_SECRET ?? '', grant_type: 'client_credentials' }),
  });
  const body = (await res.json()) as { access_token?: string; expires_in?: number; error_description?: string };
  if (!res.ok || !body.access_token) throw new HttpError(502, `Keycloak: ${body.error_description ?? `token endpoint ${res.status}`}`);
  adminToken = { value: body.access_token, until: Date.now() + Math.max(10, (body.expires_in ?? 60) - 30) * 1000 };
  return adminToken.value;
}

async function kc<T = unknown>(method: string, path: string, body?: unknown, form?: Record<string, string>): Promise<{ data: T; location: string | null }> {
  if (!keycloakEnabled()) throw badRequest('Keycloak is not configured (AUTH_PROVIDERS=keycloak, KEYCLOAK_URL)');
  const headers: Record<string, string> = { authorization: `Bearer ${await serviceToken()}` };
  let payload: string | undefined;
  if (form) {
    headers['content-type'] = 'application/x-www-form-urlencoded';
    payload = new URLSearchParams(form).toString();
  } else if (body !== undefined) {
    headers['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(`${adminApi()}${path}`, { method, headers, body: payload, signal: AbortSignal.timeout(15_000) });
  const text = await res.text();
  if (!res.ok) {
    let msg = text.slice(0, 300);
    try {
      const j = JSON.parse(text) as { errorMessage?: string; error?: string };
      msg = j.errorMessage ?? j.error ?? msg;
    } catch {
      // not JSON
    }
    if (res.status === 409) throw conflict(`Keycloak: ${msg}`);
    throw new HttpError(res.status >= 500 ? 502 : 400, `Keycloak: ${msg || res.statusText}`);
  }
  return { data: (text ? JSON.parse(text) : undefined) as T, location: res.headers.get('location') };
}

/** Only verified domains reach Keycloak: they route sign-ins to the organization's identity provider. */
const domainsBody = (domains: string[]) => domains.map((name) => ({ name, verified: true }));

/** Create the Keycloak Organization of a platform organization (alias = slug); returns its id. */
export async function kcCreateOrganization(org: { slug: string; name: string; domains: string[] }): Promise<string> {
  const { location } = await kc('POST', '/organizations', { name: org.name, alias: org.slug, enabled: true, domains: domainsBody(org.domains) });
  const id = location?.split('/').pop();
  if (id) return id;
  const found = await kc<{ id: string; alias: string }[]>('GET', `/organizations?search=${encodeURIComponent(org.slug)}&exact=true`);
  const match = found.data.find((o) => o.alias === org.slug);
  if (!match) throw new HttpError(502, 'Keycloak created the organization but did not return its id');
  return match.id;
}

export async function kcUpdateOrganization(id: string, org: { slug: string; name: string; domains: string[] }) {
  await kc('PUT', `/organizations/${encodeURIComponent(id)}`, { id, name: org.name, alias: org.slug, enabled: true, domains: domainsBody(org.domains) });
}

export async function kcDeleteOrganization(id: string) {
  await kc('DELETE', `/organizations/${encodeURIComponent(id)}`);
}

/** Add an existing Keycloak user (its id is the `sub` the platform stores as external id). */
export async function kcAddMember(orgId: string, userId: string) {
  await kc('POST', `/organizations/${encodeURIComponent(orgId)}/members`, userId).catch((err) => {
    if (!(err instanceof HttpError && err.statusCode === 409)) throw err; // already a member
  });
}

export async function kcRemoveMember(orgId: string, userId: string) {
  await kc('DELETE', `/organizations/${encodeURIComponent(orgId)}/members/${encodeURIComponent(userId)}`).catch((err) => {
    if (!(err instanceof HttpError && err.statusCode === 404)) throw err;
  });
}

/** Email an invitation: the person registers (or signs in) and joins the organization. */
export async function kcInvite(orgId: string, email: string) {
  await kc('POST', `/organizations/${encodeURIComponent(orgId)}/members/invite-user`, undefined, { email });
}

interface KcIdp {
  alias: string;
  displayName?: string;
  providerId: string;
  enabled: boolean;
  config?: Record<string, string>;
}

const toProvider = (slug: string, i: KcIdp): SsoProvider => ({
  alias: i.alias.startsWith(`${slug}-`) ? i.alias.slice(slug.length + 1) : i.alias,
  displayName: i.displayName ?? i.alias,
  type: i.providerId === 'saml' ? 'saml' : 'oidc',
  enabled: i.enabled,
  domain: i.config?.['kc.org.domain'] ?? null,
  url: i.config?.issuer ?? i.config?.metadataDescriptorUrl ?? i.config?.singleSignOnServiceUrl ?? null,
});

export async function kcListProviders(org: OrgRow): Promise<SsoProvider[]> {
  const id = settingsOf(org).keycloakOrgId;
  if (!id) return [];
  const { data } = await kc<KcIdp[]>('GET', `/organizations/${encodeURIComponent(id)}/identity-providers`);
  return (data ?? []).map((i) => toProvider(org.slug, i));
}

/**
 * Connect an identity provider to the organization: Keycloak imports the OIDC discovery document or SAML metadata,
 * the provider is linked to the Keycloak Organization, and people whose email domain matches are routed to it.
 * Provider aliases are realm-wide, so they are prefixed with the organization slug.
 */
export async function kcAddProvider(org: OrgRow, input: SsoProviderInput): Promise<SsoProvider> {
  const id = settingsOf(org).keycloakOrgId;
  if (!id) throw badRequest('Enable SSO for the organization first');
  if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(input.alias)) throw badRequest('Alias: lowercase letters, digits and -');
  if (!/^https:\/\//.test(input.url) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(input.url))
    throw badRequest('The discovery / metadata URL must use https');
  if (input.domain && !verifiedDomains(org).includes(input.domain))
    throw badRequest(`Verify the domain ${input.domain} first (General → Email domains): sign-ins are only routed for verified domains`);
  const alias = `${org.slug}-${input.alias}`;
  const fromUrl = input.type === 'oidc' && !input.url.includes('.well-known') ? `${input.url.replace(/\/$/, '')}/.well-known/openid-configuration` : input.url;
  const imported = await kc<Record<string, string>>('POST', '/identity-provider/import-config', { providerId: input.type, fromUrl });
  const cfg: Record<string, string> = {
    ...imported.data,
    syncMode: 'IMPORT',
    ...(input.type === 'oidc'
      ? {
          clientId: input.clientId ?? '',
          clientSecret: input.clientSecret ?? '',
          clientAuthMethod: 'client_secret_post',
          defaultScope: 'openid email profile',
          pkceEnabled: 'true',
          pkceMethod: 'S256',
          validateSignature: 'true',
          useJwksUrl: 'true',
        }
      : { metadataDescriptorUrl: input.url, principalType: 'EMAIL', nameIDPolicyFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress' }),
    ...(input.domain ? { 'kc.org.domain': input.domain, 'kc.org.broker.redirect.mode.email-matches': 'true' } : {}),
  };
  if (input.type === 'oidc' && (!input.clientId || !input.clientSecret)) throw badRequest('OIDC providers need a client id and a client secret');
  await kc('POST', '/identity-provider/instances', {
    alias,
    displayName: input.displayName || input.alias,
    providerId: input.type,
    enabled: true,
    trustEmail: true, // the company IdP vouches for its employees' emails
    firstBrokerLoginFlowAlias: 'first broker login',
    config: cfg,
  });
  try {
    await kc('POST', `/organizations/${encodeURIComponent(id)}/identity-providers`, alias);
  } catch (err) {
    await kc('DELETE', `/identity-provider/instances/${encodeURIComponent(alias)}`).catch(() => undefined);
    throw err;
  }
  clearSsoRoutes();
  const { data } = await kc<KcIdp>('GET', `/identity-provider/instances/${encodeURIComponent(alias)}`);
  return toProvider(org.slug, data);
}

export async function kcRemoveProvider(org: OrgRow, shortAlias: string) {
  const id = settingsOf(org).keycloakOrgId;
  if (!id) throw badRequest('SSO is not enabled for this organization');
  const alias = `${org.slug}-${shortAlias}`;
  await kc('DELETE', `/organizations/${encodeURIComponent(id)}/identity-providers/${encodeURIComponent(alias)}`).catch(() => undefined);
  await kc('DELETE', `/identity-provider/instances/${encodeURIComponent(alias)}`);
  clearSsoRoutes();
}
