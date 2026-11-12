import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MantineProvider } from '@mantine/core';
import { ModalsProvider } from '@mantine/modals';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router';
import type { EditConflict } from '@asterius/shared';
import { WorkflowFlowPage } from '../src/pages/admin/WorkflowFlow';
import { conflictSummary } from '../src/components/EditConflictDialog';
import { api, ApiError, conflictOf } from '../src/lib/api';
import { theme } from '@asterius/brand';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const conflict: EditConflict = {
  currentVersion: 4,
  changedBy: { email: 'alice@example.com', name: 'Alice Martin' },
  changedAt: new Date(Date.now() - 3 * 60_000).toISOString(),
};
const stale = () => new ApiError(412, 'Action deploy is at version 4, not 3; reload and retry', undefined, { error: 'stale', conflict });

describe('conflict helpers', () => {
  it('reads the conflict of a 412 only', () => {
    expect(conflictOf(stale())).toEqual(conflict);
    expect(conflictOf(new ApiError(412, 'x'))).toBeNull();
    expect(conflictOf(new ApiError(409, 'x', undefined, { conflict }))).toBeNull();
    expect(conflictOf(new Error('x'))).toBeNull();
  });

  it('says who changed it, when and to which version', () => {
    expect(conflictSummary(conflict, 'workflow')).toBe('Alice Martin changed this workflow 3 minutes ago (version 4).');
    expect(conflictSummary({ ...conflict, changedBy: { email: 'bot@x.io', name: null }, changedAt: null }, 'entity')).toBe(
      'bot@x.io changed this entity (version 4).',
    );
    expect(conflictSummary({ currentVersion: null, changedBy: null, changedAt: null }, 'fragment')).toBe('This fragment was deleted after you opened it.');
  });
});

describe('workflow editor conflicts', () => {
  const action = {
    identifier: 'deploy',
    title: 'Deploy',
    managed: false,
    version: 3,
    trigger: { type: 'api', on: 'create', blueprint: null, inputs: { properties: {} }, allowed: {}, approval: { required: false } },
    steps: [{ id: 'compute', type: 'transform', output: {} }],
    enabled: true,
  };
  const renderPage = () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <MantineProvider theme={theme} env="test">
        <ModalsProvider>
          <QueryClientProvider client={qc}>
            <MemoryRouter initialEntries={['/admin/actions/deploy']}>
              <Routes>
                <Route path="/admin/actions/:id" element={<WorkflowFlowPage />} />
              </Routes>
            </MemoryRouter>
          </QueryClientProvider>
        </ModalsProvider>
      </MantineProvider>,
    );
  };

  it('sends the loaded version, explains a conflict, shows their changes and overwrites without If-Match', async () => {
    vi.spyOn(api, 'meta').mockResolvedValue({ invokers: [] } as never);
    vi.spyOn(api, 'action').mockResolvedValue(action as never);
    const save = vi
      .spyOn(api, 'saveActionAt')
      .mockRejectedValueOnce(stale())
      .mockResolvedValueOnce({ ...action, version: 5 } as never);
    const diff = vi.spyOn(api, 'actionDiff').mockResolvedValue({
      fields: [{ path: 'description', before: '', after: 'by alice' }],
      stepsAdded: ['notify'],
      stepsRemoved: [],
      stepsChanged: [],
      stepsReordered: false,
    });
    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: 'Save' }));
    const dialog = await screen.findByRole('dialog');
    expect(save).toHaveBeenCalledWith('deploy', expect.objectContaining({ identifier: 'deploy' }), 3);
    expect(within(dialog).getByText(/Alice Martin changed this workflow 3 minutes ago \(version 4\)/)).toBeTruthy();

    fireEvent.click(within(dialog).getByRole('button', { name: 'See their changes' }));
    expect(await within(dialog).findByText('notify')).toBeTruthy();
    expect(diff).toHaveBeenCalledWith('deploy', 3, 4);

    fireEvent.click(within(dialog).getByRole('button', { name: 'Overwrite with mine' }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(2));
    expect(save.mock.calls[1]![2]).toBeUndefined();
    await waitFor(() => expect(screen.queryByText(/changed this workflow/)).toBeNull());
  });

  it('reloads their version', async () => {
    vi.spyOn(api, 'meta').mockResolvedValue({ invokers: [] } as never);
    const get = vi.spyOn(api, 'action').mockResolvedValue(action as never);
    vi.spyOn(api, 'saveActionAt').mockRejectedValueOnce(stale());
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Save' }));
    const dialog = await screen.findByRole('dialog');
    get.mockResolvedValue({ ...action, version: 4, title: 'Deploy (theirs)' } as never);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Reload their version' }));
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByText(/changed this workflow/)).toBeNull());
  });
});
