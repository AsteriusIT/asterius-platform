import { describe, expect, it } from 'vitest';
import { config } from '../src/config.js';
import {
  kcAddMember,
  kcAddProvider,
  kcCreateOrganization,
  kcDeleteOrganization,
  kcListProviders,
  kcRemoveMember,
  kcRemoveProvider,
  kcUpdateOrganization,
} from '../src/auth/keycloak.js';
import type { OrgRow } from '../src/orgs/orgs.js';

/**
 * Against a real Keycloak (deploy/keycloak/docker-compose.yaml):
 *   KEYCLOAK_TEST_URL=http://localhost:8180 KEYCLOAK_TEST_SECRET=dev-secret-change-me npx vitest run test/keycloak-live.test.ts
 */
const url = process.env.KEYCLOAK_TEST_URL;

describe.skipIf(!url)('Keycloak admin API (live)', () => {
  it('creates an organization, members and identity providers', async () => {
    config.AUTH_PROVIDERS.push('keycloak');
    config.KEYCLOAK_URL = url;
    config.KEYCLOAK_CLIENT_SECRET = process.env.KEYCLOAK_TEST_SECRET ?? 'dev-secret-change-me';
    const slug = `live-${Date.now().toString(36)}`;
    const id = await kcCreateOrganization({ slug, name: 'Live test', domains: [`${slug}.example.com`] });
    expect(id).toMatch(/[0-9a-f-]{36}/);
    await kcUpdateOrganization(id, { slug, name: 'Live test (renamed)', domains: [`${slug}.example.com`, `${slug}.example.org`] });

    // A user to add (the service account can manage users).
    const tokenRes = await fetch(`${url}/realms/asterius/protocol/openid-connect/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: 'asterius-platform', client_secret: config.KEYCLOAK_CLIENT_SECRET! }),
    });
    const { access_token } = (await tokenRes.json()) as { access_token: string };
    const created = await fetch(`${url}/admin/realms/asterius/users`, {
      method: 'POST',
      headers: { authorization: `Bearer ${access_token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ username: `${slug}@example.com`, email: `${slug}@example.com`, enabled: true, emailVerified: true }),
    });
    const userId = created.headers.get('location')!.split('/').pop()!;
    await kcAddMember(id, userId);
    await kcAddMember(id, userId); // idempotent
    const members = (await (
      await fetch(`${url}/admin/realms/asterius/organizations/${id}/members`, { headers: { authorization: `Bearer ${access_token}` } })
    ).json()) as { id: string }[];
    expect(members.map((m) => m.id)).toContain(userId);
    await kcRemoveMember(id, userId);

    // An OIDC provider: Keycloak's own master realm stands in for a company IdP.
    const org = { slug, settings: JSON.stringify({ keycloakOrgId: id }) } as OrgRow;
    const p = await kcAddProvider(org, {
      alias: 'corp',
      displayName: 'Corp SSO',
      type: 'oidc',
      url: `${url}/realms/master`,
      clientId: 'corp-client',
      clientSecret: 'corp-secret',
      domain: `${slug}.example.com`,
    });
    expect(p).toMatchObject({ alias: 'corp', displayName: 'Corp SSO', type: 'oidc', enabled: true, domain: `${slug}.example.com` });
    expect(p.url).toBe(`${url}/realms/master`);
    expect((await kcListProviders(org)).map((x) => x.alias)).toEqual(['corp']);
    await kcRemoveProvider(org, 'corp');
    expect(await kcListProviders(org)).toEqual([]);

    await kcDeleteOrganization(id);
    await fetch(`${url}/admin/realms/asterius/users/${userId}`, { method: 'DELETE', headers: { authorization: `Bearer ${access_token}` } });
  });
});
