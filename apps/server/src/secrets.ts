import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import { config, paths } from './config.js';
import { all, dialect, now, one, run } from './db.js';
import { badRequest, notFound } from './lib/errors.js';
import { MIN_SECRET_LENGTH, type RefResolver } from './lib/expr.js';
import type { SecretInfo } from '@asterius/shared';
import { providerOf, resolveExternal } from './secret-providers/index.js';
import { DEFAULT_ORG, orgId } from './orgs/context.js';
import { assertPlatformIdentityAllowed } from './orgs/orgs.js';

/**
 * Secrets used by invokers, integrations and webhooks are never stored in their configuration. Configurations hold
 * references, resolved at execution time:
 *   ${secret:NAME}  a secret stored encrypted (AES-256-GCM) in the database, managed by admins in the UI/API;
 *   ${env:NAME}     an environment variable of the platform pods (e.g. from a Kubernetes Secret / External Secrets).
 *                   Pod environment is shared by every tenant: only the default organization may reference it.
 * Secrets belong to an organization and only resolve in it.
 * Platform settings (DATABASE_URL, SECRETS_KEY, …) can never be referenced.
 */

function parseKey(raw: string, what: string): Buffer {
  const key = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
  if (key.length !== 32) throw new Error(`${what} must be 32 bytes (64 hex chars or base64)`);
  return key;
}

const KEY_ID = /^[A-Za-z0-9_-]{1,32}$/;

/** `id:key,id:key` → ordered ring. Key material never appears in error messages. */
export function parseKeyRing(raw: string, what: string): { id: string; key: Buffer }[] {
  const ring = raw
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)
    .map((entry) => {
      const i = entry.indexOf(':');
      const id = i < 0 ? '' : entry.slice(0, i);
      if (!KEY_ID.test(id)) throw new Error(`${what}: entries look like id:key (id: letters, digits, - and _)`);
      return { id, key: parseKey(entry.slice(i + 1), `${what} key "${id}"`) };
    });
  if (!ring.length) throw new Error(`${what} is empty`);
  if (new Set(ring.map((k) => k.id)).size !== ring.length) throw new Error(`${what}: duplicate key ids`);
  return ring;
}

function loadLegacyKey(): Buffer | undefined {
  if (config.SECRETS_KEY) return parseKey(config.SECRETS_KEY, 'SECRETS_KEY');
  if (config.SECRETS_KEYS) return undefined;
  if (dialect === 'postgres') throw new Error('SECRETS_KEY (or SECRETS_KEYS) is required with Postgres (several replicas must share the key)');
  if (fs.existsSync(paths.secretsKey)) return Buffer.from(fs.readFileSync(paths.secretsKey, 'utf8').trim(), 'base64');
  const key = randomBytes(32);
  fs.mkdirSync(config.DATA_DIR, { recursive: true });
  fs.writeFileSync(paths.secretsKey, key.toString('base64'), { mode: 0o600 });
  return key;
}

const legacyKey = loadLegacyKey();
/** Newest first. v1 values (no key id) are tried against every key. */
const ring: { id: string; key: Buffer }[] = [
  ...(config.SECRETS_KEYS ? parseKeyRing(config.SECRETS_KEYS, 'SECRETS_KEYS') : []),
  ...(legacyKey ? [{ id: config.SECRETS_KEYS ? 'legacy' : 'default', key: legacyKey }] : []),
].filter((k, i, a) => a.findIndex((o) => o.id === k.id) === i);
const current = ring[0]!;

export const currentKeyId = () => current.id;

/** Stored format v2: `v2:<keyId>:<iv>:<tag>:<data>` (base64 except the id, which is authenticated as AAD). */
export function encrypt(plain: string) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', current.key, iv);
  c.setAAD(Buffer.from(current.id));
  const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return `v2:${current.id}:${iv.toString('base64')}:${c.getAuthTag().toString('base64')}:${enc.toString('base64')}`;
}

