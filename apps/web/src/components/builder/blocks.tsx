import { useState } from 'react';
import {
  ActionIcon,
  Autocomplete,
  Badge,
  Button,
  Checkbox,
  Group,
  Input,
  JsonInput,
  MultiSelect,
  Select,
  Stack,
  Switch,
  TagsInput,
  Text,
  Textarea,
  TextInput,
  Tooltip,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useQuery } from '@tanstack/react-query';
import { IconPlus, IconTrash } from '@tabler/icons-react';
import type { PluginField, Subjects } from '@asterius/shared';
import { api } from '../../lib/api';

/** Small editors shared by the builders (actions today; integrations can reuse them). */

/** Monospace for the typed value only (labels keep the UI font). */
export const MONO_INPUT = { input: { fontFamily: 'var(--mantine-font-family-monospace)' } };

const asText = (v: unknown) => (v === undefined || v === null ? '' : typeof v === 'string' ? v : JSON.stringify(v));

interface Row {
  id: string;
  k: string;
  v: string;
}
let rowSeq = 0;
const rowId = () => `r${rowSeq++}`;

/** Object of string values (headers, workflow inputs, template parameters…). */
export function KeyValueEditor({
  value,
  onChange,
  keyPlaceholder = 'key',
  valuePlaceholder = 'value or {{ template }}',
}: {
  value: Record<string, unknown> | undefined;
  onChange: (v: Record<string, unknown>) => void;
  keyPlaceholder?: string;
  valuePlaceholder?: string;
}) {
  // Rows keep their order, allow a temporarily empty key while typing, and have stable ids: updates are
  // functional and target ids (never indexes), so quick successive edits never hit the wrong row.
  const [rows, setRows] = useState<Row[]>(() => Object.entries(value ?? {}).map(([k, v]) => ({ id: rowId(), k, v: asText(v) })));
  const commit = (fn: (rows: Row[]) => Row[]) =>
    setRows((prev) => {
      const next = fn(prev);
      queueMicrotask(() => onChange(Object.fromEntries(next.filter((r) => r.k.trim()).map((r) => [r.k, r.v]))));
      return next;
    });
  const edit = (id: string, patch: Partial<Row>) => commit((rs) => rs.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  return (
    <Stack gap={6}>
      {rows.map((row) => (
        <Group key={row.id} gap={6} wrap="nowrap" align="flex-start">
          <TextInput placeholder={keyPlaceholder} value={row.k} onChange={(e) => edit(row.id, { k: e.currentTarget.value })} w="35%" aria-label="Key" />
          <TextInput
            placeholder={valuePlaceholder}
            value={row.v}
            onChange={(e) => edit(row.id, { v: e.currentTarget.value })}
            style={{ flex: 1 }}
            styles={MONO_INPUT}
            aria-label="Value"
          />
          <ActionIcon variant="subtle" color="gray" size="lg" onClick={() => commit((rs) => rs.filter((r) => r.id !== row.id))} aria-label="Remove">
            <IconTrash size={16} />
          </ActionIcon>
        </Group>
      ))}
      <Group>
        <Button
          variant="subtle"
          color="gray"
          size="xs"
          leftSection={<IconPlus size={14} />}
          onClick={() => setRows((rs) => [...rs, { id: rowId(), k: '', v: '' }])}
        >
          Add
        </Button>
      </Group>
    </Stack>
  );
}

/** Roles, teams, users and the owning team: who may run / approve. */
export function SubjectsEditor({
  value,
  onChange,
  allowOwnerTeam,
  emptyMeans,
}: {
  value: Subjects | undefined;
  onChange: (s: Subjects) => void;
  allowOwnerTeam: boolean;
  emptyMeans: string;
}) {
  const teams = useQuery({ queryKey: ['teams'], queryFn: api.teams, staleTime: 60_000 });
  const users = useQuery({ queryKey: ['user-lookup'], queryFn: api.userLookup, staleTime: 60_000 });
  const v = value ?? {};
  const set = (patch: Partial<Subjects>) => {
    const next: Subjects = { ...v, ...patch };
    for (const k of Object.keys(next) as (keyof Subjects)[]) {
      const x = next[k];
      if (x === undefined || x === false || (Array.isArray(x) && !x.length)) delete next[k];
    }
    onChange(next);
  };
  const empty = !(v.roles?.length || v.teams?.length || v.users?.length || v.ownerTeam);
  const userEmails = [...new Set([...(users.data ?? []).map((u) => u.email), ...(v.users ?? [])])];
  return (
    <Stack gap="xs">
      <Group grow align="flex-start">
        <MultiSelect
          label="Roles"
          data={[...new Set(['admin', 'member', 'integration-admin', 'blueprint-owner', 'approver', ...(v.roles ?? [])])]}
          value={v.roles ?? []}
          onChange={(r) => set({ roles: r as Subjects['roles'] })}
          placeholder="Any role"
        />
        <MultiSelect
          label="Teams"
          searchable
          data={(teams.data ?? []).map((t) => ({ value: t.identifier, label: t.title }))}
          value={v.teams ?? []}
          onChange={(t) => set({ teams: t })}
          placeholder="Any team"
        />
      </Group>
      <MultiSelect label="People" searchable data={userEmails} value={v.users ?? []} onChange={(u) => set({ users: u })} placeholder="Any person" />
      {allowOwnerTeam && (
        <Checkbox label="Members of the team that owns the entity" checked={!!v.ownerTeam} onChange={(e) => set({ ownerTeam: e.currentTarget.checked })} />
      )}
      {empty && (
        <Text fz="xs" c="dimmed">
          Nobody selected: {emptyMeans}.
        </Text>
      )}
    </Stack>
  );
}

/** `${secret:NAME}` picker, free text allowed (env references, literal values for tests). */
function SecretInput({ field, value, onChange }: { field: PluginField; value: string; onChange: (v: string) => void }) {
  const secrets = useQuery({ queryKey: ['secrets'], queryFn: api.secrets, staleTime: 30_000 });
  return (
    <Autocomplete
      label={field.label}
      description={field.help ?? 'Pick a secret (Admin → Secrets) or type ${env:NAME}'}
      withAsterisk={field.required}
      placeholder="${secret:NAME}"
      data={(secrets.data ?? []).map((s) => `\${secret:${s.name}}`)}
      value={value}
      onChange={onChange}
      styles={MONO_INPUT}
    />
  );
}

/** One configuration field of a plugin (invoker), rendered by kind. */
export function PluginFieldInput({ field, value, onChange }: { field: PluginField; value: unknown; onChange: (v: unknown) => void }) {
  const blueprints = useQuery({ queryKey: ['blueprints'], queryFn: api.blueprints, staleTime: 30_000, enabled: field.kind === 'blueprint' });
  const common = { label: field.label, description: field.help, withAsterisk: field.required, placeholder: field.placeholder };
  const set = (v: unknown) => onChange(v === '' ? undefined : v);
  switch (field.kind) {
    case 'boolean':
      return <Switch label={field.label} description={field.help} checked={!!value} onChange={(e) => set(e.currentTarget.checked || undefined)} />;
    case 'select':
      return (
        <Select
          {...common}
          data={field.options ?? []}
          value={value ? String(value) : null}
          onChange={(v) => set(v ?? '')}
          clearable={!field.required}
          allowDeselect={!field.required}
        />
      );
    case 'blueprint':
      return (
        <Select
          {...common}
          searchable
          allowDeselect={!field.required}
          clearable={!field.required}
          data={(blueprints.data ?? []).map((b) => ({ value: b.identifier, label: b.title }))}
          value={value ? String(value) : null}
          onChange={(v) => set(v ?? '')}
        />
      );
    case 'secret':
      return <SecretInput field={field} value={asText(value)} onChange={set} />;
    case 'number':
      // Numbers may also be templates ("{{ inputs.replicas }}"): keep digits as numbers, anything else as text.
      return (
        <TextInput
          {...common}
          value={asText(value)}
          onChange={(e) => set(/^\d+$/.test(e.currentTarget.value) ? Number(e.currentTarget.value) : e.currentTarget.value)}
        />
      );
    case 'list':
      return (
        <TagsInput
          {...common}
          value={Array.isArray(value) ? value.map(String) : []}
          onChange={(v) => set(v.length ? v : undefined)}
          placeholder="Type and press Enter"
        />
      );
    case 'keyvalue':
      return (
        <Input.Wrapper label={field.label} description={field.help} withAsterisk={field.required}>
          <KeyValueEditor value={value as Record<string, unknown>} onChange={(v) => set(Object.keys(v).length ? v : undefined)} />
        </Input.Wrapper>
      );
    case 'json':
      return <JsonEditor {...common} value={value} onChange={set} />;
    case 'textarea':
      return <Textarea {...common} autosize minRows={2} value={asText(value)} onChange={(e) => set(e.currentTarget.value)} />;
    default:
      return (
        <TextInput
          {...common}
          value={asText(value)}
          onChange={(e) => set(e.currentTarget.value)}
          styles={asText(value).includes('{{') ? MONO_INPUT : undefined}
        />
      );
  }
}

/** JSON value editor that only reports valid JSON. */
export function JsonEditor({
  label,
  description,
  value,
  onChange,
  minRows = 3,
}: {
  label?: string;
  description?: string;
  value: unknown;
  onChange: (v: unknown) => void;
  minRows?: number;
}) {
  const [text, setText] = useState(() => (value === undefined ? '' : JSON.stringify(value, null, 2)));
  const [error, setError] = useState<string | null>(null);
  return (
    <JsonInput
      label={label}
      description={description}
      autosize
      minRows={minRows}
      maxRows={20}
      value={text}
      error={error}
      onChange={(t) => {
        setText(t);
        if (!t.trim()) {
          setError(null);
          return onChange(undefined);
        }
        try {
          onChange(JSON.parse(t));
          setError(null);
        } catch {
          setError('Invalid JSON');
        }
      }}
    />
  );
}

/** Click to copy `{{ variable }}` for templates. */
export function VariableChips({ variables }: { variables: string[] }) {
  return (
    <Group gap={6}>
      {variables.map((v) => (
        <Tooltip key={v} label="Copy">
          <Badge
            color="gray"
            style={{ cursor: 'pointer', textTransform: 'none', fontFamily: 'var(--mantine-font-family-monospace)' }}
            onClick={() => {
              void navigator.clipboard?.writeText(`{{ ${v} }}`);
              notifications.show({ message: `{{ ${v} }} copied`, autoClose: 1500 });
            }}
          >
            {v}
          </Badge>
        </Tooltip>
      ))}
    </Group>
  );
}
