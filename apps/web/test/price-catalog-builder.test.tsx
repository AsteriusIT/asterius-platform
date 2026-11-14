import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { PriceCatalogBuilder, priceCatalogApi } from '../src/components/builder/PriceCatalogBuilder';
import { priceCatalogBody, priceCatalogProblems, toPriceCatalogDoc } from '../src/components/builder/priceCatalog';
import { api } from '../src/lib/api';
import { renderUi } from './render';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
beforeEach(() => {
  vi.spyOn(api, 'priceCatalogs').mockResolvedValue([
    { identifier: 'builtin', title: 'Built-in', description: '', currency: 'USD', hoursPerMonth: 730, carbon: {}, prices: [], managed: false, builtin: true },
    { identifier: 'eu', title: 'EU', description: '', currency: 'EUR', hoursPerMonth: 730, carbon: {}, prices: [], managed: false },
  ]);
});

const builtin = {
  identifier: 'builtin',
  title: 'Built-in sample prices',
  description: 'Sample',
  currency: 'USD',
  hoursPerMonth: 730,
  freeProviders: ['random'],
  carbon: {
    pue: { azurerm: 1.185 },
    gridIntensity: { westeurope: 0.328 },
    defaultGridIntensity: 0.475,
    wattsPerVcpu: { azurerm: 2.27 },
    wattsPerGbMemory: 0.392,
  },
  prices: [
    { provider: 'azurerm', type: 'azurerm_linux_virtual_machine', match: { size: 'Standard_B1s' }, hourly: 0.0104, vcpu: 1, memoryGb: 1 },
    {
      provider: 'azurerm',
      type: 'azurerm_kubernetes_cluster',
      match: { 'default_node_pool.0.vm_size': 'Standard_D2s_v5' },
      hourly: 0.096,
      quantity: { attribute: 'default_node_pool.0.node_count', default: 1 },
    },
    {
      provider: 'azurerm',
      type: 'azurerm_managed_disk',
      match: { storage_account_type: 'Premium_LRS' },
      perUnit: [{ attribute: 'disk_size_gb', scale: 1, default: 32, monthly: 0.15, watts: 0.0012 }],
    },
    { provider: 'aws', type: 'aws_iam_*', match: {}, free: true },
  ],
};

const typeInto = (label: RegExp | string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });

