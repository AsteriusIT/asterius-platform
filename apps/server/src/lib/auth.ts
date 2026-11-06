import { createHash, createHmac, createPrivateKey, createSign } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Agent } from 'undici';
import { guardedLookup } from './netguard.js';
import { authDef, type AuthDef } from '../schemas.js';

/**
 * Generic authentication of outbound HTTP calls, shared by every HTTP-based source and invoker. A resource sets
 * `auth: { type: …, … }` in its config (secrets as `${secret:NAME}` references, already rendered when we see them).
 * Tokens are cached per credential until shortly before they expire.
 */

export interface AuthRequest {
  url: string;
  method: string;
  body?: string;
}
export interface AuthResult {
  headers: Record<string, string>;
  /** undici dispatcher carrying a client certificate (mtls). */
  dispatcher?: Agent;
}

/** Minimal fetcher used for token endpoints (injected by http.ts to keep retries, metrics and the circuit breaker). */
export type TokenFetch = (url: string, init: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{ data: unknown; text: string }>;

const cache = new Map<string, { token: string; expiresAt: number }>();
const dispatchers = new Map<string, Agent>();
const SKEW_MS = 60_000;

const keyOf = (a: AuthDef) => createHash('sha256').update(JSON.stringify(a)).digest('hex');

export function parseAuth(raw: unknown): AuthDef | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  return authDef.parse(raw);
}

/** Validate an `auth` block (throws a readable error). */
export function validateAuth(raw: unknown) {
  if (raw === undefined || raw === null) return;
  const r = authDef.safeParse(raw);
  if (!r.success) throw new Error(`auth: ${r.error.issues.map((i) => `${i.path.join('.') || 'type'} ${i.message}`).join('; ')}`);
}

export function invalidateAuth(raw: unknown) {
  const a = parseAuth(raw);
  if (a) cache.delete(keyOf(a));
}

async function cached(a: AuthDef, fetchToken: () => Promise<{ token: string; ttlSeconds: number }>): Promise<string> {
  const k = keyOf(a);
  const hit = cache.get(k);
  if (hit && hit.expiresAt - SKEW_MS > Date.now()) return hit.token;
  const { token, ttlSeconds } = await fetchToken();
  cache.set(k, { token, expiresAt: Date.now() + ttlSeconds * 1000 });
  return token;
}

const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64url');

/** RS256 JWT signed with a PEM key (PKCS#1 or PKCS#8). */
export function signJwtRs256(claims: Record<string, unknown>, pem: string, header: Record<string, unknown> = {}): string {
  const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', ...header }));
  const payload = b64url(JSON.stringify(claims));
  const sig = createSign('RSA-SHA256').update(`${head}.${payload}`).sign(createPrivateKey(pem));
  return `${head}.${payload}.${b64url(sig)}`;
}

const form = (o: Record<string, string | undefined>) =>
  new URLSearchParams(Object.entries(o).filter((e): e is [string, string] => e[1] !== undefined)).toString();
const FORM = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' };

interface TokenResponse {
  access_token?: string;
  expires_in?: number | string;
}
function tokenOf(data: unknown, what: string) {
  const d = (data ?? {}) as TokenResponse;
  if (!d.access_token) throw new Error(`${what}: the token endpoint returned no access_token`);
  return { token: d.access_token, ttlSeconds: Number(d.expires_in ?? 3600) };
}

// ---------- AWS Signature V4 ----------
const sha256Hex = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
const hmac = (key: Buffer | string, s: string) => createHmac('sha256', key).update(s).digest();

