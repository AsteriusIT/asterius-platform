import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import type { ObjectSchema } from '@asterius/shared';
import { Route, Routes, useParams } from 'react-router';
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

describe('New workflow dialog', () => {
  const blank = { identifier: '', title: '', description: '', icon: null, enabled: true, trigger: null, steps: [] };

  function Editor() {
    return <p>editor of {useParams().id}</p>;
  }

  it('creates a workflow from its general settings only, then opens the editor page', async () => {
    const onSave = vi.fn(async (_id: string, body: Record<string, unknown>) => ({ ...body, managed: false }));
    renderUi(
      <Routes>
        <Route path="/" element={<ActionBuilder isNew value={blank} onSave={onSave} onClose={() => undefined} />} />
        <Route path="/admin/actions/:id" element={<Editor />} />
      </Routes>,
    );
    expect(await screen.findByText('New workflow')).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/^Title/), { target: { value: 'Create a bucket' } });
    expect((screen.getByLabelText(/^Identifier/) as HTMLInputElement).value).toBe('create-a-bucket'); // derived from the title
    fireEvent.click(screen.getByText('Create and add steps'));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0]).toEqual([
      'create-a-bucket',
      { identifier: 'create-a-bucket', title: 'Create a bucket', description: '', icon: null, enabled: true, trigger: null, steps: [] },
    ]);
    expect(await screen.findByText('editor of create-a-bucket')).toBeTruthy();
  });
});
