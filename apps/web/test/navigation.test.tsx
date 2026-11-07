import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { AuthProvider } from '../src/lib/auth';
import { Layout } from '../src/components/Layout';
import { CatalogHome } from '../src/pages/Catalog';
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
const me = { id: 'u1', name: 'Ada Admin', email: 'ada@example.com', role: 'admin', teams: [], tourCompletedAt: '2026-01-01T00:00:00Z' };

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
});
