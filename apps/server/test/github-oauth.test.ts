import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { client, register, testApp } from './helpers.js';

const port = vi.hoisted(() => {
  const p = 20000 + Math.floor(Math.random() * 20000);
  process.env.AUTH_PROVIDERS = 'local,github';
  process.env.GITHUB_CLIENT_ID = 'cid';
  process.env.GITHUB_CLIENT_SECRET = 'csecret';
  process.env.GITHUB_ALLOWED_ORGS = 'acme';
  process.env.GITHUB_ADMIN_TEAMS = 'acme/platform';
  process.env.GITHUB_URL = `http://127.0.0.1:${p}`;
  process.env.GITHUB_API_URL = `http://127.0.0.1:${p}/api`;
  return p;
});

let gh: http.Server;
let app: FastifyInstance;
let account: { id: number; login: string; orgs: string[]; teams: string[]; verified: boolean };

beforeAll(async () => {
  gh = http.createServer((req, res) => {
    const send = (body: unknown) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    const url = req.url ?? '';
    if (url === '/login/oauth/access_token') return send({ access_token: 'gho_fake' });
    if (req.headers.authorization !== 'Bearer gho_fake') return res.writeHead(401).end();
    if (url === '/api/user') return send({ id: account.id, login: account.login, name: null });
    if (url === '/api/user/emails') return send([{ email: `${account.login}@Acme.test`, primary: true, verified: account.verified }]);
    if (url.startsWith('/api/user/orgs')) return send(account.orgs.map((login) => ({ login })));
    if (url.startsWith('/api/user/teams')) return send(account.teams.map((t) => ({ slug: t.split('/')[1], organization: { login: t.split('/')[0] } })));
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => gh.listen(port, '127.0.0.1', r));
  app = await testApp();
});
afterAll(async () => {
  await app.close();
  gh.close();
});

async function signIn(a: typeof account) {
  account = a;
  const login = await app.inject({ method: 'GET', url: '/api/auth/github/login' });
  const auth = new URL(login.headers.location as string);
  expect(auth.searchParams.get('code_challenge_method')).toBe('S256');
  const cb = await app.inject({ method: 'GET', url: `/api/auth/github/callback?code=c&state=${auth.searchParams.get('state')}` });
  return new URL(cb.headers.location as string, 'http://x');
}

describe('GitHub OAuth', () => {
  it('admits members of allowed orgs and maps org teams', async () => {
    const root = client(app, (await register(app, 'root@example.com')).token);
    await root.put('/api/v1/teams/backend', { title: 'Backend', entraGroupId: 'acme/backend' });
    const ok = await signIn({ id: 42, login: 'octo', orgs: ['Acme'], teams: ['Acme/backend'], verified: true });
    const me = (await client(app, new URLSearchParams(ok.hash.slice(1)).get('token')!).get('/api/auth/me')).data;
    expect(me).toMatchObject({ provider: 'github', email: 'octo@acme.test', role: 'member' });
    expect(me.teams.map((t: { identifier: string }) => t.identifier)).toEqual(['backend']);

    const admin = await signIn({ id: 43, login: 'boss', orgs: ['acme'], teams: ['acme/platform'], verified: true });
    expect((await client(app, new URLSearchParams(admin.hash.slice(1)).get('token')!).get('/api/auth/me')).data.role).toBe('admin');
  });

  it('refuses outsiders and unverified emails', async () => {
    const outsider = await signIn({ id: 44, login: 'rando', orgs: ['other'], teams: [], verified: true });
    expect(outsider.pathname).toBe('/login');
    expect(outsider.searchParams.get('error')).toMatch(/allowed organization/);
    const unverified = await signIn({ id: 45, login: 'new', orgs: ['acme'], teams: [], verified: false });
    expect(unverified.searchParams.get('error')).toMatch(/verified/);
  });
});
