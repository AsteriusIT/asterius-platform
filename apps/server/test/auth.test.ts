import { generateKeyPairSync, createVerify } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { http } from '../src/lib/http.js';
import { signJwtRs256, signSigV4, validateAuth } from '../src/lib/auth.js';

async function server(handler: (req: IncomingMessage, body: string, res: ServerResponse) => void) {
  const seen: Array<{ url: string; headers: IncomingMessage['headers']; body: string }> = [];
  const s = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.push({ url: req.url ?? '', headers: req.headers, body });
      handler(req, body, res);
    });
  });
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(s.address() as AddressInfo).port}`, seen, close: () => new Promise((r) => s.close(r)) };
}
const json = (res: ServerResponse, body: unknown, status = 200) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));

describe('auth blocks', () => {
  it('validates the block', () => {
    expect(() => validateAuth({ type: 'nope' })).toThrow(/auth/);
    expect(() => validateAuth({ type: 'oauth2-client-credentials', tokenUrl: 'x' })).toThrow();
    expect(() => validateAuth(undefined)).not.toThrow();
  });

  it('oauth2 client credentials: fetches once, caches, refreshes after a 401', async () => {
    let issued = 0;
    const idp = await server((_q, _b, res) => json(res, { access_token: `tok${++issued}`, expires_in: 3600 }));
    const api = await server((req, _b, res) => (req.headers.authorization === 'Bearer tok2' ? json(res, { ok: true }) : json(res, {}, 401)));
    const auth = { type: 'oauth2-client-credentials', tokenUrl: `${idp.url}/token`, clientId: 'cid', clientSecret: 'sec', scope: 'read' };
    const res = await http<{ ok: boolean }>(`${api.url}/x`, { auth });
    expect(res.data.ok).toBe(true);
    expect(issued).toBe(2); // tok1 rejected → invalidated → tok2
    expect(idp.seen[0]!.body).toContain('grant_type=client_credentials');
    expect(idp.seen[0]!.body).toContain('client_secret=sec');
    await http(`${api.url}/x`, { auth });
    expect(issued).toBe(2); // cached
    await idp.close();
    await api.close();
  });

  it('basic auth', async () => {
    const api = await server((_q, _b, res) => json(res, {}));
    await http(`${api.url}/x`, { auth: { type: 'basic', username: 'u', password: 'p' } });
    expect(api.seen[0]!.headers.authorization).toBe(`Basic ${Buffer.from('u:p').toString('base64')}`);
    await api.close();
  });

  it('GitHub App: signs an app JWT and uses the installation token', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const pem = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
    const gh = await server((req, _b, res) =>
      req.url?.startsWith('/app/installations/')
        ? json(res, { token: 'ghs_inst', expires_at: new Date(Date.now() + 3600_000).toISOString() }, 201)
        : json(res, { ok: true }),
    );
    await http(`${gh.url}/orgs/x/repos`, { auth: { type: 'github-app', appId: 42, installationId: 7, privateKey: pem, apiUrl: gh.url } });
    const jwt = String(gh.seen[0]!.headers.authorization).replace('Bearer ', '');
    const [h, p, s] = jwt.split('.');
    expect(JSON.parse(Buffer.from(p!, 'base64url').toString()).iss).toBe('42');
    expect(createVerify('RSA-SHA256').update(`${h}.${p}`).verify(publicKey, Buffer.from(s!, 'base64url'))).toBe(true);
    expect(gh.seen[1]!.headers.authorization).toBe('Bearer ghs_inst');
    expect(signJwtRs256({ a: 1 }, pem).split('.')).toHaveLength(3);
    await gh.close();
  });

  it('signs requests with AWS SigV4 (deterministic)', () => {
    const h = signSigV4(
      { url: 'https://example.amazonaws.com/?Param2=value2&Param1=value1', method: 'GET' },
      { region: 'us-east-1', service: 'service', accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY' },
      new Date('2015-08-30T12:36:00Z'),
    );
    expect(h.authorization).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/20150830\/us-east-1\/service\/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/,
    );
    expect(h['x-amz-date']).toBe('20150830T123600Z');
  });
});
