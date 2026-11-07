import { inflateRawSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { SignedXml } from 'xml-crypto';
import type { FastifyInstance } from 'fastify';
import { client, register, testApp } from './helpers.js';

// A throwaway IdP key pair, generated before the config module loads.
const idp = await vi.hoisted(async () => {
  const { execFileSync } = await import('node:child_process');
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'saml-'));
  const key = path.join(dir, 'key.pem');
  const crt = path.join(dir, 'crt.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', crt, '-days', '2', '-subj', '/CN=test-idp'], {
    stdio: 'ignore',
  });
  const cert = fs.readFileSync(crt, 'utf8');
  process.env.AUTH_PROVIDERS = 'local,saml';
  process.env.SAML_ENTRY_POINT = 'https://idp.example.com/sso';
  process.env.SAML_IDP_CERT = cert;
  process.env.SAML_IDP_ISSUER = 'https://idp.example.com/metadata';
  process.env.SAML_ISSUER = 'urn:asterius:test-sp';
  process.env.SAML_ADMIN_GROUPS = 'platform-admins';
  process.env.SAML_TITLE = 'Corporate SSO';
  return { key: fs.readFileSync(key, 'utf8'), cert };
});

const ACS = 'http://localhost:5173/api/auth/saml/acs';
let app: FastifyInstance;

beforeAll(async () => {
  app = await testApp();
  await register(app, 'admin@example.com'); // bootstrap admin so SAML users are plain members
});
afterAll(() => app.close());

/** Start a login and return the AuthnRequest id. */
async function startLogin(returnTo = '/catalog') {
  const res = await app.inject({ method: 'GET', url: `/api/auth/saml/login?returnTo=${encodeURIComponent(returnTo)}` });
  expect(res.statusCode).toBe(302);
  const url = new URL(res.headers.location as string);
  expect(url.origin).toBe('https://idp.example.com');
  const xml = inflateRawSync(Buffer.from(url.searchParams.get('SAMLRequest')!, 'base64')).toString();
  return { id: /ID="([^"]+)"/.exec(xml)![1]!, relay: url.searchParams.get('RelayState') };
}

function assertion(o: { id: string; inResponseTo: string; email: string; audience?: string; groups?: string[]; sign?: boolean; nameId?: string }) {
  const now = new Date();
  const iso = (d: Date) => d.toISOString();
  const later = new Date(now.getTime() + 5 * 60_000);
  const xml =
    `<saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_a${o.id}" Version="2.0" IssueInstant="${iso(now)}">` +
    `<saml:Issuer>https://idp.example.com/metadata</saml:Issuer>` +
    `<saml:Subject><saml:NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress">${o.nameId ?? o.email}</saml:NameID>` +
    `<saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer"><saml:SubjectConfirmationData InResponseTo="${o.inResponseTo}" NotOnOrAfter="${iso(later)}" Recipient="${ACS}"/></saml:SubjectConfirmation></saml:Subject>` +
    `<saml:Conditions NotBefore="${iso(new Date(now.getTime() - 60_000))}" NotOnOrAfter="${iso(later)}"><saml:AudienceRestriction><saml:Audience>${o.audience ?? 'urn:asterius:test-sp'}</saml:Audience></saml:AudienceRestriction></saml:Conditions>` +
    `<saml:AuthnStatement AuthnInstant="${iso(now)}"><saml:AuthnContext><saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport</saml:AuthnContextClassRef></saml:AuthnContext></saml:AuthnStatement>` +
    `<saml:AttributeStatement>` +
    `<saml:Attribute Name="email"><saml:AttributeValue>${o.email}</saml:AttributeValue></saml:Attribute>` +
    `<saml:Attribute Name="displayName"><saml:AttributeValue>Sam Ple</saml:AttributeValue></saml:Attribute>` +
    `<saml:Attribute Name="groups">${(o.groups ?? []).map((g) => `<saml:AttributeValue>${g}</saml:AttributeValue>`).join('')}</saml:Attribute>` +
    `</saml:AttributeStatement></saml:Assertion>`;
  if (o.sign === false) return xml;
  const sig = new SignedXml({
    privateKey: idp.key,
    publicCert: idp.cert,
    signatureAlgorithm: 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256',
    canonicalizationAlgorithm: 'http://www.w3.org/2001/10/xml-exc-c14n#',
  });
  sig.addReference({
    xpath: "//*[local-name(.)='Assertion']",
    transforms: ['http://www.w3.org/2000/09/xmldsig#enveloped-signature', 'http://www.w3.org/2001/10/xml-exc-c14n#'],
    digestAlgorithm: 'http://www.w3.org/2001/04/xmlenc#sha256',
  });
  sig.computeSignature(xml, { location: { reference: "//*[local-name(.)='Assertion']/*[local-name(.)='Issuer']", action: 'after' } });
  return sig.getSignedXml();
}