export function signSigV4(
  req: AuthRequest,
  c: { region: string; service: string; accessKeyId: string; secretAccessKey: string; sessionToken?: string },
  at = new Date(),
): Record<string, string> {
  const u = new URL(req.url);
  const amzDate = at.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const day = amzDate.slice(0, 8);
  const payloadHash = sha256Hex(req.body ?? '');
  const headers: Record<string, string> = { host: u.host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate };
  if (c.sessionToken) headers['x-amz-security-token'] = c.sessionToken;
  const names = Object.keys(headers).sort();
  const canonicalHeaders = names.map((n) => `${n}:${headers[n]!.trim()}\n`).join('');
  const query = [...u.searchParams.entries()]
    .map(([k, v]) => [encodeURIComponent(k), encodeURIComponent(v)] as const)
    .sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  const canonical = [req.method, u.pathname || '/', query, canonicalHeaders, names.join(';'), payloadHash].join('\n');
  const scope = `${day}/${c.region}/${c.service}/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonical)].join('\n');
  const key = hmac(hmac(hmac(hmac(`AWS4${c.secretAccessKey}`, day), c.region), c.service), 'aws4_request');
  const signature = createHmac('sha256', key).update(toSign).digest('hex');
  const out: Record<string, string> = {
    'x-amz-date': amzDate,
    'x-amz-content-sha256': payloadHash,
    authorization: `AWS4-HMAC-SHA256 Credential=${c.accessKeyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}`,
  };
  if (c.sessionToken) out['x-amz-security-token'] = c.sessionToken;
  return out;
}

interface AwsCreds {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}
const awsCache = new Map<string, { creds: AwsCreds; expiresAt: number }>();

/** IRSA / web identity: exchange the pod's projected token for temporary credentials. */
async function awsWebIdentity(fetchToken: TokenFetch): Promise<AwsCreds> {
  const file = process.env.AWS_WEB_IDENTITY_TOKEN_FILE;
  const role = process.env.AWS_ROLE_ARN;
  if (!file || !role) throw new Error('aws-sigv4: no accessKeyId/secretAccessKey and no AWS_WEB_IDENTITY_TOKEN_FILE / AWS_ROLE_ARN (IRSA) in the environment');
  const hit = awsCache.get(role);
  if (hit && hit.expiresAt - SKEW_MS > Date.now()) return hit.creds;
  const token = (await readFile(file, 'utf8')).trim();
  const sts = process.env.AWS_STS_ENDPOINT ?? `https://sts.${process.env.AWS_REGION ?? 'us-east-1'}.amazonaws.com/`;
  const res = await fetchToken(sts, {
    method: 'POST',
    headers: FORM,
    body: form({ Action: 'AssumeRoleWithWebIdentity', Version: '2011-06-15', RoleArn: role, RoleSessionName: 'asterius', WebIdentityToken: token }),
  });
  const pick = (tag: string) => new RegExp(`<${tag}>([^<]+)</${tag}>`).exec(res.text)?.[1];
  const accessKeyId = pick('AccessKeyId');
  const secretAccessKey = pick('SecretAccessKey');
  if (!accessKeyId || !secretAccessKey) throw new Error('aws-sigv4: STS returned no credentials');
  const creds = { accessKeyId, secretAccessKey, sessionToken: pick('SessionToken') };
  const exp = Date.parse(pick('Expiration') ?? '') || Date.now() + 3600_000;
  awsCache.set(role, { creds, expiresAt: exp });
  return creds;
}

