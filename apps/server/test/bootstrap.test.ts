import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { client, testApp } from './helpers.js';
import { config, isLocalUrl } from '../src/config.js';

let app: FastifyInstance;
beforeAll(async () => {
  app = await testApp();
  config.ADMIN_EMAILS.length = 0; // fresh install: no bootstrap admin configured
});
afterAll(() => app.close());

const register = (email: string, extra: object = {}) =>
  client(app).post('/api/auth/register', { email, name: 'N', password: 'correct-horse-battery', ...extra });

describe('admin bootstrap', () => {
  it('does not make the first registrant admin on a public URL', async () => {
    const r = await register('first@example.com');
    expect(r.data.user.role).toBe('member');
  });

  it('promotes the registrant holding the bootstrap token, once', async () => {
    config.BOOTSTRAP_TOKEN = 'one-time-bootstrap';
    try {
      expect((await register('wrong@example.com', { bootstrapToken: 'nope' })).data.user.role).toBe('member');
      expect((await register('owner@example.com', { bootstrapToken: 'one-time-bootstrap' })).data.user.role).toBe('admin');
      expect((await register('late@example.com', { bootstrapToken: 'one-time-bootstrap' })).data.user.role).toBe('member'); // an admin exists
    } finally {
      config.BOOTSTRAP_TOKEN = undefined;
    }
  });

  it('keeps the first-account fallback for local URLs only', () => {
    expect(isLocalUrl('http://localhost:5173')).toBe(true);
    expect(isLocalUrl('https://platform.example.com')).toBe(false);
  });
});
