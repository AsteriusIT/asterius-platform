import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { client, register, testApp, type Api } from './helpers.js';

let app: FastifyInstance;
let admin: Api;
let scimToken: string;

beforeAll(async () => {
  app = await testApp();
  admin = client(app, (await register(app, 'admin@example.com')).token);
  const t = await admin.post('/api/v1/scim/token', {});
  expect(t.status).toBe(201);
  scimToken = t.data.token;
});
afterAll(() => app.close());

async function scim(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, body?: unknown, token: string | null = scimToken) {
  const res = await app.inject({
    method,
    url: `/scim/v2${url}`,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/scim+json' } : {}) },
    payload: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.statusCode, data: res.body ? JSON.parse(res.body) : undefined, type: res.headers['content-type'] as string };
}

const newUser = (email: string, extra: object = {}) => ({
  schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
  userName: email,
  externalId: `ext-${email}`,
  name: { givenName: 'Ada', familyName: 'Lovelace' },
  emails: [{ value: email, primary: true }],
  active: true,
  ...extra,
});

describe('SCIM 2.0', () => {
  it('requires a SCIM-scoped token and grants nothing else', async () => {
    expect((await scim('GET', '/Users', undefined, null)).status).toBe(401);
    expect((await scim('GET', '/Users', undefined, 'ast_nope')).status).toBe(401);
    // A regular admin token is not a SCIM token, and the SCIM token cannot call the API.
    const plain = await admin.post('/api/v1/tokens', { name: 'x', scopes: ['admin'] });
    expect((await scim('GET', '/Users', undefined, plain.data.token)).status).toBe(401);
    expect((await client(app, scimToken).get('/api/v1/users')).status).toBe(403);
    expect((await admin.post('/api/v1/tokens', { name: 'y', scopes: ['scim'] })).status).toBe(400);
  });

  it('provisions, looks up, updates and lists users', async () => {
    const created = await scim('POST', '/Users', newUser('Ada@Example.com'));
    expect(created.status).toBe(201);
    expect(created.type).toContain('application/scim+json');
    expect(created.data).toMatchObject({ userName: 'ada@example.com', active: true, displayName: 'Ada Lovelace' });
    expect((await scim('POST', '/Users', newUser('ada@example.com'))).status).toBe(409);

    const found = await scim('GET', '/Users?filter=userName eq "ADA@example.com"');
    expect(found.data.totalResults).toBe(1);
    expect(found.data.Resources[0].id).toBe(created.data.id);
    expect((await scim('GET', '/Users?filter=userName co "ada"')).status).toBe(400);

    const put = await scim('PUT', `/Users/${created.data.id}`, newUser('ada@example.com', { name: { formatted: 'Ada L.' } }));
    expect(put.data.displayName).toBe('Ada L.');
    // Never an admin through SCIM, and no login without SSO (no password).
    const users = (await admin.get('/api/v1/users')).data as { email: string; role: string; provider: string }[];
    expect(users.find((u) => u.email === 'ada@example.com')).toMatchObject({ role: 'member', provider: 'scim' });
  });

  it('deactivation revokes sessions and tokens immediately', async () => {
    const u = await scim('POST', '/Users', newUser('grace@example.com'));
    const { createSession, createApiToken } = await import('../src/auth/users.js');
    const session = await createSession(u.data.id);
    const token = (await createApiToken({ name: 't', userId: u.data.id, createdBy: u.data.id })).token;
    expect((await client(app, session).get('/api/auth/me')).status).toBe(200);
    expect((await client(app, token).get('/api/auth/me')).status).toBe(200);

    const patched = await scim('PATCH', `/Users/${u.data.id}`, {
      schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
      Operations: [{ op: 'Replace', path: 'active', value: false }],
    });
    expect(patched.data.active).toBe(false);
    expect((await client(app, session).get('/api/auth/me')).status).toBe(401);
    expect((await client(app, token).get('/api/auth/me')).status).toBe(401);

    // Reactivation (Okta/Entra send value as an object without path too).
    const back = await scim('PATCH', `/Users/${u.data.id}`, { Operations: [{ op: 'replace', value: { active: true } }] });
    expect(back.data.active).toBe(true);
    expect((await scim('DELETE', `/Users/${u.data.id}`)).status).toBe(204);
    expect((await scim('GET', `/Users/${u.data.id}`)).data.active).toBe(false);
  });

  it('never exposes local accounts or service accounts', async () => {
    const all = (await scim('GET', '/Users?count=200')).data.Resources as { userName: string }[];
    expect(all.some((u) => u.userName === 'admin@example.com')).toBe(false);
    const adminId = ((await admin.get('/api/v1/users')).data as { id: string; email: string }[]).find((u) => u.email === 'admin@example.com')!.id;
    expect((await scim('GET', `/Users/${adminId}`)).status).toBe(404);
    expect((await scim('DELETE', `/Users/${adminId}`)).status).toBe(404);
  });

  it('maps groups to teams and members', async () => {
    const u1 = (await scim('POST', '/Users', newUser('m1@example.com'))).data.id as string;
    const u2 = (await scim('POST', '/Users', newUser('m2@example.com'))).data.id as string;
    const g = await scim('POST', '/Groups', { displayName: 'Platform Engineers', members: [{ value: u1 }] });
    expect(g.status).toBe(201);
    expect(g.data.id).toBe('platform-engineers');
    expect(g.data.members.map((m: { value: string }) => m.value)).toEqual([u1]);

    await scim('PATCH', '/Groups/platform-engineers', { Operations: [{ op: 'add', path: 'members', value: [{ value: u2 }] }] });
    let members = (await scim('GET', '/Groups/platform-engineers')).data.members as { value: string }[];
    expect(members).toHaveLength(2);
    await scim('PATCH', '/Groups/platform-engineers', { Operations: [{ op: 'remove', path: `members[value eq "${u1}"]` }] });
    members = (await scim('GET', '/Groups/platform-engineers')).data.members;
    expect(members.map((m) => m.value)).toEqual([u2]);

    const teams = (await admin.get('/api/v1/teams')).data as { identifier: string; members: { email: string }[] }[];
    expect(teams.find((t) => t.identifier === 'platform-engineers')!.members.map((m) => m.email)).toEqual(['m2@example.com']);
    expect((await scim('PATCH', '/Groups/platform-engineers', { Operations: [{ op: 'add', path: 'members', value: [{ value: 'nope' }] }] })).status).toBe(400);
    expect((await scim('GET', '/Groups?filter=displayName eq "Platform Engineers"')).data.totalResults).toBe(1);
    expect((await scim('DELETE', '/Groups/platform-engineers')).status).toBe(204);
  });

  it('hands a provisioned account to the first SSO sign-in with the same verified email', async () => {
    const { upsertExternalUser } = await import('../src/auth/users.js');
    const created = await scim('POST', '/Users', newUser('sso@example.com'));
    const u = await upsertExternalUser('oidc', { externalId: 'iss|sub-1', email: 'sso@example.com', emailVerified: true, name: 'Sso User', groups: [] });
    expect(u.id).toBe(created.data.id);
    expect(u.provider).toBe('oidc');
    expect((await scim('GET', `/Users/${created.data.id}`)).status).toBe(200); // still managed through SCIM

    // An unverified email never claims a provisioned account.
    const other = await scim('POST', '/Users', newUser('other@example.com'));
    const stranger = await upsertExternalUser('oidc', { externalId: 'iss|evil', email: 'other@example.com', emailVerified: false, name: 'X', groups: [] });
    expect(stranger.id).not.toBe(other.data.id);
  });

  it('serves discovery documents and audits provisioning', async () => {
    expect((await scim('GET', '/ServiceProviderConfig')).data.patch.supported).toBe(true);
    const actions = ((await admin.get('/api/v1/audit?action=scim.*&limit=100')).data as { action: string }[]).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(['scim.token_created', 'scim.user_created', 'scim.user_patched', 'scim.group_created']));
  });
});
