import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import type { ObjectSchema, StepConnection } from '@asterius/shared';
import { api } from '../src/lib/api';
import { entityPrefill, operationFields, previewInputs } from '../src/lib/connectorSteps';
import { ConnectorStepEditor } from '../src/components/builder/ConnectorStepEditor';
import { renderUi } from './render';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const inputs: ObjectSchema = {
  properties: {
    name: { type: 'string', title: 'Repository name' },
    pipelineId: { type: 'integer', title: 'Pipeline id' },
    variables: { type: 'object' },
    env: { type: 'string', enum: ['dev', 'prod'] },
  },
  required: ['name'],
};

describe('connector step helpers', () => {
  it('turns the operation inputs into step fields', () => {
    expect(operationFields(inputs)).toEqual([
      { key: 'name', label: 'Repository name', kind: 'text', required: true },
      { key: 'pipelineId', label: 'Pipeline id', kind: 'number', required: false },
      { key: 'variables', label: 'variables', kind: 'keyvalue', required: false },
      { key: 'env', label: 'env', kind: 'text', required: false, help: 'One of: dev, prod' },
    ]);
  });

  it('keeps text templates and samples typed ones for the preview', () => {
    expect(previewInputs(inputs, { name: '{{ inputs.name }}', pipelineId: '{{ inputs.id }}', env: 'dev' })).toEqual({
      name: '{{ inputs.name }}',
      pipelineId: 0,
      env: 'dev',
    });
  });

  it('prefills empty inputs from the entity', () => {
    expect(entityPrefill(inputs, ['env', 'owner'], { pipelineId: 3 })).toEqual({
      name: '{{ entity.identifier }}',
      pipelineId: 3,
      env: '{{ entity.properties.env }}',
    });
  });
});

const connection = (access: 'read' | 'read-write', api?: StepConnection['api']): StepConnection => ({
  identifier: `ado-${access}`,
  title: `ADO ${access}`,
  description: '',
  connector: { identifier: 'azure-devops', title: 'Azure DevOps', icon: 'brand-azure' },
  access,
  allowed: {},
  fields: { baseUrl: 'https://dev.azure.com', organization: 'my-org' },
  ...(api ? { api } : {}),
  operations: [
    {
      name: 'create-repository',
      title: 'Create a Git repository',
      description: 'Creates an empty Git repository.',
      kind: 'repository',
      inputs,
      outputs: ['id', 'url', 'httpStatus'],
      readOnly: false,
      polls: false,
      blueprints: ['service'],
      usable: access === 'read-write',
      ...(access === 'read' ? { reason: 'This connection is read-only and this operation changes things' } : {}),
    },
  ],
});

describe('ConnectorStepEditor', () => {
  it('edits the inputs of an operation, previews the request and prefills from the entity', async () => {
    vi.spyOn(api, 'connectionsForSteps').mockResolvedValue([connection('read-write')]);
    vi.spyOn(api, 'blueprint').mockResolvedValue({ identifier: 'service', schema: { properties: { env: { type: 'string' } } } } as never);
    const render = vi
      .spyOn(api, 'renderConnectorOperation')
      .mockResolvedValue({ method: 'POST', url: 'https://dev.azure.com/my-org/_apis/git/repositories', headers: {}, body: { name: 'x' }, inputs: {} });
    const onChange = vi.fn();
    renderUi(
      <ConnectorStepEditor
        invoker={{ type: 'connector', connection: 'ado-read-write', operation: 'create-repository', inputs: { name: '{{ inputs.name }}' } }}
        onChange={onChange}
        blueprint="service"
        onEntity
      />,
    );
    expect(await screen.findByDisplayValue('{{ inputs.name }}')).toBeTruthy();
    expect(screen.getAllByText('Creates an empty Git repository.').length).toBeGreaterThan(0);
    expect(await screen.findByText(/POST https:\/\/dev.azure.com\/my-org\/_apis\/git\/repositories/)).toBeTruthy();
    expect(render).toHaveBeenCalledWith('azure-devops', 'create-repository', {
      fields: { baseUrl: 'https://dev.azure.com', organization: 'my-org' },
      inputs: { name: '{{ inputs.name }}' },
    });
    fireEvent.change(screen.getByLabelText('Pipeline id'), { target: { value: '42' } });
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ inputs: { name: '{{ inputs.name }}', pipelineId: 42 } }));
    await waitFor(() => expect(api.blueprint).toHaveBeenCalled());
    await screen.findByText(/applies to service entities/);
    await waitFor(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Fill from the entity/ }));
      expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ inputs: { name: '{{ inputs.name }}', env: '{{ entity.properties.env }}' } }));
    });
  });

  it('explains why a write operation cannot run on a read-only connection', async () => {
    vi.spyOn(api, 'connectionsForSteps').mockResolvedValue([connection('read')]);
    vi.spyOn(api, 'renderConnectorOperation').mockResolvedValue({ method: 'POST', url: 'https://x', headers: {}, inputs: {} });
    renderUi(
      <ConnectorStepEditor
        invoker={{ type: 'connector', connection: 'ado-read', operation: 'create-repository' }}
        onChange={() => {}}
        blueprint={null}
        onEntity={false}
      />,
    );
    expect((await screen.findAllByText(/This connection is read-only and this operation changes things\. Choose/)).length).toBe(1);
    expect(screen.getByText(/Greyed-out operations change things/)).toBeTruthy();
  });

  it('edits a raw API call within the allow-list', async () => {
    vi.spyOn(api, 'connectionsForSteps').mockResolvedValue([connection('read-write', { methods: ['GET', 'POST'], paths: ['/my-org/_apis'] })]);
    const onChange = vi.fn();
    renderUi(
      <ConnectorStepEditor
        invoker={{ type: 'connector-api', connection: 'ado-read-write', method: 'GET', path: '/my-org/_apis/projects' }}
        onChange={onChange}
        blueprint={null}
        onEntity={false}
      />,
    );
    expect(await screen.findByText(/Allowed: GET, POST under \/my-org\/_apis/)).toBeTruthy();
    fireEvent.change(screen.getByDisplayValue('/my-org/_apis/projects'), { target: { value: '/my-org/_apis/git' } });
    expect(onChange).toHaveBeenLastCalledWith({ type: 'connector-api', connection: 'ado-read-write', method: 'GET', path: '/my-org/_apis/git' });
    expect(screen.queryByText('Body')).toBeNull();
  });
});
