import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import type { Action, Run } from '@asterius/shared';
import { ActionRunModal } from '../src/components/ActionRunModal';
import { api, type ServicePreview } from '../src/lib/api';
import { renderUi } from './render';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
});

const action = {
  identifier: 'create-platform-service',
  title: 'Create a service',
  description: '',
  trigger: {
    type: 'form',
    on: 'create',
    blueprint: 'platform-service',
    inputs: { properties: { name: { type: 'string', title: 'Service name' } }, required: ['name'] },
    allowed: {},
    approval: { required: false },
  },
  steps: [
    { id: 'precheck', type: 'invoke', invoker: { type: 'service-precheck' } },
    { id: 'commit', type: 'invoke', invoker: { type: 'service-spec' } },
  ],
  enabled: true,
  managed: true,
  version: 1,
} as unknown as Action;

const preview = (over: Partial<ServicePreview> = {}): ServicePreview => ({
  supported: true,
  step: 'precheck',
  inputErrors: [],
  canSubmit: true,
  specPath: 'services/team-payments/payments-api.yaml',
  specYaml: 'apiVersion: platform.asterius.io/v1alpha1\nkind: Service\n',
  policy: { status: 'allowed', allowed: true, violations: [] },
  render: {
    status: 'ok',
    resources: [{ apiVersion: 'core.azuredevops.upbound.io/v1alpha1', kind: 'Project', name: 'project', externalName: 'payments-payments-api' }],
  },
  ...over,
});

describe('V2 preview before submit', () => {
  it('previews the resources and the policy result, then confirms', async () => {
    const pv = vi.spyOn(api, 'previewAction').mockResolvedValue(preview());
    const trigger = vi.spyOn(api, 'trigger').mockResolvedValue({ id: 'r1', status: 'QUEUED' } as Run);
    renderUi(<ActionRunModal action={action} onClose={() => undefined} />);
    fireEvent.change(await screen.findByLabelText(/Service name/), { target: { value: 'payments-api' } });
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    await screen.findByText('Policies passed');
    expect(pv).toHaveBeenCalledWith('create-platform-service', { entity: null, inputs: { name: 'payments-api' } });
    expect(screen.getByText('payments-payments-api')).toBeTruthy();
    expect(trigger).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(trigger).toHaveBeenCalled());
  });

  it('blocks the confirmation when a policy denies the request', async () => {
    vi.spyOn(api, 'previewAction').mockResolvedValue(
      preview({
        canSubmit: false,
        policy: { status: 'denied', allowed: false, violations: [{ policy: 'cost-center-required', msg: 'costCenter is required' }] },
      }),
    );
    renderUi(<ActionRunModal action={action} onClose={() => undefined} />);
    fireEvent.change(await screen.findByLabelText(/Service name/), { target: { value: 'x' } });
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    await screen.findByText('Denied by policy');
    expect(screen.getByText(/costCenter is required/)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Confirm' }) as HTMLButtonElement).disabled).toBe(true);
    // editing the form drops the preview
    fireEvent.change(screen.getByLabelText(/Service name/), { target: { value: 'y' } });
    expect(screen.queryByText('Denied by policy')).toBeNull();
    expect(screen.getByRole('button', { name: 'Preview' })).toBeTruthy();
  });

  it('warns when the policy service is unavailable but lets the run decide', async () => {
    vi.spyOn(api, 'previewAction').mockResolvedValue(
      preview({
        policy: { status: 'unavailable', allowed: null, violations: [], error: 'OPA unreachable' },
        render: { status: 'unavailable', resources: [], error: 'no render' },
      }),
    );
    renderUi(<ActionRunModal action={action} onClose={() => undefined} />);
    fireEvent.change(await screen.findByLabelText(/Service name/), { target: { value: 'x' } });
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    await screen.findByText('Policy check unavailable');
    expect((screen.getByRole('button', { name: 'Confirm' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('shows the planned action of each resource (plan service): created, adopted, changed', async () => {
    vi.spyOn(api, 'previewAction').mockResolvedValue(
      preview({
        render: {
          status: 'ok',
          resources: [
            { kind: 'azuredevops_project', name: 'module.gp.azuredevops_project.this', externalName: 'payments-payments-api', action: 'import' },
            { kind: 'azuredevops_git_repository', name: 'module.gp.azuredevops_git_repository.this', externalName: 'payments-api', action: 'create' },
            { kind: 'azuredevops_environment', name: 'module.gp.azuredevops_environment.env["dev"]', externalName: 'dev', action: 'update', replace: true },
          ],
        },
      }),
    );
    renderUi(<ActionRunModal action={action} onClose={() => undefined} />);
    fireEvent.change(await screen.findByLabelText(/Service name/), { target: { value: 'payments-api' } });
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    await screen.findByText('Planned changes');
    expect(screen.getByText('Action')).toBeTruthy();
    expect(screen.getByText('import')).toBeTruthy();
    expect(screen.getByText('create')).toBeTruthy();
    expect(screen.getByText('replace')).toBeTruthy();
    expect(screen.getByText(/1 to create, 1 already exists \(adopted\), 1 to change/)).toBeTruthy();
    expect(screen.getByText('Name in Azure DevOps')).toBeTruthy();
    expect(screen.queryByText('API version')).toBeNull();
  });
});
