import { fetch as guardedFetch, type Dispatcher } from 'undici';
import { config } from '../config.js';
import { assertUrlAllowed, guardedAgent, sameOrigin } from './netguard.js';
import { invalidateAuth, resolveAuth } from './auth.js';
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
  /** Authentication block (see lib/auth.ts): OAuth2, GitHub App, cloud identities, SigV4, mTLS… */
  auth?: unknown;
  /** `error`: fail on redirects instead of following them (allow-listed calls must not leave their host). */
  redirect?: 'follow' | 'error';
}

export interface HttpResponse<T = unknown> {
  status: number;
  headers: Headers;
  data: T;
  text: string;
}

const MAX_REDIRECTS = 5;
/** Headers that may follow a redirect to another origin (credentials never do). */
const PORTABLE = new Set(['accept', 'user-agent', 'content-type']);

/**
 * fetch with the SSRF guard: every hop is checked (URL, then the resolved address at connect time) and redirects are
 * followed manually so a 30x cannot lead to an internal address or carry credentials to another origin.
 */
async function followRedirects(
  start: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string | undefined;
    signal: AbortSignal;
    dispatcher?: Dispatcher;
    redirect?: 'follow' | 'error';
  },
) {
  let url = start;
  let { method, headers, body } = init;
  for (let hop = 0; ; hop++) {
    assertUrlAllowed(url);
    const res = await guardedFetch(url, { method, headers, body, signal: init.signal, redirect: 'manual', dispatcher: init.dispatcher ?? guardedAgent }).catch(
      (e: Error) => {
        throw e.cause instanceof Error ? e.cause : e; // undici wraps the real reason ("fetch failed")
      },
    );
    const location = res.headers.get('location');
    if (res.status < 300 || res.status >= 400 || res.status === 304 || !location) return res;
    if (init.redirect === 'error') {
      await res.body?.cancel().catch(() => undefined);
      throw new Error(`Redirect to ${new URL(location, url).host} refused (redirects are not followed here)`);
    }
    await res.body?.cancel().catch(() => undefined);
    if (hop >= MAX_REDIRECTS) throw new Error(`Too many redirects from ${new URL(start).host}`);
    const next = new URL(location, url).toString();
    if (!sameOrigin(url, next)) headers = Object.fromEntries(Object.entries(headers).filter(([k]) => PORTABLE.has(k.toLowerCase())));
    if (res.status === 303 || ((res.status === 301 || res.status === 302) && method !== 'GET' && method !== 'HEAD')) {
      method = 'GET';
      body = undefined;
      headers = Object.fromEntries(Object.entries(headers).filter(([k]) => k.toLowerCase() !== 'content-type'));
    }
    url = next;
  }
}

/** One attempt, no resilience. */
async function httpOnce<T = unknown>(url: string, req: HttpRequest = {}, dispatcher?: Dispatcher): Promise<HttpResponse<T>> {
  const headers: Record<string, string> = { accept: 'application/json', 'user-agent': 'asterius-platform', ...req.headers };
  let body: string | undefined;
  if (req.body !== undefined) {
    body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
    if (!Object.keys(headers).some((h) => h.toLowerCase() === 'content-type')) headers['content-type'] = 'application/json';
  }
  const method = req.method ?? (body !== undefined ? 'POST' : 'GET');
  // `dispatcher` (mTLS client certificate) is built on the guarded connector too (lib/auth.ts), so the SSRF guard holds.
  const res = await followRedirects(url, {
    method,
    headers,
    body,
    signal: AbortSignal.timeout(req.timeoutMs ?? config.HTTP_TIMEOUT_SECONDS * 1000),
    dispatcher,
    redirect: req.redirect ?? 'follow',
  });
  metrics.upstream(new URL(url).host, res.status);
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
    err.headers = res.headers as unknown as Headers;
    throw err;
  }
  return { status: res.status, headers: res.headers as unknown as Headers, data: data as T, text };
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

  let authRetried = false;
  for (let attempt = 0; ; attempt++) {
    if (circuit) {
      const wait = breaker.check(circuit);
      if (wait > 0) throw new UpstreamError(503, `circuit open for ${circuit}: upstream failing, retry in ~${Math.ceil(wait / 1000)}s`);
    }
    let failure: unknown;
    let reason = 'network';
    let waitMs: number | undefined;
    try {
      let attemptReq = req;
      let dispatcher: Dispatcher | undefined;
      if (req.auth) {
        const body = req.body === undefined ? undefined : typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
        const a = await resolveAuth(req.auth, { url, method, body }, (u, init) => http(u, { ...init, retry: req.retry }));
        attemptReq = { ...req, headers: { ...req.headers, ...a.headers } };
        dispatcher = a.dispatcher;
      }
      const res = await limiter.run(host, () => httpOnce<T>(url, attemptReq, dispatcher));
      if (circuit) breaker.success(circuit);
      return res;
    } catch (err) {
      failure = err;
      if (err instanceof UpstreamError) {
        if (err.status === 401 && req.auth && !authRetried) {
          // The cached token may have been revoked: fetch a fresh one once.
          authRetried = true;
          invalidateAuth(req.auth);
          attempt--;
          continue;
        }
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
export function nextLink(headers: Headers, base?: string): string | undefined {
  const link = headers.get('link');
  if (!link) return undefined;
  for (const part of link.split(',')) {
    const m = /<([^>]+)>;\s*rel="?next"?/.exec(part);
    if (m) return base ? sameOriginUrl(m[1]!, base) : m[1];
  }
  return undefined;
}

/**
 * Pagination URLs come from the upstream: only follow them on the origin that was configured, because the configured
 * auth headers are sent with every page.
 */
export function sameOriginUrl(next: string, base: string): string {
  const url = new URL(next, base);
  if (!sameOrigin(url, base)) throw new Error(`Refusing to follow pagination to another origin (${url.origin}); the API must stay on ${new URL(base).origin}`);
  return url.toString();
}
