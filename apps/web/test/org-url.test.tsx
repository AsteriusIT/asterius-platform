import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { Route, Routes, useLocation } from 'react-router';
import { AuthProvider, useAuth } from '../src/lib/auth';
import { api, tabOrg } from '../src/lib/api';
import { appHref, bootRoute, hardNavigate, isOrgScoped, legacyRedirect, splitOrgPath } from '../src/lib/orgUrl';
import { OrgGate } from '../src/components/OrgGate';
import { Login } from '../src/pages/Login';
import { renderUi } from './render';

vi.mock('../src/lib/orgUrl', async (importOriginal) => ({ ...(await importOriginal<typeof import('../src/lib/orgUrl')>()), hardNavigate: vi.fn() }));

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const me = {
  id: 'u1',
  name: 'Ada',
  email: 'ada@example.com',
  role: 'member',
  organization: { id: 'o1', slug: 'acme', name: 'Acme' },
  organizations: [
    { id: 'o1', slug: 'acme', name: 'Acme', role: 'member' },
    { id: 'o2', slug: 'beta', name: 'Beta', role: 'admin' },
  ],
  teams: [],
};
/** Org header of each call, by URL. */
let calls: { url: string; org: string | undefined }[] = [];
let members = ['acme', 'beta'];

const at = (path: string) => window.history.replaceState(null, '', path);

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('asterius.token', 't');
  calls = [];
  members = ['acme', 'beta'];
  legacyRedirect.from = null;
  vi.mocked(hardNavigate).mockClear();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const org = (init?.headers as Record<string, string> | undefined)?.['x-asterius-org'];
      calls.push({ url, org });
      if (url === '/api/auth/me') {
        if (org && !members.includes(org)) return json({ error: 'You are not a member of this organization' }, 403);
        const slug = org ?? 'acme';
        return json({ ...me, organization: me.organizations.find((o) => o.slug === slug) });
      }
      if (url === '/api/meta') return json({ name: 'Asterius Platform', authProviders: ['local'] });
      return json([]);
    }),
  );
});
afterEach(() => {
  cleanup();
  at('/');
});

describe('organization URLs', () => {
  it('splits and classifies paths', () => {
    expect(splitOrgPath('/o/acme/runs/1')).toEqual({ slug: 'acme', rest: '/runs/1' });
    expect(splitOrgPath('/o/acme')).toEqual({ slug: 'acme', rest: '/' });
    expect(splitOrgPath('/runs/1')).toBeNull();
    for (const p of ['/login', '/auth/callback', '/welcome', '/platform/organizations', '/orgs/new']) expect(isOrgScoped(p), p).toBe(false);
    for (const p of ['/', '/catalog/service/x', '/runs/1', '/admin/users', '/profile']) expect(isOrgScoped(p), p).toBe(true);
  });

  it('starts in the organization of the URL, and moves legacy URLs under the remembered default', () => {
    expect(bootRoute({ pathname: '/o/beta/runs/1', search: '', hash: '' }, 'acme')).toEqual({ basename: '/o/beta' });
    expect(bootRoute({ pathname: '/runs/1', search: '?step=build', hash: '#logs' }, 'acme')).toEqual({
      basename: '/o/acme',
      replace: '/o/acme/runs/1?step=build#logs',
    });
    expect(bootRoute({ pathname: '/', search: '', hash: '' }, 'acme')).toEqual({ basename: '/o/acme', replace: '/o/acme/' });
    // Unknown default: served outside organizations until the server names it (OrgGate).
    expect(bootRoute({ pathname: '/runs/1', search: '', hash: '' }, null)).toEqual({});
    // Pages outside organizations stay where they are.
    expect(bootRoute({ pathname: '/login', search: '?returnTo=%2Fo%2Facme%2F', hash: '' }, 'acme')).toEqual({});
    expect(bootRoute({ pathname: '/platform/organizations', search: '', hash: '' }, 'acme')).toEqual({});
  });

  it('prefixes stored app links with the tab organization', () => {
    at('/o/beta/runs/1');
    expect(appHref('/runs/2?step=a')).toBe('/o/beta/runs/2?step=a');
    expect(appHref('/o/acme/runs/2')).toBe('/o/acme/runs/2');
    expect(appHref('https://ci.example/run/1')).toBe('https://ci.example/run/1');
    at('/platform/organizations');
    expect(appHref('/runs/2')).toBe('/runs/2');
  });

  it('sends the organization of the URL with API calls, not the remembered one', async () => {
    localStorage.setItem('asterius.org', 'acme');
    at('/o/beta/catalog');
    expect(tabOrg()).toBe('beta');
    await api.me();
    expect(calls.at(-1)).toEqual({ url: '/api/auth/me', org: 'beta' });
    at('/platform/organizations');
    await api.me();
    expect(calls.at(-1)).toEqual({ url: '/api/auth/me', org: 'acme' });
  });

  it('never swaps the URL organization silently when the user is not a member', async () => {
    at('/o/zeta/catalog');
    await expect(api.me()).rejects.toMatchObject({ status: 403 });
    expect(calls.map((c) => c.org)).toEqual(['zeta']);
  });
});

