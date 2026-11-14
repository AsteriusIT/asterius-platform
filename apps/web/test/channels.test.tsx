import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { ApiToken, Run } from '@asterius/shared';
import { api } from '../src/lib/api';
import { channelLabel } from '../src/lib/channels';
import { TokenTable } from '../src/pages/Profile';
import { AuditAdmin } from '../src/pages/admin/System';
import { runColumns, Runs } from '../src/pages/Runs';
import { renderUi } from './render';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('call channels', () => {
  it('labels channels', () => {
    expect(channelLabel('mcp')).toBe('MCP');
    expect(channelLabel('workflow')).toBe('AI agent step');
    expect(channelLabel(null)).toBe('Platform');
  });

  it('the audit log shows how each call came in and filters by channel', async () => {
    vi.spyOn(api, 'auditFacets').mockResolvedValue({ actions: [], actors: [] });
    const audit = vi
      .spyOn(api, 'audit')
      .mockResolvedValue([
        { id: '1', at: '2026-01-01T00:00:00Z', action: 'run.triggered', actorEmail: 'a@x.io', target: 'deploy', detail: {}, channel: 'mcp' },
      ]);
    renderUi(<AuditAdmin />);
    const row = (await screen.findByText('run.triggered')).closest('tr')!;
    expect(within(row).getByText('MCP')).toBeTruthy();
    fireEvent.click(screen.getByRole('combobox', { name: 'Channel' }));
    fireEvent.click(await screen.findByRole('option', { name: 'API token' }));
    await waitFor(() => expect(audit).toHaveBeenLastCalledWith(expect.objectContaining({ channel: 'api' })));
  });

  it('the runs list marks runs that did not come from the web UI and filters by channel', async () => {
    const col = runColumns.find((c) => c.key === 'u')!;
    const run = { triggeredBy: { id: 'u', name: 'Alice', email: 'a@x.io' }, channel: 'api' } as Run;
    const { unmount } = renderUi(<>{col.render(run)}</>);
    expect(screen.getByText('API token')).toBeTruthy();
    unmount();
    renderUi(<>{col.render({ ...run, channel: 'ui' })}</>);
    expect(screen.queryByText('Web UI')).toBeNull();
    cleanup();

    vi.spyOn(api, 'blueprints').mockResolvedValue([]);
    vi.spyOn(api, 'actions').mockResolvedValue([]);
    const runs = vi.spyOn(api, 'runs').mockResolvedValue({ items: [], total: 0 });
    renderUi(<Runs />, '/runs?channel=mcp');
    await waitFor(() => expect(runs).toHaveBeenCalledWith(expect.objectContaining({ channel: 'mcp' })));
    expect((screen.getByRole('combobox', { name: 'Filter by channel' }) as HTMLInputElement).value).toBe('MCP');
  });
});

describe('API tokens', () => {
  it('lists the workflows a token is restricted to', async () => {
    const token: ApiToken = {
      id: 't1',
      name: 'release-bot token',
      prefix: 'ast_abc',
      userId: 'u1',
      userName: 'release-bot',
      createdAt: '2026-01-01T00:00:00Z',
      expiresAt: null,
      lastUsedAt: null,
      workflows: ['deploy'],
    };
    vi.spyOn(api, 'tokens').mockResolvedValue([token, { ...token, id: 't2', name: 'laptop', workflows: null }]);
    renderUi(<TokenTable />);
    const row = (await screen.findByText('release-bot token')).closest('tr')!;
    expect(within(row).getByText('deploy')).toBeTruthy();
    expect(within(screen.getByText('laptop').closest('tr')!).getByText('Any')).toBeTruthy();
  });
});
