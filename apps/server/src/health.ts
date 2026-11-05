import { one } from './db.js';

/**
 * /readyz checks only what this pod needs to serve traffic: the database. Third-party systems (GitHub, ADO,
 * clusters…) are per integration/action and reported there; their outage must not take the portal down.
 */
let cached: { at: number; ok: boolean; error?: string } | undefined;

export async function ready() {
  if (cached && Date.now() - cached.at < 5_000) return { ok: cached.ok, ...(cached.error ? { error: cached.error } : {}) };
  try {
    await Promise.race([one('SELECT 1 AS ok'), new Promise((_, reject) => setTimeout(() => reject(new Error('database timeout')), 3000).unref())]);
    cached = { at: Date.now(), ok: true };
  } catch (err) {
    cached = { at: Date.now(), ok: false, error: (err as Error).message };
  }
  return { ok: cached.ok, ...(cached.error ? { error: cached.error } : {}) };
}
