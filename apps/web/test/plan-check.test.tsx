import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import type { PlanCheckOutput } from '@asterius/shared';
import { isPlanCheck, PlanCheckSummary } from '../src/components/PlanCheckSummary';
import { PolicyBuilder } from '../src/components/builder/GovernanceBuilders';
import { api } from '../src/lib/api';
import { renderUi } from './render';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
beforeEach(() => {
  vi.spyOn(api, 'blueprints').mockResolvedValue([]);
  vi.spyOn(api, 'actions').mockResolvedValue([]);
  vi.spyOn(api, 'checkExpression').mockResolvedValue({ ok: true, value: true } as never);
});

const output: PlanCheckOutput = {
  kind: 'plan-check',
  gate: 'override',
  requiresOverride: true,
  changes: { create: 1, update: 1, replace: 0, delete: 0, 'no-op': 1, forget: 0 },
  cost: {
    currency: 'USD',
    monthly: 350.4,
    before: 170.53,
    delta: 179.87,
    complete: false,
    unmatched: ['module.monitoring.azurerm_dashboard_grafana.main'],
    usageBased: [],
    catalog: 'builtin',
  },
  carbon: { monthlyKg: 12.34, beforeKg: 6, deltaKg: 6.34, method: 'Estimate (Cloud Carbon Footprint method)' },
  violations: [{ policy: 'budget:delta', title: 'Cost increase', severity: 'warning', source: 'budget', message: 'Estimated increase exceeds 100.00 USD' }],
  counts: { critical: 0, warning: 1, advisory: 0 },
  resources: [
    {
      address: 'azurerm_linux_virtual_machine.api',
      type: 'azurerm_linux_virtual_machine',
      provider: 'azurerm',
      action: 'update',
      region: 'westeurope',
      pricing: 'priced',
      monthly: 140.16,
      before: 30.37,
      delta: 109.79,
      co2eKg: 6,
      co2eDeltaKg: 4,
    },
    {
      address: 'module.monitoring.azurerm_dashboard_grafana.main',
      type: 'azurerm_dashboard_grafana',
      provider: 'azurerm',
      action: 'create',
      region: 'westeurope',
      pricing: 'unmatched',
      monthly: 0,
      before: 0,
      delta: 0,
      co2eKg: 0,
      co2eDeltaKg: 0,
    },
  ],
  truncated: 1,
  summary: '',
};

describe('PlanCheckSummary', () => {
  it('recognises plan-check outputs only', () => {
    expect(isPlanCheck(output)).toBe(true);
    expect(isPlanCheck({ kind: 'plan-check' })).toBe(false);
    expect(isPlanCheck({ text: 'x' })).toBe(false);
  });

  it('shows the gate, the totals, the unpriced resources, the findings and the cost table', () => {
    renderUi(<PlanCheckSummary output={output} />);
    expect(screen.getByText('Override required')).toBeTruthy();
    expect(screen.getByText('$350.40')).toBeTruthy();
    expect(screen.getByText('+$179.87')).toBeTruthy();
    expect(screen.getByText('12.3 kgCO2e')).toBeTruthy();
    expect(screen.getByText('1 resource(s) without a price are not counted')).toBeTruthy();
    expect(screen.getByText('Estimated increase exceeds 100.00 USD')).toBeTruthy();
    expect(screen.getByText('azurerm_linux_virtual_machine.api')).toBeTruthy();
    expect(screen.getByText('no price')).toBeTruthy();
    expect(screen.getByText('1 more resource(s) in the plan-check.json artifact')).toBeTruthy();
  });
});

describe('PolicyBuilder (plan policies)', () => {
  it('saves the severity of plan policies and the plan context help', async () => {
    const save = vi.fn().mockResolvedValue({});
    renderUi(
      <PolicyBuilder
        isNew={false}
        value={{
          identifier: 'no-destroy',
          title: 'No destroy',
          description: '',
          enabled: true,
          target: 'plan',
          severity: 'warning',
          match: {},
          expression: 'true',
          message: 'x',
        }}
        onSave={save}
        onClose={() => undefined}
      />,
    );
    expect(await screen.findByText('Severity')).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: /Rule/ }));
    expect(await screen.findByText(/every managed resource of the plan/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(save).toHaveBeenCalledWith('no-destroy', expect.objectContaining({ target: 'plan', severity: 'warning' })));
  });
});
