import { useState } from 'react';
import { ActionIcon, Alert, Badge, Button, Card, Checkbox, Group, Select, SimpleGrid, Stack, Switch, Tabs, Text, Textarea, TextInput } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { IconArrowDown, IconArrowUp, IconInfoCircle, IconLink, IconListDetails, IconPlus, IconSettings, IconTrash } from '@tabler/icons-react';
import type { BlueprintRelation, EntityMigration, ObjectSchema } from '@asterius/shared';
import { api, errorText, type ImpactReport } from '../../lib/api';
import { ImpactDialog } from './ImpactDialog';
import { EntityIcon, ICON_NAMES } from '../icons';
import { Empty } from '../ui';
import { FIELD_NAME, fieldProblems, fieldsToSchema, nameFromLabel, newId, schemaToFields, type FieldDraft } from './fields';
import { BLUEPRINT_PROPERTIES, FieldsEditor } from './FieldsEditor';
import { MONO_INPUT } from './blocks';
import { BuilderFooter, BuilderModal, CodePanels, CodeTabs, ManagedNotice, ReadOnlyFieldset, slugify, useCodeView, useSave } from './shell';

/**
 * Guided editor of a blueprint (an entity type of the catalog): general settings, properties (with option colors
 * and a display preview), relations to other blueprints, plus JSON / YAML views. The document is what
 * PUT /api/v1/blueprints/:id and the configuration files accept.
 */

export interface BlueprintDoc {
  identifier: string;
  title: string;
  description: string;
  icon: string | null;
  schema: ObjectSchema;
  relations: Record<string, BlueprintRelation>;
  [k: string]: unknown;
}

export interface RelationDraft {
  id: string;
  name: string;
  title: string;
  target: string;
  many: boolean;
  required: boolean;
  onDelete: NonNullable<BlueprintRelation['onDelete']>;
  inverseTitle: string;
  requireExisting: boolean;
}

const SLUG = /^[a-z][a-z0-9_-]{0,63}$/;

export function toBlueprintDoc(v: Record<string, unknown>): BlueprintDoc {
  return {
    ...v,
    identifier: String(v.identifier ?? ''),
    title: String(v.title ?? ''),
    description: (v.description as string) ?? '',
    icon: (v.icon as string) ?? null,
    schema: (v.schema as ObjectSchema) ?? { properties: {} },
    relations: (v.relations as Record<string, BlueprintRelation>) ?? {},
  };
}

export const relationsToDrafts = (r: Record<string, BlueprintRelation>): RelationDraft[] =>
  Object.entries(r).map(([name, rel]) => ({
    id: newId(),
    name,
    title: rel.title ?? '',
    target: rel.target,
    many: !!rel.many,
    required: !!rel.required,
    onDelete: rel.onDelete ?? 'ignore',
    inverseTitle: rel.inverseTitle ?? '',
    requireExisting: !!rel.requireExisting,
  }));

export const draftsToRelations = (drafts: RelationDraft[]): Record<string, BlueprintRelation> =>
  Object.fromEntries(
    drafts
      .filter((d) => d.name)
      .map((d) => [
        d.name,
        {
          ...(d.title ? { title: d.title } : {}),
          target: d.target,
          many: d.many,
          required: d.required,
          ...(d.onDelete !== 'ignore' ? { onDelete: d.onDelete } : {}),
          ...(d.inverseTitle ? { inverseTitle: d.inverseTitle } : {}),
          ...(d.requireExisting ? { requireExisting: true } : {}),
        },
      ]),
  );

export function blueprintProblems(doc: BlueprintDoc, fields: FieldDraft[], relations: RelationDraft[]): string[] {
  const out: string[] = [];
  if (!SLUG.test(doc.identifier)) out.push('Identifier: lowercase letters, digits, - and _, starting with a letter');
  if (!doc.title.trim()) out.push('Title is required');
  out.push(...fieldProblems(fields, 'Property'));
  const props = new Set(fields.map((f) => f.name));
  const seen = new Set<string>();
  relations.forEach((r, i) => {
    const where = `Relation ${i + 1}${r.title ? ` (${r.title})` : ''}`;
    if (!FIELD_NAME.test(r.name)) out.push(`${where}: the key must start with a letter and contain only letters, digits and _`);
    else if (seen.has(r.name)) out.push(`${where}: the key "${r.name}" is used twice`);
    else if (props.has(r.name)) out.push(`${where}: "${r.name}" is already a property`);
    seen.add(r.name);
    if (!r.target) out.push(`${where}: choose the blueprint it points to`);
  });
  return out;
}

