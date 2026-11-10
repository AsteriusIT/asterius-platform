import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { CommandPalette, navCommands } from '../src/components/CommandPalette';
import { api } from '../src/lib/api';
import { renderUi } from './render';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function Host() {
  const [o, setO] = useState(false);
  return (
    <>
      <span>{o ? 'open' : 'closed'}</span>
      <CommandPalette can={false} opened={o} onOpenChange={setO} />
    </>
  );
}

describe('CommandPalette', () => {
  it('hides admin pages from non-admins', () => {
    expect(navCommands(false).some((c) => c.id.startsWith('admin'))).toBe(false);
    expect(navCommands(true).some((c) => c.id.startsWith('admin'))).toBe(true);
  });

  it('opens with Ctrl+K and finds entities', async () => {
    const entities = vi.spyOn(api, 'entities').mockResolvedValue({
      items: [
        {
          blueprint: 'service',
          identifier: 'pay-api',
          title: 'Payments API',
          team: null,
          properties: {},
          relations: {},
          source: 'api',
          version: 1,
          createdAt: '',
          updatedAt: '',
        },
      ],
      total: 1,
    });
    renderUi(<Host />);
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    const box = await screen.findByLabelText('Search pages and entities');
    fireEvent.change(box, { target: { value: 'pay' } });
    await screen.findByText('Payments API');
    expect(entities).toHaveBeenCalledWith(expect.objectContaining({ search: 'pay' }));
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    await waitFor(() => expect(screen.getByText('closed')).toBeTruthy());
  });
});
