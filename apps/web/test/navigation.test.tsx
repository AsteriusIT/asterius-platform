import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { AuthProvider } from '../src/lib/auth';
import { Layout } from '../src/components/Layout';
import { CatalogHome } from '../src/pages/Catalog';
import { Route, Routes } from 'react-router';
import { AdminRoute, CategoryRedirect } from '../src/components/SectionTabs';
import { ADMIN_CATEGORIES, visibleCategories } from '../src/components/adminSections';
import { navCommands } from '../src/components/CommandPalette';
import { canAdminister } from '../src/lib/access';
import { BlueprintBuilder } from '../src/components/builder/BlueprintBuilder';
import { renderUi } from './render';

const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
const blueprints = [
  { identifier: 'service', title: 'Service', description: 'Deployable units', icon: 'kubernetes', entityCount: 12, schema: { properties: {} }, relations: {} },
  {
    identifier: 'repository',
    title: 'Repository',
    description: 'Git repositories',
    icon: 'github',
    entityCount: 30,
    schema: { properties: {} },
    relations: {},
  },
];
const me = {
  id: 'u1',
  name: 'Ada Admin',
  email: 'ada@example.com',
  role: 'admin',
  organization: { id: 'o1', slug: 'acme', name: 'Acme' },
  teams: [],
  tourCompletedAt: '2026-01-01T00:00:00Z',
};

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('asterius.token', 't');
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url.startsWith('/api/auth/me')) return json(me);
      if (url.startsWith('/api/v1/blueprints')) return json(blueprints);
      if (url === '/api/meta') return json({ name: 'Asterius Platform', logo: null, authProviders: ['local'], invokers: [], sources: [] });
      return json([]);
    }),
  );
});
afterEach(cleanup);