export function BlueprintBuilder(props: {
  value: Record<string, unknown> | null;
  isNew: boolean;
  readOnly?: boolean;
  onSave: (identifier: string, body: Record<string, unknown>) => Promise<unknown>;
  onClose: () => void;
}) {
  const title = props.isNew ? 'New blueprint' : `${props.readOnly ? 'View' : 'Edit'} ${String(props.value?.identifier)}`;
  return (
    <BuilderModal opened={!!props.value} onClose={props.onClose} title={title}>
      {props.value && <Builder {...props} value={props.value} />}
    </BuilderModal>
  );
}

function Builder({
  value,
  isNew,
  readOnly,
  onSave,
  onClose,
}: {
  value: Record<string, unknown>;
  isNew: boolean;
  readOnly?: boolean;
  onSave: (identifier: string, body: Record<string, unknown>) => Promise<unknown>;
  onClose: () => void;
}) {
  const initial = toBlueprintDoc(value);
  const [doc, setDoc] = useState<BlueprintDoc>(initial);
  const [fields, setFields] = useState<FieldDraft[]>(() => schemaToFields(initial.schema));
  const [relations, setRelations] = useState<RelationDraft[]>(() => relationsToDrafts(initial.relations));
  const [tab, setTab] = useState<string | null>('general');
  const [generation, setGeneration] = useState(0);
  const [idTouched, setIdTouched] = useState(!isNew || !!initial.identifier);
  const entityCount = typeof value.entityCount === 'number' ? value.entityCount : 0;

  const set = (patch: Partial<BlueprintDoc>) => setDoc((d) => ({ ...d, ...patch }));
  const body = (): Record<string, unknown> => {
    const { entityCount: _count, ...rest } = doc as BlueprintDoc & { entityCount?: unknown };
    return { ...rest, schema: fieldsToSchema(fields), relations: draftsToRelations(relations) };
  };
  const code = useCodeView({
    body,
    replace: (parsed) => {
      const next = toBlueprintDoc(parsed);
      if (!isNew) next.identifier = doc.identifier;
      setDoc(next);
      setFields(schemaToFields(next.schema));
      setRelations(relationsToDrafts(next.relations));
      setGeneration((g) => g + 1);
    },
  });
  const saver = useSave(() => onSave(doc.identifier, body()), onClose);
  const [impact, setImpact] = useState<ImpactReport | null>(null);
  const save = async () => {
    const found = blueprintProblems(doc, fields, relations);
    if (code.error && (tab === 'json' || tab === 'yaml')) found.unshift(`${tab.toUpperCase()}: ${code.error}`);
    if (found.length || isNew || entityCount === 0) return void saver.save(found);
    // Existing entities: check them against the new definition first.
    try {
      const report = await api.blueprintImpact(doc.identifier, body());
      if (report.invalid > 0) return setImpact(report);
    } catch {
      // the check is advisory: saving reports real problems
    }
    void saver.save([]);
  };
  const migrateAndSave = async (migrations: EntityMigration[]) => {
    setImpact(null);
    try {
      await api.migrateBlueprint(doc.identifier, migrations);
    } catch (e) {
      return void saver.save([`Migration failed: ${errorText(e)}`]).then(() => undefined);
    }
    void saver.save([]);
  };

  return (
    <Stack>
      {readOnly && <ManagedNotice />}
      {!isNew && !readOnly && entityCount > 0 && (
        <Alert color="blue" variant="light" icon={<IconInfoCircle size={18} />}>
          {entityCount} entities use this blueprint. Before saving, they are checked against the new definition and you can migrate them (rename or remove a
          property, set a default). Values of removed properties stay visible on entity pages until rewritten.
        </Alert>
      )}
      <Tabs
        value={tab}
        onChange={(t) => {
          code.open(t);
          setTab(t);
        }}
        keepMounted={false}
      >
        <Tabs.List mb="md">
          <Tabs.Tab value="general" leftSection={<IconSettings size={16} />}>
            General
          </Tabs.Tab>
          <Tabs.Tab
            value="properties"
            leftSection={<IconListDetails size={16} />}
            rightSection={fields.length ? <Badge size="xs">{fields.length}</Badge> : undefined}
          >
            Properties
          </Tabs.Tab>
          <Tabs.Tab
            value="relations"
            leftSection={<IconLink size={16} />}
            rightSection={relations.length ? <Badge size="xs">{relations.length}</Badge> : undefined}
          >
            Relations
          </Tabs.Tab>
          <CodeTabs />
        </Tabs.List>

        <ReadOnlyFieldset readOnly={readOnly} key={generation}>
          <Tabs.Panel value="general">
            <Stack gap="md">
              <SimpleGrid cols={{ base: 1, sm: 2 }}>
                <TextInput
                  label="Title"
                  withAsterisk
                  placeholder="Database"
                  value={doc.title}
                  onChange={(e) => {
                    const t = e.currentTarget.value;
                    set(isNew && !idTouched ? { title: t, identifier: slugify(t) } : { title: t });
                  }}
                />
                <TextInput
                  label="Identifier"
                  withAsterisk
                  description={isNew ? 'From the title; used in URLs and the API, cannot be changed later' : 'Cannot be changed'}
                  disabled={!isNew}
                  placeholder="database"
                  value={doc.identifier}
                  onChange={(e) => {
                    setIdTouched(true);
                    set({ identifier: e.currentTarget.value });
                  }}
                  error={doc.identifier && !SLUG.test(doc.identifier) ? 'lowercase, digits, - and _' : undefined}
                  styles={MONO_INPUT}
                />
              </SimpleGrid>
              <Textarea
                label="Description"
                description="Markdown; shown at the top of the catalog page"
                autosize
                minRows={2}
                value={doc.description}
                onChange={(e) => set({ description: e.currentTarget.value })}
              />
              <SimpleGrid cols={{ base: 1, sm: 2 }}>
                <Select
                  label="Icon"
                  description="Shown in the navigation and on entity pages"
                  searchable
                  clearable
                  data={ICON_NAMES}
                  value={doc.icon}
                  onChange={(i) => set({ icon: i })}
                  leftSection={<EntityIcon name={doc.icon} size={16} />}
                  renderOption={({ option }) => (
                    <Group gap="xs">
                      <EntityIcon name={option.value} size={16} />
                      {option.label}
                    </Group>
                  )}
                />
              </SimpleGrid>
            </Stack>
          </Tabs.Panel>

          <Tabs.Panel value="properties">
            <FieldsEditor
              fields={fields}
              onChange={(f) => {
                setFields(f);
                set({ schema: fieldsToSchema(f) });
              }}
              mode={BLUEPRINT_PROPERTIES}
            />
          </Tabs.Panel>

          <Tabs.Panel value="relations">
            <RelationsEditor relations={relations} onChange={setRelations} self={doc.identifier} selfTitle={doc.title} />
          </Tabs.Panel>
        </ReadOnlyFieldset>

        <CodePanels view={code} readOnly={readOnly} />
      </Tabs>
      {impact && (
        <ImpactDialog
          key={impact.total + impact.invalid}
          blueprint={doc.identifier}
          body={body()}
          report={impact}
          onCancel={() => setImpact(null)}
          onSaveAnyway={() => {
            setImpact(null);
            void saver.save([]);
          }}
          onMigrate={(m) => void migrateAndSave(m)}
        />
      )}
      <BuilderFooter
        problems={saver.problems}
        readOnly={readOnly}
        saving={saver.saving}
        saveLabel={isNew ? 'Create blueprint' : 'Save'}
        onSave={save}
        onClose={onClose}
      />
    </Stack>
  );
}

