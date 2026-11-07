import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { exportJWK, generateKeyPair, SignJWT, createLocalJWKSet } from 'jose';
import { client, register, silentLog, testApp, type Api } from './helpers.js';
import { config } from '../src/config.js';
import { DEFAULT_ORG, withOrg } from '../src/orgs/context.js';
import { findOrg, patchSettings } from '../src/orgs/orgs.js';
import { resolveRef, setSecret } from '../src/secrets.js';
import { checkAllConfig } from '../src/config-loader.js';
import { checkKeycloakIdToken, orgAliasesOf, upsertKeycloakUser } from '../src/auth/keycloak.js';
import { one } from '../src/db.js';

let app: FastifyInstance;
let tokens: Record<string, string>;
const as = (who: string, org?: string): Api => client(app, tokens[who], org);

beforeAll(async () => {
  app = await testApp();
  tokens = {
    root: (await register(app, 'admin@example.com', 'Root')).token, // ADMIN_EMAILS: platform super-admin
    alice: (await register(app, 'alice@example.com', 'Alice')).token,
    bob: (await register(app, 'bob@example.com', 'Bob')).token,
  };
});
afterAll(() => app.close());

describe('organizations', () => {
  it('starts everyone in the default organization with AUTO_JOIN_DEFAULT_ORG (single-tenant)', async () => {
    const me = (await as('alice').get('/api/auth/me')).data;
    expect(me.organization.slug).toBe('default');
    expect(me.organizations.map((o: { slug: string }) => o.slug)).toEqual(['default']);
    expect(me.role).toBe('member');
    expect((await as('root').get('/api/auth/me')).data).toMatchObject({ superadmin: true, role: 'admin' });
  });

  it('lets anyone create an organization and become its admin', async () => {
    const res = await as('alice').post('/api/orgs', { slug: 'acme', name: 'Acme', domains: ['acme.test'] });
    expect(res.status, JSON.stringify(res.data)).toBe(201);
    expect(res.data).toMatchObject({ slug: 'acme', name: 'Acme', domains: ['acme.test'], memberCount: 1 });
    expect((await as('alice').post('/api/orgs', { slug: 'acme', name: 'Again' })).status).toBe(409);
    expect((await as('alice').post('/api/orgs', { slug: 'admin', name: 'Reserved' })).status).toBe(400);
    const me = (await as('alice', 'acme').get('/api/auth/me')).data;
    expect(me).toMatchObject({ role: 'admin', organization: { slug: 'acme' } });
  });

  it('protects email domains: one organization each, verified before they count', async () => {
    // Someone else cannot claim acme.test.
    expect((await as('bob').post('/api/orgs', { slug: 'squat', name: 'Squat', domains: ['acme.test'] })).status).toBe(409);
    const org = (await as('alice', 'acme').get('/api/v1/org')).data;
    expect(org.domainStatus).toEqual([
      { domain: 'acme.test', verified: false, record: '_asterius-verification.acme.test', value: expect.stringMatching(/^asterius-verification=/) },
    ]);
    // Unverified: people coming through acme's identity provider do not join, and the DNS check fails.
    const { upsertKeycloakUser: upsert } = await import('../src/auth/keycloak.js');
    const early = await upsert({ sub: 'kc-early', email: 'early@acme.test', emailVerified: true, name: 'Early', orgs: [], sso: ['acme'] });
    expect(
      await one('SELECT 1 AS x FROM memberships m JOIN organizations o ON o.id = m.org_id WHERE o.slug = ? AND m.user_id = ?', 'acme', early.id),
    ).toBeUndefined();
    expect((await as('alice', 'acme').post('/api/v1/org/domains/verify', { domain: 'acme.test' })).status).toBe(400);
    expect((await as('alice', 'acme').post('/api/v1/org/domains/verify', { domain: 'acme.test', trusted: true })).status).toBe(403);
    // A super-admin vouches for it: people coming through acme's identity provider now join…
    const v = await as('root', 'acme').post('/api/v1/org/domains/verify', { domain: 'acme.test', trusted: true });
    expect(v.data.domainStatus[0].verified).toBe(true);
    const inSlug = 'SELECT via FROM memberships m JOIN organizations o ON o.id = m.org_id WHERE o.slug = ? AND m.user_id = ?';
    // …but registering in Keycloak with a matching, verified email does not: only SSO lets people in.
    const registered = await upsert({ sub: 'kc-reg', email: 'reg@acme.test', emailVerified: true, name: 'Reg', orgs: [], sso: [] });
    expect(await one(inSlug, 'acme', registered.id)).toBeUndefined();
    // Another email domain through the same provider does not join either.
    const guest = await upsert({ sub: 'kc-guest', email: 'guest@elsewhere.test', emailVerified: true, name: 'Guest', orgs: [], sso: ['acme'] });
    expect(await one(inSlug, 'acme', guest.id)).toBeUndefined();
    const late = await upsert({ sub: 'kc-late', email: 'late@acme.test', emailVerified: true, name: 'Late', orgs: [], sso: ['acme'] });
    expect(
      await one('SELECT via FROM memberships m JOIN organizations o ON o.id = m.org_id WHERE o.slug = ? AND m.user_id = ?', 'acme', late.id),
    ).toMatchObject({
      via: 'sso',
    });
  });

  it('isolates every resource: same identifiers, separate data', async () => {
    const schema = { properties: { tier: { type: 'integer' } } };
    expect((await as('alice', 'acme').put('/api/v1/blueprints/service', { title: 'Acme service', schema })).status).toBe(200);
    expect((await as('root', 'default').put('/api/v1/blueprints/service', { title: 'Default service', schema })).status).toBe(200);
    await as('alice', 'acme').post('/api/v1/blueprints/service/entities', { identifier: 'billing', properties: { tier: 1 } });

    expect((await as('alice', 'acme').get('/api/v1/blueprints/service')).data.title).toBe('Acme service');
    expect((await as('bob').get('/api/v1/blueprints/service')).data.title).toBe('Default service');
    expect((await as('bob').get('/api/v1/blueprints/service/entities/billing')).status).toBe(404);
    expect((await as('alice', 'acme').get('/api/v1/blueprints/service/entities')).data.total).toBe(1);
    expect((await as('root', 'default').get('/api/v1/blueprints/service/entities')).data.total).toBe(0);
  });

  it('keeps the roadmap features separate too: scorecards, dashboards, history, tombstones, versions, budgets', async () => {
    const acme = as('alice', 'acme');
    const dflt = as('root', 'default');
    const card = (title: string) => ({
      title,
      blueprint: 'service',
      levels: [{ name: 'Gold' }],
      rules: [{ identifier: 'tiered', title: 'Has a tier', level: 'Gold', expression: '$exists(properties.tier)' }],
    });
    expect((await acme.put('/api/v1/scorecards/maturity', card('Acme maturity'))).status).toBe(200);
    expect((await dflt.put('/api/v1/scorecards/maturity', card('Default maturity'))).status).toBe(200);
    expect((await acme.get('/api/v1/scorecards/maturity')).data.title).toBe('Acme maturity');
    expect((await dflt.get('/api/v1/scorecards/maturity')).data.title).toBe('Default maturity');
    // Results are computed per organization: acme's entity is evaluated in acme only.
    expect((await acme.get('/api/v1/scorecards/maturity/summary')).data.total).toBe(1);
    expect((await dflt.get('/api/v1/scorecards/maturity/summary')).data.total).toBe(0);

    const board = (title: string) => ({ title, widgets: [{ type: 'markdown', title: 'Hello', content: 'hi' }] });
    expect((await acme.put('/api/v1/dashboards/home', board('Acme home'))).status).toBe(200);
    expect((await dflt.get('/api/v1/dashboards/home')).status).toBe(404);
    expect((await acme.get('/api/v1/dashboards')).data.map((d: { identifier: string }) => d.identifier)).toEqual(['home']);

    // Entity history and tombstones follow the entity's organization.
    await acme.patch('/api/v1/blueprints/service/entities/billing', { properties: { tier: 2 } });
    expect((await acme.get('/api/v1/blueprints/service/entities/billing/history')).data.items.length).toBeGreaterThanOrEqual(2);
    expect((await dflt.get('/api/v1/blueprints/service/entities/billing/history')).status).toBe(404);
    await dflt.post('/api/v1/blueprints/service/entities', { identifier: 'billing', properties: {} });
    await dflt.del('/api/v1/blueprints/service/entities/billing');
    const deleted = (org: Api) => org.get('/api/v1/deleted-entities').then((r) => r.data.items.map((t: { identifier: string }) => t.identifier));
    expect(await deleted(dflt)).toEqual(['billing']);
    expect(await deleted(acme)).toEqual([]);
    expect((await acme.get('/api/v1/blueprints/service/entities/billing')).status).toBe(200); // untouched

    // Action versions: same identifier, separate histories.
    const action = { title: 'Hello', trigger: 'create', steps: [{ id: 't', type: 'transform', output: { x: '1' } }] };
    await acme.put('/api/v1/actions/hello', action);
    await acme.put('/api/v1/actions/hello', { ...action, title: 'Hello again' });
    await dflt.put('/api/v1/actions/hello', action);
    expect((await acme.get('/api/v1/actions/hello/versions')).data).toHaveLength(2);
    expect((await dflt.get('/api/v1/actions/hello/versions')).data).toHaveLength(1);

    // AI budgets are per organization; model prices are the platform's.
    expect((await acme.put('/api/v1/ai/budgets', { scope: 'global', hardUsd: 5 })).status).toBe(200);
    expect((await dflt.get('/api/v1/ai/budgets')).data).toEqual([]);
    expect((await acme.put('/api/v1/ai/prices/some-model', { input: 1, output: 2 })).status).toBe(403);

    // Configuration-as-code status is per organization.
    expect((await acme.get('/api/v1/config/status')).data).toMatchObject({ source: 'none', appliedHash: null });
  });

  it('refuses organizations you do not belong to (super-admins excepted)', async () => {
    const res = await as('bob', 'acme').get('/api/v1/blueprints');
    expect(res.status).toBe(403);
    expect((await as('bob', 'nope').get('/api/v1/blueprints')).status).toBe(403);
    expect((await as('root', 'acme').get('/api/v1/blueprints/service')).data.title).toBe('Acme service');
    // Organization admin pages are per organization: Alice is admin of acme, not of default.
    expect((await as('alice', 'acme').get('/api/v1/org/members')).status).toBe(200);
    expect((await as('alice', 'default').get('/api/v1/org/members')).status).toBe(403);
  });

  it('binds API tokens to the organization they were created in', async () => {
    const t = (await as('alice', 'acme').post('/api/v1/tokens', { name: 'ci' })).data.token as string;
    const ci = client(app, t, 'default'); // the header cannot move a token to another organization
    expect((await ci.get('/api/v1/blueprints/service')).data.title).toBe('Acme service');
    expect((await as('alice', 'default').get('/api/v1/tokens')).data).toHaveLength(0);
    expect((await as('alice', 'acme').get('/api/v1/tokens')).data).toHaveLength(1);
  });

  it('manages members: add by email, change roles, remove', async () => {
    const admin = as('alice', 'acme');
    expect((await admin.post('/api/v1/org/members', { email: 'nobody@example.com' })).status).toBe(404); // no account, no Keycloak
    expect((await admin.post('/api/v1/org/members', { email: 'bob@example.com' })).status).toBe(201);
    expect((await as('bob', 'acme').get('/api/v1/blueprints/service')).status).toBe(200);
    const members = (await admin.get('/api/v1/org/members')).data as { id: string; email: string; role: string }[];
    const bob = members.find((m) => m.email === 'bob@example.com')!;
    expect(bob.role).toBe('member');
    expect((await as('bob', 'acme').put('/api/v1/blueprints/x', { title: 'X' })).status).toBe(403);
    expect((await admin.patch(`/api/v1/org/members/${bob.id}`, { role: 'admin' })).status).toBe(200);
    expect((await as('bob', 'acme').put('/api/v1/blueprints/x', { title: 'X', schema: { properties: {} } })).status).toBe(200);
    // The last admin cannot leave the organization without a successor.
    const alice = members.find((m) => m.email === 'alice@example.com')!;
    expect((await admin.del(`/api/v1/org/members/${bob.id}`)).status).toBe(200);
    expect((await admin.del(`/api/v1/org/members/${alice.id}`)).status).toBe(409);
    expect((await as('bob', 'acme').get('/api/v1/blueprints')).status).toBe(403);
  });

  it('keeps secrets per organization and reserves ${env:} to the default one', async () => {
    const acme = (await findOrg('acme'))!;
    process.env.SOME_PLATFORM_VAR = 'from-env';
    await withOrg(acme.id, () => setSecret('TOKEN', 'acme-secret-value', '', null));
    expect(await withOrg(acme.id, () => resolveRef('secret', 'TOKEN'))).toBe('acme-secret-value');
    await expect(withOrg(DEFAULT_ORG, () => resolveRef('secret', 'TOKEN'))).rejects.toThrow(/not defined/);
    await expect(withOrg(acme.id, () => resolveRef('env', 'SOME_PLATFORM_VAR'))).rejects.toThrow(/default organization/);
    expect(await withOrg(DEFAULT_ORG, () => resolveRef('env', 'SOME_PLATFORM_VAR'))).toBe('from-env');
  });

  it('routes inbound webhooks by organization', async () => {
    await as('alice', 'acme').put('/api/v1/integrations/events', {
      title: 'Events',
      type: 'webhook',
      config: { secret: '${secret:TOKEN}' },
      mappings: [{ kind: 'event', entity: { blueprint: 'service', identifier: 'name' } }],
    });
    const saved = (await as('alice', 'acme').get('/api/v1/integrations/events')).data;
    expect(saved.webhookUrl).toBe('http://platform.test/api/v1/ingest/acme/events');
    const post = (url: string) =>
      app.inject({
        method: 'POST',
        url,
        headers: { 'content-type': 'application/json', 'x-asterius-token': 'acme-secret-value' },
        payload: { name: 'from-hook' },
      });
    expect((await post('/api/v1/ingest/acme/events')).statusCode).toBe(202); // queued, processed by workers
    expect((await post('/api/v1/ingest/events')).statusCode).toBe(404); // legacy URL: the default organization
    expect((await post('/api/v1/ingest/nope/events')).statusCode).toBe(404);
    const { processInbound } = await import('../src/integrations/inbound.js');
    expect(await processInbound()).toBe(1); // across organizations, each event in its own
    expect((await as('alice', 'acme').get('/api/v1/blueprints/service/entities/from-hook')).status).toBe(200);
  });

  it('applies configuration as code per organization (CONFIG_DIR/orgs/<slug>)', async () => {
    const dir = path.join(config.CONFIG_DIR, 'orgs', 'beta');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'catalog.yaml'), 'blueprints:\n  - identifier: system\n    title: System\n    schema: { properties: {} }\n');
    fs.writeFileSync(path.join(config.CONFIG_DIR, 'platform.yaml'), 'organizations:\n  - slug: beta\n    name: Beta Corp\n    admins: [alice@example.com]\n');
    await checkAllConfig(silentLog);
    const beta = (await findOrg('beta'))!;
    expect(beta).toMatchObject({ name: 'Beta Corp', managed: 1 });
    const bp = (await as('alice', 'beta').get('/api/v1/blueprints/system')).data;
    expect(bp).toMatchObject({ title: 'System', managed: true });
    expect((await as('alice', 'acme').get('/api/v1/blueprints/system')).status).toBe(404);
    expect((await as('alice', 'beta').get('/api/v1/org')).data.configStatus).toMatchObject({ ok: true, files: 1 });
    // An organization's own files cannot declare organizations.
    fs.writeFileSync(path.join(dir, 'evil.yaml'), 'organizations:\n  - slug: evil\n    name: Evil\n');
    await checkAllConfig(silentLog);
    expect(await findOrg('evil')).toBeUndefined();
    expect((await as('alice', 'beta').get('/api/v1/org')).data.configStatus.ok).toBe(false);
    fs.rmSync(path.join(config.CONFIG_DIR, 'orgs'), { recursive: true });
    fs.rmSync(path.join(config.CONFIG_DIR, 'platform.yaml'));
  });

  it('refuses Git sources that are not https and directory sources from tenants', async () => {
    const admin = as('alice', 'acme');
    expect((await admin.put('/api/v1/org/config-source', { type: 'git', url: 'http://git.example.com/r.git' })).status).toBe(400);
    expect((await admin.put('/api/v1/org/config-source', { type: 'git', url: 'https://git.example.com/r.git', token: 'plain' })).status).toBe(400);
    expect((await admin.put('/api/v1/org/config-source', { type: 'directory' })).status).toBe(403);
    const ok = await admin.put('/api/v1/org/config-source', { type: 'git', url: 'https://git.example.com/r.git', branch: 'main', token: '${secret:TOKEN}' });
    expect(ok.status).toBe(200);
    expect(ok.data.configSource).toMatchObject({ type: 'git', branch: 'main', path: '' });
    await admin.put('/api/v1/org/config-source', { type: 'none' });
  });

  it('deletes an organization and everything in it', async () => {
    expect((await as('alice', 'acme').del('/api/v1/org')).status).toBe(400); // confirmation missing
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/v1/org',
      headers: { authorization: `Bearer ${tokens.alice}`, 'x-asterius-org': 'acme', 'content-type': 'application/json' },
      payload: JSON.stringify({ confirm: 'acme' }),
    });
    expect(res.statusCode).toBe(200);
    expect(await findOrg('acme')).toBeUndefined();
    // Nothing of acme is left anywhere (it had scorecards, dashboards, history, versions and budgets).
    for (const t of [
      'entities',
      'entity_relations',
      'entity_versions',
      'entity_tombstones',
      'scorecards',
      'scorecard_results',
      'scorecard_history',
      'dashboards',
      'blueprints',
      'blueprint_stats',
      'actions',
      'action_versions',
      'ai_budgets',
      'runs',
      'api_tokens',
      'teams',
      'team_members',
      'secrets',
      'integrations',
      'webhooks',
      'memberships',
    ])
      expect(await one(`SELECT count(*) AS n FROM ${t} WHERE org_id NOT IN (SELECT id FROM organizations)`), t).toMatchObject({ n: 0 });
    expect((await as('alice').get('/api/auth/me')).data.organizations.map((o: { slug: string }) => o.slug)).not.toContain('acme');
  });

  it('asks accounts without an organization to join or create one', async () => {
    config.AUTO_JOIN_DEFAULT_ORG = false;
    const t = (await register(app, 'solo@example.com', 'Solo')).token;
    config.AUTO_JOIN_DEFAULT_ORG = true;
    const solo = client(app, t);
    expect((await solo.get('/api/auth/me')).data).toMatchObject({ organization: null, organizations: [] });
    const res = await solo.get('/api/v1/blueprints');
    expect(res.status).toBe(403);
    expect(res.data.code).toBe('NO_ORGANIZATION');
    expect((await solo.post('/api/orgs', { slug: 'solo', name: 'Solo' })).status).toBe(201);
    expect((await solo.get('/api/v1/blueprints')).status).toBe(200); // falls back to the first organization
  });

  it('lists every organization for super-admins only', async () => {
    expect((await as('alice').get('/api/orgs?all=true')).status).toBe(403);
    const all = (await as('root').get('/api/orgs?all=true')).data as { slug: string }[];
    expect(all.map((o) => o.slug)).toEqual(expect.arrayContaining(['default', 'beta', 'solo']));
  });
});