function gate(path: string, page = <div>home page</div>) {
  return renderUi(
    <AuthProvider>
      <Routes>
        <Route element={<OrgGate />}>
          <Route path="/login" element={<Login />} />
          <Route path="*" element={page} />
        </Route>
      </Routes>
    </AuthProvider>,
    path,
  );
}

describe('OrgGate', () => {
  it('shows the not-a-member page with links to the user organizations', async () => {
    at('/o/zeta/catalog');
    gate('/catalog');
    expect(await screen.findByText('You are not a member of zeta')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Acme' }).getAttribute('href')).toBe('/o/acme/');
    expect(screen.getByRole('link', { name: 'Beta' }).getAttribute('href')).toBe('/o/beta/');
    expect(screen.queryByText('home page')).toBeNull();
    // Nothing was remembered for a refused organization.
    expect(localStorage.getItem('asterius.org')).toBeNull();
  });

  it('renders organization pages in a member organization', async () => {
    at('/o/beta/runs');
    gate('/runs');
    expect(await screen.findByText('home page')).toBeTruthy();
    await waitFor(() => expect(localStorage.getItem('asterius.org')).toBe('beta')); // the default for new visits
  });

  it('redirects a legacy URL to the default organization, keeping path, query and hash', async () => {
    at('/runs/r1');
    gate('/runs/r1?step=build#logs');
    await waitFor(() => expect(hardNavigate).toHaveBeenCalledWith('/o/acme/runs/r1?step=build#logs'));
  });

  it('retries a legacy URL without the remembered organization the user left', async () => {
    members = ['acme'];
    localStorage.setItem('asterius.org', 'beta');
    legacyRedirect.from = '/runs/r1';
    at('/o/beta/runs/r1');
    gate('/runs/r1');
    await waitFor(() => expect(hardNavigate).toHaveBeenCalledWith('/runs/r1'));
    expect(localStorage.getItem('asterius.org')).toBeNull();
  });

  it('leaves the organization for pages outside it and links to other organizations', async () => {
    at('/o/acme/platform/organizations');
    gate('/platform/organizations');
    await waitFor(() => expect(hardNavigate).toHaveBeenCalledWith('/platform/organizations'));
    cleanup();
    at('/o/acme/o/beta/catalog');
    gate('/o/beta/catalog');
    await waitFor(() => expect(hardNavigate).toHaveBeenCalledWith('/o/beta/catalog'));
  });

  it('signs in first, then comes back to the deep link', async () => {
    localStorage.removeItem('asterius.token');
    at('/runs/r1');
    function Where() {
      return <div>at {useLocation().pathname + useLocation().search}</div>;
    }
    renderUi(
      <AuthProvider>
        <Routes>
          <Route element={<OrgGate />}>
            <Route path="/login" element={<Where />} />
            <Route path="*" element={<div>home page</div>} />
          </Route>
        </Routes>
      </AuthProvider>,
      '/runs/r1?step=a',
    );
    expect(await screen.findByText(`at /login?returnTo=${encodeURIComponent('/runs/r1?step=a')}`)).toBeTruthy();
  });

  it('switches organization with a full load of its home', async () => {
    at('/o/acme/');
    function Switch() {
      const { switchOrg, org } = useAuth();
      return <button onClick={() => switchOrg('beta')}>{org?.slug ?? '…'}</button>;
    }
    gate('/', <Switch />);
    fireEvent.click(await screen.findByRole('button', { name: 'acme' }));
    expect(hardNavigate).toHaveBeenCalledWith('/o/beta/', false);
    expect(localStorage.getItem('asterius.org')).toBe('beta');
  });
});

describe('Login', () => {
  it('goes back to the returnTo of its URL once signed in', async () => {
    at('/login');
    gate('/login?returnTo=%2Fo%2Fbeta%2Fruns%2Fr1');
    await waitFor(() => expect(hardNavigate).toHaveBeenCalledWith('/o/beta/runs/r1'));
  });
});
