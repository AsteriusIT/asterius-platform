import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router';
import type { Blueprint, Entity } from '@asterius/shared';
import { theme } from '../src/theme';
import { CatalogList } from '../src/pages/Catalog';
import { api } from '../src/lib/api';
import { formatFilters, formatSort, nextSort, parseFilters, parseSort, toApiSort, toCsv } from '../src/lib/catalogView';

vi.mock('../src/lib/auth', () => ({ useAuth: () => ({ user: null, isAdmin: false }) }));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('catalogView helpers', () => {
  it('round-trips sort and filters', () => {
    expect(parseSort('-tier')).toEqual({ key: 'tier', dir: 'desc' });
    expect(formatSort(parseSort('title'))).toBe('title');
    expect(nextSort(null, 'a')).toEqual({ key: 'a', dir: 'asc' });
    expect(nextSort({ key: 'a', dir: 'asc' }, 'a')).toEqual({ key: 'a', dir: 'desc' });
    expect(nextSort({ key: 'a', dir: 'desc' }, 'a')).toBeNull();
    expect(toApiSort('tier', ['tier'])).toBe('prop.tier');
    expect(toApiSort('updated', ['tier'])).toBe('updated');
    expect(parseFilters(formatFilters({ tier: '1', note: 'a:b' }))).toEqual({ tier: '1', note: 'a:b' });
  });

  it('escapes CSV and neutralises formulas', () => {
    const e = { identifier: 'a', title: 'Say "hi", ok', team: null, properties: { x: '=cmd()', n: 3 } } as unknown as Entity;
    expect(toCsv([e], ['x', 'n'])).toBe('identifier,title,team,x,n\r\na,"Say ""hi"", ok",,\'=cmd(),3\r\n');
  });
});

const bp = {
  identifier: 'service',
  title: 'Services',
  description: '',
  icon: null,
  schema: { properties: { tier: { type: 'string', title: 'Tier' } } },
  relations: {},
} as unknown as Blueprint;

describe('catalog table', () => {
  it('sorts from the header and filters by property', async () => {
    vi.spyOn(api, 'blueprint').mockResolvedValue(bp);
    vi.spyOn(api, 'teams').mockResolvedValue([]);
    vi.spyOn(api, 'actions').mockResolvedValue([]);
    const entities = vi.spyOn(api, 'entities').mockResolvedValue({ items: [], total: 0 });
    render(
      <MantineProvider theme={theme} env="test">
        <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
          <MemoryRouter initialEntries={['/catalog/service?f=tier:1']}>
            <Routes>
              <Route path="/catalog/:bp" element={<CatalogList />} />
            </Routes>
          </MemoryRouter>
        </QueryClientProvider>
      </MantineProvider>,
    );
    await screen.findByText('Tier: 1');
    expect(entities).toHaveBeenCalledWith(expect.objectContaining({ filters: { tier: '1' } }));
    fireEvent.click(screen.getByRole('button', { name: 'Sort by Tier' }));
    await waitFor(() => expect(entities).toHaveBeenCalledWith(expect.objectContaining({ sort: 'prop.tier', order: 'asc' })));
    fireEvent.click(screen.getByRole('button', { name: 'Remove filter Tier' }));
    await waitFor(() => expect(entities).toHaveBeenLastCalledWith(expect.objectContaining({ filters: {} })));
  });
});
