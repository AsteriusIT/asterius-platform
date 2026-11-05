import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import type { ObjectSchema } from '@asterius/shared';
import { fieldProblems, fieldsToSchema, nameFromLabel, schemaToFields } from '../src/components/builder/fields';
import { ActionBuilder, docProblems, toActionDoc } from '../src/components/builder/ActionBuilder';
import { renderUi } from './render';

afterEach(cleanup);

describe('form fields ↔ JSON Schema', () => {
  const schema: ObjectSchema = {
    properties: {
      name: { type: 'string', title: 'Name', pattern: '^[a-z]+$', minLength: 3 },
      env: { type: 'string', title: 'Environment', enum: ['dev', 'prod'], default: 'dev', enumColors: { prod: 'red' } },
      size: { type: 'integer', minimum: 1, maximum: 10 },
      notes: { type: 'string', format: 'markdown' },
      config: { type: 'string', format: 'yaml' },
      regions: { type: 'array', items: { type: 'string', enum: ['weu', 'neu'] } },
      tags: { type: 'array', items: { type: 'string' } },
      system: { type: 'string', format: 'entity', blueprint: 'system' },
      when: { type: 'string', format: 'date-time' },
      public: { type: 'boolean' },
    },
    required: ['name', 'env'],
    order: ['env', 'name'],
  };

  it('round-trips without losing unknown options', () => {
    const fields = schemaToFields(schema);
    expect(fields.map((f) => f.type)).toEqual(['choice', 'text', 'integer', 'textarea', 'textarea', 'multichoice', 'tags', 'entity', 'datetime', 'boolean']);
    const back = fieldsToSchema(fields);
    expect(back.properties).toEqual(schema.properties);
    expect(back.required).toEqual(['env', 'name']);
    expect(back.order).toEqual(['env', 'name', 'size', 'notes', 'config', 'regions', 'tags', 'system', 'when', 'public']);
  });

  it('derives keys from labels and reports problems', () => {
    expect(nameFromLabel('Owning team')).toBe('owningTeam');
    expect(nameFromLabel('Région (EU)')).toBe('regionEu');
    expect(nameFromLabel('3 replicas')).toBe('f3Replicas');
    const fields = schemaToFields({ properties: { a: { type: 'string', enum: [] }, b: { type: 'string', format: 'entity' } } });
    fields.push({ ...fields[0], id: 'x' }); // duplicate key
    expect(fieldProblems(fields)).toEqual([
      'Field 1: add at least one option',
      'Field 2: choose the blueprint of the entity',
      'Field 3: the key "a" is used twice',
      'Field 3: add at least one option',
    ]);
  });

  it('reads every definition form and checks the document before saving', () => {
    // Flat (legacy) form → a form trigger; a single invoker → a one-step workflow.
    const doc = toActionDoc({ identifier: 'Bad Id', title: '', trigger: 'day-2', invoker: { type: 'webhook' } });
    expect(doc.trigger).toEqual({ type: 'form', on: 'day-2', blueprint: null, inputs: { properties: {} }, allowed: {}, approval: { required: false } });
    expect(doc.steps).toEqual([{ id: 'run', name: '', type: 'invoke', invoker: { type: 'webhook' } }]);
    expect(doc).not.toHaveProperty('blueprint');
    const webhook = {
      type: 'webhook',
      title: 'Webhook',
      description: '',
      example: {},
      fields: [{ key: 'url', label: 'URL', kind: 'text' as const, required: true }],
    };
    expect(docProblems(doc, [], [webhook])).toEqual([
      'Identifier: lowercase letters, digits, - and _, starting with a letter',
      'Title is required',
      'Trigger: forms on an entity need a blueprint',
      'Step 1 (run): "URL" is required',
    ]);
    // A workflow without trigger nor steps is a draft: it can be saved.
    const draft = toActionDoc({ identifier: 'ok', title: 'Ok', trigger: null, steps: [] });
    expect(draft.trigger).toBeNull();
    expect(docProblems(draft, [], [webhook])).toEqual([]);
  });
});

