import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { Agent, McpServer, Run } from '@asterius/shared';
import { api } from '../src/lib/api';
import { agentFilterOptions, channelLabel, viaText } from '../src/lib/agents';
import { AgentsAdmin, McpServersAdmin } from '../src/pages/admin/Agents';
import { AuditAdmin } from '../src/pages/admin/System';
import { runColumns } from '../src/pages/Runs';
import { renderUi } from './render';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const bot: Agent = {
  identifier: 'release-bot',
  title: 'Release bot',
  description: '',
  ownerTeam: 'payments',
  workflows: ['deploy'],
  blueprints: ['*'],
  oauthClients: [],
  enabled: true,
  version: 1,
  managed: false,
  tokens: 1,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

describe('agent labels', () => {
  it('describes channels and agents', () => {
    expect(channelLabel('mcp')).toBe('MCP');
    expect(channelLabel(null)).toBe('Platform');
    expect(viaText({ channel: 'api', agent: 'release-bot' })).toBe('API token · agent release-bot');
    expect(agentFilterOptions(['release-bot', '*']).map((o) => o.value)).toEqual(['*', '-', 'release-bot']);
  });
});

describe('AgentsAdmin', () => {
  it('lists agents with their allow-lists and issues a token shown once', async () => {
    vi.spyOn(api, 'agents').mockResolvedValue([bot, { ...bot, identifier: 'idle', title: 'Idle', workflows: [], enabled: false, tokens: 0 }]);
    vi.spyOn(api, 'agentTokens').mockResolvedValue([]);
    const create = vi.spyOn(api, 'createAgentToken').mockResolvedValue({ id: 't1', token: 'ast_secret_once' });
    renderUi(<AgentsAdmin />);
    const row = (await screen.findByText('Release bot')).closest('tr')!;
    expect(within(row).getByText('deploy')).toBeTruthy();
    expect(within(row).getByText('all')).toBeTruthy(); // blueprints: *
    const idle = screen.getByText('Idle').closest('tr')!;
    expect(within(idle).getByText('none')).toBeTruthy(); // no workflow allowed
    expect(within(idle).getByText('disabled')).toBeTruthy();
    fireEvent.click(within(row).getByLabelText('Tokens'));
    fireEvent.click(await screen.findByRole('button', { name: 'Issue token' }));
    await waitFor(() => expect(create).toHaveBeenCalledWith('release-bot', { name: 'Release bot token', expiresInDays: 90 }));
    expect(await screen.findByText('ast_secret_once')).toBeTruthy();
  });
});

describe('McpServersAdmin', () => {
  it('tests a server against its allow-list', async () => {
    const server: McpServer = {
      identifier: 'tickets',
      title: 'Tickets',
      description: '',
      url: 'https://mcp.example.com/mcp',
      auth: { type: 'bearer', token: '${secret:t}' },
      tools: ['echo', 'search'],
      timeoutSeconds: 30,
      enabled: true,
      version: 1,
      managed: false,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    };
    vi.spyOn(api, 'mcpServers').mockResolvedValue([server]);
    vi.spyOn(api, 'testMcpServer').mockResolvedValue({
      ok: true,
      message: 'Connected: 2 tool(s), 1 allowed',
      tools: [
        { name: 'echo', allowed: true },
        { name: 'delete_all', allowed: false },
      ],
      missing: ['search'],
    });
    renderUi(<McpServersAdmin />);
    const row = (await screen.findByText('Tickets')).closest('tr')!;
    fireEvent.click(within(row).getByLabelText('Test'));
    expect(await screen.findByText('Connected: 2 tool(s), 1 allowed')).toBeTruthy();
    expect(screen.getByText(/Allowed but not offered by the server: search/)).toBeTruthy();
    expect(screen.getByText('not allowed')).toBeTruthy();
  });
});

describe('AuditAdmin agent filter', () => {
  it('opens on the agent of the URL and shows how each call came in', async () => {
    vi.spyOn(api, 'auditFacets').mockResolvedValue({ actions: [], actors: [], agents: ['release-bot'] });
    const audit = vi.spyOn(api, 'audit').mockResolvedValue([
      {
        id: '1',
        at: '2026-01-01T00:00:00Z',
        action: 'run.triggered',
        actorEmail: 'a@x.io',
        target: 'deploy',
        detail: {},
        channel: 'mcp',
        agent: 'release-bot',
      },
    ]);
    renderUi(<AuditAdmin />, '/admin/audit?agent=release-bot');
    await waitFor(() => expect(audit).toHaveBeenCalledWith(expect.objectContaining({ agent: 'release-bot' })));
    expect(await screen.findByText('MCP')).toBeTruthy();
    expect(screen.getAllByText('release-bot').length).toBeGreaterThan(0);
  });
});

describe('runs list', () => {
  it('marks runs started by an agent', () => {
    const col = runColumns.find((c) => c.key === 'u')!;
    const run = { triggeredBy: { id: 'u', name: 'Alice', email: 'a@x.io' }, agent: 'release-bot', channel: 'api' } as Run;
    renderUi(<>{col.render(run)}</>);
    expect(screen.getByText('release-bot')).toBeTruthy();
    expect(screen.getByText('API token')).toBeTruthy();
  });
});
