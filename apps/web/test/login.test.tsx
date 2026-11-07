import { cleanup, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../src/lib/api';
import { Login } from '../src/pages/Login';
import { renderUi } from './render';

vi.mock('../src/lib/auth', () => ({ useAuth: () => ({ user: null, signIn: vi.fn() }) }));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

async function dividers(authProviders: string[]) {
  vi.spyOn(api, 'meta').mockResolvedValue({ authProviders } as unknown as Awaited<ReturnType<typeof api.meta>>);
  renderUi(<Login />);
  await screen.findAllByText(/Continue with|Sign in/);
  return screen.queryAllByText('or').length;
}

describe('Login: one "or" between two present sections', () => {
  it.each([
    [['keycloak', 'local'], 1],
    [['keycloak', 'github'], 1],
    [['keycloak', 'entra', 'local'], 2],
    [['entra', 'local'], 1],
    [['keycloak'], 0],
    [['local'], 0],
    [['entra', 'github'], 0],
  ])('%j → %i', async (providers, expected) => {
    expect(await dividers(providers)).toBe(expected);
  });
});
