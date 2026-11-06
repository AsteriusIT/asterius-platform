import { useState } from 'react';
import { Checkbox, JsonInput, MultiSelect, NumberInput, Select, Stack, TagsInput, Textarea, TextInput } from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { useQuery } from '@tanstack/react-query';
import type { ObjectSchema, PropertySchema } from '@asterius/shared';
import { api } from '../lib/api';

/**
 * Form generated from a JSON Schema (action inputs, entity properties). Formats map to dedicated inputs:
 * team → team picker, entity → catalog search (with `blueprint`), user → user picker, markdown → textarea,
 * date → date input, object → JSON editor.
 */

export type FormValues = Record<string, unknown>;

export const orderedFields = (schema: ObjectSchema) => {
  const keys = Object.keys(schema.properties ?? {});
  const order = schema.order ?? [];
  return [...order.filter((k) => keys.includes(k)), ...keys.filter((k) => !order.includes(k))];
};

/** Defaults declared in the schema. */
export function initialValues(schema: ObjectSchema, current: FormValues = {}): FormValues {
  const out: FormValues = {};
  for (const [k, p] of Object.entries(schema.properties ?? {})) out[k] = current[k] ?? p.default ?? (p.type === 'boolean' ? false : undefined);
  return out;
}

/** Client-side checks for immediate feedback; the server validates everything again. */
export function validateValues(schema: ObjectSchema, values: FormValues): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const k of schema.required ?? []) {
    const v = values[k];
    if (v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length)) errors[k] = 'Required';
  }
  for (const [k, p] of Object.entries(schema.properties ?? {})) {
    const v = values[k];
    if (typeof v === 'string' && v && p.pattern && !new RegExp(p.pattern).test(v)) errors[k] = p.description ?? `Must match ${p.pattern}`;
  }
  return errors;
}

export function EntitySelect(props: {
  blueprint: string;
  label: string;
  description?: string;
  value: string | null;
  onChange: (v: string | null) => void;
  error?: string;
  required?: boolean;
}) {
  const [search, setSearch] = useState('');
  const [debounced] = useDebouncedValue(search, 250);
  const q = useQuery({
    queryKey: ['entity-options', props.blueprint, debounced],
    queryFn: () => api.entities({ blueprint: props.blueprint, search: debounced, limit: 30 }),
  });
  const data = (q.data?.items ?? []).map((e) => ({ value: e.identifier, label: e.title === e.identifier ? e.identifier : `${e.title} (${e.identifier})` }));
  if (props.value && !data.some((d) => d.value === props.value)) data.unshift({ value: props.value, label: props.value });
  return (
    <Select
      label={props.label}
      description={props.description}
      required={props.required}
      error={props.error}
      searchable
      clearable
      data={data}
      value={props.value}
      onChange={props.onChange}
      onSearchChange={setSearch}
      nothingFoundMessage={q.isFetching ? 'Searching…' : 'No match'}
      filter={({ options }) => options}
    />
  );
}

function TeamSelect(props: {
  label: string;
  description?: string;
  value: string | null;
  onChange: (v: string | null) => void;
  error?: string;
  required?: boolean;
}) {
  const teams = useQuery({ queryKey: ['teams'], queryFn: api.teams, staleTime: 60_000 });
  return <Select {...props} searchable clearable data={(teams.data ?? []).map((t) => ({ value: t.identifier, label: t.title }))} />;
}

function UserSelect(props: {
  label: string;
  description?: string;
  value: string | null;
  onChange: (v: string | null) => void;
  error?: string;
  required?: boolean;
}) {
  const users = useQuery({ queryKey: ['user-lookup'], queryFn: api.userLookup, staleTime: 60_000 });
  return <Select {...props} searchable clearable data={(users.data ?? []).map((u) => ({ value: u.email, label: `${u.name} <${u.email}>` }))} />;
}

/** Several entities of one blueprint (a `many` relation). */
export function EntityMultiSelect(props: {
  blueprint: string;
  label: string;
  description?: string;
  value: string[];
  onChange: (v: string[]) => void;
  error?: string;
  required?: boolean;
}) {
  const [search, setSearch] = useState('');
  const [debounced] = useDebouncedValue(search, 250);
  const q = useQuery({
    queryKey: ['entity-options', props.blueprint, debounced],
    queryFn: () => api.entities({ blueprint: props.blueprint, search: debounced, limit: 30 }),
  });
  const data = (q.data?.items ?? []).map((e) => ({ value: e.identifier, label: e.title === e.identifier ? e.identifier : `${e.title} (${e.identifier})` }));
  for (const v of props.value) if (!data.some((d) => d.value === v)) data.unshift({ value: v, label: v });
  return (
    <MultiSelect
      label={props.label}
      description={props.description}
      required={props.required}
      error={props.error}
      searchable
      data={data}
      value={props.value}
      onChange={props.onChange}
      onSearchChange={setSearch}
      nothingFoundMessage={q.isFetching ? 'Searching…' : 'No match'}
      filter={({ options }) => options}
    />
  );
}