describe('keycloak sign-in', () => {
  it('verifies ID tokens and follows the organization claim', async () => {
    config.KEYCLOAK_URL = 'https://id.example.com';
    config.KEYCLOAK_CLIENT_ID = 'asterius-platform';
    const { publicKey, privateKey } = await generateKeyPair('RS256');
    const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256' };
    const keySet = createLocalJWKSet({ keys: [jwk] });
    const sign = (claims: Record<string, unknown>, iss = 'https://id.example.com/realms/asterius') =>
      new SignJWT(claims)
        .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
        .setIssuer(iss)
        .setAudience('asterius-platform')
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(privateKey);

    expect(orgAliasesOf(['a', 'b'])).toEqual(['a', 'b']);
    expect(orgAliasesOf({ a: { id: '1' } })).toEqual(['a']);
    await expect(
      checkKeycloakIdToken(await sign({ sub: 's', email: 'x@y.z', nonce: 'n' }, 'https://evil.example.com/realms/asterius'), 'n', keySet),
    ).rejects.toThrow();
    await expect(checkKeycloakIdToken(await sign({ sub: 's', email: 'x@y.z', nonce: 'other' }), 'n', keySet)).rejects.toThrow(/nonce/);

    const beta = (await findOrg('beta'))!;
    await patchSettings(beta.id, { keycloakOrgId: 'kc-beta' }); // linked to a Keycloak Organization
    const id = await checkKeycloakIdToken(
      await sign({ sub: 'kc-1', email: 'Kim@Beta.test', email_verified: true, name: 'Kim', nonce: 'n', organization: ['beta'] }),
      'n',
      keySet,
    );
    expect(id).toMatchObject({ sub: 'kc-1', email: 'kim@beta.test', emailVerified: true, orgs: ['beta'] });
    let user = await upsertKeycloakUser(id);
    expect(await one('SELECT via FROM memberships WHERE org_id = ? AND user_id = ?', beta.id, user.id)).toMatchObject({ via: 'sso' });
    // Keycloak's admin API unreachable (no provider links known): nothing is removed.
    user = await upsertKeycloakUser({ ...id, orgs: [] });
    expect(await one('SELECT via FROM memberships WHERE org_id = ? AND user_id = ?', beta.id, user.id)).toMatchObject({ via: 'sso' });
    // Removed from the Keycloak organization: the SSO membership goes at the next sign-in.
    user = await upsertKeycloakUser({ ...id, orgs: [], sso: [] });
    expect(await one('SELECT via FROM memberships WHERE org_id = ? AND user_id = ?', beta.id, user.id)).toBeUndefined();
    expect(user.provider).toBe('keycloak');
  });
});
