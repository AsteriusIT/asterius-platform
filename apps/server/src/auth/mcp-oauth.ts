import type { FastifyRequest } from 'fastify';
import { createRemoteJWKSet, decodeJwt, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { config } from '../config.js';
import { one } from '../db.js';
import { findOrg, membership } from '../orgs/orgs.js';
import { assertSecureUrl } from './oauth.js';
import { issuer as keycloakIssuer, keycloakEnabled, keycloakJwksUrl, orgAliasesOf } from './keycloak.js';
import { principalFor, type Principal, type UserRow } from './users.js';

/**
 * MCP authorization (spec 2025-06-18): the MCP endpoint is an OAuth 2.1 resource server. It publishes RFC 9728 Protected
 * Resource Metadata naming the authorization server (the Keycloak realm, else OIDC_ISSUER, else MCP_OAUTH_ISSUERS), and
 * accepts that server's access tokens (JWT) as Bearer: signature through the issuer JWKS, `iss`, `exp` and `aud`. The
 * token is mapped to an existing platform user the same way sign-in does (Keycloak `sub`, or `issuer|sub` for OIDC);
 * unknown users are rejected, nothing is provisioned here.
 */

const trim = (u: string) => u.replace(/\/$/, '');
export const MCP_PATHS = ['/api/mcp', '/api/v1/mcp'];

export const resourceUrl = (path = MCP_PATHS[0]) => `${trim(config.PUBLIC_URL)}${path}`;

/** Issuers whose access tokens are accepted; the first one is advertised. */
export function trustedIssuers(): { issuer: string; keycloak: boolean }[] {
  const out: { issuer: string; keycloak: boolean }[] = [];
  if (keycloakEnabled()) out.push({ issuer: keycloakIssuer(), keycloak: true });
  for (const i of [config.OIDC_ISSUER, ...config.MCP_OAUTH_ISSUERS])
    if (i && !out.some((o) => o.issuer === trim(i))) out.push({ issuer: trim(i), keycloak: false });
  return out;
}

/** RFC 9728 document for the MCP endpoint at `path`. */
export function protectedResourceMetadata(path = MCP_PATHS[0]) {
  return {
    resource: resourceUrl(path),
    authorization_servers: trustedIssuers()
      .slice(0, 1)
      .map((i) => i.issuer),
    bearer_methods_supported: ['header'],
    scopes_supported: config.MCP_OAUTH_SCOPES.split(/\s+/).filter(Boolean),
    resource_documentation: 'https://github.com/AsteriusIT/asterius-platform/blob/main/docs/MCP.md',
  };
}

/** `WWW-Authenticate` challenge of the MCP endpoint (RFC 9728 §5.1). */
export const mcpChallenge = (path = MCP_PATHS[0]) =>
  `Bearer realm="asterius-platform", resource_metadata="${trim(config.PUBLIC_URL)}/.well-known/oauth-protected-resource${path}"`;

const keySets = new Map<string, { at: number; keys: JWTVerifyGetKey }>();

async function keysFor(i: { issuer: string; keycloak: boolean }): Promise<JWTVerifyGetKey> {
  const hit = keySets.get(i.issuer);
  if (hit && Date.now() - hit.at < 3600_000) return hit.keys;
  let jwksUri: string;
  if (i.keycloak) jwksUri = keycloakJwksUrl();
  else {
    assertSecureUrl(i.issuer, 'issuer');
    const res = await fetch(`${i.issuer}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(config.HTTP_TIMEOUT_SECONDS * 1000) });
    if (!res.ok) throw new Error(`OIDC discovery failed (${res.status})`);
    const doc = (await res.json()) as { issuer: string; jwks_uri: string };
    if (trim(doc.issuer ?? '') !== i.issuer) throw new Error('OIDC discovery issuer mismatch');
    jwksUri = doc.jwks_uri;
  }
  assertSecureUrl(jwksUri, 'jwks_uri');
  const keys = createRemoteJWKSet(new URL(jwksUri));
  keySets.set(i.issuer, { at: Date.now(), keys });
  return keys;
}

/** Forget cached JWKS (tests, key rotation). */
export const resetMcpOauthCache = () => keySets.clear();

/** Looks like a JWT (three dot-separated parts); API tokens and sessions are never tried as JWTs. */
export const looksLikeJwt = (t: string) => t.split('.').length === 3 && !t.startsWith('ast_');

/** Verify an access token and return the platform principal, or undefined when it is not acceptable. */
export async function authenticateAccessToken(req: FastifyRequest, token: string, path = MCP_PATHS[0]): Promise<Principal | undefined> {
  if (!looksLikeJwt(token)) return undefined;
  let iss: string | undefined;
  try {
    iss = decodeJwt(token).iss;
  } catch {
    return undefined;
  }
  const trusted = trustedIssuers().find((i) => i.issuer === (iss ? trim(iss) : ''));
  if (!trusted) return undefined;
  try {
    const audience = [...new Set([resourceUrl(path), ...MCP_PATHS.map((p) => resourceUrl(p)), ...config.MCP_OAUTH_AUDIENCES])];
    const { payload } = await jwtVerify(token, await keysFor(trusted), { issuer: trusted.issuer, audience, requiredClaims: ['sub', 'exp'] });
    const sub = String(payload.sub);
    const user = trusted.keycloak
      ? await one<UserRow>("SELECT * FROM users WHERE provider = 'keycloak' AND external_id = ?", sub)
      : await one<UserRow>("SELECT * FROM users WHERE provider = 'oidc' AND external_id = ?", `${trusted.issuer}|${sub}`);
    if (!user || user.active !== 1) return undefined;
    // Organization: the X-Asterius-Org header (resolved by principalFor), else the first organization of the token's
    // `organization` claim the user belongs to, else the user's last / first organization.
    let org: string | undefined;
    if (!req.headers['x-asterius-org']) {
      for (const alias of orgAliasesOf(payload.organization)) {
        const o = await findOrg(alias);
        if (o && (user.superadmin === 1 || (await membership(o.id, user.id)))) {
          org = o.id;
          break;
        }
      }
    }
    return await principalFor(req, { user, ...(org ? { token: { id: 'oauth', scopes: null, blueprints: null, ipAllow: null, org } } : {}) });
  } catch (err) {
    req.log.debug({ err }, 'mcp access token refused');
    return undefined;
  }
}
