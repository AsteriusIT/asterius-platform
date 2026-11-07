import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { config } from '../config.js';
import { all, one, run, withAdvisoryLock } from '../db.js';
import type { FastifyBaseLogger } from 'fastify';
import { syncExternalMembership, syncEntraTeams, upsertEntraUser, type UserRow } from './users.js';
import { finishLogin } from './oauth.js';
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
  // With more than 200 groups Entra omits the claim and sends `_claim_names.groups` (overage): resolve through Graph.
  const names = payload._claim_names as Record<string, string> | undefined;
  const overage = !Array.isArray(payload.groups) && (!!names?.groups || payload.hasgroups === true);
  const groups = Array.isArray(payload.groups) ? payload.groups.map(String) : [];
  return { externalId: `${payload.tid}:${oid}`, oid, email, name: String(payload.name || email || 'User'), groups, overage };
}

const GRAPH = 'https://graph.microsoft.com';

/** App-only Graph token (client credentials). Needs GroupMember.Read.All with admin consent. */
async function graphToken() {
  const res = await fetch(`${authority()}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: config.ENTRA_CLIENT_ID!,
      client_secret: config.ENTRA_CLIENT_SECRET!,
      grant_type: 'client_credentials',
      scope: `${GRAPH}/.default`,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  const body = (await res.json()) as { access_token?: string; error_description?: string };
  if (!res.ok || !body.access_token) throw new Error(body.error_description?.split('\n')[0] ?? `Graph token endpoint ${res.status}`);
  return body.access_token;
}

/** All group object ids a user belongs to (transitively), through Microsoft Graph. */
export async function graphGroupsOf(oid: string): Promise<string[]> {
  const token = await graphToken();
  const out: string[] = [];
  let url: string | undefined = `${GRAPH}/v1.0/users/${encodeURIComponent(oid)}/getMemberObjects`;
  let body: string | undefined = JSON.stringify({ securityEnabledOnly: true });
  for (let page = 0; url && page < 20; page++) {
    const res: Response = await fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body,
      signal: AbortSignal.timeout(15_000),
    });
    const data = (await res.json()) as { value?: string[]; '@odata.nextLink'?: string; error?: { message?: string } };
    if (!res.ok) throw new Error(`Microsoft Graph: ${data.error?.message ?? res.status}`);
    out.push(...(data.value ?? []).map(String));
    const next: string | undefined = data['@odata.nextLink'];
    url = next && next.startsWith(`${GRAPH}/`) ? next : undefined; // never follow a link to another host
    body = undefined;
  }
  return out;
}

/**
 * Re-apply roles and team memberships of Entra users that hold an active session, from their current groups in Entra,
 * so removing someone from a group takes effect without waiting for their next sign-in. One replica at a time.
 */
export async function resyncEntraMemberships(log: FastifyBaseLogger) {
  await withAdvisoryLock(726204, async () => {
    const users = await all<UserRow>(
      "SELECT DISTINCT u.* FROM users u JOIN sessions s ON s.user_id = u.id WHERE u.provider = 'entra' AND u.active = 1 AND s.expires_at > ?",
      new Date().toISOString(),
    );
    for (const u of users) {
      try {
        const oid = (u.external_id ?? '').split(':')[1];
        if (!oid) continue;
        const groups = await graphGroupsOf(oid);
        await run('UPDATE users SET groups = ? WHERE id = ?', JSON.stringify(groups), u.id);
        await syncExternalMembership(u.id, { externalId: u.external_id ?? '', email: u.email, name: u.name, groups, adminGroups: config.ENTRA_ADMIN_GROUPS });
        await syncEntraTeams(u.id, groups);
      } catch (err) {
        log.warn({ err, user: u.email }, 'entra membership re-sync failed');
      }
    }
  });
}

export function startEntraResync(log: FastifyBaseLogger) {
  if (!config.AUTH_PROVIDERS.includes('entra') || !config.ENTRA_RESYNC_MINUTES) return () => undefined;
  const timer = setInterval(
    () => void resyncEntraMemberships(log).catch((err) => log.error({ err }, 'entra re-sync failed')),
    config.ENTRA_RESYNC_MINUTES * 60_000,
  );
  timer.unref();
  return () => clearInterval(timer);
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

      const id = await checkIdToken(tokens.id_token, st.nonce, keys());
      const { externalId, email, name } = id;
      let groups = id.groups;
      if (id.overage) {
        // Fail closed: silently treating "too many groups" as "no groups" would drop teams and (wrongly) admin rights.
        try {
          groups = await graphGroupsOf(id.oid);
        } catch (err) {
          throw new Error(`you belong to too many groups for the token and the Graph lookup failed (${(err as Error).message})`, { cause: err });
        }
      }

      const user = await upsertEntraUser({ externalId, email, name, groups });
      if (user.active !== 1) return reply.redirect(fail('Your account is disabled'));
      await audit({ id: user.id, email: user.email }, 'auth.login', null, { provider: 'entra' });

      return finishLogin(req, reply, user.id, st.return_to);
    } catch (err) {
      req.log.warn({ err }, 'entra sign-in failed');
      return reply.redirect(fail(`Microsoft sign-in failed: ${(err as Error).message}`));
    }
  });
}
