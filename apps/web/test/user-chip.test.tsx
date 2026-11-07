import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { UserChip } from '../src/components/UserChip';
import { api } from '../src/lib/api';
import { renderUi } from './render';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('UserChip', () => {
  it('shows the display name only, and the email in the hover card', async () => {
    renderUi(<UserChip user={{ id: 'u1', name: 'Alice Martin', email: 'alice@example.com' }} />);
    expect(screen.getByText('Alice Martin')).toBeTruthy();
    expect(screen.queryByText('alice@example.com')).toBeNull();
    fireEvent.mouseEnter(screen.getByRole('button', { name: 'User Alice Martin' }));
    expect(await screen.findByText('alice@example.com')).toBeTruthy();
  });

  it('completes a reference without email from the user directory on hover', async () => {
    const lookup = vi.spyOn(api, 'userLookup').mockResolvedValue([{ id: 'u2', name: 'Bob', email: 'bob@example.com' }]);
    renderUi(<UserChip user={{ id: 'u2', name: 'Bob' }} />);
    expect(lookup).not.toHaveBeenCalled();
    fireEvent.mouseEnter(screen.getByRole('button', { name: 'User Bob' }));
    expect(await screen.findByText('bob@example.com')).toBeTruthy();
  });

  it('renders "system" without a user', () => {
    renderUi(<UserChip user={null} />);
    expect(screen.getByText('system')).toBeTruthy();
  });
});
