import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { testApp } from './helpers.js';

vi.hoisted(() => {
  process.env.SESSION_COOKIE = 'true';
});

let app: FastifyInstance;
beforeAll(async () => {
  app = await testApp();
});
afterAll(() => app.close());

const cookieOf = (setCookie: unknown) => String(setCookie).split(';')[0]!;

describe('cookie sessions', () => {
  let cookie = '';
  let csrf = '';

  it('sets an httpOnly SameSite cookie at sign-in and keeps the token out of the body', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email: 'a@example.com', name: 'A', password: 'correct-horse-battery' },
    });
    expect(res.statusCode).toBe(200);
    const header = String(res.headers['set-cookie']);
    expect(header).toMatch(/HttpOnly/);
    expect(header).toMatch(/SameSite=Lax/);
    const body = res.json();
    expect(body.token).toBe('cookie');
    csrf = body.csrfToken;
    cookie = cookieOf(res.headers['set-cookie']);
    expect(cookie.split('=')[1]!.length).toBeGreaterThan(20);
    expect(cookie).not.toContain(body.csrfToken);
  });

  it('authenticates reads with the cookie alone and hands out the CSRF token', async () => {
    const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } });
    expect(me.statusCode).toBe(200);
    expect(me.json().csrfToken).toBe(csrf);
  });

  it('requires the CSRF token and a same-origin Origin for state changes', async () => {
    const put = (headers: Record<string, string>) =>
      app.inject({
        method: 'PUT',
        url: '/api/auth/me/tour',
        headers: { cookie, 'content-type': 'application/json', ...headers },
        payload: JSON.stringify({ completed: true }),
      });
    expect((await put({})).statusCode).toBe(403);
    expect((await put({ 'x-csrf-token': 'forged' })).statusCode).toBe(403);
    expect((await put({ 'x-csrf-token': csrf, origin: 'https://evil.example.com' })).statusCode).toBe(403);
    expect((await put({ 'x-csrf-token': csrf })).statusCode).toBe(200);
    expect((await put({ 'x-csrf-token': csrf, origin: new URL((await import('../src/config.js')).config.PUBLIC_URL).origin })).statusCode).toBe(200);
  });

  it('does not accept the cookie as an API token, and Authorization headers still work', async () => {
    const token = cookie.split('=')[1]!;
    const viaHeader = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { authorization: `Bearer ${token}` } });
    expect(viaHeader.statusCode).toBe(200);
    expect(viaHeader.json().csrfToken).toBeUndefined();
    const forged = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: 'asterius_session=ast_whatever' } });
    expect(forged.statusCode).toBe(401);
  });

  it('logs out by deleting the session and expiring the cookie', async () => {
    const out = await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie } });
    expect(String(out.headers['set-cookie'])).toMatch(/Max-Age=0/);
    expect((await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } })).statusCode).toBe(401);
  });
});
