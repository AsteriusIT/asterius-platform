import { parse } from 'yaml';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import type { ConnectorDefinition } from '@asterius/shared';
import { api } from '../src/lib/api';
import { ConnectorBuilder } from '../src/components/builder/ConnectorBuilder';
import { connectorBody, connectorProblems, toConnectorDoc } from '../src/components/builder/connectorDoc';
import { ConnectorsAdmin } from '../src/pages/admin/Connectors';
import { renderUi } from './render';

vi.mock('../src/lib/auth', async (orig) => ({
  ...(await orig<typeof import('../src/lib/auth')>()),
  useCan: () => () => true,
}));

beforeEach(() => {
  localStorage.clear();
  vi.spyOn(api, 'checkExpression').mockResolvedValue({ ok: true, value: null } as never);
  vi.spyOn(api, 'blueprints').mockResolvedValue([]);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const pagerduty: ConnectorDefinition = {
  identifier: 'pagerduty',
  title: 'PagerDuty',
  description: 'Services and incidents',
  icon: 'alarm',
  category: 'incident',
  fields: { properties: { baseUrl: { type: 'string', title: 'API URL', format: 'url', default: 'https://api.pagerduty.com' } } },
  auth: [{ type: 'header', title: 'REST API key', set: {}, headers: { Authorization: 'Token token={token}' } }],
  authOptional: false,
  headers: { accept: 'application/vnd.pagerduty+json;version=2' },
  kinds: {
    service: {
      title: 'Services',
      method: 'GET',
      path: '/services',
      query: { limit: '100' },
      headers: {},
      itemsPath: 'services',
      pagination: { type: 'offset', param: 'offset', pageSize: 100 },
    },
  },
  operations: {},
  builtin: true,
  managed: true,
  version: 0,
  updatedAt: null,
};

/** An Azure DevOps-like definition, as stored (defaults filled in). */
const ado = {
  identifier: 'my-ado',
  title: 'My ADO',
  description: '',
  category: 'source-control',
  fields: {
    properties: {
      baseUrl: { type: 'string', title: 'Service URL', format: 'url', default: 'https://dev.azure.com' },
      organization: { type: 'string', title: 'Organization' },
    },
    required: ['organization'],
    order: ['organization', 'baseUrl'],
  },
  auth: [{ type: 'basic', title: 'PAT', set: { username: '' } }],
  authOptional: false,
  headers: {},
  test: {
    method: 'GET',
    path: '/{{ connection.organization }}/_apis/projects',
    query: { 'api-version': '7.1' },
    headers: {},
    expect: { condition: '$exists(body.value)' },
  },
  kinds: {
    project: {
      title: 'Projects',
      method: 'GET',
      path: '/{{ connection.organization }}/_apis/projects',
      query: {},
      headers: {},
      itemsPath: 'value',
      pagination: { type: 'cursor', param: 'continuationToken', cursorHeader: 'x-ms-continuationtoken' },
      requires: ['organization'],
    },
  },
  operations: {
    'run-pipeline': {
      title: 'Run a pipeline',
      description: '',
      kind: 'project',
      inputs: { properties: { pipelineId: { type: 'integer', title: 'Pipeline id' } }, required: ['pipelineId'] },
      method: 'POST',
      path: '/{{ connection.organization }}/_apis/pipelines/{{ inputs.pipelineId }}/runs',
      query: {},
      headers: {},
      body: { resources: {} },
      output: { runId: 'body.id' },
      poll: {
        method: 'GET',
        path: '/{{ connection.organization }}/_apis/pipelines/{{ inputs.pipelineId }}/runs/{{ output.runId }}',
        query: {},
        headers: {},
        intervalSeconds: 15,
        timeoutMinutes: 240,
        done: 'body.state = "completed"',
        failed: 'body.result = "failed"',
      },
    },
  },
  example: { fields: { organization: 'acme' }, auth: { type: 'basic', password: '${secret:ADO_PAT}' } },
};

describe('connector document', () => {
  it('accepts every built-in definition (a duplicate saves as is)', () => {
    const files = import.meta.glob<string>('../../server/connectors/*.yaml', { query: '?raw', import: 'default', eager: true });
    expect(Object.keys(files).length).toBeGreaterThan(5);
    for (const [f, text] of Object.entries(files)) {
      const def = parse(text) as Record<string, unknown>;
      expect([f, connectorProblems(toConnectorDoc(def))]).toEqual([f, []]);
    }
  });

  it('round-trips a definition: order of fields, auth, pagination, polling and the example are kept', () => {
    const body = connectorBody(toConnectorDoc(ado));
    expect(connectorProblems(toConnectorDoc(ado))).toEqual([]);
    expect(body).toMatchObject({
      fields: { order: ['organization', 'baseUrl'], required: ['organization'] },
      auth: [{ type: 'basic', title: 'PAT', set: { username: '' } }],
      test: { path: '/{{ connection.organization }}/_apis/projects', query: { 'api-version': '7.1' }, expect: { condition: '$exists(body.value)' } },
      kinds: { project: { pagination: { type: 'cursor', param: 'continuationToken', cursorHeader: 'x-ms-continuationtoken' }, requires: ['organization'] } },
      operations: {
        'run-pipeline': {
          kind: 'project',
          body: { resources: {} },
          output: { runId: 'body.id' },
          poll: { timeoutMinutes: 240, failed: 'body.result = "failed"' },
        },
      },
      example: { auth: { password: '${secret:ADO_PAT}' } },
    });
    expect(connectorBody(toConnectorDoc(body))).toEqual(body);
  });

  it('reports what the server would refuse', () => {
    const problems = connectorProblems(
      toConnectorDoc({
        ...ado,
        fields: { properties: { organization: { type: 'string' } } },
        auth: [
          { type: 'header', set: {}, headers: { 'X-Key': 'static' } },
          { type: 'bearer', set: { token: 'literal' } },
        ],
        kinds: { 'Bad Key': { path: 'no-slash', pagination: { type: 'cursor' } } },
        operations: { op: { title: '', kind: 'nope', path: '/x/{{ inputs.missing }}', inputs: {}, poll: { path: '/p', done: '', intervalSeconds: 1 } } },
      }),
    );
    const has = (re: RegExp) => expect(problems.some((p) => re.test(p))).toBe(true);
    has(/"baseUrl" field is required/);
    has(/Authentication 1 \(header\): add a header whose format has a \{credential\} placeholder/);
    has(/Authentication 2 \(bearer\): "token" is a credential/);
    has(/Kind Bad Key: the key must be lowercase/);
    has(/Kind Bad Key: Starts with \//);
    has(/cursor pagination needs a parameter/);
    has(/cursor pagination needs a cursor path or header/);
    has(/Operation op: title is required/);
    has(/kind "nope" is not one of the kinds/);
    has(/inputs.missing is used but is not an input/);
    has(/polling: the "done" condition is required/);
    has(/interval between 2 and 3600 seconds/);
    expect(connectorProblems(toConnectorDoc({ ...ado, headers: { 'X-Token': '${secret:T}' } }))).toContain(
      'A definition cannot contain ${secret:…} / ${env:…} references: credentials belong to connections',
    );
  });
});

describe('ConnectorBuilder', () => {
  it('creates a connector with one auth method, one kind and one operation', async () => {
    const save = vi.fn().mockResolvedValue({});
    renderUi(
      <ConnectorBuilder
        isNew
        value={{ identifier: '', title: '', fields: { properties: { baseUrl: { type: 'string', title: 'API URL', format: 'url' } }, required: ['baseUrl'] } }}
        onSave={save}
        onClose={() => undefined}
      />,
    );
    fireEvent.change(await screen.findByLabelText(/^Title/), { target: { value: 'Acme CMDB' } });

    fireEvent.click(screen.getByRole('tab', { name: /Authentication/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Add a method' }));
    fireEvent.change(screen.getByLabelText('Authentication title'), { target: { value: 'Service account' } });
    expect(screen.getByText('default')).toBeTruthy();
    expect(screen.getByText(/Connections supply: username, password \(secret\)/)).toBeTruthy();

    fireEvent.click(screen.getByRole('tab', { name: /Kinds/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Add a kind' }));
    fireEvent.change(screen.getByLabelText('Kind new title'), { target: { value: 'Applications' } });
    fireEvent.change(screen.getByLabelText('Kind applications path'), { target: { value: '/apps' } });
    fireEvent.click(screen.getByRole('combobox', { name: 'Pagination type' }));
    fireEvent.click(await screen.findByRole('option', { name: 'Page number' }));
    fireEvent.change(await screen.findByLabelText(/^Parameter/), { target: { value: 'page' } });

    fireEvent.click(screen.getByRole('tab', { name: /Operations/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Add an operation' }));
    fireEvent.change(screen.getByLabelText(/Operation new title/), { target: { value: 'Open a ticket' } });
    fireEvent.change(screen.getByLabelText('Operation open-a-ticket path'), { target: { value: '/tickets' } });
    fireEvent.change(screen.getByLabelText('Body'), { target: { value: '{ "summary": "{{ inputs.summary }}" }' } });

    // The body uses an input that is not declared yet.
    fireEvent.click(screen.getByRole('button', { name: 'Create connector' }));
    expect(await screen.findByText('Operation open-a-ticket: inputs.summary is used but is not an input')).toBeTruthy();
    expect(save).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /Add a field/ }));
    fireEvent.change(screen.getByLabelText('Label'), { target: { value: 'Summary' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create connector' }));
    await waitFor(() => expect(save).toHaveBeenCalled());
    const [id, body] = save.mock.calls[0]!;
    expect(id).toBe('acme-cmdb');
    expect(body).toEqual({
      identifier: 'acme-cmdb',
      title: 'Acme CMDB',
      description: '',
      category: 'other',
      fields: { properties: { baseUrl: { type: 'string', format: 'url', title: 'API URL' } }, required: ['baseUrl'], order: ['baseUrl'] },
      auth: [{ type: 'basic', title: 'Service account', set: {} }],
      authOptional: false,
      headers: {},
      kinds: { applications: { title: 'Applications', method: 'GET', path: '/apps', pagination: { type: 'page', param: 'page' } } },
      operations: {
        'open-a-ticket': {
          title: 'Open a ticket',
          description: '',
          inputs: { properties: { summary: { type: 'string', title: 'Summary' } }, order: ['summary'] },
          method: 'POST',
          path: '/tickets',
          body: { summary: '{{ inputs.summary }}' },
        },
      },
    });
  });

  it('keeps baseUrl in the connection form, not removable', async () => {
    renderUi(<ConnectorBuilder isNew={false} value={ado} onSave={vi.fn()} onClose={() => undefined} />);
    fireEvent.click(await screen.findByRole('tab', { name: /Connection form/ }));
    expect(((await screen.findByLabelText('baseUrl default')) as HTMLInputElement).value).toBe('https://dev.azure.com');
    // Only the other field (organization) has a remove button.
    expect(screen.getAllByRole('button', { name: 'Remove field' })).toHaveLength(1);
  });
});

describe('connectors admin', () => {
  it('opens a built-in read-only in the form editor, still copyable', async () => {
    vi.spyOn(api, 'connectors').mockResolvedValue([pagerduty]);
    vi.spyOn(api, 'connections').mockResolvedValue([]);
    renderUi(<ConnectorsAdmin />, '/admin/connectors?open=pagerduty');
    fireEvent.click(await screen.findByRole('button', { name: 'View' }));
    expect(await screen.findByText(/Built-in connector: it ships with the platform/)).toBeTruthy();
    expect((screen.getByLabelText(/^Title/) as HTMLInputElement).closest('fieldset')?.disabled).toBe(true);
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: /Kinds/ }));
    expect(((await screen.findByLabelText('Kind service path')) as HTMLInputElement).value).toBe('/services');
    fireEvent.click(screen.getByRole('tab', { name: 'YAML' }));
    const yaml = (await screen.findByLabelText('YAML document')) as HTMLTextAreaElement;
    expect(yaml.value).toContain('Token token={token}');
    expect(yaml.value).not.toContain('builtin');
    expect(screen.getByRole('button', { name: /Duplicate/ })).toBeTruthy();
  });
});
