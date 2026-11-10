import { useMemo, useState } from 'react';
import { ActionIcon, Badge, Button, Card, Checkbox, Grid, Group, NumberInput, Paper, Select, Stack, Table, TagsInput, Text, TextInput } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { IconArrowDown, IconArrowUp, IconPlus, IconTrash } from '@tabler/icons-react';
import { api } from '../../lib/api';
import { initialValues, SchemaForm, validateValues, type FormValues } from '../SchemaForm';
import { Empty } from '../ui';
import { PropertyValue } from '../PropertyValue';
import { MONO_INPUT } from './blocks';
import { emptyField, FIELD_NAME, FIELD_TYPES, fieldsToSchema, nameFromLabel, type FieldDraft, type FieldType } from './fields';

/** How the editor talks about fields: action form inputs, or blueprint properties. */
export interface FieldsMode {
  /** Where the value is available in templates, e.g. `inputs.<key>`. */
  templatePath: (name: string) => string;
  noun: string;
  emptyTitle: string;
  emptyHint: string;
  previewTitle: string;
  /** Blueprint properties: option colors, "hidden in tables", and a preview of how values are displayed. */
  catalog?: boolean;
}

export const ACTION_FIELDS: FieldsMode = {
  templatePath: (n) => `inputs.${n}`,
  noun: 'field',
  emptyTitle: 'No fields',
  emptyHint: 'Actions without fields run with one click.',
  previewTitle: 'Preview',
};

export const BLUEPRINT_PROPERTIES: FieldsMode = {
  templatePath: (n) => `entity.properties.${n}`,
  noun: 'property',
  emptyTitle: 'No properties',
  emptyHint: 'Entities will only have an identifier, a title, a team and relations.',
  previewTitle: 'Preview',
  catalog: true,
};

const COLORS = ['gray', 'red', 'orange', 'yellow', 'green', 'teal', 'cyan', 'blue', 'indigo', 'grape', 'pink'];

/** Fields of a form (action inputs) or properties of a blueprint, with a live preview. */
export function FieldsEditor({ fields, onChange, mode = ACTION_FIELDS }: { fields: FieldDraft[]; onChange: (f: FieldDraft[]) => void; mode?: FieldsMode }) {
  const [touchedNames, setTouchedNames] = useState<Set<string>>(() => new Set(fields.map((f) => f.id)));
  const update = (id: string, patch: Partial<FieldDraft>) => onChange(fields.map((f) => (f.id === id ? { ...f, ...patch } : f)));
  const move = (i: number, d: -1 | 1) => {
    const next = [...fields];
    [next[i], next[i + d]] = [next[i + d], next[i]];
    onChange(next);
  };
  const add = () => onChange([...fields, emptyField()]);

  return (
    <Grid gap="lg">
      <Grid.Col span={{ base: 12, md: 7 }}>
        <Stack gap="sm">
          {!fields.length && <Empty title={mode.emptyTitle}>{mode.emptyHint}</Empty>}
          {fields.map((f, i) => (
            <Card key={f.id} shadow="none" withBorder radius="lg" padding="md">
              <Group justify="space-between" mb="xs">
                <Text fz="xs" c="dimmed" fw={500}>
                  {mode.noun[0].toUpperCase() + mode.noun.slice(1)} {i + 1}
                </Text>
                <Group gap="4xs">
                  <ActionIcon variant="subtle" color="gray" disabled={i === 0} onClick={() => move(i, -1)} aria-label="Move up">
                    <IconArrowUp size={16} />
                  </ActionIcon>
                  <ActionIcon variant="subtle" color="gray" disabled={i === fields.length - 1} onClick={() => move(i, 1)} aria-label="Move down">
                    <IconArrowDown size={16} />
                  </ActionIcon>
                  <ActionIcon variant="subtle" color="red" onClick={() => onChange(fields.filter((x) => x.id !== f.id))} aria-label={`Remove ${mode.noun}`}>
                    <IconTrash size={16} />
                  </ActionIcon>
                </Group>
              </Group>
              <FieldCard
                mode={mode}
                field={f}
                autoName={!touchedNames.has(f.id)}
                onChange={(patch) => update(f.id, patch)}
                onNameTouched={() => setTouchedNames(new Set(touchedNames).add(f.id))}
              />
            </Card>
          ))}
          <Group>
            <Button variant="light" color="gray" c="var(--mantine-color-text)" leftSection={<IconPlus size={16} />} onClick={add}>
              Add a {mode.noun}
            </Button>
          </Group>
        </Stack>
      </Grid.Col>
      <Grid.Col span={{ base: 12, md: 5 }}>
        <Preview fields={fields} mode={mode} />
      </Grid.Col>
    </Grid>
  );
}