describe('navigation', () => {
  it('links to the catalog page instead of listing every blueprint, and folds to icons', async () => {
    renderUi(
      <AuthProvider>
        <Layout />
      </AuthProvider>,
    );
    const catalog = await screen.findByRole('link', { name: 'Catalog' });
    expect(catalog.getAttribute('href')).toBe('/catalog');
    await waitFor(() => expect(catalog.textContent).toContain('42')); // total entities
    expect(screen.queryByRole('link', { name: 'Service' })).toBeNull();

    fireEvent.click(screen.getByLabelText('Collapse sidebar'));
    expect(localStorage.getItem('asterius.nav-collapsed')).toBe('true');
    expect(screen.getByRole('link', { name: 'Catalog' }).textContent).not.toContain('Catalog'); // icon only, name kept for a11y
    expect(screen.getByLabelText('Expand sidebar')).toBeTruthy();
  });

  it('has To do (with its count) right after Home and Runs after Self-service in the sidebar, not in the header', async () => {
    const orig = globalThis.fetch;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => (url.startsWith('/api/v1/approvals') ? json([{ id: 'r1' }, { id: 'r2' }]) : (orig as typeof fetch)(url))),
    );
    renderUi(
      <AuthProvider>
        <Layout />
      </AuthProvider>,
    );
    const todo = await screen.findByRole('link', { name: 'To do (2 waiting for you)' });
    expect(todo.getAttribute('href')).toBe('/todo');
    expect(todo.textContent).toContain('2');
    const nav = [...document.querySelectorAll('.app-navbar a.nav-link')].map((a) => a.getAttribute('href'));
    expect(nav.slice(0, 5)).toEqual(['/', '/todo', '/self-service', '/runs', '/catalog']);
    expect(document.querySelector('.app-header a[href="/approvals"]')).toBeNull();
    expect(document.querySelector('.app-header a[href="/runs"]')).toBeNull();
    expect(document.querySelector('[data-tour="todo"]')).toBeTruthy();
    expect(document.querySelector('[data-tour="runs"]')?.getAttribute('href')).toBe('/runs');
  });

  it('lists every kind on the catalog page, filterable', async () => {
    renderUi(
      <AuthProvider>
        <CatalogHome />
      </AuthProvider>,
    );
    expect((await screen.findByRole('link', { name: 'Repository' })).getAttribute('href')).toBe('/catalog/repository');
    expect(screen.getByRole('link', { name: 'Service' })).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText('Filter kinds'), { target: { value: 'deploy' } });
    expect(screen.queryByRole('link', { name: 'Repository' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Service' })).toBeTruthy();
  });

  const app = (path: string) =>
    renderUi(
      <AuthProvider>
        <Routes>
          <Route element={<Layout />}>
            <Route path="/admin" element={<AdminRoute />}>
              {ADMIN_CATEGORIES.map((c) => (
                <Route key={c.id} path={c.id} element={<CategoryRedirect category={c} />} />
              ))}
              {ADMIN_CATEGORIES.flatMap((c) => c.tabs).map((t) => (
                <Route key={t.path} path={t.path.replace('/admin/', '')} element={<div>page {t.label}</div>} />
              ))}
            </Route>
            <Route path="*" element={<div>other</div>} />
          </Route>
        </Routes>
      </AuthProvider>,
      path,
    );

  it('shows five admin categories to admins, active on any of their tab routes', async () => {
    app('/admin/webhooks');
    for (const t of ['Catalog model', 'Automation', 'Access', 'Governance', 'Settings']) {
      expect(await screen.findByRole('link', { name: t })).toBeTruthy();
    }
    expect(screen.queryByRole('link', { name: 'Webhooks' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Automation' }).getAttribute('data-active')).toBe('true');
    expect(screen.getByRole('link', { name: 'Access' }).getAttribute('data-active')).toBeNull();
  });

  it('renders the tabs on /admin/actions with Actions active', async () => {
    app('/admin/actions');
    const tab = await screen.findByRole('tab', { name: 'Actions' });
    expect(tab.getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('tab', { name: 'Integrations' }).getAttribute('aria-selected')).toBe('false');
    expect(screen.getAllByRole('tab')).toHaveLength(8); // Actions, Fragments, Integrations, Connections, Connectors, Webhooks, Deliveries, Notifications
  });

  it('redirects a category URL to its first tab', async () => {
    app('/admin/automation');
    expect((await screen.findByRole('tab', { name: 'Actions' })).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByText('page Actions')).toBeTruthy();
  });

  it('hides the categories from members', async () => {
    const orig = globalThis.fetch;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => (url.startsWith('/api/auth/me') ? json({ ...me, role: 'member' }) : (orig as typeof fetch)(url))),
    );
    app('/');
    await screen.findByRole('link', { name: 'Catalog' });
    expect(screen.queryByRole('link', { name: 'Automation' })).toBeNull();
  });

  /** Signed in as a member of Acme holding these delegated roles. */
  const asMember = (roles: string[]) => {
    const orig = globalThis.fetch;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => (url.startsWith('/api/auth/me') ? json({ ...me, name: 'Bo Member', role: 'member', roles }) : (orig as typeof fetch)(url))),
    );
  };

  it('shows a blueprint owner the Blueprints page only, and keeps Secrets closed', async () => {
    asMember(['blueprint-owner']);
    app('/admin/blueprints');
    expect(await screen.findByText('page Blueprints')).toBeTruthy();
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['Blueprints']);
    expect(screen.getByRole('link', { name: 'Catalog model' }).getAttribute('href')).toBe('/admin/blueprints');
    for (const t of ['Automation', 'Access', 'Governance', 'Settings']) expect(screen.queryByRole('link', { name: t })).toBeNull();
    cleanup();

    app('/admin/secrets');
    expect(await screen.findByText('other')).toBeTruthy(); // sent home
    expect(screen.queryByText('page Secrets')).toBeNull();
  });

  it('sends a category URL to the first tab the role may open', async () => {
    asMember(['integration-admin']);
    app('/admin/automation');
    expect(await screen.findByText('page Integrations')).toBeTruthy();
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['Integrations', 'Connections', 'Connectors']);
    expect(screen.getByRole('link', { name: 'Automation' }).getAttribute('href')).toBe('/admin/integrations');
    expect(screen.queryByRole('link', { name: 'Catalog model' })).toBeNull();
  });

  it('keeps admin-only pages closed to an integration admin (Deliveries, the workflow editor)', async () => {
    asMember(['integration-admin']);
    app('/admin/deliveries');
    expect(await screen.findByText('other')).toBeTruthy();
  });

  it('shows the delegated roles readably in the account menu', async () => {
    asMember(['blueprint-owner', 'approver', 'release-manager']);
    app('/');
    fireEvent.click(await screen.findByLabelText('Account'));
    expect(await screen.findByLabelText('Role: Blueprint owner')).toBeTruthy();
    expect(screen.getByLabelText('Role: Approver')).toBeTruthy();
    expect(screen.getByLabelText('Role: release-manager')).toBeTruthy(); // custom role: its slug
  });

  it('hides the admin-only AI draft from a blueprint owner editing a blueprint', async () => {
    const editor = () =>
      renderUi(
        <AuthProvider>
          <BlueprintBuilder isNew value={{ identifier: '', title: '' }} onSave={async () => undefined} onClose={() => undefined} />
        </AuthProvider>,
      );
    const orig = globalThis.fetch;
    const withAi = (role: string, roles: string[]) =>
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string) =>
          url.startsWith('/api/auth/me')
            ? json({ ...me, role, roles })
            : url.startsWith('/api/v1/ai/status')
              ? json({ enabled: true, provider: 'anthropic', assistantModel: 'm' })
              : (orig as typeof fetch)(url),
        ),
      );
    withAi('admin', []);
    editor();
    expect(await screen.findByText('Draft with AI')).toBeTruthy();
    cleanup();

    withAi('member', ['blueprint-owner']);
    editor();
    expect(await screen.findByLabelText(/^Title/)).toBeTruthy();
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByText('Draft with AI')).toBeNull();
  });

  it('gives a plain member or an approver no Administration section', async () => {
    asMember(['approver']);
    app('/');
    await screen.findByRole('link', { name: 'Catalog' });
    expect(screen.queryByText('Administration')).toBeNull();
    for (const c of ADMIN_CATEGORIES) expect(screen.queryByRole('link', { name: c.title })).toBeNull();
  });
});

