import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { http as request, UpstreamError } from '../src/lib/http.js';
import { withCircuit, CircuitBreaker, KeyedLimiter, backoffMs, parseRetryAfter, rateLimitWaitMs, isRetryableStatus } from '../src/lib/resilience.js';

describe('resilience primitives', () => {
  it('parses Retry-After and rate-limit reset headers', () => {
    expect(parseRetryAfter('2')).toBe(2000);
    expect(parseRetryAfter('Wed, 21 Oct 2015 07:28:05 GMT', Date.parse('Wed, 21 Oct 2015 07:28:00 GMT'))).toBe(5000);
    expect(parseRetryAfter('garbage')).toBeUndefined();
    const now = 1_800_000_000_000;
    expect(rateLimitWaitMs(new Headers({ 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(now / 1000 + 7) }), now)).toBe(7000);
    expect(rateLimitWaitMs(new Headers({ 'x-ratelimit-remaining': '12', 'x-ratelimit-reset': String(now / 1000 + 7) }), now)).toBeUndefined();
  });

  it('only retries what is safe', () => {
    expect(isRetryableStatus(429, 'POST')).toBe(true);
    expect(isRetryableStatus(503, 'GET')).toBe(true);
    expect(isRetryableStatus(503, 'POST')).toBe(false);
    expect(isRetryableStatus(404, 'GET')).toBe(false);
    expect(isRetryableStatus(403, 'GET')).toBe(false);
    expect(isRetryableStatus(403, 'GET', new Headers({ 'x-ratelimit-remaining': '0' }))).toBe(true);
  });

  it('backs off exponentially with jitter, capped', () => {
    const p = { retries: 5, baseMs: 100, maxDelayMs: 1000 };
    expect(backoffMs(0, p, () => 1)).toBe(100);
    expect(backoffMs(0, p, () => 0)).toBe(50);
    expect(backoffMs(10, p, () => 1)).toBe(1000);
  });

  it('caps concurrency per key', async () => {
    const l = new KeyedLimiter(2);
    let active = 0;
    let peak = 0;
    await Promise.all(
      Array.from({ length: 8 }, () =>
        l.run('h', async () => {
          peak = Math.max(peak, ++active);
          await new Promise((r) => setTimeout(r, 5));
          active--;
        }),
      ),
    );
    expect(peak).toBe(2);
  });

  it('opens a circuit after repeated failures and half-opens after the cooldown', () => {
    let t = 0;
    const b = new CircuitBreaker(2, 1000, () => t);
    expect(b.failure('a')).toBe(false);
    expect(b.failure('a')).toBe(true);
    expect(b.check('a')).toBeGreaterThan(0);
    expect(b.check('other')).toBe(0);
    t = 1500;
    expect(b.check('a')).toBe(0); // probe
    expect(b.check('a')).toBeGreaterThan(0); // only one probe at a time
    b.success('a');
    expect(b.check('a')).toBe(0);
  });
});

async function server(handler: (n: number, req: IncomingMessage, res: ServerResponse) => void) {
  let n = 0;
  const s = createServer((req, res) => handler(++n, req, res));
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(s.address() as AddressInfo).port}`, count: () => n, close: () => new Promise((r) => s.close(r)) };
}

describe('http() resilience', () => {
  it('retries 5xx on GET and honours Retry-After on 429', async () => {
    const s = await server((n, _q, res) => {
      if (n === 1) res.writeHead(503).end();
      else if (n === 2) res.writeHead(429, { 'retry-after': '0' }).end();
      else res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
    });
    const res = await request<{ ok: boolean }>(`${s.url}/x`);
    expect(res.data.ok).toBe(true);
    expect(s.count()).toBe(3);
    await s.close();
  });

  it('does not retry 5xx on POST, but retries 429', async () => {
    const s = await server((n, _q, res) => {
      if (n === 1) res.writeHead(500).end();
      else res.writeHead(200).end();
    });
    await expect(request(`${s.url}/x`, { method: 'POST', body: {} })).rejects.toBeInstanceOf(UpstreamError);
    expect(s.count()).toBe(1);
    await s.close();
    const t = await server((n, _q, res) => (n === 1 ? res.writeHead(429).end() : res.writeHead(200).end()));
    await request(`${t.url}/x`, { method: 'POST', body: {} });
    expect(t.count()).toBe(2);
    await t.close();
  });

  it('does not retry 4xx, gives up after the configured retries and refuses waits beyond the cap', async () => {
    const s = await server((_n, _q, res) => res.writeHead(404).end());
    await expect(request(`${s.url}/x`)).rejects.toMatchObject({ status: 404 });
    expect(s.count()).toBe(1);
    await s.close();
    const t = await server((_n, _q, res) => res.writeHead(500).end());
    await expect(request(`${t.url}/x`, { retry: { retries: 2 } })).rejects.toMatchObject({ status: 500 });
    expect(t.count()).toBe(3);
    await t.close();
    const u = await server((_n, _q, res) => res.writeHead(429, { 'retry-after': '3600' }).end());
    await expect(request(`${u.url}/x`)).rejects.toThrow(/not waiting/);
    expect(u.count()).toBe(1);
    await u.close();
  });

  it('fails fast once the circuit of an integration is open', async () => {
    const s = await server((_n, _q, res) => res.writeHead(500).end());
    await withCircuit('flaky', async () => {
      for (let i = 0; i < 5; i++) await request(`${s.url}/x`, { retry: false }).catch(() => undefined);
      const before = s.count();
      await expect(request(`${s.url}/x`, { retry: false })).rejects.toThrow(/circuit open/);
      expect(s.count()).toBe(before);
    });
    // Other callers are not affected.
    await expect(request(`${s.url}/x`, { retry: false })).rejects.toThrow(/500/);
    await s.close();
  });
});
