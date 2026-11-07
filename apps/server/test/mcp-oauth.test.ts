import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';
import type { FastifyInstance } from 'fastify';
import { client, register, testApp } from './helpers.js';
import { run } from '../src/db.js';

const port = vi.hoisted(() => {
  const p = 20000 + Math.floor(Math.random() * 20000);
  process.env.AUTH_PROVIDERS = 'local,oidc';
  process.env.OIDC_ISSUER = `http://127.0.0.1:${p}`;
  process.env.OIDC_CLIENT_ID = 'asterius';
  process.env.OIDC_CLIENT_SECRET = 'shh';
  process.env.MCP_OAUTH_AUDIENCES = 'claude-connector';
  return p;
});
const issuer = `http://127.0.0.1:${port}`;
const resource = 'http://platform.test/api/mcp';

let idp: http.Server;
let app: FastifyInstance;
let jwk: JWK;
let signKey: CryptoKey;
let sessionToken: string;

const sign = (o: { iss?: string; aud?: string; exp?: string | number; sub?: string; key?: CryptoKey } = {}) =>
  new SignJWT({ email: 'sso@example.com' })
    .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
    .setIssuer(o.iss ?? issuer)
    .setAudience(o.aud ?? resource)
    .setSubject(o.sub ?? 'kc-sub-1')
    .setIssuedAt()
    .setExpirationTime(o.exp ?? '5m')
    .sign(o.key ?? signKey);
const mcp = (token: string, url = '/api/mcp', method = 'ping', params?: object) =>
  app.inject({
    method: 'POST',
    url,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    payload: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });

beforeAll(async () => {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  signKey = privateKey as CryptoKey;
  jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
  idp = http.createServer((req, res) => {
    const send = (body: unknown) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    if (req.url === '/.well-known/openid-configuration')
      return send({ issuer, authorization_endpoint: `${issuer}/auth`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks` });
    if (req.url === '/jwks') return send({ keys: [jwk] });
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => idp.listen(port, '127.0.0.1', r));
  app = await testApp();
  const reg = await register(app, 'sso@example.com');
  sessionToken = reg.token;
  // The account of this person was created by an earlier OIDC sign-in.
  await run("UPDATE users SET provider = 'oidc', external_id = ? WHERE id = ?", `${issuer}|kc-sub-1`, reg.user.id);
});
afterAll(async () => {
  await app.close();
  await new Promise((r) => idp.close(r));
});

describe('MCP OAuth 2.1 resource server', () => {
  it('serves RFC 9728 metadata, plain and path-suffixed', async () => {
    for (const url of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/api/mcp']) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        resource,
        authorization_servers: [issuer],
        bearer_methods_supported: ['header'],
        scopes_supported: ['openid', 'profile', 'email'],
      });
      expect(res.json().resource_documentation).toBeTruthy();
    }
    const v1 = await app.inject({ method: 'GET', url: '/.well-known/oauth-protected-resource/api/v1/mcp' });
    expect(v1.json().resource).toBe('http://platform.test/api/v1/mcp');
  });

  it('challenges with the metadata URL on 401', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/mcp', payload: {} });
    expect(res.statusCode).toBe(401);
    expect(res.headers['www-authenticate']).toBe(
      'Bearer realm="asterius-platform", resource_metadata="http://platform.test/.well-known/oauth-protected-resource/api/mcp"',
    );
  });

  it('accepts an access token of the issuer and maps it to the user', async () => {
    expect((await mcp(await sign())).statusCode).toBe(200);
    expect((await mcp(await sign({ aud: 'claude-connector' }), '/api/v1/mcp')).statusCode).toBe(200);
    const who = await mcp(await sign(), '/api/mcp', 'tools/call', { name: 'whoami', arguments: {} });
    expect(who.json().result.content[0].text).toContain('sso@example.com');
  });

  it('rejects wrong audience, expired, unknown issuer, bad signature and unknown users', async () => {
    expect((await mcp(await sign({ aud: 'someone-else' }))).statusCode).toBe(401);
    expect((await mcp(await sign({ exp: Math.floor(Date.now() / 1000) - 120 }))).statusCode).toBe(401);
    expect((await mcp(await sign({ iss: 'https://evil.example.com' }))).statusCode).toBe(401);
    expect((await mcp(await sign({ key: (await generateKeyPair('RS256')).privateKey as CryptoKey }))).statusCode).toBe(401);
    expect((await mcp(await sign({ sub: 'nobody' }))).statusCode).toBe(401);
  });

  it('keeps API tokens working', async () => {
    const t = await client(app, sessionToken).post('/api/v1/tokens', { name: 'mcp' });
    expect((await mcp(t.data.token)).statusCode).toBe(200);
  });
});
