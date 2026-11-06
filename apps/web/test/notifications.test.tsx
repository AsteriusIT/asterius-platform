import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { NotificationCenter } from '../src/components/NotificationCenter';
import { api } from '../src/lib/api';
import { renderUi } from './render';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const item = (id: string, read: boolean) => ({
  id,
  kind: 'approval.requested',
  title: `Approval ${id}`,
  body: '',
  link: `/runs/${id}`,
  createdAt: '2026-01-01T00:00:00Z',
  read,
});

describe('NotificationCenter', () => {
  it('shows the unread count and marks items read when opened', async () => {
    vi.spyOn(api, 'notifications').mockResolvedValue({ items: [item('a', false), item('b', true)], unread: 1 });
    vi.spyOn(api, 'notificationPrefs').mockResolvedValue({ email: false, slack: false });
    const mark = vi.spyOn(api, 'markNotificationsRead').mockResolvedValue({ changed: 1 });
    renderUi(<NotificationCenter />);
    fireEvent.click(await screen.findByRole('button', { name: 'Notifications (1 unread)' }));
    fireEvent.click(await screen.findByText('Approval a'));
    await waitFor(() => expect(mark).toHaveBeenCalledWith({ ids: ['a'] }));
  });

  it('marks everything read and saves preferences', async () => {
    vi.spyOn(api, 'notifications').mockResolvedValue({ items: [item('a', false)], unread: 1 });
    vi.spyOn(api, 'notificationPrefs').mockResolvedValue({ email: false, slack: false });
    const mark = vi.spyOn(api, 'markNotificationsRead').mockResolvedValue({ changed: 1 });
    const save = vi.spyOn(api, 'saveNotificationPrefs').mockResolvedValue({ email: true, slack: false });
    renderUi(<NotificationCenter />);
    fireEvent.click(await screen.findByRole('button', { name: /Notifications/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Mark all as read' }));
    await waitFor(() => expect(mark).toHaveBeenCalledWith({ all: true }));
    const email = await screen.findByLabelText('Email');
    await waitFor(() => expect((email as HTMLInputElement).disabled).toBe(false));
    fireEvent.click(email);
    await waitFor(() => expect(save).toHaveBeenCalledWith({ email: true, slack: false }));
  });

  it('shows an empty state', async () => {
    vi.spyOn(api, 'notifications').mockResolvedValue({ items: [], unread: 0 });
    vi.spyOn(api, 'notificationPrefs').mockResolvedValue({ email: false, slack: false });
    renderUi(<NotificationCenter />);
    fireEvent.click(await screen.findByRole('button', { name: 'Notifications' }));
    await screen.findByText('No notification yet');
  });
});
