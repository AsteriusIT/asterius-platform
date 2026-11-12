import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MantineProvider } from '@mantine/core';
import { ModalsProvider } from '@mantine/modals';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router';
import type { WorkflowStep } from '@asterius/shared';
import { connectSteps, disconnectSteps, insertStepAfter, needsOf, stepTone } from '../src/lib/workflow';
import { WorkflowFlow } from '../src/components/WorkflowFlow';
import { WorkflowFlowPage } from '../src/pages/admin/WorkflowFlow';
import { RunPage } from '../src/pages/Runs';
import { api } from '../src/lib/api';
import { theme } from '@asterius/brand';
import { renderUi } from './render';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const t = (id: string, needs?: string[]): WorkflowStep => ({ id, type: 'transform', output: {}, ...(needs ? { needs } : {}) }) as WorkflowStep;
const graph = (steps: WorkflowStep[]) => Object.fromEntries(steps.map((s, i) => [s.id, needsOf(steps, i)]));

describe('graph editing helpers', () => {
  it('adds a dependency on an earlier step in place', () => {
    const steps = [t('a'), t('b', []), t('c', [])];
    expect(graph(connectSteps(steps, 'b', 'c')!)).toEqual({ a: [], b: [], c: ['b'] });
  });

  it('reorders when the new dependency comes later, and refuses loops', () => {
    const steps = [t('a'), t('b'), t('c', [])]; // a -> b, c parallel
    const next = connectSteps(steps, 'c', 'a')!;
    expect(next.map((s) => s.id)).toEqual(['c', 'a', 'b']);
    expect(graph(next)).toEqual({ c: [], a: ['c'], b: ['a'] });
    expect(connectSteps(steps, 'b', 'a')).toBeNull();
  });

  it('removes a dependency, implicit or explicit', () => {
    expect(graph(disconnectSteps([t('a'), t('b')], 'a', 'b'))).toEqual({ a: [], b: [] });
  });

  it('inserts after the last step as a plain sequence, elsewhere without changing other steps', () => {
    const steps = [t('a'), t('b')];
    expect(graph(insertStepAfter(steps, 'b', t('n')))).toEqual({ a: [], b: ['a'], n: ['b'] });
    expect(graph(insertStepAfter(steps, 'a', t('n')))).toEqual({ a: [], b: ['a'], n: ['a'] });
    expect(graph(insertStepAfter(steps, null, t('n')))).toEqual({ a: [], b: ['a'], n: [] });
  });

  it('maps run statuses to colours', () => {
    expect(['SUCCESS', 'FAILURE', 'WAITING_APPROVAL', 'WAITING', 'RUNNING', 'SKIPPED', 'PENDING'].map((s) => stepTone(s as never))).toEqual([
      'success',
      'failure',
      'pending',
      'pending',
      'running',
      'skipped',
      'idle',
    ]);
  });
});

describe('WorkflowFlow', () => {
  it('draws the trigger and the steps with their status colour', () => {
    renderUi(
      <WorkflowFlow
        trigger={{ title: 'Form submitted', tone: 'success' }}
        steps={[
          { id: 'build', type: 'invoke', needs: [], tone: 'success' },
          { id: 'approve', name: 'Platform approval', type: 'approval', needs: ['build'], tone: 'pending' },
          { id: 'deploy', type: 'invoke', needs: ['approve'], tone: 'failure' },
        ]}
      />,
    );
    const tone = (label: string) => screen.getByLabelText(label).getAttribute('data-tone');
    expect(tone('Trigger: Form submitted')).toBe('success');
    expect(tone('Integration: build')).toBe('success');
    expect(tone('Approval: Platform approval')).toBe('pending');
    expect(tone('Integration: deploy')).toBe('failure');
  });
});

/** The editor page on `action` (served by a mocked GET /actions/:id). */
function renderPage(action: Record<string, unknown>) {
  vi.spyOn(api, 'action').mockResolvedValue({ managed: false, version: 1, ...action } as never);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <MantineProvider theme={theme} env="test">
      <ModalsProvider>
        <QueryClientProvider client={qc}>
          <MemoryRouter initialEntries={[`/admin/actions/${String(action.identifier)}`]}>
            <Routes>
              <Route path="/admin/actions/:id" element={<WorkflowFlowPage />} />
            </Routes>
          </MemoryRouter>
        </QueryClientProvider>
      </ModalsProvider>
    </MantineProvider>
  );
}

const webhookMeta = {
  invokers: [
    {
      type: 'webhook',
      title: 'Webhook (HTTP)',
      description: 'Call a URL',
      example: { type: 'webhook', url: 'https://x' },
      fields: [{ key: 'url', label: 'URL', kind: 'text', required: true }],
    },
  ],
};

