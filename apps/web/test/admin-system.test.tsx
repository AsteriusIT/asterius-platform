import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { AuditAdmin, ConfigAdmin, DeliveriesAdmin } from '../src/pages/admin/System';
import { auditToCsv } from '../src/lib/auditCsv';
import { api } from '../src/lib/api';
import { renderUi } from './render';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('auditToCsv', () => {
  it('quotes cells and includes detail', () => {
    const csv = auditToCsv([{ id: '1', at: '2026-01-01T00:00:00Z', action: 'team.created', actorEmail: null, target: 'a,b', detail: { x: 1 } }]);
    expect(csv).toBe('at,actor,action,target,detail\r\n2026-01-01T00:00:00Z,system,team.created,"a,b","{""x"":1}"\r\n');
  });
});

describe('AuditAdmin', () => {
  it('sends the selected actor filter', async () => {
    vi.spyOn(api, 'auditFacets').mockResolvedValue({ actions: ['team.created'], actors: ['admin@example.com'] });
    const audit = vi.spyOn(api, 'audit').mockResolvedValue([]);
    renderUi(<AuditAdmin />);
    await waitFor(() => expect(audit).toHaveBeenCalled());
    fireEvent.change(screen.getByLabelText('Resource'), { target: { value: 'pay' } });
    await waitFor(() => expect(audit).toHaveBeenLastCalledWith(expect.objectContaining({ target: 'pay' })));
  });
});

describe('ConfigAdmin', () => {
  it('shows the last error and previews changes before reload', async () => {
    vi.spyOn(api, 'configInfo').mockResolvedValue({
      dir: '/config',
      managed: { blueprints: 1 },
      status: { lastCheckedAt: null, lastAppliedAt: null, hash: null, files: 2, error: 'bad yaml' },
    });
    vi.spyOn(api, 'configDiff').mockResolvedValue({ error: null, kinds: { actions: { added: ['deploy'], removed: [], kept: [] } } });
    renderUi(<ConfigAdmin />);
    await screen.findByText('bad yaml');
    fireEvent.click(screen.getByRole('button', { name: /Reload now/ }));
    await screen.findByText(/1 added \(deploy\)/);
  });
});

describe('DeliveriesAdmin', () => {
  it('redelivers the selected failures', async () => {
    vi.spyOn(api, 'allDeliveries').mockResolvedValue([
      {
        id: 'd1',
        webhook: 'hook',
        event: 'run.failed',
        status: 'failed',
        attempts: 8,
        responseStatus: 500,
        lastError: 'boom',
        createdAt: '2026-01-01T00:00:00Z',
        deliveredAt: null,
      },
    ]);
    const redeliver = vi.spyOn(api, 'redeliverMany').mockResolvedValue({ queued: 1 });
    renderUi(<DeliveriesAdmin />);
    await screen.findByText('boom');
    fireEvent.click(screen.getByLabelText('Select row'));
    fireEvent.click(screen.getByRole('button', { name: /Redeliver 1/ }));
    await waitFor(() => expect(redeliver).toHaveBeenCalledWith(['d1']));
  });
});
