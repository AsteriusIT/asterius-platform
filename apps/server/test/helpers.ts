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

/** Small JSON client over fastify.inject; `org` sets X-Asterius-Org (the organization a session works in). */
export function client(app: FastifyInstance, token?: string, org?: string) {
  const call = async (method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await app.inject({
      method,
      url,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(org ? { 'x-asterius-org': org } : {}),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...headers,
      },
      payload: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = res.body ? (res.headers['content-type']?.includes('json') ? res.json() : res.body) : undefined;
    return { status: res.statusCode, data };
  };
  return {
    get: (url: string, h?: Record<string, string>) => call('GET', url, undefined, h),
    post: (url: string, body?: unknown, h?: Record<string, string>) => call('POST', url, body ?? {}, h),
    put: (url: string, body: unknown, h?: Record<string, string>) => call('PUT', url, body, h),
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

const wantsStream = (body: string) => {
  try {
    return (JSON.parse(body) as { stream?: boolean }).stream === true;
  } catch {
    return false;
  }
};

interface FakeMessage {
  content: ({ type: string; text?: string; input?: unknown } & Record<string, unknown>)[];
  usage: Record<string, number>;
  stop_reason: string;
}

/** The server-sent events of a Messages API stream for a complete message. */
export function messageEvents(m: FakeMessage): string {
  const ev = (type: string, data: object) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
  let out = ev('message_start', { message: { ...m, content: [], stop_reason: null, usage: { ...m.usage, output_tokens: 1 } } });
  m.content.forEach((block, index) => {
    if (block.type === 'text') {
      out += ev('content_block_start', { index, content_block: { type: 'text', text: '' } });
      out += ev('content_block_delta', { index, delta: { type: 'text_delta', text: block.text } });
    } else {
      out += ev('content_block_start', { index, content_block: { ...block, input: {} } });
      out += ev('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input ?? {}) } });
    }
    out += ev('content_block_stop', { index });
  });
  out += ev('message_delta', { delta: { stop_reason: m.stop_reason, stop_sequence: null }, usage: m.usage });
  return out + ev('message_stop', {});
}

/** A local HTTP server standing in for external systems (webhook endpoints, CI APIs). */
export async function fakeServer(
  handler: (r: Received) => { status?: number; body?: unknown; headers?: Record<string, string> } = () => ({ status: 200, body: { ok: true } }),
) {
  const received: Received[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const r = { method: req.method ?? '', url: req.url ?? '', headers: req.headers, body };
      received.push(r);
      const out = handler(r);
      const message = out.body as { type?: string } | undefined;
      if (message?.type === 'message' && wantsStream(body)) {
        // The Claude SDK streams: answer with the server-sent events of a complete message.
        res.writeHead(out.status ?? 200, { 'content-type': 'text/event-stream' });
        res.end(messageEvents(message as never));
        return;
      }
      res.writeHead(out.status ?? 200, { 'content-type': 'application/json', ...out.headers });
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

/**
 * Run test code that calls platform internals directly (syncs, run engine, secrets…) in the default organization, as
 * the workers do for the organization of what they process. HTTP requests made inside open their own context.
 */
export async function inDefaultOrg<T>(fn: () => Promise<T>): Promise<T> {
  const { DEFAULT_ORG, withOrg } = await import('../src/orgs/context.js');
  return withOrg(DEFAULT_ORG, fn);
}