const response = (inResponseTo: string, inner: string) =>
  Buffer.from(
    `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_r${inResponseTo}" Version="2.0" IssueInstant="${new Date().toISOString()}" Destination="${ACS}" InResponseTo="${inResponseTo}">` +
      `<saml:Issuer>https://idp.example.com/metadata</saml:Issuer><samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>${inner}</samlp:Response>`,
  ).toString('base64');

async function acs(samlResponse: string, relay = '/catalog') {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/saml/acs',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: new URLSearchParams({ SAMLResponse: samlResponse, RelayState: relay }).toString(),
  });
  return new URL(res.headers.location as string, 'http://x');
}

describe('SAML 2.0', () => {
  it('serves SP metadata and advertises the provider', async () => {
    const md = await app.inject({ method: 'GET', url: '/api/auth/saml/metadata' });
    expect(md.body).toContain('urn:asterius:test-sp');
    expect(md.body).toContain('/api/auth/saml/acs');
    const meta = (await client(app).get('/api/meta')).data;
    expect(meta).toMatchObject({ samlTitle: 'Corporate SSO' });
    expect(meta.authProviders).toContain('saml');
  });

  it('signs a user in from a signed assertion and applies group mapping', async () => {
    const { id } = await startLogin();
    const to = await acs(response(id, assertion({ id: 'ok1', inResponseTo: id, email: 'Sam@Corp.com', groups: ['platform-admins'] })));
    expect(to.pathname).toBe('/auth/callback');
    const hash = new URLSearchParams(to.hash.slice(1));
    expect(hash.get('returnTo')).toBe('/catalog');
    const me = (await client(app, hash.get('token')!).get('/api/auth/me')).data;
    expect(me).toMatchObject({ email: 'sam@corp.com', provider: 'saml', role: 'admin', name: 'Sam Ple' });
  });

  it('rejects replays: a request id is single use', async () => {
    const { id } = await startLogin();
    const body = response(id, assertion({ id: 'rp', inResponseTo: id, email: 'replay@corp.com' }));
    expect((await acs(body)).pathname).toBe('/auth/callback');
    const again = await acs(body);
    expect(again.pathname).toBe('/login');
  });

  it('rejects unsigned, tampered, unsolicited and wrong-audience assertions', async () => {
    const a = await startLogin();
    expect((await acs(response(a.id, assertion({ id: 'u1', inResponseTo: a.id, email: 'x@corp.com', sign: false })))).pathname).toBe('/login');

    const b = await startLogin();
    const signed = assertion({ id: 't1', inResponseTo: b.id, email: 'victim@corp.com' });
    const tampered = signed.replace('victim@corp.com', 'admin@corp.com').replace('victim@corp.com', 'admin@corp.com');
    expect((await acs(response(b.id, tampered))).pathname).toBe('/login');

    expect((await acs(response('_never-issued', assertion({ id: 'x1', inResponseTo: '_never-issued', email: 'y@corp.com' })))).pathname).toBe('/login');

    const c = await startLogin();
    expect((await acs(response(c.id, assertion({ id: 'aud', inResponseTo: c.id, email: 'z@corp.com', audience: 'urn:someone-else' })))).pathname).toBe(
      '/login',
    );
    expect(
      (await app.inject({ method: 'POST', url: '/api/auth/saml/acs', headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: '' }))
        .statusCode,
    ).toBe(303);
  });

  it('keeps open-redirect relay states out', async () => {
    const { id } = await startLogin('//evil.example.com');
    const to = await acs(response(id, assertion({ id: 'rs', inResponseTo: id, email: 'relay@corp.com' })), '//evil.example.com');
    expect(new URLSearchParams(to.hash.slice(1)).get('returnTo')).toBe('/');
  });

  it('records failed SAML sign-ins in the audit log', async () => {
    const admin = client(app, (await client(app).post('/api/auth/login', { email: 'admin@example.com', password: 'correct-horse-battery' })).data.token);
    const log = (await admin.get('/api/v1/audit?action=auth.login_failed&limit=50')).data as { detail: { provider?: string } }[];
    expect(log.some((e) => e.detail.provider === 'saml')).toBe(true);
  });
});