describe('PriceCatalogBuilder', () => {
  it('creates a catalog with an hourly and a usage-based entry', async () => {
    const save = vi.fn().mockResolvedValue({});
    renderUi(
      <PriceCatalogBuilder
        isNew
        value={{ identifier: '', title: '', description: '', currency: 'USD', extends: 'builtin', prices: [] }}
        onSave={save}
        onClose={() => undefined}
      />,
    );
    fireEvent.change(await screen.findByLabelText(/^Title/), { target: { value: 'Negotiated prices' } });

    fireEvent.click(screen.getByRole('tab', { name: /Prices/ }));
    fireEvent.click(screen.getByRole('button', { name: /Add price/ }));
    typeInto(/^Provider/, 'azurerm');
    typeInto(/^Resource type/, 'azurerm_linux_virtual_machine');
    fireEvent.click(screen.getByRole('button', { name: /Add matcher/ }));
    typeInto('Matcher 1 attribute', 'size');
    typeInto('Matcher 1 value', 'Standard_D2s_*');
    fireEvent.click(screen.getByLabelText('Hourly'));
    typeInto(/^Hourly price/, '0.1');
    typeInto(/^vCPUs/, '2');
    expect(screen.queryByLabelText(/^Monthly price/)).toBeNull();

    fireEvent.click(screen.getByText('All prices'));
    expect(screen.getByText('0.1 USD/h')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Add price/ }));
    typeInto(/^Provider/, 'aws');
    typeInto(/^Resource type/, 'aws_s3_bucket');
    fireEvent.click(screen.getByLabelText('Usage-based'));
    expect(screen.queryByLabelText(/^Hourly price/)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Create price catalog' }));
    await waitFor(() => expect(save).toHaveBeenCalled());
    const [id, body] = save.mock.calls[0]!;
    expect(id).toBe('negotiated-prices');
    expect(body).toEqual({
      identifier: 'negotiated-prices',
      title: 'Negotiated prices',
      description: '',
      currency: 'USD',
      extends: 'builtin',
      hoursPerMonth: 730,
      carbon: {},
      prices: [
        { provider: 'azurerm', type: 'azurerm_linux_virtual_machine', match: { size: 'Standard_D2s_*' }, hourly: 0.1, vcpu: 2 },
        { provider: 'aws', type: 'aws_s3_bucket', match: {}, usageBased: true },
      ],
    });
  });

  it('duplicates and removes entries, and filters the table', async () => {
    renderUi(<PriceCatalogBuilder isNew={false} value={{ ...builtin, identifier: 'mine' }} onSave={vi.fn()} onClose={() => undefined} />);
    fireEvent.click(await screen.findByRole('tab', { name: /Prices/ }));
    fireEvent.click(screen.getByRole('button', { name: /Duplicate Price 4/ }));
    expect(screen.getAllByText('aws_iam_*')).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: /Remove Price 5/ }));
    expect(screen.getAllByText('aws_iam_*')).toHaveLength(1);
    typeInto('Filter prices', 'disk');
    expect(screen.getByText('azurerm_managed_disk')).toBeTruthy();
    expect(screen.queryByText('aws_iam_*')).toBeNull();
    expect(screen.getByText('0.15/month per disk_size_gb USD')).toBeTruthy();
  });

  it('opens the built-in catalog read-only, still browsable and tryable', async () => {
    const estimate = vi.spyOn(priceCatalogApi, 'estimate').mockResolvedValue({
      kind: 'plan-check',
      gate: 'pass',
      requiresOverride: false,
      changes: { create: 1, update: 0, delete: 0, replace: 0, 'no-op': 0, forget: 0 },
      cost: { currency: 'USD', monthly: 70.08, before: 0, delta: 70.08, complete: false, unmatched: ['azurerm_thing.x'], usageBased: [], catalog: 'builtin' },
      carbon: { monthlyKg: 1.5, beforeKg: 0, deltaKg: 1.5, method: 'Estimate' },
      violations: [],
      counts: { critical: 0, warning: 0, advisory: 0 },
      resources: [],
      truncated: 0,
      summary: '',
    });
    renderUi(<PriceCatalogBuilder isNew={false} readOnly value={builtin} onSave={vi.fn()} onClose={() => undefined} />);
    expect((await screen.findByLabelText(/^Title/)).closest('fieldset')?.disabled).toBe(true);
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();

    fireEvent.click(screen.getByRole('tab', { name: /Prices/ }));
    expect(screen.queryByRole('button', { name: /Add price/ })).toBeNull();
    fireEvent.click(screen.getByText('azurerm_kubernetes_cluster'));
    expect((screen.getByLabelText(/^Quantity attribute/) as HTMLInputElement).value).toBe('default_node_pool.0.node_count');
    fireEvent.click(screen.getByText('All prices'));
    expect(screen.getByText('azurerm_managed_disk')).toBeTruthy();

    fireEvent.click(screen.getByRole('tab', { name: /Carbon/ }));
    expect((screen.getByLabelText('PUE provider 1') as HTMLInputElement).value).toBe('azurerm');

    fireEvent.click(screen.getByRole('button', { name: /Try on a plan/ }));
    const dialog = await screen.findByRole('dialog', { name: /Try builtin/ });
    fireEvent.change(within(dialog).getByLabelText('Plan JSON'), { target: { value: '{"resource_changes": []}' } });
    fireEvent.click(within(dialog).getByRole('button', { name: /Estimate/ }));
    await within(dialog).findByText('$70.08');
    expect(within(dialog).getByText('1 resource(s) without a price are not counted')).toBeTruthy();
    expect(estimate).toHaveBeenCalledWith('builtin', { resource_changes: [] });
  });

  it('lists what blocks saving', async () => {
    const save = vi.fn();
    const bad = {
      identifier: 'mine',
      title: 'Mine',
      currency: 'usd',
      extends: 'eu',
      hoursPerMonth: 800,
      carbon: { pue: { azurerm: 5 } },
      prices: [
        { provider: 'azurerm', type: '', match: { sku: 3 } },
        { provider: 'aws', type: 'aws_ebs_volume', match: {}, perUnit: [{ attribute: '', scale: 0 }] },
      ],
    };
    renderUi(<PriceCatalogBuilder isNew={false} value={bad} onSave={save} onClose={() => undefined} />);
    await screen.findByLabelText(/^Title/);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText(/Currency: ISO 4217 code/);
    for (const msg of [
      /Hours per month: greater than 0, at most 744/,
      /PUE azurerm: between 1 and 3/,
      /Price 1 \(azurerm\): resource type is required/,
      /Price 1 \(azurerm\): monthly price is required/,
      /Price 2 \(aws aws_ebs_volume\) unit 1: attribute is required/,
      /Price 2 \(aws aws_ebs_volume\) unit 1 scale: greater than 0/,
    ])
      expect(screen.getByText(msg)).toBeTruthy();
    expect(save).not.toHaveBeenCalled();
  });
});

describe('price catalog model', () => {
  it('round-trips the entries of the built-in catalog unchanged', () => {
    expect(priceCatalogBody(toPriceCatalogDoc(builtin))).toEqual(builtin);
  });

  it('keeps matcher types and flags a currency different from the extended catalog', () => {
    const doc = toPriceCatalogDoc({
      identifier: 'x',
      title: 'X',
      currency: 'USD',
      extends: 'eu',
      prices: [{ provider: '*', type: '*', match: { count: 2, enabled: true, size: ['a', 'b'] }, monthly: 1 }],
    });
    expect((priceCatalogBody(doc).prices as { match: unknown }[])[0]!.match).toEqual({ count: 2, enabled: true, size: ['a', 'b'] });
    expect(priceCatalogProblems(doc, [{ identifier: 'eu', currency: 'EUR' }])).toEqual(['Currency: eu is in EUR, a catalog extends one in the same currency']);
    expect(priceCatalogProblems({ ...doc, identifier: 'builtin', extends: 'builtin' }, [])).toContain('A price catalog cannot extend itself');
  });
});
