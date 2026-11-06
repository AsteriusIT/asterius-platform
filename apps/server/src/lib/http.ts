import { config } from '../config.js';
import { metrics } from '../metrics.js';
import {
  CircuitBreaker,
  IDEMPOTENT_METHODS,
  KeyedLimiter,
  backoffMs,
  callContext,
  isRetryableStatus,
  rateLimitWaitMs,
  sleep,
  type RetryPolicy,
} from './resilience.js';

/** Outbound HTTP for invokers, sources and webhooks: timeout, JSON handling, errors with a body excerpt. */

export class UpstreamError extends Error {
  /** Response headers (rate-limit information), when the upstream answered. */
  headers?: Headers;
  constructor(
    public status: number,
    message: string,
    public body?: string,
  ) {
    super(message);
  }
}

export interface HttpRequest {
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
  /** Override the retry policy (defaults from HTTP_RETRIES…), or `false` to send exactly once. */
  retry?: Partial<RetryPolicy> | false;
}

export interface HttpResponse<T = unknown> {
  status: number;
  headers: Headers;
  data: T;
  text: string;
}

/** One attempt, no resilience. */
async function httpOnce<T = unknown>(url: string, req: HttpRequest = {}): Promise<HttpResponse<T>> {
  const headers: Record<string, string> = { accept: 'application/json', 'user-agent': 'asterius-platform', ...req.headers };
  let body: string | undefined;
  if (req.body !== undefined) {
    body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
    if (!Object.keys(headers).some((h) => h.toLowerCase() === 'content-type')) headers['content-type'] = 'application/json';
  }
  const res = await fetch(url, {
    method: req.method ?? (body !== undefined ? 'POST' : 'GET'),
    headers,
    body,
    signal: AbortSignal.timeout(req.timeoutMs ?? config.HTTP_TIMEOUT_SECONDS * 1000),
    redirect: 'follow',
  });
  const text = await res.text();
  let data: unknown = text;
  if (text && (res.headers.get('content-type') ?? '').includes('json')) {
    try {
      data = JSON.parse(text);
    } catch {
      /* keep text */
    }
  }
  if (!res.ok && res.status !== 304) {
    const err = new UpstreamError(
      res.status,
      `${req.method ?? 'GET'} ${new URL(url).host}${new URL(url).pathname} → ${res.status}: ${text.slice(0, 300)}`,
      text,
    );
    err.headers = res.headers;
    throw err;
  }
  return { status: res.status, headers: res.headers, data: data as T, text };
}

const limiter = new KeyedLimiter(config.HTTP_MAX_CONCURRENCY_PER_HOST);
const breaker = new CircuitBreaker(config.HTTP_CIRCUIT_THRESHOLD, config.HTTP_CIRCUIT_COOLDOWN_SECONDS * 1000);

/**
 * Outbound request with: per-host concurrency cap, retries with jittered backoff on 429 / 5xx / network errors
 * (5xx and network errors only for idempotent methods), Retry-After and X-RateLimit-Reset waits, and a circuit
 * breaker per integration (see `withCircuit`) so one broken upstream fails fast instead of holding workers.
 */
export async function http<T = unknown>(url: string, req: HttpRequest = {}): Promise<HttpResponse<T>> {
  const method = (req.method ?? (req.body !== undefined ? 'POST' : 'GET')).toUpperCase();
  const host = new URL(url).host;
  const policy: RetryPolicy | undefined =
    req.retry === false
      ? undefined
      : { retries: config.HTTP_RETRIES, baseMs: config.HTTP_RETRY_BASE_MS, maxDelayMs: config.HTTP_RETRY_MAX_DELAY_SECONDS * 1000, ...req.retry };
  const circuit = config.HTTP_CIRCUIT_THRESHOLD > 0 ? callContext.getStore()?.circuit : undefined;

  for (let attempt = 0; ; attempt++) {
    if (circuit) {
      const wait = breaker.check(circuit);
      if (wait > 0) throw new UpstreamError(503, `circuit open for ${circuit}: upstream failing, retry in ~${Math.ceil(wait / 1000)}s`);
    }
    let failure: unknown;
    let reason = 'network';
    let waitMs: number | undefined;
    try {
      const res = await limiter.run(host, () => httpOnce<T>(url, req));
      if (circuit) breaker.success(circuit);
      return res;
    } catch (err) {
      failure = err;
      if (err instanceof UpstreamError) {
        const retryable = isRetryableStatus(err.status, method, err.headers);
        if (!retryable) {
          if (circuit) breaker.success(circuit); // a 4xx means the upstream is alive
          throw err;
        }
        reason = String(err.status);
        waitMs = err.headers ? rateLimitWaitMs(err.headers) : undefined;
      } else if (!IDEMPOTENT_METHODS.has(method)) throw err;
    }
    const exhausted = !policy || attempt >= policy.retries;
    const delay = waitMs ?? (policy ? backoffMs(attempt, policy) : 0);
    const tooLong = policy !== undefined && waitMs !== undefined && waitMs > policy.maxDelayMs;
    if (exhausted || tooLong) {
      if (circuit && breaker.failure(circuit)) metrics.httpCircuitOpened(circuit);
      if (tooLong && failure instanceof UpstreamError) failure.message += ` (rate limited for ${Math.ceil(waitMs! / 1000)}s, not waiting)`;
      throw failure;
    }
    metrics.httpRetry(host, reason);
    if (waitMs !== undefined) metrics.httpRateLimitWait(host, delay / 1000);
    await sleep(delay);
  }
}

/** Parse RFC 5988 `Link` headers (GitHub / GitLab pagination). */
export function nextLink(headers: Headers): string | undefined {
  const link = headers.get('link');
  if (!link) return undefined;
  for (const part of link.split(',')) {
    const m = /<([^>]+)>;\s*rel="?next"?/.exec(part);
    if (m) return m[1];
  }
  return undefined;
}
