import { one } from './db.js';

/**
 * /readyz checks only what this pod needs to serve traffic: the database. Third-party systems (GitHub, ADO,
 * clusters…) are per integration/action and reported there; their outage must not take the portal down.
 */
let cached: { at: number; ok: boolean; error?: string } | undefined;

/**
 * Liveness of background loops. A loop registers with the longest silence it tolerates and calls `beat` after every
 * iteration (successful or not: a failing loop is alive, a hung one is not). /healthz reports stuck loops so the
 * orchestrator restarts a replica whose scheduler stopped without crashing.
 */
const loops = new Map<string, { maxSilenceMs: number; lastBeat: number }>();

export function registerLoop(name: string, maxSilenceMs: number) {
  loops.set(name, { maxSilenceMs, lastBeat: Date.now() });
  return () => void loops.delete(name);
}

export function beat(name: string) {
  const l = loops.get(name);
  if (l) l.lastBeat = Date.now();
}

/** Loops that have been silent for too long (empty when everything is healthy). */
export function stuckLoops(): string[] {
  const t = Date.now();
  return [...loops].filter(([, l]) => t - l.lastBeat > l.maxSilenceMs).map(([name]) => name);
}

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
