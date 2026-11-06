import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';
import type { FastifyInstance } from 'fastify';
import { client, register, testApp } from './helpers.js';

// The issuer URL must be known before the config module loads.
const port = vi.hoisted(() => {
  const p = 20000 + Math.floor(Math.random() * 20000);
  process.env.AUTH_PROVIDERS = 'local,oidc';
  process.env.OIDC_ISSUER = `http://127.0.0.1:${p}`;
  process.env.OIDC_CLIENT_ID = 'asterius';
  process.env.OIDC_CLIENT_SECRET = 'shh';
  process.env.OIDC_TITLE = 'Keycloak';
  process.env.OIDC_ADMIN_GROUPS = 'platform-admins';
  return p;
});
const issuer = `http://127.0.0.1:${port}`;

let idp: http.Server;
let app: FastifyInstance;
let jwk: JWK;
let signKey: CryptoKey;
let claims: Record<string, unknown> = {};
let lastNonce = '';
let tokenRequest: URLSearchParams | undefined;

beforeAll(async () => {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  signKey = privateKey as CryptoKey;
  jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
  idp = http.createServer((req, res) => {
    const send = (body: unknown) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.url === '/.well-known/openid-configuration')
      return send({ issuer, authorization_endpoint: `${issuer}/auth`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks` });
    if (req.url === '/jwks') return send({ keys: [jwk] });
    if (req.url === '/token') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', async () => {
        tokenRequest = new URLSearchParams(body);
        const jwt = await new SignJWT({ ...claims, nonce: lastNonce })
          .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
          .setIssuer((claims.iss as string) ?? issuer)
          .setAudience('asterius')
          .setExpirationTime('5m')
          .sign(signKey);
        send({ id_token: jwt });
      });
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => idp.listen(port, '127.0.0.1', r));
  app = await testApp();
});
afterAll(async () => {
  await app.close();
  idp.close();
});

/** Walk the flow: login redirect → (IdP) → callback. Returns the final redirect location. */
async function signIn(c: Record<string, unknown>, mutate?: (state: string) => string) {
  claims = c;
  const login = await app.inject({ method: 'GET', url: '/api/auth/oidc/login?returnTo=/catalog' });
  expect(login.statusCode).toBe(302);
  const auth = new URL(login.headers.location as string);
  expect(auth.origin).toBe(issuer);
  expect(auth.searchParams.get('code_challenge_method')).toBe('S256');
  lastNonce = auth.searchParams.get('nonce')!;
  const state = mutate ? mutate(auth.searchParams.get('state')!) : auth.searchParams.get('state')!;
  const cb = await app.inject({ method: 'GET', url: `/api/auth/oidc/callback?code=abc&state=${state}` });
  return new URL(cb.headers.location as string, 'http://x');
}

describe('generic OIDC', () => {
  it('advertises the provider', async () => {
    const meta = (await client(app).get('/api/meta')).data;
    expect(meta.authProviders).toContain('oidc');
    expect(meta.oidcTitle).toBe('Keycloak');
  });

  it('signs a user in, creates the account and maps groups to teams and admin', async () => {
    // First local user takes the bootstrap admin role so the OIDC user is a plain member.
    const local = await register(app, 'root@example.com');
    const root = client(app, local.token);
    await root.put('/api/v1/teams/payments', { title: 'Payments', entraGroupId: 'payments-group' });

    const to = await signIn({ sub: 'u-1', email: 'Dev@Example.com', email_verified: true, name: 'Dev', groups: ['payments-group'] });
    expect(to.pathname).toBe('/auth/callback');
    const hash = new URLSearchParams(to.hash.slice(1));
    expect(hash.get('returnTo')).toBe('/catalog');
    const dev = client(app, hash.get('token')!);
    const me = (await dev.get('/api/auth/me')).data;
    expect(me).toMatchObject({ email: 'dev@example.com', provider: 'oidc', role: 'member' });
    expect(me.teams.map((t: { identifier: string }) => t.identifier)).toEqual(['payments']);
    expect(tokenRequest?.get('code_verifier')).toBeTruthy();

    // Group removal on the IdP side removes the team at next sign-in; admin group promotes.
    const again = await signIn({ sub: 'u-1', email: 'dev@example.com', email_verified: true, groups: ['platform-admins'] });
    const me2 = (await client(app, new URLSearchParams(again.hash.slice(1)).get('token')!).get('/api/auth/me')).data;
    expect(me2.teams).toEqual([]);
    expect(me2.role).toBe('admin');
  });

  it('rejects a replayed or unknown state, wrong nonce and wrong issuer', async () => {
    const bad = await signIn({ sub: 'u-2', email: 'x@example.com' }, () => 'nope');
    expect(bad.pathname).toBe('/login');
    expect(bad.searchParams.get('error')).toMatch(/expired/);

    claims = { sub: 'u-2', email: 'x@example.com' };
    const login = await app.inject({ method: 'GET', url: '/api/auth/oidc/login' });
    const auth = new URL(login.headers.location as string);
    lastNonce = 'attacker-nonce';
    const state = auth.searchParams.get('state')!;
    const cb = await app.inject({ method: 'GET', url: `/api/auth/oidc/callback?code=abc&state=${state}` });
    expect(new URL(cb.headers.location as string, 'http://x').searchParams.get('error')).toMatch(/nonce/);
    const replay = await app.inject({ method: 'GET', url: `/api/auth/oidc/callback?code=abc&state=${state}` });
    expect(new URL(replay.headers.location as string, 'http://x').searchParams.get('error')).toMatch(/expired/);

    const wrongIss = await signIn({ sub: 'u-2', email: 'x@example.com', iss: 'https://evil.example.com' });
    expect(wrongIss.searchParams.get('error')).toMatch(/failed/);
  });

  it('keys accounts by subject: a different subject with a known email is refused, not merged', async () => {
    const clash = await signIn({ sub: 'u-3', email: 'dev@example.com', email_verified: false });
    expect(clash.pathname).toBe('/login');
    const fresh = await signIn({ sub: 'u-5', email: 'unverified@example.com', email_verified: false });
    const me = (await client(app, new URLSearchParams(fresh.hash.slice(1)).get('token')!).get('/api/auth/me')).data;
    expect(me).toMatchObject({ provider: 'oidc', role: 'member' });
  });

  it('keeps open-redirect attempts out', async () => {
    claims = { sub: 'u-4', email: 'y@example.com' };
    const login = await app.inject({ method: 'GET', url: '/api/auth/oidc/login?returnTo=//evil.example.com' });
    lastNonce = new URL(login.headers.location as string).searchParams.get('nonce')!;
    const cb = await app.inject({
      method: 'GET',
      url: `/api/auth/oidc/callback?code=abc&state=${new URL(login.headers.location as string).searchParams.get('state')}`,
    });
    expect(new URLSearchParams(new URL(cb.headers.location as string).hash.slice(1)).get('returnTo')).toBe('/');
  });
});
