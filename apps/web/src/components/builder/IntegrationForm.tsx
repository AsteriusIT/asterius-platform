import { useState } from 'react';
import { Alert, Button, Group, Input, MultiSelect, NumberInput, Select, SimpleGrid, Stack, Switch, Text, TextInput } from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { useQuery } from '@tanstack/react-query';
import { IconPlugConnected, IconPlus, IconTrash } from '@tabler/icons-react';
import type { PluginInfo } from '@asterius/shared';
import { api, errorText } from '../../lib/api';
import { useAppMutation } from '../../lib/queryClient';
import { JsonEditor, KeyValueEditor, MONO_INPUT, PluginFieldInput } from './blocks';
import type { Doc } from './FormEditor';
import { JsonBlock } from '../CodeEditor';

interface Mapping {
  kind?: string;
  filter?: string;
  items?: string;
  delete?: string;
  merge?: boolean;
  entity: { blueprint: string; identifier: string; title?: string; team?: string; properties?: Record<string, string>; relations?: Record<string, string> };
}

const blankMapping = (kind: string): Mapping => ({ kind, entity: { blueprint: '', identifier: '', properties: {} } });

/** Live preview of one mapping against a sample item (server-side JSONata, nothing written). */
export function MappingPreview({ mapping, item }: { mapping: Mapping; item: unknown }) {
  const [debounced] = useDebouncedValue(JSON.stringify({ mapping, item }), 600);
  const ready = !!mapping.entity.blueprint && !!mapping.entity.identifier && item !== undefined;
  const q = useQuery({
    queryKey: ['mapping-preview', debounced],
    queryFn: () => api.previewMapping(JSON.parse(debounced) as { mapping: unknown; item: unknown }),
    enabled: ready,
    retry: false,
  });
  if (!ready)
    return (
      <Text fz="xs" c="dimmed">
        Pick a blueprint and an identifier expression, and test the connection to preview against a real item.
      </Text>
    );
  if (q.error)
    return (
      <Text fz="xs" c="red" role="alert">
        {errorText(q.error)}
      </Text>
    );
  if (!q.data) return null;
  return (
    <div>
      <Text fz="xs" c="dimmed">
        Preview ({q.data.skipped ? 'item skipped by the filter' : `${q.data.mapped.length} entity`})
      </Text>
      {q.data.mapped.length > 0 && <JsonBlock value={q.data.mapped} aria-label="Mapping preview" />}
    </div>
  );
}