function FieldCard({
  mode,
  field: f,
  autoName,
  onChange,
  onNameTouched,
}: {
  mode: FieldsMode;
  field: FieldDraft;
  autoName: boolean;
  onChange: (p: Partial<FieldDraft>) => void;
  onNameTouched: () => void;
}) {
  const blueprints = useQuery({ queryKey: ['blueprints'], queryFn: api.blueprints, staleTime: 30_000, enabled: f.type === 'entity' });
  const hasOptions = f.type === 'choice' || f.type === 'multichoice';
  const isNumber = f.type === 'number' || f.type === 'integer';
  return (
    <Stack gap="xs">
      <Group grow align="flex-start">
        <TextInput
          label="Label"
          placeholder="Service name"
          value={f.label}
          onChange={(e) => {
            const label = e.currentTarget.value;
            onChange(autoName ? { label, name: nameFromLabel(label) } : { label });
          }}
        />
        <Select
          label="Type"
          data={FIELD_TYPES as unknown as { value: string; label: string }[]}
          value={f.type}
          allowDeselect={false}
          onChange={(t) => onChange({ type: t as FieldType, defaultValue: undefined })}
        />
      </Group>
      <Group grow align="flex-start">
        <TextInput
          label="Key"
          description={
            <>
              In templates: <code>{`{{ ${mode.templatePath(f.name || 'key')} }}`}</code>
            </>
          }
          value={f.name}
          error={f.name && !FIELD_NAME.test(f.name) ? 'Letters, digits and _' : undefined}
          onChange={(e) => {
            onNameTouched();
            onChange({ name: e.currentTarget.value });
          }}
          styles={MONO_INPUT}
        />
        <TextInput label="Help text" value={f.description} onChange={(e) => onChange({ description: e.currentTarget.value })} />
      </Group>
      {hasOptions && <TagsInput label="Options" placeholder="Type an option and press Enter" value={f.options} onChange={(options) => onChange({ options })} />}
      {f.type === 'entity' && (
        <Select
          label="Blueprint"
          searchable
          data={(blueprints.data ?? []).map((b) => ({ value: b.identifier, label: b.title }))}
          value={f.blueprint || null}
          onChange={(b) => onChange({ blueprint: b ?? '' })}
        />
      )}
      {isNumber && (
        <Group grow>
          <NumberInput label="Minimum" value={f.minimum ?? ''} onChange={(v) => onChange({ minimum: v === '' ? undefined : Number(v) })} />
          <NumberInput label="Maximum" value={f.maximum ?? ''} onChange={(v) => onChange({ maximum: v === '' ? undefined : Number(v) })} />
        </Group>
      )}
      {f.type === 'text' && (
        <TextInput
          label="Pattern (regular expression)"
          placeholder="^[a-z][a-z0-9-]{2,40}$"
          value={f.pattern}
          onChange={(e) => onChange({ pattern: e.currentTarget.value })}
          styles={MONO_INPUT}
        />
      )}
      {mode.catalog && hasOptions && f.options.length > 0 && <OptionColors field={f} onChange={onChange} />}
      <Group justify="space-between" align="flex-end">
        <DefaultInput field={f} onChange={(defaultValue) => onChange({ defaultValue })} />
        <Group gap="lg" mb="xs">
          {mode.catalog && (
            <Checkbox
              label="Hide in tables"
              checked={!!f.extra.hidden}
              onChange={(e) => onChange({ extra: { ...f.extra, hidden: e.currentTarget.checked || undefined } })}
            />
          )}
          <Checkbox label="Required" checked={f.required} onChange={(e) => onChange({ required: e.currentTarget.checked })} />
        </Group>
      </Group>
    </Stack>
  );
}

