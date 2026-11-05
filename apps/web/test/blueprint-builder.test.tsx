import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { BlueprintBuilder, blueprintProblems, draftsToRelations, relationsToDrafts, toBlueprintDoc } from '../src/components/builder/BlueprintBuilder';
import { schemaToFields } from '../src/components/builder/fields';
import { renderUi } from './render';

afterEach(cleanup);

describe('blueprint relations', () => {
  it('round-trip', () => {
    const rel = { system: { title: 'System', target: 'system', many: false, required: true }, dependsOn: { target: 'service', many: true, required: false } };
    expect(draftsToRelations(relationsToDrafts(rel))).toEqual(rel);
  });

  it('reports clashes and missing targets', () => {
    const doc = toBlueprintDoc({ identifier: 'service', title: 'Service' });
    const fields = schemaToFields({ properties: { tier: { type: 'integer' } } });
    const rels = [
      { id: 'a', name: 'tier', title: 'Tier', target: 'system', many: false, required: false },
      { id: 'b', name: 'owner', title: '', target: '', many: false, required: false },
      { id: 'c', name: 'owner', title: '', target: 'team', many: false, required: false },
    ];
    expect(blueprintProblems(doc, fields, rels)).toEqual([
      'Relation 1 (Tier): "tier" is already a property',
      'Relation 2: choose the blueprint it points to',
      'Relation 3: the key "owner" is used twice',
    ]);
  });
});

describe('BlueprintBuilder', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const body = url.startsWith('/api/v1/blueprints') ? [{ identifier: 'system', title: 'System', schema: { properties: {} }, relations: {} }] : [];
        return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
      }),
    );
  });

  it('builds properties and relations, keeps JSON in sync and saves', async () => {
    const onSave = vi.fn(async () => undefined);
    renderUi(
      <BlueprintBuilder isNew value={{ identifier: '', title: '', schema: { properties: {} }, relations: {} }} onSave={onSave} onClose={() => undefined} />,
    );
    fireEvent.change(await screen.findByLabelText(/^Title/), { target: { value: 'Database' } });
    expect((screen.getByLabelText(/^Identifier/) as HTMLInputElement).value).toBe('database');

    fireEvent.click(screen.getByRole('tab', { name: /Properties/ }));
    fireEvent.click(screen.getByText('Add a property'));
    fireEvent.change(screen.getByLabelText('Label'), { target: { value: 'Engine' } });
    expect(screen.getByText(/entity\.properties\.engine/)).toBeTruthy();
    expect(screen.getByText('On the entity page')).toBeTruthy();

    fireEvent.click(screen.getByRole('tab', { name: /Relations/ }));
    fireEvent.click(screen.getByText('Add a relation'));
    fireEvent.change(screen.getByLabelText('Label'), { target: { value: 'Owning system' } });
    expect((screen.getByLabelText('Key') as HTMLInputElement).value).toBe('owningSystem');

    fireEvent.click(screen.getByRole('tab', { name: /JSON/ }));
    const json = screen.getByRole('textbox') as HTMLTextAreaElement;
    const doc = JSON.parse(json.value);
    expect(doc.schema.properties).toEqual({ engine: { type: 'string', title: 'Engine' } });
    expect(doc.relations).toEqual({ owningSystem: { title: 'Owning system', target: '', many: false, required: false } });

    // Fix the target through JSON, then save.
    doc.relations.owningSystem.target = 'system';
    fireEvent.change(json, { target: { value: JSON.stringify(doc) } });
    fireEvent.click(screen.getByText('Create blueprint'));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    const [id, saved] = onSave.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(id).toBe('database');
    expect(saved).toMatchObject({ title: 'Database', relations: { owningSystem: { target: 'system' } } });
  });

  it('refuses to save an incomplete blueprint', async () => {
    const onSave = vi.fn();
    renderUi(<BlueprintBuilder isNew value={{ identifier: '', title: '' }} onSave={onSave} onClose={() => undefined} />);
    fireEvent.click(await screen.findByText('Create blueprint'));
    expect(await screen.findByText('Title is required')).toBeTruthy();
    expect(onSave).not.toHaveBeenCalled();
  });
});