function open(key: Buffer, iv: string, tag: string, data: string, aad?: string) {
  const d = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
  if (aad) d.setAAD(Buffer.from(aad));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(data, 'base64')), d.final()]).toString('utf8');
}

export function decrypt(stored: string) {
  const parts = stored.split(':');
  if (parts[0] === 'v2' && parts.length === 5) {
    const [, id, iv, tag, data] = parts as [string, string, string, string, string];
    const k = ring.find((x) => x.id === id);
    if (!k) throw new Error(`secret encrypted with unknown key "${id}": add it to SECRETS_KEYS`);
    return open(k.key, iv, tag, data, id);
  }
  const [v, iv, tag, data] = parts;
  if (v !== 'v1' || !iv || !tag || !data) throw new Error('unsupported secret format');
  for (const k of ring) {
    try {
      return open(k.key, iv, tag, data);
    } catch {
      // try the next key
    }
  }
  throw new Error('secret cannot be decrypted with any configured key');
}

/** Key id a stored value was sealed with (`v1` values predate key ids). */
export const keyIdOf = (stored: string) => (stored.startsWith('v2:') ? stored.split(':')[1]! : 'v1');

/**
 * Maintenance: re-encrypt every stored secret with the current (first) key. Run after adding a new key at the head
 * of SECRETS_KEYS; once nothing reports an old key id the old key can be removed. Safe to repeat and to run while
 * the platform serves traffic (each row is updated only if it was not changed meanwhile).
 */
export async function reencryptSecrets(): Promise<{ total: number; reencrypted: number; failed: string[] }> {
  // Every organization's secrets: the key ring is the platform's.
  const rows = await all<{ org_id: string; name: string; value_enc: string }>('SELECT org_id, name, value_enc FROM secrets');
  let reencrypted = 0;
  const failed: string[] = [];
  for (const r of rows) {
    if (keyIdOf(r.value_enc) === current.id) continue;
    try {
      const { changes } = await run(
        'UPDATE secrets SET value_enc = ? WHERE org_id = ? AND name = ? AND value_enc = ?',
        encrypt(decrypt(r.value_enc)),
        r.org_id,
        r.name,
        r.value_enc,
      );
      reencrypted += changes;
    } catch {
      failed.push(`${r.org_id}/${r.name}`);
    }
  }
  return { total: rows.length, reencrypted, failed };
}

export const SECRET_NAME = /^[A-Za-z0-9_.-]{1,100}$/;

export async function listSecrets(): Promise<SecretInfo[]> {
  const rows = await all<{ name: string; description: string; updated_at: string }>(
    'SELECT name, description, updated_at FROM secrets WHERE org_id = ? ORDER BY name',
    orgId(),
  );
  return rows.map((r) => ({ name: r.name, description: r.description, updatedAt: r.updated_at }));
}

/** Returned when a secret is too short to be masked in logs and results (see redact). */
export const shortSecretWarning = (value: string) =>
  value.length < MIN_SECRET_LENGTH
    ? `This secret is shorter than ${MIN_SECRET_LENGTH} characters: it will not be masked if it appears in run logs or results. Prefer a longer value.`
    : undefined;

export async function setSecret(name: string, value: string, description: string, userId: string | null) {
  if (!SECRET_NAME.test(name)) throw badRequest('Secret names may contain letters, digits, _ . - (max 100)');
  const enc = encrypt(value);
  const org = orgId();
  const existing = await one('SELECT name FROM secrets WHERE org_id = ? AND name = ?', org, name);
  if (existing)
    await run(
      'UPDATE secrets SET value_enc = ?, description = ?, updated_by = ?, updated_at = ? WHERE org_id = ? AND name = ?',
      enc,
      description,
      userId,
      now(),
      org,
      name,
    );
  else
    await run(
      'INSERT INTO secrets (org_id, name, value_enc, description, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      org,
      name,
      enc,
      description,
      userId,
      now(),
    );
}