function DefaultInput({ field: f, onChange }: { field: FieldDraft; onChange: (v: unknown) => void }) {
  const v = f.defaultValue;
  if (f.type === 'boolean')
    return (
      <Select
        label="Default"
        w={160}
        data={['yes', 'no']}
        value={v === true ? 'yes' : v === false ? 'no' : null}
        onChange={(x) => onChange(x === null ? undefined : x === 'yes')}
        clearable
      />
    );
  if (f.type === 'choice')
    return <Select label="Default" w={220} data={f.options} value={v ? String(v) : null} onChange={(x) => onChange(x ?? undefined)} clearable />;
  if (f.type === 'number' || f.type === 'integer')
    return <NumberInput label="Default" w={160} value={typeof v === 'number' ? v : ''} onChange={(x) => onChange(x === '' ? undefined : Number(x))} />;
  if (['multichoice', 'tags', 'json', 'entity', 'team', 'user'].includes(f.type)) return <span />;
  return <TextInput label="Default" w={260} value={typeof v === 'string' ? v : ''} onChange={(e) => onChange(e.currentTarget.value || undefined)} />;
}

/** Badge color per option (blueprints): how values are highlighted in tables and on entity pages. */
function OptionColors({ field: f, onChange }: { field: FieldDraft; onChange: (p: Partial<FieldDraft>) => void }) {
  const colors = (f.extra.enumColors as Record<string, string> | undefined) ?? {};
  const set = (option: string, color: string | null) => {
    const next = Object.fromEntries(Object.entries({ ...colors, [option]: color ?? undefined }).filter(([o, c]) => c && f.options.includes(o)));
    onChange({ extra: { ...f.extra, enumColors: Object.keys(next).length ? next : undefined } });
  };
  return (
    <Stack gap="3xs">
      <Text fz="sm" fw={500}>
        Colors
      </Text>
      <Group gap="xs">
        {f.options.map((o) => (
          <Group key={o} gap="2xs" wrap="nowrap">
            <Badge color={colors[o] ?? 'gray'}>{o}</Badge>
            <Select
              size="xs"
              w={110}
              data={COLORS}
              value={colors[o] ?? null}
              onChange={(c) => set(o, c)}
              placeholder="gray"
              clearable
              aria-label={`Color of ${o}`}
            />
          </Group>
        ))}
      </Group>
    </Stack>
  );
}

/** The generated form, as users will see it; for blueprints also how values are displayed. */
function Preview({ fields, mode }: { fields: FieldDraft[]; mode: FieldsMode }) {
  const schema = useMemo(() => fieldsToSchema(fields), [fields]);
  const [values, setValues] = useState<FormValues>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const merged = { ...initialValues(schema), ...values };
  const names = Object.keys(schema.properties);
  return (
    <Paper p="lg" radius="xl" pos="sticky" top={0} bg="var(--surface)" shadow="none">
      <Group justify="space-between" mb="sm">
        <Text fw={600}>{mode.previewTitle}</Text>
        <Button size="compact-xs" variant="subtle" color="gray" onClick={() => setErrors(validateValues(schema, merged))}>
          Check
        </Button>
      </Group>
      {names.length ? (
        <Stack>
          {mode.catalog && (
            <Text fz="xs" c="dimmed">
              Type sample values to see how entities display them.
            </Text>
          )}
          <SchemaForm schema={schema} values={merged} onChange={setValues} errors={errors} />
          {mode.catalog && (
            <Stack gap="3xs">
              <Text fz="sm" fw={500}>
                On the entity page
              </Text>
              <Table withRowBorders={false} verticalSpacing="3xs" highlightOnHover={false}>
                <Table.Tbody>
                  {names.map((n) => (
                    <Table.Tr key={n}>
                      <Table.Td c="dimmed" fz="sm" w="40%">
                        {schema.properties[n].title ?? n}
                      </Table.Td>
                      <Table.Td>
                        <PropertyValue schema={schema.properties[n]} value={merged[n]} />
                      </Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </Stack>
          )}
        </Stack>
      ) : (
        <Text fz="sm" c="dimmed">
          The form appears here as you add {mode.noun === 'property' ? 'properties' : 'fields'}.
        </Text>
      )}
    </Paper>
  );
}
