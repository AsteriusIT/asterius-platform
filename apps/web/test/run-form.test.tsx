import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import type { Action } from '@asterius/shared';
import { ActionRunModal } from '../src/components/ActionRunModal';
import { api } from '../src/lib/api';
import { renderUi } from './render';

const auth = vi.hoisted(() => ({ isAdmin: false }));
vi.mock('../src/lib/auth', () => ({ useAuth: () => ({ user: null, isAdmin: auth.isAdmin }) }));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
});

const action: Action = {
  version: 1,
  identifier: 'deploy',
  title: 'Deploy',
  description: '',
  icon: null,
  trigger: { type: 'form', on: 'create', blueprint: null, inputs: { properties: {} }, allowed: {}, approval: { required: false } },
  steps: [{ id: 'run', type: 'invoke', invoker: { type: 'catalog' } }],
  enabled: true,
  managed: false,
  priority: 5,
} as Action;

describe('run form priority', () => {
  it('is not offered to members', () => {
    auth.isAdmin = false;
    renderUi(<ActionRunModal action={action} onClose={() => {}} />);
    expect(screen.queryByLabelText(/Priority/)).toBeNull();
  });

  it('lets admins set the run priority, and sends none when left empty', async () => {
    auth.isAdmin = true;
    const trigger = vi.spyOn(api, 'trigger').mockResolvedValue({ id: 'r1', status: 'QUEUED' } as never);
    renderUi(<ActionRunModal action={action} onClose={() => {}} />);
    const input = screen.getByLabelText(/Priority/) as HTMLInputElement;
    expect(input.placeholder).toBe('5'); // the workflow's priority
    fireEvent.click(screen.getByRole('button', { name: 'Run' }));
    await waitFor(() => expect(trigger).toHaveBeenCalledTimes(1));
    expect(trigger.mock.calls[0]![1]).not.toHaveProperty('priority');

    cleanup();
    renderUi(<ActionRunModal action={action} onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText(/Priority/), { target: { value: '42' } });
    fireEvent.click(screen.getByRole('button', { name: 'Run' }));
    await waitFor(() => expect(trigger).toHaveBeenCalledTimes(2));
    expect(trigger.mock.calls[1]![1]).toMatchObject({ priority: 42 });
  });
});
