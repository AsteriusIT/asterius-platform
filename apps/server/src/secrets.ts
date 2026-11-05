import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import { config, paths } from './config.js';
import { all, dialect, now, one, run } from './db.js';
import { badRequest, notFound } from './lib/errors.js';
import type { RefResolver } from './lib/expr.js';
import type { SecretInfo } from '@asterius/shared';

/**
 * Secrets used by invokers, integrations and webhooks are never stored in their configuration. Configurations hold
 * references, resolved at execution time:
 *   ${secret:NAME}  a secret stored encrypted (AES-256-GCM) in the database, managed by admins in the UI/API;
 *   ${env:NAME}     an environment variable of the platform pods (e.g. from a Kubernetes Secret / External Secrets).
 * Platform settings (DATABASE_URL, SECRETS_KEY, …) can never be referenced.
 */

function loadKey(): Buffer {
  const raw = config.SECRETS_KEY;
  if (raw) {
    const key = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
    if (key.length !== 32) throw new Error('SECRETS_KEY must be 32 bytes (64 hex chars or base64)');
    return key;
  }
  if (dialect === 'postgres') throw new Error('SECRETS_KEY is required with Postgres (several replicas must share the key)');
  if (fs.existsSync(paths.secretsKey)) return Buffer.from(fs.readFileSync(paths.secretsKey, 'utf8').trim(), 'base64');
  const key = randomBytes(32);
  fs.mkdirSync(config.DATA_DIR, { recursive: true });
  fs.writeFileSync(paths.secretsKey, key.toString('base64'), { mode: 0o600 });
  return key;
}

const key = loadKey();

export function encrypt(plain: string) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return `v1:${iv.toString('base64')}:${c.getAuthTag().toString('base64')}:${enc.toString('base64')}`;
}

export function decrypt(stored: string) {
  const [v, iv, tag, data] = stored.split(':');
  if (v !== 'v1' || !iv || !tag || !data) throw new Error('unsupported secret format');
  const d = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(data, 'base64')), d.final()]).toString('utf8');
}

export const SECRET_NAME = /^[A-Za-z0-9_.-]{1,100}$/;

export async function listSecrets(): Promise<SecretInfo[]> {
  const rows = await all<{ name: string; description: string; updated_at: string }>('SELECT name, description, updated_at FROM secrets ORDER BY name');
  return rows.map((r) => ({ name: r.name, description: r.description, updatedAt: r.updated_at }));
}

export async function setSecret(name: string, value: string, description: string, userId: string | null) {
  if (!SECRET_NAME.test(name)) throw badRequest('Secret names may contain letters, digits, _ . - (max 100)');
  const enc = encrypt(value);
  const existing = await one('SELECT name FROM secrets WHERE name = ?', name);
  if (existing)
    await run('UPDATE secrets SET value_enc = ?, description = ?, updated_by = ?, updated_at = ? WHERE name = ?', enc, description, userId, now(), name);
  else await run('INSERT INTO secrets (name, value_enc, description, updated_by, updated_at) VALUES (?, ?, ?, ?, ?)', name, enc, description, userId, now());
}

export async function deleteSecret(name: string) {
  const { changes } = await run('DELETE FROM secrets WHERE name = ?', name);
  if (!changes) throw notFound(`Secret ${name}`);
}

const PLATFORM_SETTINGS = new Set(Object.keys(config));

export const resolveRef: RefResolver = async (kind, name) => {
  if (kind === 'env') {
    if (PLATFORM_SETTINGS.has(name)) throw new Error(`\${env:${name}} is a platform setting and cannot be referenced`);
    const v = process.env[name];
    if (v === undefined) throw new Error(`Environment variable ${name} is not set`);
    return v;
  }
  const row = await one<{ value_enc: string }>('SELECT value_enc FROM secrets WHERE name = ?', name);
  if (!row) throw new Error(`Secret ${name} is not defined (Admin → Secrets)`);
  return decrypt(row.value_enc);
};

/** Resolve a single value that may be a reference (`${secret:X}`) or a literal. */
export async function resolveValue(v: unknown): Promise<string | undefined> {
  if (typeof v !== 'string' || !v) return undefined;
  const m = /^\$\{(secret|env):([A-Za-z0-9_.-]+)\}$/.exec(v.trim());
  return m ? resolveRef(m[1] as 'secret' | 'env', m[2]) : v;
}

/**
 * Run callback tokens: HMAC of the run id with a key derived from SECRETS_KEY. Nothing to store, verifiable by any
 * replica, and scoped to one run (a pipeline can only report on the run that started it).
 */
const callbackKey = createHmac('sha256', key).update('run-callback-v1').digest();
export const runToken = (runId: string) => `astrun_${createHmac('sha256', callbackKey).update(runId).digest('base64url')}`;
/** Workflow steps get their own token: a pipeline can only report on the step that started it. */
export const stepToken = (runId: string, stepId: string) => `astrun_${createHmac('sha256', callbackKey).update(`${runId}:${stepId}`).digest('base64url')}`;
const same = (a: string, b: string | undefined) => !!b && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
export const checkRunToken = (runId: string, token: string | undefined) => same(runToken(runId), token);
export const checkStepToken = (runId: string, stepId: string, token: string | undefined) => same(stepToken(runId, stepId), token);