describe('ActionBuilder', () => {
  const meta = {
    name: 'x',
    version: '0',
    authProviders: ['local'],
    allowRegistration: true,
    sources: [],
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
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const body = url.startsWith('/api/meta') ? meta : [];
        return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
      }),
    );
  });
  const blank = { identifier: '', title: '', description: '', icon: null, enabled: true, trigger: null, steps: [] };
  /** The server echoes the saved document. */
  const echo = () => vi.fn(async (_id: string, body: Record<string, unknown>) => ({ ...body, managed: false }));

  it('creates a workflow from its general settings only, then opens the editor', async () => {
    const onSave = echo();
    renderUi(<ActionBuilder isNew value={blank} onSave={onSave} onClose={() => undefined} />);
    expect(await screen.findByText('New workflow')).toBeTruthy();
    expect(screen.queryByRole('tab', { name: /Workflow/ })).toBeNull(); // no full editor yet
    fireEvent.change(screen.getByLabelText(/^Title/), { target: { value: 'Create a bucket' } });
    expect((screen.getByLabelText(/^Identifier/) as HTMLInputElement).value).toBe('create-a-bucket'); // derived from the title
    fireEvent.click(screen.getByText('Create and add steps'));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0]).toEqual([
      'create-a-bucket',
      { identifier: 'create-a-bucket', title: 'Create a bucket', description: '', icon: null, enabled: true, trigger: null, steps: [] },
    ]);

    // The editor opens on the (empty) workflow: no trigger until one is added.
    expect(await screen.findByText('Edit create-a-bucket')).toBeTruthy();
    expect(screen.getByText('Start with a trigger')).toBeTruthy();
    expect(screen.getByText(/Draft: add a trigger and a step/)).toBeTruthy();
  });

  it('builds trigger and steps node by node, keeps JSON in sync and saves the document', async () => {
    const onSave = echo();
    renderUi(<ActionBuilder isNew={false} value={{ ...blank, identifier: 'bucket', title: 'Bucket' }} onSave={onSave} onClose={() => undefined} />);

    // Trigger: a form submission with one field.
    fireEvent.click(await screen.findByLabelText('Add a trigger'));
    fireEvent.click(await screen.findByText('Form submission'));
    fireEvent.click(screen.getByText('Add a field'));
    fireEvent.change(screen.getByLabelText('Label'), { target: { value: 'Bucket name' } });
    expect((screen.getByLabelText('Key') as HTMLInputElement).value).toBe('bucketName'); // derived from the label
    fireEvent.click(screen.getByLabelText('Required'));

    // Steps, one by one: an AI agent, then an approval inserted after it.
    fireEvent.click(screen.getByRole('button', { name: 'Add a step' }));
    fireEvent.click(await screen.findByText('AI agent'));
    fireEvent.change(screen.getByLabelText(/^Prompt/), { target: { value: 'Review {{ inputs.bucketName }}' } });
    expect(screen.getByText('inputs.bucketName')).toBeTruthy(); // trigger fields are offered as variables
    fireEvent.click(screen.getByRole('button', { name: 'Add a step' }));
    fireEvent.click(await screen.findByText('Approval'));
    fireEvent.change(screen.getByLabelText(/^Run only if/), { target: { value: 'steps.review.output.text != ""' } });
    // Insert an integration call before the approval.
    fireEvent.click(screen.getByRole('button', { name: /Insert a step before Approval/ }));
    fireEvent.click(await screen.findByText('Integration'));

    fireEvent.click(screen.getByRole('tab', { name: /JSON/ }));
    const json = screen.getByRole('textbox') as HTMLTextAreaElement;
    const doc = JSON.parse(json.value);
    expect(doc.trigger).toMatchObject({
      type: 'form',
      on: 'create',
      inputs: { properties: { bucketName: { type: 'string', title: 'Bucket name' } }, required: ['bucketName'] },
    });
    expect(doc.steps.map((s: { id: string; type: string }) => `${s.id}:${s.type}`)).toEqual(['review:agent', 'call:invoke', 'approval:approval']);
    expect(doc.steps[0]).toMatchObject({ model: 'claude-opus-5-5', effort: 'medium', prompt: 'Review {{ inputs.bucketName }}' });

    // Edit in JSON, see it in the builder.
    doc.trigger.inputs.properties.region = { type: 'string', title: 'Region', enum: ['weu'] };
    fireEvent.change(json, { target: { value: JSON.stringify(doc) } });
    fireEvent.click(screen.getByRole('tab', { name: /Workflow/ }));
    fireEvent.click(screen.getByRole('button', { name: /Form submission/ }));
    expect(screen.getAllByDisplayValue('Region').length).toBeGreaterThan(0);

    fireEvent.click(screen.getByText('Save'));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    const [id, saved] = onSave.mock.calls[0];
    expect(id).toBe('bucket');
    expect(Object.keys((saved.trigger as { inputs: ObjectSchema }).inputs.properties)).toEqual(['bucketName', 'region']);
    expect(saved).not.toHaveProperty('inputs');
  });

  it('lists problems instead of saving a broken workflow', async () => {
    const onSave = vi.fn();
    renderUi(<ActionBuilder isNew={false} value={{ identifier: 'x', title: '', invoker: { type: 'webhook' } }} onSave={onSave} onClose={() => undefined} />);
    fireEvent.click(await screen.findByRole('button', { name: /^Integration/ }));
    expect(await screen.findByLabelText(/^URL/)).toBeTruthy(); // invoker form rendered from the plugin's fields
    fireEvent.click(screen.getByText('Save'));
    expect(await screen.findByText('Title is required')).toBeTruthy();
    expect(screen.getByText('Step 1 (run): "URL" is required')).toBeTruthy();
    expect(onSave).not.toHaveBeenCalled();
  });
});
