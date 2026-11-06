import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import type { Run } from '@asterius/shared';
import { Approvals } from '../src/pages/Runs';
import { api } from '../src/lib/api';
import { renderUi } from './render';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const run = (id: string, step?: string) =>
  ({
    id,
    actionTitle: `Action ${id}`,
    blueprint: null,
    entity: null,
    status: 'PENDING_APPROVAL',
    triggeredBy: { id: 'u', name: 'Alice', email: 'a@x' },
    createdAt: '2026-01-01T00:00:00Z',
    startedAt: null,
    endedAt: null,
    pendingStep: step ? { id: step, name: 'Gate', message: null } : null,
  }) as unknown as Run;

describe('Approvals', () => {
  it('approves several requests and steps at once', async () => {
    vi.spyOn(api, 'approvals').mockResolvedValue([run('r1'), run('r2', 'gate')]);
    const approve = vi.spyOn(api, 'approve').mockResolvedValue(run('r1'));
    const approveStep = vi.spyOn(api, 'approveStep').mockResolvedValue(run('r2'));
    renderUi(<Approvals />);
    await screen.findByText('Action r1');
    fireEvent.click(screen.getByLabelText('Select all rows'));
    fireEvent.change(screen.getByLabelText('Comment for the decision'), { target: { value: 'lgtm' } });
    fireEvent.click(screen.getByRole('button', { name: /Approve selected/ }));
    await waitFor(() => expect(approve).toHaveBeenCalledWith('r1', 'lgtm'));
    expect(approveStep).toHaveBeenCalledWith('r2', 'gate', 'lgtm');
  });

  it('requires a comment to reject', async () => {
    vi.spyOn(api, 'approvals').mockResolvedValue([run('r1')]);
    renderUi(<Approvals />);
    await screen.findByText('Action r1');
    fireEvent.click(screen.getByLabelText('Select row'));
    expect((screen.getByRole('button', { name: /Reject selected/ }) as HTMLButtonElement).disabled).toBe(true);
  });
});
