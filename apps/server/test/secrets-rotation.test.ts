import { createCipheriv, randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hex = () => randomBytes(32).toString('hex');
const A = hex();
const B = hex();
const legacy = hex();
const ENV = ['SECRETS_KEY', 'SECRETS_KEYS', 'CALLBACK_KEYS'];

async function load(env: Record<string, string | undefined>) {
  vi.resetModules();
  for (const k of ENV) delete process.env[k];
  for (const [k, v] of Object.entries(env)) if (v !== undefined) process.env[k] = v;
  return import('../src/secrets.js');
}

beforeEach(() => {
  process.env.SECRETS_KEY = legacy;
});
afterEach(() => {
  for (const k of ENV) delete process.env[k];
});

describe('SECRETS_KEYS ring', () => {
  it('reads values written before rotation (v1 with the legacy key) and seals new ones with the newest key', async () => {
    const old = await load({ SECRETS_KEY: legacy });
    expect(old.encrypt('hunter2')).toMatch(/^v2:default:/);
    // A genuine v1 value, as written by earlier releases:
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', Buffer.from(legacy, 'hex'), iv);
    const enc = Buffer.concat([c.update('old-secret', 'utf8'), c.final()]);
    const v1 = `v1:${iv.toString('base64')}:${c.getAuthTag().toString('base64')}:${enc.toString('base64')}`;

    const rotated = await load({ SECRETS_KEY: legacy, SECRETS_KEYS: `k2:${A}` });
    expect(rotated.decrypt(v1)).toBe('old-secret');
    const fresh = rotated.encrypt('new');
    expect(fresh).toMatch(/^v2:k2:/);
    expect(rotated.decrypt(fresh)).toBe('new');
  });

  it('refuses values sealed with a key that left the ring, and tampered key ids', async () => {
    const m1 = await load({ SECRETS_KEYS: `k1:${A},k0:${B}` });
    const sealed = m1.encrypt('x');
    const m2 = await load({ SECRETS_KEYS: `k2:${B}` });
    expect(() => m2.decrypt(sealed)).toThrow(/unknown key "k1"/);
    const m3 = await load({ SECRETS_KEYS: `k1:${A},k0:${B}` });
    expect(() => m3.decrypt(sealed.replace('v2:k1:', 'v2:k0:'))).toThrow();
  });

  it('rejects malformed rings without echoing key material', async () => {
    await expect(load({ SECRETS_KEYS: `nocolon${A}` })).rejects.toThrow(/id:key/);
    await expect(load({ SECRETS_KEYS: 'k1:tooshort' })).rejects.toThrow(/must be 32 bytes/);
    await load({ SECRETS_KEYS: 'k1:tooshort' }).catch((e: Error) => expect(e.message).not.toContain('tooshort'));
  });

  it('re-encrypts stored secrets with the newest key', async () => {
    const m1 = await load({ SECRETS_KEYS: `k1:${A}` });
    await m1.setSecret('DB_PASSWORD', 'p@ss', '', null);
    const m2 = await load({ SECRETS_KEYS: `k2:${B},k1:${A}` });
    const dbm = await import('../src/db.js');
    const before = await dbm.one<{ value_enc: string }>('SELECT value_enc FROM secrets WHERE name = ?', 'DB_PASSWORD');
    expect(m2.keyIdOf(before!.value_enc)).toBe('k1');
    expect(await m2.reencryptSecrets()).toMatchObject({ total: 1, reencrypted: 1, failed: [] });
    expect((await m2.reencryptSecrets()).reencrypted).toBe(0);
    const m3 = await load({ SECRETS_KEYS: `k2:${B}` }); // k1 retired
    expect(await m3.resolveValue('${secret:DB_PASSWORD}')).toBe('p@ss');
  });
});

describe('CALLBACK_KEYS ring', () => {
  it('keeps tokens valid across rotation', async () => {
    const m1 = await load({ SECRETS_KEY: legacy });
    const oldToken = m1.runToken('run-1');
    const m2 = await load({ SECRETS_KEY: legacy, CALLBACK_KEYS: `n1:${A},derived` });
    expect(m2.checkRunToken('run-1', oldToken)).toBe(true); // derived key still accepted
    const t = m2.runToken('run-1');
    expect(t).not.toBe(oldToken);
    expect(m2.checkRunToken('run-1', t)).toBe(true);
    expect(m2.checkRunToken('run-2', t)).toBe(false);
    expect(m2.checkStepToken('run-1', 's', m2.stepToken('run-1', 's'))).toBe(true);
    const m3 = await load({ SECRETS_KEY: legacy, CALLBACK_KEYS: `n1:${A}` }); // derived retired
    expect(m3.checkRunToken('run-1', oldToken)).toBe(false);
    expect(m3.checkRunToken('run-1', t)).toBe(true);
  });

  it('is independent of SECRETS_KEY once configured', async () => {
    const a = await load({ SECRETS_KEY: legacy, CALLBACK_KEYS: `n1:${A}` });
    const t = a.runToken('r');
    const b = await load({ SECRETS_KEY: hex(), CALLBACK_KEYS: `n1:${A}` });
    expect(b.checkRunToken('r', t)).toBe(true);
  });
});