export async function deleteSecret(name: string) {
  const { changes } = await run('DELETE FROM secrets WHERE org_id = ? AND name = ?', orgId(), name);
  if (!changes) throw notFound(`Secret ${name}`);
}

const PLATFORM_SETTINGS = new Set(Object.keys(config));

export const resolveRef: RefResolver = async (kind, name) => {
  if (providerOf(kind)) {
    await assertPlatformIdentityAllowed(orgId(), `\${${kind}:…} (external secret manager)`);
    return resolveExternal(kind, name);
  }
  if (kind === 'env') {
    if (orgId() !== DEFAULT_ORG)
      throw new Error(`\${env:${name}}: environment references are reserved to the default organization; store the value as a secret`);
    if (PLATFORM_SETTINGS.has(name)) throw new Error(`\${env:${name}} is a platform setting and cannot be referenced`);
    const v = process.env[name];
    if (v === undefined) throw new Error(`Environment variable ${name} is not set`);
    return v;
  }
  const row = await one<{ value_enc: string }>('SELECT value_enc FROM secrets WHERE org_id = ? AND name = ?', orgId(), name);
  if (!row) throw new Error(`Secret ${name} is not defined (Admin → Secrets)`);
  return decrypt(row.value_enc);
};

/** Resolve a single value that may be a reference (`${secret:X}`) or a literal. */
export async function resolveValue(v: unknown): Promise<string | undefined> {
  if (typeof v !== 'string' || !v) return undefined;
  const m = /^\$\{(secret|env|vault|awssm|azkv|gcpsm|k8s):([^}\s]+)\}$/.exec(v.trim());
  return m ? resolveRef(m[1]!, m[2]!) : v;
}

/**
 * Run callback tokens: HMAC of the run id with a key derived from SECRETS_KEY. Nothing to store, verifiable by any
 * replica, and scoped to one run (a pipeline can only report on the run that started it).
 */
const derivedCallbackKey = () =>
  legacyKey ? createHmac('sha256', legacyKey).update('run-callback-v1').digest() : createHmac('sha256', current.key).update('run-callback-v1').digest();
const callbackRing: Buffer[] = config.CALLBACK_KEYS
  ? config.CALLBACK_KEYS.split(',')
      .map((x) => x.trim())
      .filter(Boolean)
      .map((e) => (e === 'derived' ? derivedCallbackKey() : parseKeyRing(e, 'CALLBACK_KEYS')[0]!.key))
  : [derivedCallbackKey()];
if (!callbackRing.length) throw new Error('CALLBACK_KEYS is empty');
const mac = (key: Buffer, msg: string) => `astrun_${createHmac('sha256', key).update(msg).digest('base64url')}`;

/** Value of the DNS TXT record proving an organization controls an email domain (stable, nothing stored). */
const domainKey = createHmac('sha256', legacyKey ?? current.key)
  .update('domain-verification-v1')
  .digest();
export const domainToken = (org: string, domain: string) =>
  createHmac('sha256', domainKey).update(`${org}:${domain.toLowerCase()}`).digest('base64url').slice(0, 32);
export const runToken = (runId: string) => mac(callbackRing[0]!, runId);
/** Workflow steps get their own token: a pipeline can only report on the step that started it. */
export const stepToken = (runId: string, stepId: string) => mac(callbackRing[0]!, `${runId}:${stepId}`);
const same = (a: string, b: string | undefined) => !!b && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
/** Verify against every key of the ring (always all of them: constant work regardless of which one matches). */
const verify = (msg: string, token: string | undefined) => callbackRing.map((k) => same(mac(k, msg), token)).reduce((a, b) => a || b, false);
export const checkRunToken = (runId: string, token: string | undefined) => verify(runId, token);
export const checkStepToken = (runId: string, stepId: string, token: string | undefined) => verify(`${runId}:${stepId}`, token);
