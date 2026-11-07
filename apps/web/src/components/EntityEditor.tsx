import { useState } from 'react';
import { Alert, Button, Drawer, Group, Select, Stack, Tabs, Text, TextInput } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useQuery } from '@tanstack/react-query';
import { parse, stringify } from 'yaml';
import type { Blueprint, Entity, RelationValue } from '@asterius/shared';
import { api, errorText } from '../lib/api';
import { useAuth } from '../lib/auth';
import { CodeEditor } from './CodeEditor';
import { EntityMultiSelect, EntitySelect, initialValues, SchemaForm, validateValues, type FormValues } from './SchemaForm';

/** The editable part of an entity: what the API accepts in a PUT / POST. */
export interface EntityDraft {
  identifier: string;
  title: string;
  team: string | null;
  properties: FormValues;
  relations: Record<string, RelationValue>;
}

export const draftOf = (bp: Blueprint, e?: Entity | null): EntityDraft => ({
  identifier: e?.identifier ?? '',
  title: e?.title ?? '',
  team: e?.team ?? null,
  properties: initialValues(bp.schema, e?.properties),
  relations: e?.relations ?? {},
});

/** Drop unset values; keep properties the blueprint does not declare (a PUT replaces the entity). */
export const bodyOf = (bp: Blueprint, d: EntityDraft, existing?: Entity | null) => {
  const extra = Object.fromEntries(Object.entries(existing?.properties ?? {}).filter(([k]) => !bp.schema.properties[k]));
  const properties = Object.fromEntries(Object.entries({ ...extra, ...d.properties }).filter(([, v]) => v !== undefined && v !== null && v !== ''));
  return { identifier: d.identifier, title: d.title || undefined, team: d.team, properties, relations: d.relations };
};

/**
 * Create or edit an entity with the form generated from its blueprint (SchemaForm for the properties, pickers for
 * team and relations). The YAML tab is the advanced view of the same document.
 */
export function EntityEditor(props: { blueprint: Blueprint; entity?: Entity | null; opened: boolean; onClose: () => void; onSaved: (e: Entity) => void }) {
  return (
    <Drawer
      opened={props.opened}
      onClose={props.onClose}
      position="right"
      size="lg"
      title={<Text fw={600}>{props.entity ? `Edit ${props.entity.title}` : `New ${props.blueprint.title}`}</Text>}
    >
      {props.opened && <EditorBody {...props} />}
    </Drawer>
  );
}