describe('flow editor page', () => {
  const draft = {
    identifier: 'deploy',
    title: 'Deploy',
    trigger: { type: 'api', on: 'create', blueprint: null, inputs: { properties: {} }, allowed: {}, approval: { required: false } },
    steps: [
      { id: 'compute', type: 'transform', output: {} },
      { id: 'notify', type: 'transform', output: {} },
    ],
    enabled: true,
  };

  it('opens a step in a dialog and draws the test result on the graph', async () => {
    vi.spyOn(api, 'meta').mockResolvedValue({ invokers: [] } as never);
    vi.spyOn(api, 'dryRun').mockResolvedValue({
      valid: false,
      inputErrors: [],
      missingSecrets: [],
      steps: [
        { id: 'compute', type: 'transform', status: 'planned', errors: [], rendered: { a: 1 } },
        { id: 'notify', type: 'transform', status: 'error', errors: ['bad template'] },
      ],
    });
    render(renderPage(draft));
    expect(await screen.findByLabelText('Transform: notify')).toBeTruthy();
    expect(screen.queryByText('Experimental')).toBeNull();
    expect(screen.queryByText('Unsaved changes')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Dry run' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Start the dry run' }));
    expect(await screen.findByText('Dry run found problems')).toBeTruthy();
    await waitFor(() => expect(screen.getByLabelText('Transform: notify').getAttribute('data-tone')).toBe('failure'));
    expect(screen.getByLabelText('Transform: compute').getAttribute('data-tone')).toBe('success');

    fireEvent.click(screen.getByLabelText('Transform: notify'));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('bad template')).toBeTruthy();
  });

  it('expands a fragment step into its own steps, wired as a run inlines them', async () => {
    vi.spyOn(api, 'meta').mockResolvedValue({ invokers: [] } as never);
    vi.spyOn(api, 'fragments').mockResolvedValue([
      {
        identifier: 'notify',
        title: 'Notify',
        description: '',
        params: { properties: {} },
        steps: [
          { id: 'ask', type: 'approval', minApprovals: 1 },
          { id: 'post', type: 'transform', output: {} },
        ],
        outputs: {},
        version: 2,
        managed: false,
        updatedAt: '2026-11-01T00:00:00.000Z',
      },
    ] as never);
    render(
      renderPage({
        ...draft,
        steps: [
          { id: 'compute', type: 'transform', output: {} },
          { id: 'n', name: 'Notify team', type: 'fragment', fragment: 'notify' },
          { id: 'done', type: 'transform', output: {} },
        ],
      }),
    );
    expect(await screen.findByLabelText('Fragment: Notify team')).toBeTruthy();
    expect(screen.queryByLabelText('Notify · Approval: ask')).toBeNull();

    fireEvent.click(await screen.findByLabelText('Show the steps of Notify team'));
    expect(await screen.findByLabelText('Notify · Approval: ask')).toBeTruthy();
    expect(screen.getByLabelText('Notify · Transform: post')).toBeTruthy();
    // An inner step selects its fragment step.
    fireEvent.click(screen.getByLabelText('Notify · Transform: post'));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Notify team')).toBeTruthy();

    fireEvent.click(screen.getByLabelText('Hide the steps of Notify team'));
    await waitFor(() => expect(screen.queryByLabelText('Notify · Approval: ask')).toBeNull());
  });

  it('adds a step from the toolbar and opens it', async () => {
    vi.spyOn(api, 'meta').mockResolvedValue({ invokers: [] } as never);
    render(renderPage(draft));
    fireEvent.click(await screen.findByRole('button', { name: 'Add a step' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: /^Wait/ }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getAllByText('Wait').length).toBeGreaterThan(0);
    expect(screen.getByText('Unsaved changes')).toBeTruthy();
    expect(screen.getByLabelText(/^Wait: /)).toBeTruthy();
  });

  it('builds trigger and steps, keeps the JSON in sync and saves the document', async () => {
    vi.spyOn(api, 'meta').mockResolvedValue(webhookMeta as never);
    const save = vi.spyOn(api, 'saveActionAt').mockImplementation(async (_id, body) => body as never);
    render(renderPage({ identifier: 'bucket', title: 'Bucket', description: '', icon: null, enabled: true, trigger: null, steps: [] }));
    expect(await screen.findByText(/Draft: add a trigger and a step/)).toBeTruthy();

    // Trigger: a form submission with one field.
    fireEvent.click(screen.getByRole('button', { name: 'Add a trigger' }));
    fireEvent.click(await screen.findByText('Add a field'));
    fireEvent.change(screen.getByLabelText('Label'), { target: { value: 'Bucket name' } });
    expect((screen.getByLabelText('Key') as HTMLInputElement).value).toBe('bucketName'); // derived from the label
    fireEvent.click(screen.getByLabelText('Required'));

    // Steps: an AI agent, then an approval after it.
    fireEvent.click(screen.getByRole('button', { name: 'Add a step' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: /^AI agent/ }));
    fireEvent.change(await screen.findByLabelText(/^Prompt/), { target: { value: 'Review {{ inputs.bucketName }}' } });
    expect(screen.getByText('inputs.bucketName')).toBeTruthy(); // trigger fields are offered as variables
    fireEvent.click(screen.getByRole('button', { name: 'Add a step' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: /^Approval/ }));
    expect(await screen.findByLabelText(/^Approval: /)).toBeTruthy();

    // The document, as JSON: edit it there and see it in the trigger's form.
    fireEvent.click(screen.getByRole('button', { name: 'Code' }));
    const json = (await screen.findAllByRole('textbox')).find((t) => (t as HTMLTextAreaElement).value.startsWith('{')) as HTMLTextAreaElement;
    const doc = JSON.parse(json.value);
    expect(doc.trigger).toMatchObject({
      type: 'form',
      inputs: { properties: { bucketName: { type: 'string', title: 'Bucket name' } }, required: ['bucketName'] },
    });
    expect(doc.steps.map((s: { id: string; type: string }) => `${s.id}:${s.type}`)).toEqual(['review:agent', 'approval:approval']);
    expect(doc.steps[0]).toMatchObject({ model: 'claude-opus-5-5', effort: 'medium', prompt: 'Review {{ inputs.bucketName }}' });
    doc.trigger.inputs.properties.region = { type: 'string', title: 'Region', enum: ['weu'] };
    fireEvent.change(json, { target: { value: JSON.stringify(doc) } });
    fireEvent.click(screen.getByLabelText('Trigger: Form submission'));
    await waitFor(() => expect(screen.getAllByDisplayValue('Region').length).toBeGreaterThan(0));

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(save).toHaveBeenCalled());
    const [id, saved] = save.mock.calls[0] as [string, Record<string, unknown>];
    expect(id).toBe('bucket');
    expect(Object.keys((saved.trigger as { inputs: { properties: object } }).inputs.properties)).toEqual(['bucketName', 'region']);
    await waitFor(() => expect(screen.queryByText('Unsaved changes')).toBeNull());
  });

  it('lists problems instead of saving a broken workflow', async () => {
    vi.spyOn(api, 'meta').mockResolvedValue(webhookMeta as never);
    const save = vi.spyOn(api, 'saveActionAt');
    render(renderPage({ identifier: 'x', title: '', invoker: { type: 'webhook' } }));
    fireEvent.click(await screen.findByLabelText('Integration: run'));
    expect(await screen.findByLabelText(/^URL/)).toBeTruthy(); // invoker form rendered from the plugin's fields
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Title is required')).toBeTruthy();
    expect(screen.getByText('Step 1 (run): "URL" is required')).toBeTruthy();
    expect(save).not.toHaveBeenCalled();
  });

  it('opens a managed workflow read-only', async () => {
    vi.spyOn(api, 'meta').mockResolvedValue({ invokers: [] } as never);
    render(renderPage({ ...draft, managed: true }));
    expect(await screen.findByText('Read-only')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add a step' })).toBeNull();
  });
});