export function IntegrationForm({ doc, patch, isNew }: { doc: Doc; patch: (p: Doc) => void; isNew: boolean }) {
  const meta = useQuery({ queryKey: ['meta'], queryFn: api.meta, staleTime: Infinity });
  const blueprints = useQuery({ queryKey: ['blueprints'], queryFn: api.blueprints, staleTime: 30_000 });
  const sources = meta.data?.sources ?? [];
  const type = String(doc.type ?? '');
  const source: PluginInfo | undefined = sources.find((s) => s.type === type);
  const config = (doc.config ?? {}) as Record<string, unknown>;
  const mappings = (doc.mappings ?? []) as Mapping[];
  const kinds = source?.kinds?.length ? source.kinds : ['item'];
  const [sample, setSample] = useState<unknown[]>([]);
  const [sampleIndex, setSampleIndex] = useState(0);

  const test = useAppMutation({
    mutationFn: () => api.testIntegration({ type, config, kind: mappings[0]?.kind ?? kinds[0] }),
    onSuccess: (r) => {
      setSample(r.sample);
      setSampleIndex(0);
    },
  });
  const setMapping = (i: number, p: Partial<Mapping>) => patch({ mappings: mappings.map((m, j) => (j === i ? { ...m, ...p } : m)) });

  return (
    <Stack gap="md">
      <SimpleGrid cols={{ base: 1, sm: 2 }}>
        <TextInput
          label="Identifier"
          value={String(doc.identifier ?? '')}
          disabled={!isNew}
          onChange={(e) => patch({ identifier: e.currentTarget.value })}
          styles={MONO_INPUT}
        />
        <TextInput label="Title" value={String(doc.title ?? '')} onChange={(e) => patch({ title: e.currentTarget.value })} />
        <Select
          label="Type"
          data={sources.map((s) => ({ value: s.type, label: s.title }))}
          value={type || null}
          allowDeselect={false}
          description={source?.description}
          onChange={(t) => {
            const next = sources.find((s) => s.type === t);
            // A new type starts from its example configuration.
            patch({ type: t, config: (next?.example as { config?: Record<string, unknown> } | undefined)?.config ?? {} });
          }}
        />
        <NumberInput
          label="Sync every (minutes)"
          description="0: manual only"
          min={0}
          max={10080}
          disabled={type === 'webhook'}
          value={typeof doc.intervalMinutes === 'number' ? doc.intervalMinutes : 60}
          onChange={(v) => patch({ intervalMinutes: typeof v === 'number' ? v : 0 })}
        />
      </SimpleGrid>
      <Group>
        <Switch label="Enabled" checked={doc.enabled !== false} onChange={(e) => patch({ enabled: e.currentTarget.checked })} />
        <Switch label="Delete entities no longer seen" checked={!!doc.deleteMissing} onChange={(e) => patch({ deleteMissing: e.currentTarget.checked })} />
      </Group>

      <Input.Wrapper label="Connection">
        <Stack gap="sm" mt={4}>
          {source?.fields?.length ? (
            <SimpleGrid cols={{ base: 1, sm: 2 }}>
              {source.fields.map((f) => (
                <PluginFieldInput
                  key={f.key}
                  field={f}
                  value={config[f.key]}
                  onChange={(v) => {
                    const next = { ...config };
                    if (v === undefined) delete next[f.key];
                    else next[f.key] = v;
                    patch({ config: next });
                  }}
                />
              ))}
            </SimpleGrid>
          ) : (
            <JsonEditor label="Configuration (JSON)" value={config} onChange={(v) => patch({ config: (v ?? {}) as Record<string, unknown> })} minRows={5} />
          )}
          <Group>
            <Button
              size="xs"
              variant="default"
              leftSection={<IconPlugConnected size={14} />}
              loading={test.isPending}
              disabled={!type}
              onClick={() => test.mutate()}
            >
              Test connection
            </Button>
            {test.data &&
              (test.data.ok ? (
                <Text fz="xs" c="green">
                  Connected · {test.data.sample.length} sample item{test.data.sample.length === 1 ? '' : 's'} {test.data.note ?? ''}
                </Text>
              ) : (
                <Text fz="xs" c="red" role="alert">
                  {test.data.error}
                </Text>
              ))}
          </Group>
        </Stack>
      </Input.Wrapper>

      <Input.Wrapper label="Mappings" description="JSONata expressions evaluated against each item of the source">
        <Stack gap="md" mt={4}>
          {sample.length > 1 && (
            <Select
              size="xs"
              label="Preview with sample item"
              data={sample.map((_, i) => ({ value: String(i), label: `Item ${i + 1}` }))}
              value={String(sampleIndex)}
              allowDeselect={false}
              onChange={(v) => setSampleIndex(Number(v))}
              w={200}
            />
          )}
          {mappings.map((m, i) => (
            <Alert key={i} variant="outline" color="gray" p="sm" aria-label={`Mapping ${i + 1}`}>
              <Stack gap="xs">
                <Group justify="space-between">
                  <Text fz="sm" fw={500}>
                    Mapping {i + 1}
                  </Text>
                  <Button
                    size="compact-xs"
                    variant="subtle"
                    color="red"
                    leftSection={<IconTrash size={14} />}
                    onClick={() => patch({ mappings: mappings.filter((_, j) => j !== i) })}
                  >
                    Remove
                  </Button>
                </Group>
                <SimpleGrid cols={{ base: 1, sm: 3 }}>
                  <Select
                    label="Kind"
                    data={kinds}
                    value={m.kind ?? kinds[0]}
                    allowDeselect={false}
                    onChange={(v) => setMapping(i, { kind: v ?? undefined })}
                  />
                  <Select
                    label="Blueprint"
                    searchable
                    data={(blueprints.data ?? []).map((b) => ({ value: b.identifier, label: b.title }))}
                    value={m.entity.blueprint || null}
                    onChange={(v) => setMapping(i, { entity: { ...m.entity, blueprint: v ?? '' } })}
                  />
                  <TextInput
                    label="Only if"
                    placeholder="always"
                    value={m.filter ?? ''}
                    onChange={(e) => setMapping(i, { filter: e.currentTarget.value || undefined })}
                    styles={MONO_INPUT}
                  />
                </SimpleGrid>
                <SimpleGrid cols={{ base: 1, sm: 3 }}>
                  <TextInput
                    label="Identifier"
                    placeholder="e.g. code"
                    withAsterisk
                    value={m.entity.identifier}
                    onChange={(e) => setMapping(i, { entity: { ...m.entity, identifier: e.currentTarget.value } })}
                    styles={MONO_INPUT}
                  />
                  <TextInput
                    label="Title"
                    value={m.entity.title ?? ''}
                    onChange={(e) => setMapping(i, { entity: { ...m.entity, title: e.currentTarget.value || undefined } })}
                    styles={MONO_INPUT}
                  />
                  <TextInput
                    label="Team"
                    value={m.entity.team ?? ''}
                    onChange={(e) => setMapping(i, { entity: { ...m.entity, team: e.currentTarget.value || undefined } })}
                    styles={MONO_INPUT}
                  />
                </SimpleGrid>
                <Input.Wrapper label="Properties" description="property → expression">
                  <KeyValueEditor
                    value={m.entity.properties}
                    onChange={(v) => setMapping(i, { entity: { ...m.entity, properties: v as Record<string, string> } })}
                    keyPlaceholder="property"
                    valuePlaceholder="JSONata expression"
                  />
                </Input.Wrapper>
                <Input.Wrapper label="Relations" description="relation → expression returning identifiers">
                  <KeyValueEditor
                    value={m.entity.relations}
                    onChange={(v) => setMapping(i, { entity: { ...m.entity, relations: v as Record<string, string> } })}
                    keyPlaceholder="relation"
                    valuePlaceholder="JSONata expression"
                  />
                </Input.Wrapper>
                <MultiSelect
                  size="xs"
                  label="Options"
                  data={[{ value: 'merge', label: 'Merge properties instead of replacing' }]}
                  value={m.merge ? ['merge'] : []}
                  onChange={(v) => setMapping(i, { merge: v.includes('merge') })}
                />
                <MappingPreview mapping={m} item={sample[sampleIndex]} />
              </Stack>
            </Alert>
          ))}
          <Group>
            <Button size="xs" variant="default" leftSection={<IconPlus size={14} />} onClick={() => patch({ mappings: [...mappings, blankMapping(kinds[0])] })}>
              Add a mapping
            </Button>
          </Group>
        </Stack>
      </Input.Wrapper>
    </Stack>
  );
}
