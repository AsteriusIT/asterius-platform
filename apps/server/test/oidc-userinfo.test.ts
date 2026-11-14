import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';
import type { FastifyInstance } from 'fastify';
import { client, testApp } from './helpers.js';

// A provider shaped like Asterius Identity (or any strict OIDC Core §5.4 server): only client_secret_basic at the
// token endpoint, and the scope claims (email, profile) at UserInfo, never in the ID token.
const hoisted = await vi.hoisted(async () => {
  const http = await import('node:http');
  const srv = http.createServer();
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const p = (srv.address() as { port: number }).port;
  process.env.AUTH_PROVIDERS = 'local,oidc';
  process.env.OIDC_ISSUER = `http://127.0.0.1:${p}/t/demo`;
  process.env.OIDC_CLIENT_ID = 'c.platform';
  process.env.OIDC_CLIENT_SECRET = 's3cr:et';
  process.env.OIDC_ADMIN_GROUPS = 'platform-admins';
  return { srv, port: p };
});
const issuer = `http://127.0.0.1:${hoisted.port}/t/demo`;

let idp: http.Server;
let app: FastifyInstance;
let jwk: JWK;
let signKey: CryptoKey;
let idClaims: Record<string, unknown> = {};
let userinfo: Record<string, unknown> | null = {};
let lastNonce = '';
let tokenRequest: { body: URLSearchParams; authorization?: string } | undefined;
let userinfoAuth: string | undefined;

beforeAll(async () => {
  const { publicKey, privateKey } = await generateKeyPair('ES256');
  signKey = privateKey as CryptoKey;
  jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'ES256', use: 'sig' };
  idp = hoisted.srv;
  idp.on('request', (req, res) => {
    const send = (body: unknown, status = 200) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.url === '/t/demo/.well-known/openid-configuration')
      return send({
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        userinfo_endpoint: `${issuer}/userinfo`,
        jwks_uri: `${issuer}/jwks`,
        token_endpoint_auth_methods_supported: ['private_key_jwt', 'client_secret_basic'],
      });
    if (req.url === '/t/demo/jwks') return send({ keys: [jwk] });
    if (req.url === '/t/demo/userinfo') {
      userinfoAuth = req.headers.authorization;
      if (req.headers.authorization !== 'Bearer at-1' || !userinfo) return send({ error: 'invalid_token' }, 401);
      return send(userinfo);
    }
    if (req.url === '/t/demo/token') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', async () => {
        tokenRequest = { body: new URLSearchParams(body), authorization: req.headers.authorization };
        // The server refuses client_secret_post, like Asterius does.
        if (tokenRequest.body.has('client_secret')) return send({ error: 'invalid_client' }, 401);
        const jwt = await new SignJWT({ ...idClaims, nonce: lastNonce })
          .setProtectedHeader({ alg: 'ES256', kid: 'k1' })
          .setIssuer(issuer)
          .setAudience('c.platform')
          .setExpirationTime('5m')
          .sign(signKey);
        send({ id_token: jwt, access_token: 'at-1', token_type: 'Bearer' });
      });
      return;
    }
    res.writeHead(404).end();
  });
  app = await testApp();
});
afterAll(async () => {
  await app.close();
  idp.close();
});

async function signIn() {
  const login = await app.inject({ method: 'GET', url: '/api/auth/oidc/login?returnTo=/catalog' });
  const auth = new URL(login.headers.location as string);
  lastNonce = auth.searchParams.get('nonce')!;
  const cb = await app.inject({ method: 'GET', url: `/api/auth/oidc/callback?code=abc&state=${auth.searchParams.get('state')}` });
  return new URL(cb.headers.location as string, 'http://x');
}

describe('generic OIDC against a strict provider', () => {
  it('authenticates with client_secret_basic when the provider does not offer client_secret_post', async () => {
    idClaims = { sub: 'u-1' };
    userinfo = { sub: 'u-1', email: 'Dev@Example.com', email_verified: true, name: 'Dev', groups: ['platform-admins'] };
    const to = await signIn();
    expect(to.pathname).toBe('/auth/callback');
    // RFC 6749 §2.3.1: form-urlencoded id and secret, then base64 of "id:secret".
    const expected = Buffer.from(`${encodeURIComponent('c.platform')}:${encodeURIComponent('s3cr:et')}`).toString('base64');
    expect(tokenRequest?.authorization).toBe(`Basic ${expected}`);
    expect(tokenRequest?.body.has('client_secret')).toBe(false);
    expect(tokenRequest?.body.get('code_verifier')).toBeTruthy();
  });

  it('reads email, name and groups from UserInfo when the ID token does not carry them', async () => {
    idClaims = { sub: 'u-2' };
    userinfo = { sub: 'u-2', email: 'Ops@Example.com', email_verified: true, name: 'Ops', groups: ['platform-admins'] };
    const to = await signIn();
    expect(to.pathname).toBe('/auth/callback');
    expect(userinfoAuth).toBe('Bearer at-1');
    const me = (await client(app, new URLSearchParams(to.hash.slice(1)).get('token')!).get('/api/auth/me')).data;
    expect(me).toMatchObject({ email: 'ops@example.com', name: 'Ops', provider: 'oidc', role: 'admin' });
  });

  it('refuses UserInfo claims about another subject (OIDC Core §5.3.2)', async () => {
    idClaims = { sub: 'u-3' };
    userinfo = { sub: 'someone-else', email: 'victim@example.com', email_verified: true };
    const to = await signIn();
    expect(to.pathname).toBe('/login');
    expect(to.searchParams.get('error')).toMatch(/subject/);
  });

  it('still fails clearly when neither the ID token nor UserInfo has an email', async () => {
    idClaims = { sub: 'u-4' };
    userinfo = { sub: 'u-4', name: 'Nobody' };
    const to = await signIn();
    expect(to.pathname).toBe('/login');
    expect(to.searchParams.get('error')).toMatch(/email/);
  });
});