describe('run flow view', () => {
  const step = (id: string, status: string, extra: Record<string, unknown> = {}) => ({
    id,
    name: id,
    type: 'invoke',
    needs: [],
    status,
    statusLabel: null,
    attempt: 1,
    maxAttempts: 1,
    continueOnError: false,
    output: null,
    link: null,
    message: null,
    approvals: [],
    startedAt: null,
    endedAt: null,
    ...extra,
  });
  const run = {
    id: 'r1',
    action: 'request-flow',
    actionTitle: 'Deploy',
    blueprint: null,
    entity: null,
    inputs: { env: 'prod' },
    status: 'IN_PROGRESS',
    statusLabel: null,
    link: null,
    triggeredBy: { id: 'u', name: 'Alice', email: 'a@x' },
    approvals: [],
    result: null,
    createdAt: '2026-01-01T00:00:00Z',
    startedAt: '2026-01-01T00:00:00Z',
    endedAt: null,
    logs: [{ seq: 1, at: '2026-01-01T00:00:00Z', stepId: 'build', level: 'info', message: 'compiling' }],
    steps: [step('build', 'FAILURE'), step('gate', 'WAITING_APPROVAL', { type: 'approval', needs: ['build'], canApprove: true })],
  };

  it('colours the steps, opens ?step= with its logs and shows the request', async () => {
    vi.spyOn(api, 'run').mockResolvedValue(run as never);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <MantineProvider theme={theme} env="test">
        <QueryClientProvider client={qc}>
          <MemoryRouter initialEntries={['/runs/r1?step=build']}>
            <Routes>
              <Route path="/runs/:id" element={<RunPage />} />
            </Routes>
          </MemoryRouter>
        </QueryClientProvider>
      </MantineProvider>,
    );
    await waitFor(() => expect(screen.getByLabelText('Integration: build').getAttribute('data-tone')).toBe('failure'));
    expect(screen.getByLabelText('Approval: gate').getAttribute('data-tone')).toBe('pending');
    expect(screen.getByLabelText('Trigger: Form submitted').getAttribute('data-tone')).toBe('success');
    // ?step= opens that step, with its logs.
    const drawer = await screen.findByRole('dialog');
    expect(within(drawer).getByText('compiling')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Request' }));
    expect(await screen.findByText('request-flow')).toBeTruthy();
  });
});
