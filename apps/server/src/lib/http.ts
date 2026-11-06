import { fetch as guardedFetch } from 'undici';
import { config } from '../config.js';
import { assertUrlAllowed, guardedAgent, sameOrigin } from './netguard.js';

/** Outbound HTTP for invokers, sources and webhooks: timeout, JSON handling, errors with a body excerpt. */

export class UpstreamError extends Error {
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
async function followRedirects(start: string, init: { method: string; headers: Record<string, string>; body: string | undefined; signal: AbortSignal }) {
  let url = start;
  let { method, headers, body } = init;
  for (let hop = 0; ; hop++) {
    assertUrlAllowed(url);
    const res = await guardedFetch(url, { method, headers, body, signal: init.signal, redirect: 'manual', dispatcher: guardedAgent }).catch((e: Error) => {
      throw e.cause instanceof Error ? e.cause : e; // undici wraps the real reason ("fetch failed")
    });
    const location = res.headers.get('location');
    if (res.status < 300 || res.status >= 400 || res.status === 304 || !location) return res;
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

export async function http<T = unknown>(url: string, req: HttpRequest = {}): Promise<HttpResponse<T>> {
  const headers: Record<string, string> = { accept: 'application/json', 'user-agent': 'asterius-platform', ...req.headers };
  let body: string | undefined;
  if (req.body !== undefined) {
    body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
    if (!Object.keys(headers).some((h) => h.toLowerCase() === 'content-type')) headers['content-type'] = 'application/json';
  }
  const method = req.method ?? (body !== undefined ? 'POST' : 'GET');
  const res = await followRedirects(url, { method, headers, body, signal: AbortSignal.timeout(req.timeoutMs ?? config.HTTP_TIMEOUT_SECONDS * 1000) });
  const text = await res.text();
  let data: unknown = text;
  if (text && (res.headers.get('content-type') ?? '').includes('json')) {
    try {
      data = JSON.parse(text);
    } catch {
      /* keep text */
    }
  }
  if (!res.ok)
    throw new UpstreamError(res.status, `${req.method ?? 'GET'} ${new URL(url).host}${new URL(url).pathname} → ${res.status}: ${text.slice(0, 300)}`, text);
  return { status: res.status, headers: res.headers as unknown as Headers, data: data as T, text };
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