// ---------- resolution ----------
export async function resolveAuth(raw: unknown, req: AuthRequest, fetchToken: TokenFetch): Promise<AuthResult> {
  const a = parseAuth(raw);
  if (!a) return { headers: {} };
  switch (a.type) {
    case 'basic':
      return { headers: { authorization: `Basic ${Buffer.from(`${a.username}:${a.password}`).toString('base64')}` } };
    case 'bearer':
      return { headers: { authorization: `Bearer ${a.token}` } };
    case 'oauth2-client-credentials': {
      const token = await cached(a, async () => {
        const headers: Record<string, string> = { ...FORM };
        const body: Record<string, string | undefined> = { grant_type: 'client_credentials', scope: a.scope, audience: a.audience };
        if (a.authStyle === 'basic')
          headers.authorization = `Basic ${Buffer.from(`${encodeURIComponent(a.clientId)}:${encodeURIComponent(a.clientSecret)}`).toString('base64')}`;
        else {
          body.client_id = a.clientId;
          body.client_secret = a.clientSecret;
        }
        return tokenOf((await fetchToken(a.tokenUrl, { method: 'POST', headers, body: form(body) })).data, 'oauth2');
      });
      return { headers: { authorization: `Bearer ${token}` } };
    }
    case 'github-app': {
      const api = (a.apiUrl ?? 'https://api.github.com').replace(/\/$/, '');
      const token = await cached(a, async () => {
        const iat = Math.floor(Date.now() / 1000) - 30;
        const jwt = signJwtRs256({ iat, exp: iat + 540, iss: a.appId }, a.privateKey);
        const res = await fetchToken(`${api}/app/installations/${encodeURIComponent(a.installationId)}/access_tokens`, {
          method: 'POST',
          headers: { authorization: `Bearer ${jwt}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' },
          body: '',
        });
        const d = res.data as { token?: string; expires_at?: string };
        if (!d.token) throw new Error('github-app: no installation token returned');
        return { token: d.token, ttlSeconds: d.expires_at ? (Date.parse(d.expires_at) - Date.now()) / 1000 : 3000 };
      });
      return { headers: { authorization: `Bearer ${token}` } };
    }
    case 'azure-managed-identity': {
      const token = await cached(a, async () => {
        const tokenFile = process.env.AZURE_FEDERATED_TOKEN_FILE;
        const clientId = a.clientId ?? process.env.AZURE_CLIENT_ID;
        const tenant = process.env.AZURE_TENANT_ID;
        if (tokenFile && clientId && tenant) {
          // AKS workload identity: federated token → Entra client assertion.
          const assertion = (await readFile(tokenFile, 'utf8')).trim();
          const host = process.env.AZURE_AUTHORITY_HOST ?? 'https://login.microsoftonline.com/';
          const res = await fetchToken(`${host.replace(/\/?$/, '/')}${tenant}/oauth2/v2.0/token`, {
            method: 'POST',
            headers: FORM,
            body: form({
              grant_type: 'client_credentials',
              client_id: clientId,
              scope: `${a.resource.replace(/\/$/, '')}/.default`,
              client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
              client_assertion: assertion,
            }),
          });
          return tokenOf(res.data, 'azure workload identity');
        }
        const q = form({ resource: a.resource, client_id: a.clientId, 'api-version': process.env.IDENTITY_ENDPOINT ? '2019-08-01' : '2018-02-01' });
        const base = process.env.IDENTITY_ENDPOINT ?? 'http://169.254.169.254/metadata/identity/oauth2/token';
        const headers: Record<string, string> = process.env.IDENTITY_HEADER ? { 'x-identity-header': process.env.IDENTITY_HEADER } : { metadata: 'true' };
        return tokenOf((await fetchToken(`${base}?${q}`, { headers })).data, 'azure managed identity');
      });
      return { headers: { authorization: `Bearer ${token}` } };
    }
    case 'gcp-service-account': {
      const token = await cached(a, async () => {
        if (!a.serviceAccountJson) {
          const res = await fetchToken('http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token', {
            headers: { 'metadata-flavor': 'Google' },
          });
          return tokenOf(res.data, 'gcp metadata server');
        }
        const sa = (typeof a.serviceAccountJson === 'string' ? JSON.parse(a.serviceAccountJson) : a.serviceAccountJson) as {
          client_email: string;
          private_key: string;
          token_uri?: string;
        };
        const iat = Math.floor(Date.now() / 1000);
        const aud = sa.token_uri ?? 'https://oauth2.googleapis.com/token';
        const jwt = signJwtRs256({ iss: sa.client_email, scope: a.scope, aud, iat, exp: iat + 3600 }, sa.private_key);
        return tokenOf(
          (await fetchToken(aud, { method: 'POST', headers: FORM, body: form({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt }) }))
            .data,
          'gcp',
        );
      });
      return { headers: { authorization: `Bearer ${token}` } };
    }
    case 'aws-sigv4': {
      const creds =
        a.accessKeyId && a.secretAccessKey
          ? { accessKeyId: a.accessKeyId, secretAccessKey: a.secretAccessKey, sessionToken: a.sessionToken }
          : await awsWebIdentity(fetchToken);
      return { headers: signSigV4(req, { region: a.region, service: a.service, ...creds }) };
    }
    case 'mtls': {
      const k = keyOf(a);
      let dispatcher = dispatchers.get(k);
      if (!dispatcher) {
        dispatcher = new Agent({ connect: { lookup: guardedLookup as never, cert: a.cert, key: a.key, ...(a.ca ? { ca: a.ca } : {}) } });
        dispatchers.set(k, dispatcher);
      }
      return { headers: {}, dispatcher };
    }
  }
}
