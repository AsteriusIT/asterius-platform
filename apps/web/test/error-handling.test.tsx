import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MantineProvider } from '@mantine/core';
import { Notifications } from '@mantine/notifications';
import { QueryClientProvider } from '@tanstack/react-query';
import { theme } from '../src/theme';
import { ErrorBoundary } from '../src/components/ErrorBoundary';
import { createQueryClient, useAppMutation } from '../src/lib/queryClient';
import { renderUi } from './render';

afterEach(cleanup);

function Boom(): never {
  throw new Error('kaboom');
}

describe('ErrorBoundary', () => {
  it('shows a fallback with reload instead of a blank page', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    renderUi(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    );
    expect(screen.getByRole('alert')).toBeTruthy();
    expect(screen.getByText('kaboom')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Reload' })).toBeTruthy();
  });
});

function Fails() {
  const m = useAppMutation({
    mutationFn: async () => {
      throw new Error('nope');
    },
  });
  return <button onClick={() => m.mutate()}>go</button>;
}

describe('mutation errors', () => {
  it('toasts failures', async () => {
    render(
      <MantineProvider theme={theme} env="test">
        <Notifications />
        <QueryClientProvider client={createQueryClient()}>
          <Fails />
        </QueryClientProvider>
      </MantineProvider>,
    );
    fireEvent.click(screen.getByText('go'));
    await waitFor(() => expect(screen.getByText('nope')).toBeTruthy());
  });
});
