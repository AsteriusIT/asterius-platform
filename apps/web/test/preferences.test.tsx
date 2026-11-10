import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { Route, Routes } from 'react-router';
import type { Action, Blueprint, PublicUser, SavedCatalogView } from '@asterius/shared';
import { api, ApiError, type ActionView } from '../src/lib/api';
import { importLegacyPreferences } from '../src/lib/preferences';
import { runAccess } from '../src/lib/permissions';
import { SelfService } from '../src/pages/SelfService';
import { CatalogList } from '../src/pages/Catalog';
import { renderUi } from './render';

const alice: PublicUser = {
  id: 'u1',
  email: 'alice@example.com',
  name: 'Alice',
  provider: 'local',
  role: 'member',
  roles: [],
  active: true,
  teams: [{ identifier: 'payments', title: 'Payments' }],
};
const auth = vi.hoisted(() => ({ user: null as PublicUser | null }));
vi.mock('../src/lib/auth', () => ({ useAuth: () => ({ user: auth.user, isAdmin: false }) }));

beforeEach(() => {
  auth.user = alice;
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('legacy localStorage import', () => {
  it('moves favourites, recents, columns and views to the server once, then removes them', async () => {
    localStorage.setItem('asterius.favourites', JSON.stringify(['b', 'c']));
    localStorage.setItem('asterius.recent-actions', JSON.stringify(['c']));
    localStorage.setItem('asterius.catalog.columns.service', JSON.stringify(['tier']));
    localStorage.setItem('asterius.catalog.columns.db', JSON.stringify(['engine']));
    localStorage.setItem(
      'asterius.catalog.views.service',
      JSON.stringify([
        { name: 'Gold', search: 'f=tier%3Agold' },
        { name: 'Dup', search: '' },
      ]),
    );
    localStorage.setItem('asterius.draft.a.', JSON.stringify({ x: 1 }));
    const update = vi.spyOn(api, 'updatePreferences').mockImplementation(async (p) => p as never);
    const create = vi.spyOn(api, 'createView').mockImplementation(async (v) => (v.name === 'Dup' ? Promise.reject(new ApiError(409, 'exists')) : (v as never)));
    await importLegacyPreferences({ favourites: ['a', 'b'], 'catalog.columns.db': ['size'] });
    // Favourites merged, server columns kept.
    expect(update).toHaveBeenCalledWith({ favourites: ['a', 'b', 'c'], recentActions: ['c'], 'catalog.columns.service': ['tier'] });
    expect(create).toHaveBeenCalledWith({ name: 'Gold', blueprint: 'service', query: 'f=tier%3Agold' });
    expect(Object.keys(localStorage)).toEqual(['asterius.draft.a.']);
    // Nothing left: no second import.
    update.mockClear();
    await importLegacyPreferences({});
    expect(update).not.toHaveBeenCalled();
  });

  it('keeps the browser copy when saving fails, to retry later', async () => {
    localStorage.setItem('asterius.favourites', JSON.stringify(['a']));
    vi.spyOn(api, 'updatePreferences').mockRejectedValue(new Error('offline'));
    expect(await importLegacyPreferences({ recentActions: ['x'] })).toEqual({ recentActions: ['x'] });
    expect(localStorage.getItem('asterius.favourites')).toBe('["a"]');
  });
});

const form = (allowed: object, on: 'create' | 'day-2' = 'create') =>
  ({
    trigger: { type: 'form', on, blueprint: 'service', inputs: { properties: {} }, allowed, approval: { required: false } },
    enabled: true,
  }) as Pick<Action, 'trigger' | 'enabled'>;
const titles = (id: string) => ({ payments: 'Payments', search: 'Search' })[id] ?? id;

describe('runAccess', () => {
  it('names the teams, roles and people allowed and whom to ask', () => {
    expect(runAccess(form({ teams: ['payments'], roles: ['approver'] }), titles)).toEqual({
      who: ['Team: Payments', 'Role: approver'],
      ask: 'Ask a member of Payments to run it for you, or an admin to add you to this team.',
    });
    expect(runAccess(form({ teams: ['payments', 'search'] }), titles).ask).toMatch(/Payments or Search .* one of these teams/);
    expect(runAccess(form({ users: ['a@x.io', 'b@x.io'] }), titles).who).toEqual(['People: a@x.io, b@x.io']);
    expect(runAccess(form({ ownerTeam: true }, 'day-2'), titles, { team: 'search' })).toEqual({
      who: ['Owner team: Search'],
      ask: 'Ask a member of Search (owner of this entity) to run it for you or to give you access.',
    });
    expect(runAccess({ ...form({}), enabled: false }, titles)).toEqual({ who: [], ask: 'This action is disabled.' });
  });
});

const action = (id: string, allowedForMe: boolean, allowed: object = {}): ActionView =>
  ({
    identifier: id,
    title: id.toUpperCase(),
    description: '',
    icon: null,
    version: 1,
    enabled: true,
    managed: false,
    steps: [{ id: 's', type: 'transform', output: {} }],
    trigger: { type: 'form', on: 'create', blueprint: 'service', inputs: { properties: {} }, allowed, approval: { required: false } },
    allowedForMe,
  }) as unknown as ActionView;

describe('self-service', () => {
  it('keeps favourites on the server and explains how to get access to an action I cannot run', async () => {
    vi.spyOn(api, 'actions').mockResolvedValue([action('open', true), action('locked', false, { teams: ['search'], roles: ['approver'] })]);
    vi.spyOn(api, 'blueprints').mockResolvedValue([]);
    vi.spyOn(api, 'teams').mockResolvedValue([{ identifier: 'search', title: 'Search team' } as never]);
    vi.spyOn(api, 'preferences').mockResolvedValue({ favourites: [], recentActions: ['open', 'locked'] });
    const update = vi.spyOn(api, 'updatePreferences').mockResolvedValue({});
    renderUi(<SelfService />);
    // Recent: only what I can run.
    expect(await screen.findByRole('button', { name: 'OPEN' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'LOCKED' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Add to favourites: OPEN' }));
    expect(update).toHaveBeenCalledWith({ favourites: ['open'] });
    expect(await screen.findByRole('button', { name: 'Remove from favourites: OPEN' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'How to get access to LOCKED' }));
    expect(await screen.findByText('Team: Search team')).toBeTruthy();
    expect(screen.getByText('Role: approver')).toBeTruthy();
    expect(screen.getByText(/Ask a member of Search team to run it for you/)).toBeTruthy();
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
const view = (patch: Partial<SavedCatalogView>): SavedCatalogView => ({
  id: 'v1',
  name: 'Mine',
  blueprint: 'service',
  query: 'f=tier:gold',
  team: null,
  owner: { id: 'u1', name: 'Alice' },
  mine: true,
  canEdit: true,
  createdAt: '',
  updatedAt: '',
  ...patch,
});

describe('catalog views and team filter', () => {
  const mount = (path = '/catalog/service') =>
    renderUi(
      <Routes>
        <Route path="/catalog/:bp" element={<CatalogList />} />
      </Routes>,
      path,
    );
  beforeEach(() => {
    vi.spyOn(api, 'blueprint').mockResolvedValue(bp);
    vi.spyOn(api, 'teams').mockResolvedValue([]);
    vi.spyOn(api, 'actions').mockResolvedValue([]);
    vi.spyOn(api, 'resolveDashboard').mockResolvedValue(null as never);
    vi.spyOn(api, 'scorecards').mockResolvedValue([]);
  });

  it('filters on my teams with a shareable team=@mine parameter', async () => {
    vi.spyOn(api, 'preferences').mockResolvedValue({});
    vi.spyOn(api, 'views').mockResolvedValue([]);
    const entities = vi.spyOn(api, 'entities').mockResolvedValue({ items: [], total: 0 });
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'My teams' }));
    await waitFor(() => expect(entities).toHaveBeenLastCalledWith(expect.objectContaining({ team: '@mine' })));
    expect(screen.getByRole('button', { name: 'My teams' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('lists my views and the ones shared with my teams, saves and shares, and uses server-side columns', async () => {
    vi.spyOn(api, 'preferences').mockResolvedValue({ 'catalog.columns.service': [] });
    vi.spyOn(api, 'views').mockResolvedValue([
      view({}),
      view({ id: 'v2', name: 'Team view', mine: false, canEdit: false, team: { identifier: 'payments', title: 'Payments' }, owner: { id: 'u2', name: 'Bob' } }),
    ]);
    vi.spyOn(api, 'entities').mockResolvedValue({ items: [], total: 0 });
    const create = vi.spyOn(api, 'createView').mockResolvedValue(view({}));
    const updateView = vi.spyOn(api, 'updateView').mockResolvedValue(view({}));
    const prefs = vi.spyOn(api, 'updatePreferences').mockResolvedValue({});
    mount('/catalog/service?q=db');
    // Columns from the server: none picked, so no Tier column.
    await screen.findByText('Name');
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Sort by Tier' })).toBeNull());

    fireEvent.click(screen.getByRole('button', { name: 'Views' }));
    expect(await screen.findByText('My views')).toBeTruthy();
    expect(screen.getByText('Shared with my teams')).toBeTruthy();
    expect(screen.getByText('Payments')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Delete view Team view' })).toBeNull();

    fireEvent.change(screen.getByRole('textbox', { name: 'View name' }), { target: { value: 'DBs' } });
    fireEvent.change(screen.getByRole('combobox', { name: 'Share with' }), { target: { value: 'payments' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(create).toHaveBeenCalledWith({ name: 'DBs', blueprint: 'service', query: 'q=db', team: 'payments' }));

    // Same name as one of mine: updates it.
    fireEvent.click(screen.getByRole('button', { name: 'Edit view Mine' }));
    fireEvent.click(screen.getByRole('button', { name: 'Update' }));
    await waitFor(() => expect(updateView).toHaveBeenCalledWith('v1', { query: 'q=db', team: null }));

    fireEvent.click(screen.getByRole('button', { name: 'Choose columns' }));
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Tier' }));
    expect(prefs).toHaveBeenCalledWith({ 'catalog.columns.service': ['tier'] });
  });
});
