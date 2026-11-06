import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { audit } from '../audit.js';
import { consumeFlow, failUrl, newFlow, finishLogin } from './oauth.js';
import { upsertExternalUser } from './users.js';

/**
 * GitHub OAuth sign-in (authorization code + PKCE). Access is limited to members of GITHUB_ALLOWED_ORGS. Groups for
 * team mapping are `org` and `org/team-slug`; the GitHub access token is used for these lookups only and discarded.
 */

const redirectUri = () => config.GITHUB_REDIRECT_URI ?? `${config.PUBLIC_URL}/api/auth/github/callback`;

async function gh<T>(path: string, token: string): Promise<T> {
  const res = await fetch(`${config.GITHUB_API_URL}${path}`, {
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'asterius-platform',
    },
    signal: AbortSignal.timeout(config.HTTP_TIMEOUT_SECONDS * 1000),
  });
  if (!res.ok) throw new Error(`GitHub API ${path} answered ${res.status}`);
  return (await res.json()) as T;
}

export async function githubRoutes(app: FastifyInstance) {
  if (!config.GITHUB_CLIENT_ID || !config.GITHUB_CLIENT_SECRET)
    throw new Error('AUTH_PROVIDERS includes github: set GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET');
  if (!config.GITHUB_ALLOWED_ORGS.length)
    throw new Error('AUTH_PROVIDERS includes github: set GITHUB_ALLOWED_ORGS (otherwise any GitHub account could sign in)');

  app.get('/api/auth/github/login', async (req, reply) => {
    const flow = await newFlow((req.query as { returnTo?: string }).returnTo);
    const params = new URLSearchParams({
      client_id: config.GITHUB_CLIENT_ID!,
      redirect_uri: redirectUri(),
      scope: 'read:user user:email read:org',
      state: flow.state,
      code_challenge: flow.challenge,
      code_challenge_method: 'S256',
    });
    return reply.redirect(`${config.GITHUB_URL}/login/oauth/authorize?${params}`);
  });

  app.get('/api/auth/github/callback', async (req, reply) => {
    const q = req.query as { code?: string; state?: string; error?: string; error_description?: string };
    if (q.error) return reply.redirect(failUrl(q.error_description?.slice(0, 200) ?? q.error));
    if (!q.code || !q.state) return reply.redirect(failUrl('Invalid sign-in response'));
    const st = await consumeFlow(q.state);
    if (!st) return reply.redirect(failUrl('Your sign-in expired, please try again'));

    try {
      const res = await fetch(`${config.GITHUB_URL}/login/oauth/access_token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: new URLSearchParams({
          client_id: config.GITHUB_CLIENT_ID!,
          client_secret: config.GITHUB_CLIENT_SECRET!,
          code: q.code,
          redirect_uri: redirectUri(),
          code_verifier: st.code_verifier,
        }),
        signal: AbortSignal.timeout(config.HTTP_TIMEOUT_SECONDS * 1000),
      });
      const tok = (await res.json()) as { access_token?: string; error?: string; error_description?: string };
      if (!res.ok || !tok.access_token) throw new Error(tok.error_description ?? tok.error ?? `token endpoint ${res.status}`);

      const me = await gh<{ id: number; login: string; name: string | null }>('/user', tok.access_token);
      const emails = await gh<{ email: string; primary: boolean; verified: boolean }[]>('/user/emails', tok.access_token);
      const primary = emails.find((e) => e.primary && e.verified);
      if (!primary) throw new Error('your GitHub account has no verified primary email');

      const orgs = (await gh<{ login: string }[]>('/user/orgs?per_page=100', tok.access_token)).map((o) => o.login.toLowerCase());
      const allowed = config.GITHUB_ALLOWED_ORGS.map((o) => o.toLowerCase());
      if (!orgs.some((o) => allowed.includes(o))) return reply.redirect(failUrl('Your GitHub account is not a member of an allowed organization'));
      const teams = await gh<{ slug: string; organization: { login: string } }[]>('/user/teams?per_page=100', tok.access_token);
      const groups = [...orgs, ...teams.map((t) => `${t.organization.login.toLowerCase()}/${t.slug}`)];

      const user = await upsertExternalUser('github', {
        externalId: String(me.id),
        email: primary.email.toLowerCase(),
        emailVerified: true,
        name: me.name || me.login,
        groups,
        adminGroups: config.GITHUB_ADMIN_TEAMS.map((t) => t.toLowerCase()),
      });
      if (user.active !== 1) return reply.redirect(failUrl('Your account is disabled'));
      await audit({ id: user.id, email: user.email }, 'auth.login', null, { provider: 'github' });
      return finishLogin(req, reply, user.id, st.return_to);
    } catch (err) {
      req.log.warn({ err }, 'github sign-in failed');
      return reply.redirect(failUrl(`GitHub sign-in failed: ${(err as Error).message.slice(0, 200)}`));
    }
  });
}
