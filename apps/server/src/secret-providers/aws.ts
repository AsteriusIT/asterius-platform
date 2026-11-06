import { createHash, createHmac } from 'node:crypto';
import fs from 'node:fs';
import { config } from '../config.js';
import { httpJson, type SecretProvider } from './types.js';

/**
 * AWS Secrets Manager over HTTPS with SigV4 (no SDK). Credentials, in order: environment keys, or IRSA /
 * web-identity (AWS_ROLE_ARN + AWS_WEB_IDENTITY_TOKEN_FILE exchanged through STS), so pods need no static keys.
 */
interface Creds {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  until: number;
}
let creds: Creds | undefined;

const hmac = (key: Buffer | string, data: string) => createHmac('sha256', key).update(data).digest();
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

async function credentials(): Promise<Creds> {
  if (config.AWS_ACCESS_KEY_ID && config.AWS_SECRET_ACCESS_KEY)
    return { accessKeyId: config.AWS_ACCESS_KEY_ID, secretAccessKey: config.AWS_SECRET_ACCESS_KEY, sessionToken: config.AWS_SESSION_TOKEN, until: Infinity };
  if (creds && creds.until > Date.now()) return creds;
  const token = fs.readFileSync(config.AWS_WEB_IDENTITY_TOKEN_FILE!, 'utf8').trim();
  const sts = config.AWS_STS_ENDPOINT ?? `https://sts.${config.AWS_REGION}.amazonaws.com`;
  const q = new URLSearchParams({
    Action: 'AssumeRoleWithWebIdentity',
    Version: '2011-06-15',
    RoleArn: config.AWS_ROLE_ARN!,
    RoleSessionName: 'asterius-platform',
    WebIdentityToken: token,
    DurationSeconds: '3600',
  });
  const r = await httpJson<{
    AssumeRoleWithWebIdentityResponse: {
      AssumeRoleWithWebIdentityResult: { Credentials: { AccessKeyId: string; SecretAccessKey: string; SessionToken: string; Expiration: number } };
    };
  }>(`${sts}/?${q}`, { headers: { accept: 'application/json' } });
  const c = r.AssumeRoleWithWebIdentityResponse.AssumeRoleWithWebIdentityResult.Credentials;
  creds = { accessKeyId: c.AccessKeyId, secretAccessKey: c.SecretAccessKey, sessionToken: c.SessionToken, until: c.Expiration * 1000 - 120_000 };
  return creds;
}

/** Build the SigV4 headers of a JSON POST to a service endpoint. Exported for tests. */
export function signV4(p: {
  path?: string;
  host: string;
  region: string;
  service: string;
  target: string;
  body: string;
  amzDate: string;
  creds: Omit<Creds, 'until'>;
}) {
  const date = p.amzDate.slice(0, 8);
  const headers: Record<string, string> = {
    'content-type': 'application/x-amz-json-1.1',
    host: p.host,
    'x-amz-date': p.amzDate,
    'x-amz-target': p.target,
    ...(p.creds.sessionToken ? { 'x-amz-security-token': p.creds.sessionToken } : {}),
  };
  const names = Object.keys(headers).sort();
  const canonical = `POST\n${p.path ?? '/'}\n\n${names.map((n) => `${n}:${headers[n]}\n`).join('')}\n${names.join(';')}\n${sha(p.body)}`;
  const scope = `${date}/${p.region}/${p.service}/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', p.amzDate, scope, sha(canonical)].join('\n');
  const key = hmac(hmac(hmac(hmac(`AWS4${p.creds.secretAccessKey}`, date), p.region), p.service), 'aws4_request');
  const signature = createHmac('sha256', key).update(toSign).digest('hex');
  return { ...headers, authorization: `AWS4-HMAC-SHA256 Credential=${p.creds.accessKeyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}` };
}

/** `name` or `name#jsonKey` (when the secret is a JSON object). Secret names may contain `/`. */
export const awssm: SecretProvider = {
  kind: 'awssm',
  title: 'AWS Secrets Manager',
  example: 'prod/payments/db#password',
  enabled: () =>
    !!config.AWS_REGION && !!((config.AWS_ACCESS_KEY_ID && config.AWS_SECRET_ACCESS_KEY) || (config.AWS_ROLE_ARN && config.AWS_WEB_IDENTITY_TOKEN_FILE)),
  async get(ref) {
    const [id, field] = ref.split('#') as [string, string | undefined];
    const endpoint = new URL(config.AWS_SECRETSMANAGER_ENDPOINT ?? `https://secretsmanager.${config.AWS_REGION}.amazonaws.com`);
    const body = JSON.stringify({ SecretId: id });
    const headers = signV4({
      host: endpoint.host,
      path: endpoint.pathname,
      region: config.AWS_REGION!,
      service: 'secretsmanager',
      target: 'secretsmanager.GetSecretValue',
      body,
      amzDate: new Date().toISOString().replace(/[-:]|\.\d{3}/g, ''),
      creds: await credentials(),
    });
    const r = await httpJson<{ SecretString?: string }>(endpoint.href, { method: 'POST', headers, body });
    if (r.SecretString === undefined) throw new Error('binary secrets are not supported');
    if (!field) return r.SecretString;
    const v = (JSON.parse(r.SecretString) as Record<string, unknown>)[field];
    if (typeof v !== 'string') throw new Error(`key "${field}" not found or not a string`);
    return v;
  },
};
