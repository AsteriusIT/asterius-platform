import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';

export async function testApp() {
  const app = await buildApp({ logger: false });
  await app.ready();
  return app;
}

export type Api = ReturnType<typeof client>;

/** Small JSON client over fastify.inject. */
export function client(app: FastifyInstance, token?: string) {
  const call = async (method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await app.inject({
      method,
      url,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
      payload: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = res.body ? (res.headers['content-type']?.includes('json') ? res.json() : res.body) : undefined;
    return { status: res.statusCode, data };
  };
  return {
    get: (url: string, h?: Record<string, string>) => call('GET', url, undefined, h),
    post: (url: string, body?: unknown, h?: Record<string, string>) => call('POST', url, body ?? {}, h),
    put: (url: string, body: unknown) => call('PUT', url, body),
    patch: (url: string, body: unknown, h?: Record<string, string>) => call('PATCH', url, body, h),
    del: (url: string) => call('DELETE', url),
  };
}

export async function register(app: FastifyInstance, email: string, name = email.split('@')[0]) {
  const res = await client(app).post('/api/auth/register', { email, name, password: 'correct-horse-battery' });
  if (res.status !== 200) throw new Error(`register ${email}: ${JSON.stringify(res.data)}`);
  return res.data as { token: string; user: { id: string; role: string } };
}

export interface Received {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

/** A local HTTP server standing in for external systems (webhook endpoints, CI APIs). */
export async function fakeServer(handler: (r: Received) => { status?: number; body?: unknown } = () => ({ status: 200, body: { ok: true } })) {
  const received: Received[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const r = { method: req.method ?? '', url: req.url ?? '', headers: req.headers, body };
      received.push(r);
      const out = handler(r);
      res.writeHead(out.status ?? 200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(out.body ?? {}));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url, received, close: () => new Promise((r) => server.close(r)) };
}

export async function waitFor<T>(fn: () => Promise<T | undefined | false>, timeoutMs = 15_000): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('waitFor: timed out');
    await new Promise((r) => setTimeout(r, 100));
  }
}

export const silentLog = {
  info() {},
  warn() {},
  error() {},
  debug() {},
  trace() {},
  fatal() {},
  child() {
    return silentLog;
  },
  level: 'silent',
} as never;