describe('admin access by role', () => {
  const user = (role: 'admin' | 'member', roles: string[] = []) => ({ role, roles, organization: { id: 'o1', slug: 'acme', name: 'Acme' } });
  const can = (u: ReturnType<typeof user>) => (area: Parameters<typeof canAdminister>[1]) => canAdminister(u, area);
  const tabs = (u: ReturnType<typeof user>) => visibleCategories(can(u)).flatMap((c) => c.tabs.map((t) => t.label));

  it('matches the server guards', () => {
    expect(tabs(user('admin'))).toEqual(ADMIN_CATEGORIES.flatMap((c) => c.tabs.map((t) => t.label)));
    expect(tabs(user('member'))).toEqual([]);
    expect(tabs(user('member', ['approver', 'custom-role']))).toEqual([]);
    expect(tabs(user('member', ['blueprint-owner']))).toEqual(['Blueprints']);
    expect(tabs(user('member', ['integration-admin']))).toEqual(['Integrations', 'Connections', 'Connectors']);
    expect(tabs(user('member', ['integration-admin', 'blueprint-owner']))).toEqual(['Blueprints', 'Integrations', 'Connections', 'Connectors']);
    expect(canAdminister({ ...user('admin'), organization: null }, 'blueprints')).toBe(false); // no organization yet
  });

  it('lists only the permitted admin pages in the command palette', () => {
    const admin = navCommands(can(user('member', ['blueprint-owner']))).filter((c) => c.id.startsWith('admin'));
    expect(admin.map((c) => c.to)).toEqual(['/admin/blueprints']);
  });
});