/** Links to other blueprints (or this one): one entity or many, optional or required. */
function RelationsEditor({
  relations,
  onChange,
  self,
  selfTitle,
}: {
  relations: RelationDraft[];
  onChange: (r: RelationDraft[]) => void;
  self: string;
  selfTitle: string;
}) {
  const blueprints = useQuery({ queryKey: ['blueprints'], queryFn: api.blueprints, staleTime: 30_000 });
  const [touched, setTouched] = useState<Set<string>>(() => new Set(relations.map((r) => r.id)));
  const targets = (blueprints.data ?? []).map((b) => ({ value: b.identifier, label: b.identifier === self ? `${b.title} (this blueprint)` : b.title }));
  if (self && !targets.some((t) => t.value === self)) targets.unshift({ value: self, label: `${selfTitle || self} (this blueprint)` });
  const update = (id: string, patch: Partial<RelationDraft>) => onChange(relations.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  const move = (i: number, d: -1 | 1) => {
    const next = [...relations];
    [next[i], next[i + d]] = [next[i + d], next[i]];
    onChange(next);
  };

  return (
    <Stack gap="sm">
      <Text fz="sm" c="dimmed">
        Relations link entities together (a service belongs to a system, depends on other services…). They appear on both entity pages: as links on one side, as
        “Referenced by” on the other. Targets that are not in the catalog yet are kept and shown as missing.
      </Text>
      {!relations.length && <Empty title="No relations">Add one to link entities of this blueprint to others.</Empty>}
      {relations.map((r, i) => (
        <Card key={r.id} shadow="none" withBorder radius="lg" padding="md">
          <Group justify="space-between" mb="xs">
            <Text fz="xs" c="dimmed" fw={500}>
              Relation {i + 1}
            </Text>
            <Group gap={2}>
              <ActionIcon variant="subtle" color="gray" disabled={i === 0} onClick={() => move(i, -1)} aria-label="Move up">
                <IconArrowUp size={16} />
              </ActionIcon>
              <ActionIcon variant="subtle" color="gray" disabled={i === relations.length - 1} onClick={() => move(i, 1)} aria-label="Move down">
                <IconArrowDown size={16} />
              </ActionIcon>
              <ActionIcon variant="subtle" color="red" onClick={() => onChange(relations.filter((x) => x.id !== r.id))} aria-label="Remove relation">
                <IconTrash size={16} />
              </ActionIcon>
            </Group>
          </Group>
          <Stack gap="xs">
            <SimpleGrid cols={{ base: 1, sm: 3 }}>
              <TextInput
                label="Label"
                placeholder="Depends on"
                value={r.title}
                onChange={(e) => {
                  const t = e.currentTarget.value;
                  update(r.id, touched.has(r.id) ? { title: t } : { title: t, name: nameFromLabel(t) });
                }}
              />
              <TextInput
                label="Key"
                description={
                  <>
                    In templates: <code>{`{{ entity.relations.${r.name || 'key'} }}`}</code>
                  </>
                }
                value={r.name}
                error={r.name && !FIELD_NAME.test(r.name) ? 'Letters, digits and _' : undefined}
                onChange={(e) => {
                  setTouched(new Set(touched).add(r.id));
                  update(r.id, { name: e.currentTarget.value });
                }}
                styles={MONO_INPUT}
              />
              <Select
                label="Points to"
                searchable
                data={targets}
                value={r.target || null}
                onChange={(t) => update(r.id, { target: t ?? '' })}
                allowDeselect={false}
              />
            </SimpleGrid>
            <Group gap="xl">
              <Switch label="Many (a list of entities)" checked={r.many} onChange={(e) => update(r.id, { many: e.currentTarget.checked })} />
              <Checkbox label="Required" checked={r.required} onChange={(e) => update(r.id, { required: e.currentTarget.checked })} />
              <Checkbox
                label="Target must exist"
                description="For entities written by hand (UI, API)"
                checked={r.requireExisting}
                onChange={(e) => update(r.id, { requireExisting: e.currentTarget.checked })}
              />
            </Group>
            <SimpleGrid cols={{ base: 1, sm: 2 }}>
              <Select
                label="When the target is deleted"
                data={[
                  { value: 'ignore', label: 'Keep the reference (shown as missing)' },
                  { value: 'detach', label: 'Remove the reference' },
                  { value: 'cascade', label: 'Delete this entity too' },
                  { value: 'restrict', label: 'Refuse the deletion' },
                ]}
                value={r.onDelete}
                onChange={(v) => update(r.id, { onDelete: (v as RelationDraft['onDelete']) ?? 'ignore' })}
                allowDeselect={false}
              />
              <TextInput
                label="Reverse label"
                description="How the target's page names these entities"
                placeholder="Used by"
                value={r.inverseTitle}
                onChange={(e) => update(r.id, { inverseTitle: e.currentTarget.value })}
              />
            </SimpleGrid>
          </Stack>
        </Card>
      ))}
      <Group>
        <Button
          variant="light"
          color="gray"
          c="var(--mantine-color-text)"
          leftSection={<IconPlus size={16} />}
          onClick={() =>
            onChange([
              ...relations,
              { id: newId(), name: '', title: '', target: '', many: false, required: false, onDelete: 'ignore', inverseTitle: '', requireExisting: false },
            ])
          }
        >
          Add a relation
        </Button>
      </Group>
    </Stack>
  );
}
