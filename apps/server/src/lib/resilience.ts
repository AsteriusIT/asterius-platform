import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Building blocks of the resilient outbound HTTP layer (used by `lib/http.ts`): retry policy with jittered
 * backoff, Retry-After / rate-limit header parsing, per-host concurrency limiter and a per-key circuit breaker.
 * Pure and dependency free so that it can be tested without a network.
 */

export interface RetryPolicy {
  /** Retries after the first attempt (0 disables retrying). */
  retries: number;
  baseMs: number;
  maxDelayMs: number;
}

export const IDEMPOTENT_METHODS = new Set(['GET', 'HEAD', 'OPTIONS', 'PUT', 'DELETE']);

/** 429 is always safe to retry (the request was rejected); 5xx and network errors only for idempotent methods. */
export function isRetryableStatus(status: number, method: string, headers?: Headers): boolean {
  if (status === 429) return true;
  // GitHub signals rate limiting with 403 + `x-ratelimit-remaining: 0` or a Retry-After header.
  if (status === 403 && headers && (headers.get('retry-after') || headers.get('x-ratelimit-remaining') === '0')) return true;
  return status >= 500 && status !== 501 && IDEMPOTENT_METHODS.has(method);
}

/** Retry-After (delta seconds or HTTP date) → milliseconds. */
export function parseRetryAfter(value: string | null | undefined, nowMs = Date.now()): number | undefined {
  if (!value) return undefined;
  const v = value.trim();
  if (/^\d+(\.\d+)?$/.test(v)) return Math.round(Number(v) * 1000);
  const at = Date.parse(v);
  return Number.isNaN(at) ? undefined : Math.max(0, at - nowMs);
}

/** Wait requested by the server: Retry-After, else X-RateLimit-Reset / RateLimit-Reset when the quota is exhausted. */
export function rateLimitWaitMs(headers: Headers, nowMs = Date.now()): number | undefined {
  const retryAfter = parseRetryAfter(headers.get('retry-after'), nowMs);
  if (retryAfter !== undefined) return retryAfter;
  const remaining = headers.get('x-ratelimit-remaining') ?? headers.get('ratelimit-remaining');
  if (remaining !== null && Number(remaining) > 0) return undefined;
  const reset = headers.get('x-ratelimit-reset') ?? headers.get('ratelimit-reset');
  if (reset === null || !/^\d+(\.\d+)?$/.test(reset)) return undefined;
  const n = Number(reset);
  // Either an epoch (seconds) or a number of seconds to wait.
  return n > 1e9 ? Math.max(0, n * 1000 - nowMs) : Math.round(n * 1000);
}

/** Exponential backoff with full jitter, capped. `random` is injectable for tests. */
export function backoffMs(attempt: number, policy: RetryPolicy, random = Math.random): number {
  const ceiling = Math.min(policy.maxDelayMs, policy.baseMs * 2 ** attempt);
  return Math.round(ceiling / 2 + (random() * ceiling) / 2);
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Caps the number of concurrent operations per key (host). Waiters are served in FIFO order. */
export class KeyedLimiter {
  private active = new Map<string, number>();
  private waiting = new Map<string, Array<() => void>>();
  constructor(private limit: number) {}

  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    if (this.limit <= 0) return fn();
    if ((this.active.get(key) ?? 0) >= this.limit) await new Promise<void>((resolve) => this.waiting.set(key, [...(this.waiting.get(key) ?? []), resolve]));
    else this.active.set(key, (this.active.get(key) ?? 0) + 1);
    try {
      return await fn();
    } finally {
      const next = this.waiting.get(key)?.shift();
      if (next)
        next(); // hand the slot over
      else {
        const n = (this.active.get(key) ?? 1) - 1;
        if (n <= 0) this.active.delete(key);
        else this.active.set(key, n);
      }
    }
  }
}

/** Opens after `threshold` consecutive failures; lets one probe through after `cooldownMs` (half-open). */
export class CircuitBreaker {
  private state = new Map<string, { failures: number; openUntil: number; probing: boolean }>();
  constructor(
    private threshold: number,
    private cooldownMs: number,
    private clock: () => number = Date.now,
  ) {}

  /** Returns the remaining open time in ms when calls must be refused, else 0. */
  check(key: string): number {
    const s = this.state.get(key);
    if (!s || s.failures < this.threshold) return 0;
    const t = this.clock();
    if (t < s.openUntil) return s.openUntil - t;
    if (s.probing) return Math.max(1, this.cooldownMs); // someone else is probing
    s.probing = true;
    return 0;
  }
  success(key: string) {
    this.state.delete(key);
  }
  /** Returns true when this failure opened (or re-opened) the circuit. */
  failure(key: string): boolean {
    const s = this.state.get(key) ?? { failures: 0, openUntil: 0, probing: false };
    s.failures++;
    s.probing = false;
    const opened = s.failures >= this.threshold;
    if (opened) s.openUntil = this.clock() + this.cooldownMs;
    this.state.set(key, s);
    return opened;
  }
  isOpen(key: string) {
    return this.check(key) > 0;
  }
}

/** Identifies who is calling (an integration identifier): the circuit breaker is scoped to it. */
export const callContext = new AsyncLocalStorage<{ circuit: string }>();
export const withCircuit = <T>(circuit: string, fn: () => Promise<T>): Promise<T> => callContext.run({ circuit }, fn);