function Field({
  name,
  p,
  value,
  onChange,
  error,
  required,
}: {
  name: string;
  p: PropertySchema;
  value: unknown;
  onChange: (v: unknown) => void;
  error?: string;
  required: boolean;
}) {
  const common = { label: p.title ?? name, description: p.description, error, required };
  const str = (v: unknown) => (v === undefined || v === null ? '' : String(v));
  const enumData = (p.enum ?? []).map((v) => ({ value: String(v), label: String(v) }));

  if (p.type === 'boolean')
    return <Checkbox label={common.label} description={p.description} error={error} checked={!!value} onChange={(e) => onChange(e.currentTarget.checked)} />;
  if (p.enum && (p.type === 'string' || p.type === 'number' || p.type === 'integer'))
    return (
      <Select
        {...common}
        data={enumData}
        value={value === undefined || value === null ? null : String(value)}
        onChange={(v) => onChange(v === null ? undefined : p.type === 'string' ? v : Number(v))}
        clearable={!required}
      />
    );
  if (p.type === 'number' || p.type === 'integer')
    return (
      <NumberInput
        {...common}
        value={typeof value === 'number' ? value : ''}
        min={p.minimum}
        max={p.maximum}
        allowDecimal={p.type === 'number'}
        onChange={(v) => onChange(v === '' ? undefined : Number(v))}
      />
    );
  if (p.type === 'array') {
    const arr = Array.isArray(value) ? value.map(String) : [];
    if (p.items?.enum) return <MultiSelect {...common} data={p.items.enum.map(String)} value={arr} onChange={onChange} />;
    return <TagsInput {...common} value={arr} onChange={onChange} placeholder="Type and press Enter" />;
  }
  if (p.type === 'object')
    return (
      <JsonInput
        {...common}
        autosize
        minRows={3}
        formatOnBlur
        value={typeof value === 'string' ? value : value ? JSON.stringify(value, null, 2) : ''}
        onChange={(v) => {
          try {
            onChange(v ? JSON.parse(v) : undefined);
          } catch {
            onChange(v);
          }
        }}
      />
    );
  if (p.format === 'entity' && p.blueprint)
    return <EntitySelect {...common} blueprint={p.blueprint} value={value ? str(value) : null} onChange={(v) => onChange(v ?? undefined)} />;
  if (p.format === 'team') return <TeamSelect {...common} value={value ? str(value) : null} onChange={(v) => onChange(v ?? undefined)} />;
  if (p.format === 'user') return <UserSelect {...common} value={value ? str(value) : null} onChange={(v) => onChange(v ?? undefined)} />;
  if (p.format === 'markdown' || p.format === 'yaml' || p.format === 'text')
    return (
      <Textarea
        {...common}
        autosize
        minRows={3}
        value={str(value)}
        onChange={(e) => onChange(e.currentTarget.value)}
        ff={p.format === 'yaml' ? 'monospace' : undefined}
      />
    );
  const type =
    p.format === 'date' ? 'date' : p.format === 'date-time' ? 'datetime-local' : p.format === 'email' ? 'email' : p.format === 'url' ? 'url' : 'text';
  return <TextInput {...common} type={type} value={str(value)} onChange={(e) => onChange(e.currentTarget.value)} maxLength={p.maxLength} />;
}

export function SchemaForm({
  schema,
  values,
  onChange,
  errors = {},
}: {
  schema: ObjectSchema;
  values: FormValues;
  onChange: (v: FormValues) => void;
  errors?: Record<string, string>;
}) {
  const required = new Set(schema.required ?? []);
  return (
    <Stack gap="sm">
      {orderedFields(schema).map((k) => (
        <Field
          key={k}
          name={k}
          p={schema.properties[k]}
          value={values[k]}
          error={errors[k]}
          required={required.has(k)}
          onChange={(v) => onChange({ ...values, [k]: v })}
        />
      ))}
    </Stack>
  );
}
