import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import type { Blueprint } from '@asterius/shared';
import { theme } from '../src/theme';
import { CatalogList } from '../src/pages/Catalog';
import { api } from '../src/lib/api';

vi.mock('../src/lib/auth', () => ({ useAuth: () => ({ user: null, isAdmin: false }) }));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const bp = {
  identifier: 'service',
  title: 'Services',
  description: '',
  icon: null,
  schema: { properties: { tier: { type: 'string' } } },
  relations: {},
} as unknown as Blueprint;

function Where() {
  const l = useLocation();
  return <div data-testid="where">{l.pathname + l.search}</div>;
}

function mount(url: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MantineProvider theme={theme} env="test">
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={[url]}>
          <Where />
          <Routes>
            <Route path="/catalog/:bp" element={<CatalogList />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    </MantineProvider>,
  );
}

function mockApi() {
  vi.spyOn(api, 'blueprint').mockResolvedValue(bp);
  vi.spyOn(api, 'teams').mockResolvedValue([]);
  vi.spyOn(api, 'actions').mockResolvedValue([]);
  return vi.spyOn(api, 'entities').mockResolvedValue({ items: [], total: 0 });
}

describe('catalog search', () => {
  it('reads q from the URL and writes it back', async () => {
    const entities = mockApi();
    mount('/catalog/service?q=abc');
    const box = (await screen.findByLabelText('Search services')) as HTMLInputElement;
    expect(box.value).toBe('abc');
    fireEvent.change(box, { target: { value: 'pay' } });
    await waitFor(() => expect(screen.getByTestId('where').textContent).toContain('q=pay'));
    await waitFor(() => expect(entities).toHaveBeenCalledWith(expect.objectContaining({ search: 'pay' })));
    fireEvent.change(box, { target: { value: '' } });
    await waitFor(() => expect(screen.getByTestId('where').textContent).not.toContain('q='));
  });
});
