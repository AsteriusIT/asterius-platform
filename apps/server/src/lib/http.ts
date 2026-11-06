import { config } from '../config.js';

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
  /** `error`: fail on redirects instead of following them (allow-listed calls must not leave their host). */
  redirect?: 'follow' | 'error';
}

export interface HttpResponse<T = unknown> {
  status: number;
  headers: Headers;
  data: T;
  text: string;
}

export async function http<T = unknown>(url: string, req: HttpRequest = {}): Promise<HttpResponse<T>> {
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
    redirect: req.redirect ?? 'follow',
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
  if (!res.ok)
    throw new UpstreamError(res.status, `${req.method ?? 'GET'} ${new URL(url).host}${new URL(url).pathname} → ${res.status}: ${text.slice(0, 300)}`, text);
  return { status: res.status, headers: res.headers, data: data as T, text };
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
