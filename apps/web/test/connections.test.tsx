import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { Connection, ConnectorDefinition, Integration } from '@asterius/shared';
import { api, ApiError } from '../src/lib/api';
import { authInputs, authProblems, blueprintsFed, connectionTypeOf } from '../src/lib/connectors';
import { ConnectionBuilder, connectionBody, toConnectionDoc } from '../src/components/builder/ConnectionBuilder';
import { IntegrationForm } from '../src/components/builder/IntegrationForm';
import { ConnectionsAdmin } from '../src/pages/admin/Connections';
import { ConnectorsAdmin } from '../src/pages/admin/Connectors';
import { renderUi } from './render';

// Delegated roles: `canAdmin` false is an integration admin (connections yes, definitions read-only).
let canAdmin = true;
vi.mock('../src/lib/auth', async (orig) => ({
  ...(await orig<typeof import('../src/lib/auth')>()),
  useCan: () => (area: string) => (area === 'admin' ? canAdmin : true),
}));

beforeEach(() => {
  canAdmin = true;
  localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const def = (over: Partial<ConnectorDefinition>): ConnectorDefinition => ({
  identifier: 'x',
  title: 'X',
  description: '',
  icon: null,
  category: 'other',
  fields: { properties: { baseUrl: { type: 'string', title: 'API URL' } } },
  auth: [],
  authOptional: false,
  headers: {},
  kinds: {},
  operations: {},
  builtin: false,
  managed: false,
  version: 1,
  updatedAt: null,
  ...over,
});

const pagerduty = def({
  identifier: 'pagerduty',
  title: 'PagerDuty',
  description: 'Services and incidents',
  icon: 'alarm',
  category: 'incident',
  builtin: true,
  version: 0,
  fields: { properties: { baseUrl: { type: 'string', title: 'API URL', default: 'https://api.pagerduty.com' } } },
  auth: [{ type: 'header', title: 'REST API key', set: {}, headers: { Authorization: 'Token token={token}' } }],
  kinds: { service: { method: 'GET', path: '/services', query: {}, headers: {} }, incident: { method: 'GET', path: '/incidents', query: {}, headers: {} } },
});

const cmdb = def({
  identifier: 'acme-cmdb',
  title: 'Acme CMDB',
  category: 'internal',
  version: 3,
  fields: { properties: { baseUrl: { type: 'string', title: 'API URL' }, tenant: { type: 'string', title: 'Tenant' } }, required: ['baseUrl', 'tenant'] },
  auth: [
    { type: 'bearer', title: 'API token', set: {} },
    { type: 'basic', title: 'Service account', set: { username: 'svc' } },
  ],
  kinds: { application: { title: 'Applications', method: 'GET', path: '/apps', query: {}, headers: {} } },
  operations: {
    'create-ticket': {
      title: 'Open a ticket',
      description: 'Opens a change ticket',
      method: 'POST',
      path: '/tickets',
      query: {},
      headers: {},
      inputs: { properties: { summary: { type: 'string', title: 'Summary' } }, required: ['summary'] },
    },
  },
});

const conn = (over: Partial<Connection>): Connection => ({
  identifier: 'cmdb-prod',
  title: 'CMDB production',
  description: '',
  connector: 'acme-cmdb',
  fields: { baseUrl: 'https://cmdb.acme.example', tenant: 'acme' },
  auth: { type: 'bearer', token: '${secret:CMDB_TOKEN}' },
  access: 'read-write',
  allowed: { teams: ['platform'] },
  version: 4,
  managed: false,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-02T00:00:00.000Z',
  ...over,
});

describe('connector helpers', () => {
  it('lists what a connection supplies for a method: not the fixed values, plus header credentials and extra secrets', () => {
    expect(authInputs(cmdb.auth[1]!).map((f) => f.key)).toEqual(['password']);
    expect(authInputs(pagerduty.auth[0]!)).toEqual([expect.objectContaining({ key: 'token', secret: true, required: true })]);
    expect(authInputs({ type: 'bearer', set: {}, secrets: ['apiKey'] }).map((f) => f.key)).toEqual(['token', 'apiKey']);
  });

  it('refuses literal credentials and missing required values', () => {
    expect(authProblems(cmdb.auth[0], { type: 'bearer', token: 'abc123' }).token).toMatch(/reference/);
    expect(authProblems(cmdb.auth[0], { type: 'bearer' }).token).toBe('Required');
    expect(authProblems(cmdb.auth[0], { type: 'bearer', token: '${vault:kv/cmdb#token}' })).toEqual({});
    // An Azure DevOps PAT: an empty Basic username is allowed.
    expect(authProblems({ type: 'basic', set: {} }, { type: 'basic', username: '', password: '${env:PAT}' })).toEqual({});
  });

  it('knows which integration types take a connection and which blueprints a connection feeds', () => {
    expect(connectionTypeOf('connector', [])).toBe(true);
    expect(connectionTypeOf('pagerduty', [pagerduty])).toBe('pagerduty');
    expect(connectionTypeOf('acme-cmdb', [cmdb])).toBeUndefined(); // organization definitions are used through `connector`
    expect(connectionTypeOf('http', [pagerduty])).toBeUndefined();
    const integrations = [
      { identifier: 'a', mappings: [{ entity: { blueprint: 'service' } }, { entity: { blueprint: 'incident' } }] },
      { identifier: 'b', mappings: [{ entity: { blueprint: 'team' } }] },
    ];
    expect(blueprintsFed(['a'], integrations)).toEqual(['incident', 'service']);
  });

  it('sends no empty values and no empty allow-lists', () => {
    const body = connectionBody(
      toConnectionDoc({ ...conn({}), fields: { baseUrl: 'https://x', tenant: '' }, allowed: { teams: [], workflows: ['deploy'] }, managed: false }),
    );
    expect(body).toMatchObject({ fields: { baseUrl: 'https://x' }, allowed: { workflows: ['deploy'] } });
    expect(body).not.toHaveProperty('managed');
    expect(body).not.toHaveProperty('api');
  });
});

describe('connection editor', () => {
  const mocks = () => {
    vi.spyOn(api, 'connectors').mockResolvedValue([pagerduty, cmdb]);
    vi.spyOn(api, 'teams').mockResolvedValue([{ identifier: 'platform', title: 'Platform' } as never]);
    vi.spyOn(api, 'actions').mockResolvedValue([]);
    vi.spyOn(api, 'secrets').mockResolvedValue([{ name: 'CMDB_TOKEN' } as never]);
  };
  const { version: _v, managed: _m, createdAt: _c, updatedAt: _u, ...value } = conn({});

  it('generates the fields from the definition, refuses a literal credential and saves with the loaded version', async () => {
    mocks();
    const save = vi.fn().mockResolvedValue({});
    renderUi(<ConnectionBuilder value={{ ...value, version: 4 }} isNew={false} onSave={save} onClose={() => undefined} />);
    expect(((await screen.findByLabelText(/Tenant/)) as HTMLInputElement).value).toBe('acme');
    fireEvent.click(screen.getByRole('tab', { name: /Authentication/ }));
    const token = (await screen.findAllByLabelText(/Token/))[0]!;
    fireEvent.change(token, { target: { value: 'plain-text-token' } });
    expect(await screen.findByText(/Must be a reference/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText(/Authentication, token: Must be a reference/)).toBeTruthy();
    expect(save).not.toHaveBeenCalled();

    fireEvent.change(token, { target: { value: '${secret:CMDB_TOKEN}' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(save).toHaveBeenCalledWith(
        'cmdb-prod',
        expect.objectContaining({ connector: 'acme-cmdb', auth: { type: 'bearer', token: '${secret:CMDB_TOKEN}' }, access: 'read-write' }),
        { ifMatch: 4 },
      ),
    );
  });

  it('shows the values a method fixes and only asks for the others', async () => {
    mocks();
    renderUi(<ConnectionBuilder value={{ ...value, auth: { type: 'basic' } }} isNew={false} onSave={vi.fn()} onClose={() => undefined} />);
    fireEvent.click(await screen.findByRole('tab', { name: /Authentication/ }));
    expect(await screen.findByText('Set by the connector')).toBeTruthy();
    expect(screen.getByText('svc')).toBeTruthy();
    expect(screen.queryByLabelText(/^Username/)).toBeNull();
    expect(screen.getAllByLabelText(/Password or token/).length).toBeGreaterThan(0);
  });

  it('offers to reload when someone else saved the connection meanwhile', async () => {
    mocks();
    const conflict = { currentVersion: 5, changedBy: { email: 'alice@acme.example', name: 'Alice' }, changedAt: null };
    const save = vi.fn().mockRejectedValue(new ApiError(412, 'stale', undefined, { conflict }));
    const reload = vi.spyOn(api, 'connection').mockResolvedValue(conn({ title: 'Renamed by Alice', version: 5 }));
    renderUi(<ConnectionBuilder value={{ ...value, version: 4 }} isNew={false} onSave={save} onClose={() => undefined} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Save' }));
    expect(await screen.findByText(/Alice changed this connection \(version 5\)/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Reload their version' }));
    await waitFor(() => expect(reload).toHaveBeenCalledWith('cmdb-prod'));
    expect(((await screen.findByLabelText(/^Title/)) as HTMLInputElement).value).toBe('Renamed by Alice');
  });
});

describe('connections admin', () => {
  const integration = {
    identifier: 'cmdb-apps',
    title: 'CMDB applications',
    type: 'connector',
    config: { connection: 'cmdb-prod' },
    mappings: [{ kind: 'application', entity: { blueprint: 'service', identifier: 'id', properties: {}, relations: {} } }],
  } as unknown as Integration;

  it('lists connections, tests one from its panel and shows its usage and the blueprints it feeds', async () => {
    vi.spyOn(api, 'connectors').mockResolvedValue([pagerduty, cmdb]);
    vi.spyOn(api, 'connections').mockResolvedValue([conn({})]);
    vi.spyOn(api, 'connectionUsage').mockResolvedValue({ integrations: ['cmdb-apps'], actions: ['deploy'], fragments: [] });
    vi.spyOn(api, 'integrations').mockResolvedValue([integration]);
    vi.spyOn(api, 'blueprints').mockResolvedValue([{ identifier: 'service', title: 'Service' } as never]);
    const test = vi
      .spyOn(api, 'testConnection')
      .mockResolvedValue({ ok: false, status: 401, latencyMs: 87, error: 'HTTP 401 Unauthorized', checkedAt: new Date().toISOString() });
    renderUi(<ConnectionsAdmin />, '/admin/connections');
    const row = await screen.findByRole('row', { name: /CMDB production/ });
    expect(within(row).getByText('Acme CMDB')).toBeTruthy();
    expect(within(row).getByText('read-write')).toBeTruthy();
    expect(within(row).getByText('not tested')).toBeTruthy();
    expect(await within(row).findByText('2 uses')).toBeTruthy();

    fireEvent.click(within(row).getByText('CMDB production'));
    fireEvent.click(await screen.findByRole('button', { name: /Test connection/ }));
    await waitFor(() => expect(test).toHaveBeenCalledWith('cmdb-prod'));
    expect(await screen.findByText('HTTP 401 Unauthorized')).toBeTruthy();
    expect(within(row).getAllByText('failed').length).toBeGreaterThan(0); // the list shows the last result too
    expect((await screen.findByText('Service')).closest('a')?.getAttribute('href')).toBe('/catalog/service');

    fireEvent.click(screen.getByRole('tab', { name: /Usage/ }));
    expect((await screen.findByText('cmdb-apps')).closest('a')?.getAttribute('href')).toBe('/admin/integrations?open=cmdb-apps');
    expect(screen.getByText('deploy').closest('a')?.getAttribute('href')).toBe('/admin/actions/deploy');
  });

  it('creates a connection from a connector card, grouped by category', async () => {
    vi.spyOn(api, 'connectors').mockResolvedValue([pagerduty, cmdb]);
    vi.spyOn(api, 'connections').mockResolvedValue([]);
    vi.spyOn(api, 'teams').mockResolvedValue([]);
    vi.spyOn(api, 'actions').mockResolvedValue([]);
    vi.spyOn(api, 'secrets').mockResolvedValue([]);
    renderUi(<ConnectionsAdmin />, '/admin/connections');
    await screen.findByText('No connections yet');
    await waitFor(() => expect(api.connectors).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 0));
    fireEvent.click(await screen.findByRole('button', { name: 'New' }));
    expect(await screen.findByText('Incidents')).toBeTruthy();
    expect(screen.getByText('Your connectors')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'PagerDuty' }));
    expect(await screen.findByText('New connection')).toBeTruthy();
    expect(screen.getByText('Services and incidents')).toBeTruthy();
  });

  it('opens the editor of a new connection from a link (?new=<connector>)', async () => {
    vi.spyOn(api, 'connectors').mockResolvedValue([pagerduty, cmdb]);
    vi.spyOn(api, 'connections').mockResolvedValue([]);
    vi.spyOn(api, 'teams').mockResolvedValue([]);
    vi.spyOn(api, 'actions').mockResolvedValue([]);
    vi.spyOn(api, 'secrets').mockResolvedValue([]);
    renderUi(<ConnectionsAdmin />, '/admin/connections?new=acme-cmdb');
    expect(await screen.findByText('New connection')).toBeTruthy();
    expect(screen.getByLabelText(/Tenant/)).toBeTruthy();
  });
});

describe('connectors admin', () => {
  const mocks = () => {
    vi.spyOn(api, 'connectors').mockResolvedValue([pagerduty, cmdb]);
    vi.spyOn(api, 'connections').mockResolvedValue([conn({})]);
  };

  it('shows a definition readably and duplicates a built-in into an organization definition (admins)', async () => {
    mocks();
    const save = vi.spyOn(api, 'saveConnectorAt').mockResolvedValue(cmdb);
    renderUi(<ConnectorsAdmin />, '/admin/connectors?open=pagerduty');
    expect(await screen.findByText('Connection fields')).toBeTruthy();
    expect(screen.getByText('REST API key')).toBeTruthy();
    expect(screen.getByText(/Connection supplies: token \(secret\)/)).toBeTruthy();
    expect(screen.getByText('/services', { exact: false })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull(); // built-ins are read-only
    fireEvent.click(screen.getByRole('button', { name: /Duplicate/ }));
    const yaml = (await screen.findByLabelText('YAML document')) as HTMLTextAreaElement;
    expect(yaml.value).toContain('identifier: pagerduty-custom');
    expect(yaml.value).not.toContain('builtin');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(save).toHaveBeenCalledWith('pagerduty-custom', expect.objectContaining({ title: 'PagerDuty (custom)' }), undefined));
  });

  it('edits an organization definition pinned to its version and shows the server validation error', async () => {
    mocks();
    vi.spyOn(api, 'saveConnectorAt').mockRejectedValue(new ApiError(400, 'This change breaks connection(s): cmdb-prod (fields: tenant is required)'));
    renderUi(<ConnectorsAdmin />, '/admin/connectors?open=acme-cmdb');
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Save' }));
    expect(await screen.findByText(/breaks connection\(s\): cmdb-prod/)).toBeTruthy();
    expect(api.saveConnectorAt).toHaveBeenCalledWith('acme-cmdb', expect.anything(), 3);
  });

  it('renders the request of an operation with a connection, sending nothing', async () => {
    mocks();
    const render = vi.spyOn(api, 'renderConnectorOperation').mockResolvedValue({
      method: 'POST',
      url: 'https://cmdb.acme.example/tickets',
      headers: { 'content-type': 'application/json' },
      body: { summary: 'Rotate keys' },
      inputs: { summary: 'Rotate keys' },
    });
    renderUi(<ConnectorsAdmin />, '/admin/connectors?open=acme-cmdb');
    fireEvent.click(await screen.findByRole('tab', { name: /Try an operation/ }));
    fireEvent.change(await screen.findByLabelText(/Summary/), { target: { value: 'Rotate keys' } });
    fireEvent.click(screen.getByRole('combobox', { name: 'Connection' }));
    fireEvent.click(await screen.findByRole('option', { name: 'CMDB production' }));
    fireEvent.click(screen.getByRole('button', { name: /Render the request/ }));
    await waitFor(() =>
      expect(render).toHaveBeenCalledWith('acme-cmdb', 'create-ticket', {
        fields: { baseUrl: 'https://cmdb.acme.example', tenant: 'acme' },
        inputs: { summary: 'Rotate keys' },
      }),
    );
    expect(await screen.findByText('POST https://cmdb.acme.example/tickets')).toBeTruthy();
  });

  it('keeps definitions read-only for integration admins', async () => {
    canAdmin = false;
    mocks();
    renderUi(<ConnectorsAdmin />, '/admin/connectors?open=acme-cmdb');
    expect(await screen.findByText('Connection fields')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'New' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Duplicate/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Delete/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'View' }));
    expect(await screen.findByText(/Only admins change connector definitions/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
  });
});

describe('integration form with connections', () => {
  const meta = {
    sources: [
      { type: 'connector', title: 'Connector', description: '', kinds: [], example: {}, fields: [{ key: 'connection', label: 'Connection', kind: 'text' }] },
      {
        type: 'github',
        title: 'GitHub',
        description: '',
        kinds: ['repository'],
        example: {},
        fields: [
          { key: 'org', label: 'Organization', kind: 'text', required: true },
          { key: 'token', label: 'Token', kind: 'secret', required: true },
          { key: 'topics', label: 'Topics', kind: 'list' },
        ],
      },
    ],
    invokers: [],
    models: [],
  };
  const github = def({
    identifier: 'github',
    title: 'GitHub',
    builtin: true,
    kinds: { repository: { method: 'GET', path: '/repos', query: {}, headers: {} } },
  });

  it('offers the kinds of the connection definition for the mappings of a connector integration', async () => {
    vi.spyOn(api, 'meta').mockResolvedValue(meta as never);
    vi.spyOn(api, 'blueprints').mockResolvedValue([]);
    vi.spyOn(api, 'connectors').mockResolvedValue([pagerduty, cmdb, github]);
    vi.spyOn(api, 'connections').mockResolvedValue([conn({})]);
    const doc = {
      identifier: 'apps',
      title: 'Apps',
      type: 'connector',
      config: { connection: 'cmdb-prod' },
      mappings: [{ kind: 'application', entity: { blueprint: '', identifier: 'id' } }],
    };
    renderUi(<IntegrationForm doc={doc} patch={() => undefined} isNew={false} />);
    const kind = (await screen.findByRole('combobox', { name: 'Kind' })) as HTMLInputElement;
    await waitFor(() => expect(kind.value).toBe('Applications (application)'));
    expect((await screen.findByText('Open CMDB production')).closest('a')?.getAttribute('href')).toBe('/admin/connections?open=cmdb-prod');
  });

  it('replaces the URL and token inputs of a code source by a connection picker', async () => {
    vi.spyOn(api, 'meta').mockResolvedValue(meta as never);
    vi.spyOn(api, 'blueprints').mockResolvedValue([]);
    vi.spyOn(api, 'secrets').mockResolvedValue([]);
    vi.spyOn(api, 'connectors').mockResolvedValue([github]);
    vi.spyOn(api, 'connections').mockResolvedValue([conn({ identifier: 'gh', title: 'GitHub Acme', connector: 'github', fields: {} })]);
    const patch = vi.fn();
    const doc = { identifier: 'repos', title: 'Repos', type: 'github', config: { org: 'acme', token: '${secret:GH}' }, mappings: [] };
    const view = renderUi(<IntegrationForm doc={doc} patch={patch} isNew={false} />);
    expect((await screen.findAllByLabelText(/^Token/)).length).toBeGreaterThan(0);
    fireEvent.click(await screen.findByRole('switch', { name: /Use a connection/ }));
    await waitFor(() => expect(patch).toHaveBeenCalledWith({ config: { connection: 'gh' } }));

    cleanup();
    view.unmount();
    renderUi(<IntegrationForm doc={{ ...doc, config: { connection: 'gh', topics: ['go'] } }} patch={patch} isNew={false} />);
    expect(await screen.findByText('Open GitHub Acme')).toBeTruthy();
    expect(screen.queryByLabelText(/^Token/)).toBeNull();
    expect(screen.queryByLabelText(/^Organization/)).toBeNull();
    expect(screen.getAllByLabelText(/Topics/).length).toBeGreaterThan(0);
  });
});
