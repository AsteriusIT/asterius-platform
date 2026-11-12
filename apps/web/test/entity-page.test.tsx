import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router';
import type { Blueprint, Entity } from '@asterius/shared';
import { theme } from '@asterius/brand';
import { EntityPage } from '../src/pages/EntityPage';
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
  schema: { properties: { repo: { type: 'string', format: 'url', title: 'Repository' } } },
  relations: {},
} as unknown as Blueprint;
const entity = {
  blueprint: 'service',
  identifier: 'api',
  title: 'API',
  team: null,
  properties: { repo: 'https://git.example/api' },
  relations: {},
  source: 'api',
  version: 1,
  createdAt: '',
  updatedAt: '',
} as Entity;

let docsOn = false;
const bpWithDocs = () => (docsOn = true);

function mount(url: string) {
  const withDocs = docsOn;
  docsOn = false;
  vi.spyOn(api, 'blueprint').mockResolvedValue(
    withDocs ? ({ ...bp, schema: { properties: { docs: { type: 'string', format: 'docs' } } } } as unknown as Blueprint) : bp,
  );
  vi.spyOn(api, 'entity').mockResolvedValue(withDocs ? ({ ...entity, properties: { docs: 'https://x/y.md' } } as Entity) : entity);
  vi.spyOn(api, 'related').mockResolvedValue({ outgoing: {}, incoming: {} });
  vi.spyOn(api, 'entityActions').mockResolvedValue([]);
  vi.spyOn(api, 'runs').mockResolvedValue({ items: [], total: 0 });
  render(
    <MantineProvider theme={theme} env="test">
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter initialEntries={[url]}>
          <Routes>
            <Route path="/catalog/:bp/:id" element={<EntityPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    </MantineProvider>,
  );
}

describe('EntityPage', () => {
  it('shows a links section for url properties', async () => {
    mount('/catalog/service/api');
    const links = await screen.findAllByRole('link', { name: 'Repository' });
    expect(links[0].getAttribute('href')).toBe('https://git.example/api');
  });

  it('opens the tab named in the URL', async () => {
    mount('/catalog/service/api?tab=json');
    expect(await screen.findByRole('tab', { name: 'Raw', selected: true })).toBeTruthy();
  });

  it('has each tab once, and the history tab shows one panel with the versions', async () => {
    vi.spyOn(api, 'history').mockResolvedValue({
      items: [
        {
          version: 1,
          op: 'create',
          actor: null,
          source: 'integration:grafana',
          at: '2026-11-07T14:00:00Z',
          diff: [],
          snapshot: { title: 'API', team: null, properties: {}, relations: {} },
        },
      ],
    } as unknown as Awaited<ReturnType<typeof api.history>>);
    mount('/catalog/service/api?tab=history');
    const tabs = (await screen.findAllByRole('tab')).map((t) => t.textContent);
    expect(tabs).toEqual([...new Set(tabs)]);
    expect(await screen.findByText('Version 1')).toBeTruthy();
    expect(screen.getAllByRole('tabpanel')).toHaveLength(1);
  });
});

describe('EntityPage docs tab', () => {
  it('renders the docs of a docs property with relative links resolved', async () => {
    bpWithDocs();
    vi.spyOn(api, 'entityDocs').mockResolvedValue({
      property: 'docs',
      url: 'https://raw.example/acme/api/main/docs/index.md',
      markdown: '# Guide\n\n[more](more.md)',
    });
    mount('/catalog/service/api?tab=docs');
    expect(await screen.findByRole('heading', { name: 'Guide' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'more' }).getAttribute('href')).toBe('https://raw.example/acme/api/main/docs/more.md');
  });

  it('has no Docs tab without a docs property', async () => {
    mount('/catalog/service/api');
    await screen.findByText('Overview');
    expect(screen.queryByRole('tab', { name: 'Docs' })).toBeNull();
  });
});
