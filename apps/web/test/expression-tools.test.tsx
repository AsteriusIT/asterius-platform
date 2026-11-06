import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import type { WorkflowStep } from '@asterius/shared';
import { DryRunPanel, ExpressionStatus } from '../src/components/builder/ExpressionTools';
import { api } from '../src/lib/api';
import { renderUi } from './render';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('ExpressionStatus', () => {
  it('shows the server verdict and a sample result', async () => {
    const check = vi.spyOn(api, 'checkExpression').mockResolvedValue({ ok: true, value: 6 });
    renderUi(<ExpressionStatus expression="inputs.n * 2" context={{ inputs: { n: 3 } }} />);
    await screen.findByText('6');
    expect(check).toHaveBeenCalledWith('inputs.n * 2', { inputs: { n: 3 } });
  });

  it('shows syntax errors', async () => {
    vi.spyOn(api, 'checkExpression').mockResolvedValue({ ok: false, error: 'Unexpected token' });
    renderUi(<ExpressionStatus expression="inputs.(" />);
    expect((await screen.findByRole('alert')).textContent).toContain('Unexpected token');
  });
});

describe('DryRunPanel', () => {
  it('sends sample inputs and lists the simulated steps', async () => {
    const dry = vi.spyOn(api, 'simulate').mockResolvedValue({ steps: [{ id: 'calc', type: 'transform', skipped: false, preview: { double: 6 } }] });
    renderUi(<DryRunPanel steps={[{ id: 'calc', type: 'transform', output: { double: 'inputs.n * 2' } } as WorkflowStep]} />);
    fireEvent.change(screen.getByLabelText(/Sample inputs/), { target: { value: '{"n":3}' } });
    fireEvent.click(screen.getByRole('button', { name: 'Test run' }));
    await waitFor(() => expect(dry).toHaveBeenCalledWith(expect.anything(), { n: 3 }));
    await screen.findByText(/"double": 6/);
  });

  it('rejects invalid JSON', () => {
    renderUi(<DryRunPanel steps={[{ id: 'a', type: 'transform', output: {} } as WorkflowStep]} />);
    fireEvent.change(screen.getByLabelText(/Sample inputs/), { target: { value: '{' } });
    expect(screen.getByText('Must be a JSON object')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Test run' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
