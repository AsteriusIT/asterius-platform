import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { AuthProvider } from '../src/lib/auth';
import { Layout } from '../src/components/Layout';
import { CatalogHome } from '../src/pages/Catalog';
import { Navigate, Route, Routes } from 'react-router';
import { SectionTabs } from '../src/components/SectionTabs';
import { ADMIN_CATEGORIES } from '../src/components/adminSections';
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
            <Route path="/admin" element={<SectionTabs />}>
              {ADMIN_CATEGORIES.map((c) => (
                <Route key={c.id} path={c.id} element={<Navigate to={c.tabs[0].path} replace />} />
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
    expect(screen.getAllByRole('tab')).toHaveLength(6); // Actions, Fragments, Integrations, Webhooks, Deliveries, Notifications
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
});