function EditorBody({
  blueprint: bp,
  entity,
  onClose,
  onSaved,
}: {
  blueprint: Blueprint;
  entity?: Entity | null;
  onClose: () => void;
  onSaved: (e: Entity) => void;
}) {
  const { user, isAdmin } = useAuth();
  const teams = useQuery({ queryKey: ['teams'], queryFn: api.teams, staleTime: 60_000 });
  const myTeams = isAdmin ? (teams.data ?? []).map((t) => t.identifier) : (user?.teams ?? []).map((t) => t.identifier);
  const [draft, setDraft] = useState<EntityDraft>(() => {
    const d = draftOf(bp, entity);
    return !entity && !d.team && !isAdmin && myTeams.length === 1 ? { ...d, team: myTeams[0] } : d;
  });
  const [tab, setTab] = useState<string | null>('form');
  const [yaml, setYaml] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const patch = (p: Partial<EntityDraft>) => setDraft((d) => ({ ...d, ...p }));

  /** Leaving the YAML tab: read the text back into the form. */
  const fromYaml = (): EntityDraft | null => {
    try {
      const doc = parse(yaml) as Partial<EntityDraft> | null;
      if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new Error('The document must be a YAML mapping');
      return {
        ...draft,
        ...doc,
        identifier: entity ? draft.identifier : String(doc.identifier ?? ''),
        properties: initialValues(bp.schema, doc.properties ?? {}),
        relations: doc.relations ?? {},
      };
    } catch (e) {
      setError(`YAML: ${errorText(e)}`);
      return null;
    }
  };
  const switchTab = (t: string | null) => {
    setError(null);
    if (t === 'yaml') setYaml(stringify(bodyOf(bp, draft, entity), { lineWidth: 120 }));
    else if (tab === 'yaml') {
      const d = fromYaml();
      if (!d) return;
      setDraft(d);
    }
    setTab(t);
  };

  const save = async () => {
    setError(null);
    let d = draft;
    if (tab === 'yaml') {
      const parsed = fromYaml();
      if (!parsed) return;
      d = parsed;
    }
    const found = validateValues(bp.schema, d.properties);
    for (const [name, r] of Object.entries(bp.relations)) if (r.required && !d.relations[name]?.length) found[`relation:${name}`] = 'Required';
    setErrors(found);
    if (!entity && !d.identifier.trim()) return setError('Identifier is required');
    if (Object.keys(found).length) return setError('Fix the highlighted fields');
    setSaving(true);
    try {
      const body = bodyOf(bp, d, entity);
      const saved = entity ? await api.saveEntity(bp.identifier, entity.identifier, body) : await api.createEntity(bp.identifier, body);
      notifications.show({ color: 'green', message: `${saved.title} saved` });
      onSaved(saved);
      onClose();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setSaving(false);
    }
  };

  const setRelation = (name: string, v: RelationValue) => {
    const next = { ...draft.relations };
    if (v === null || (Array.isArray(v) && !v.length)) delete next[name];
    else next[name] = v;
    patch({ relations: next });
  };

  return (
    <Stack>
      <Tabs value={tab} onChange={switchTab}>
        <Tabs.List mb="md">
          <Tabs.Tab value="form">Form</Tabs.Tab>
          <Tabs.Tab value="yaml">YAML (advanced)</Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="form">
          <Stack gap="sm">
            <TextInput
              label="Identifier"
              description={entity ? 'Cannot be changed' : 'Unique key of the entity, e.g. my-service'}
              required
              disabled={!!entity}
              value={draft.identifier}
              onChange={(e) => patch({ identifier: e.currentTarget.value })}
            />
            <TextInput label="Title" value={draft.title} onChange={(e) => patch({ title: e.currentTarget.value })} />
            <Select
              label="Team"
              description={isAdmin ? undefined : 'You can assign the entity to one of your teams'}
              required={!isAdmin}
              clearable={isAdmin}
              searchable
              data={(teams.data ?? []).filter((t) => myTeams.includes(t.identifier)).map((t) => ({ value: t.identifier, label: t.title }))}
              value={draft.team}
              onChange={(v) => patch({ team: v })}
            />
            <SchemaForm schema={bp.schema} values={draft.properties} onChange={(properties) => patch({ properties })} errors={errors} />
            {Object.entries(bp.relations).map(([name, r]) =>
              r.many ? (
                <EntityMultiSelect
                  key={name}
                  blueprint={r.target}
                  label={r.title ?? name}
                  required={r.required}
                  error={errors[`relation:${name}`]}
                  value={
                    Array.isArray(draft.relations[name]) ? (draft.relations[name] as string[]) : draft.relations[name] ? [String(draft.relations[name])] : []
                  }
                  onChange={(v) => setRelation(name, v)}
                />
              ) : (
                <EntitySelect
                  key={name}
                  blueprint={r.target}
                  label={r.title ?? name}
                  required={r.required}
                  error={errors[`relation:${name}`]}
                  value={typeof draft.relations[name] === 'string' ? (draft.relations[name] as string) : null}
                  onChange={(v) => setRelation(name, v)}
                />
              ),
            )}
          </Stack>
        </Tabs.Panel>
        <Tabs.Panel value="yaml">
          <CodeEditor language="yaml" aria-label="YAML document" value={yaml} onChange={setYaml} minRows={16} maxRows={30} />
        </Tabs.Panel>
      </Tabs>
      {error && (
        <Alert color="red" variant="light" style={{ whiteSpace: 'pre-wrap' }}>
          {error}
        </Alert>
      )}
      <Group justify="flex-end">
        <Button variant="default" onClick={onClose}>
          Cancel
        </Button>
        <Button onClick={save} loading={saving}>
          {entity ? 'Save' : 'Create'}
        </Button>
      </Group>
    </Stack>
  );
}
