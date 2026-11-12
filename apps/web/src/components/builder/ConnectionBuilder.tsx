import {
  Alert,
  Chip,
  Group,
  Input,
  MultiSelect,
  SegmentedControl,
  Select,
  SimpleGrid,
  Stack,
  Switch,
  TagsInput,
  Text,
  Textarea,
  TextInput,
} from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { IconKey, IconPlug, IconShieldLock, IconWritingSign } from '@tabler/icons-react';
import type { AuthType, ConnectorAuthMethod, ConnectorDefinition, HttpMethod, ObjectSchema } from '@asterius/shared';
import { api } from '../../lib/api';
import { authInputs, authProblems, CREDENTIAL_HELP, methodLabel, type AuthField } from '../../lib/connectors';
import { SchemaForm, validateValues } from '../SchemaForm';
import { EntityIcon } from '../icons';
import { ICON } from '@asterius/brand';
import { Caption, Mono } from '../ui';
import { MONO_INPUT, SecretInput } from './blocks';
import { FormBuilder, identityProblems, IdentityFields, type Doc, type EditorProps, type FormContext } from './FormBuilder';

/**
 * Form editor of a connection: the definition's fields (SchemaForm), one of its auth methods (credentials are
 * references only), access and automation allow-lists, raw API allow-list; JSON / YAML views and edit conflicts
 * (If-Match) from FormBuilder.
 */

type Auth = { type: AuthType } & Record<string, unknown>;

export interface ConnectionDoc extends Doc {
  description: string;
  connector: string;
  fields: Record<string, unknown>;
  auth: Auth | null;
  access: 'read' | 'read-write';
  allowed: { workflows?: string[]; teams?: string[] };
  api?: { methods: HttpMethod[]; paths: string[] };
}

export const HTTP_METHODS: HttpMethod[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

export const toConnectionDoc = (v: Record<string, unknown>): ConnectionDoc => ({
  ...v,
  identifier: String(v.identifier ?? ''),
  title: String(v.title ?? ''),
  description: String(v.description ?? ''),
  connector: String(v.connector ?? ''),
  fields: (v.fields as Record<string, unknown>) ?? {},
  auth: (v.auth as Auth | null | undefined) ?? null,
  access: v.access === 'read-write' ? 'read-write' : 'read',
  allowed: (v.allowed as ConnectionDoc['allowed']) ?? {},
  api: v.api as ConnectionDoc['api'],
});

/** The document sent to the API: no empty values, no empty allow-lists. */
export function connectionBody(d: ConnectionDoc): Record<string, unknown> {
  const { managed: _m, createdAt: _c, updatedAt: _u, ...rest } = d as ConnectionDoc & { managed?: unknown; createdAt?: unknown; updatedAt?: unknown };
  const fields = Object.fromEntries(Object.entries(d.fields).filter(([, v]) => v !== undefined && v !== null && v !== ''));
  const auth = d.auth ? Object.fromEntries(Object.entries(d.auth).filter(([k, v]) => v !== undefined && (v !== '' || k === 'username'))) : null;
  const allowed = Object.fromEntries(Object.entries(d.allowed).filter(([, v]) => v?.length));
  const out: Record<string, unknown> = { ...rest, fields, auth, allowed };
  if (!d.api) delete out.api;
  return out;
}

/** A new connection of a definition: its example values and default method. */
export function blankConnection(def: ConnectorDefinition): Record<string, unknown> {
  const method = def.auth[0];
  const exampleAuth = def.example?.auth as Auth | undefined;
  return {
    identifier: '',
    title: '',
    description: '',
    connector: def.identifier,
    fields: { ...(def.example?.fields ?? {}) },
    auth: exampleAuth?.type ? exampleAuth : method && !def.authOptional ? { type: method.type } : null,
    access: 'read',
    allowed: {},
  };
}

const methodOf = (def: ConnectorDefinition | undefined, auth: Auth | null): ConnectorAuthMethod | undefined =>
  auth ? def?.auth.find((m) => m.type === auth.type) : undefined;

const fieldsWithDefaults = (schema: ObjectSchema, values: Record<string, unknown>) => {
  const out: Record<string, unknown> = {};
  for (const [k, p] of Object.entries(schema.properties ?? {})) out[k] = values[k] ?? p.default;
  return out;
};

export function connectionProblems(d: ConnectionDoc, def: ConnectorDefinition | undefined): string[] {
  const out = identityProblems(d);
  if (!def) return [...out, `Unknown connector "${d.connector}"`];
  for (const [k, e] of Object.entries(validateValues(def.fields, fieldsWithDefaults(def.fields, d.fields))))
    out.push(`${def.fields.properties[k]?.title ?? k}: ${e}`);
  if (!d.auth && def.auth.length && !def.authOptional) out.push('Authentication: choose a method');
  const method = methodOf(def, d.auth);
  if (d.auth && !method) out.push(`Authentication: ${def.title} does not support "${d.auth.type}"`);
  for (const [k, e] of Object.entries(authProblems(method, d.auth))) out.push(`Authentication, ${k}: ${e}`);
  if (d.api) {
    if (!d.api.methods.length) out.push('Raw API calls: allow at least one method');
    if (!d.api.paths.length) out.push('Raw API calls: list at least one path prefix');
    for (const p of d.api.paths) if (!/^\/[^?#\s]*$/.test(p)) out.push(`Raw API calls: "${p}" must start with / (no query string)`);
  }
  return out;
}

function GeneralTab(ctx: FormContext<ConnectionDoc> & { def?: ConnectorDefinition }) {
  const { doc, set, def } = ctx;
  const values = doc.fields;
  return (
    <Stack gap="md">
      {def && (
        <Group gap="sm" wrap="nowrap">
          <EntityIcon name={def.icon} size={ICON.lg} />
          <div>
            <Text fz="sm" fw={600}>
              {def.title}
            </Text>
            <Caption>{def.description}</Caption>
          </div>
        </Group>
      )}
      <IdentityFields {...ctx} placeholder={def ? `${def.title} production` : 'Connection'} />
      <Textarea label="Description" autosize minRows={2} value={doc.description} onChange={(e) => set({ description: e.currentTarget.value })} />
      {def && (
        <Input.Wrapper label="Settings" description={`The fields of the ${def.title} connector. Credentials go to Authentication.`}>
          <Stack mt="2xs">
            <SchemaForm
              schema={def.fields}
              values={values}
              errors={validateValues(def.fields, fieldsWithDefaults(def.fields, values))}
              onChange={(v) => set({ fields: v })}
            />
          </Stack>
        </Input.Wrapper>
      )}
    </Stack>
  );
}

function AuthInput({ field, value, onChange, error }: { field: AuthField; value: unknown; onChange: (v: string | undefined) => void; error?: string }) {
  const text = value === undefined || value === null ? '' : typeof value === 'string' ? value : JSON.stringify(value);
  if (field.secret)
    return (
      <SecretInput
        field={{ label: field.label, required: field.required, help: field.placeholder ? `${CREDENTIAL_HELP}. ${field.placeholder}` : undefined }}
        value={text}
        onChange={(v) => onChange(v)}
        error={error}
      />
    );
  if (field.options) return <Select label={field.label} data={field.options} value={text || null} onChange={(v) => onChange(v ?? undefined)} clearable />;
  return (
    <TextInput
      label={field.label}
      withAsterisk={field.required && !field.allowEmpty}
      placeholder={field.placeholder}
      value={text}
      error={error}
      onChange={(e) => onChange(e.currentTarget.value)}
      styles={MONO_INPUT}
    />
  );
}

const NONE = '__none__';

function AuthTab({ doc, set, def }: FormContext<ConnectionDoc> & { def?: ConnectorDefinition }) {
  if (!def) return null;
  if (!def.auth.length)
    return (
      <Alert color="gray" variant="light">
        {def.title} needs no authentication.
      </Alert>
    );
  const method = methodOf(def, doc.auth);
  const errors = authProblems(method, doc.auth);
  const options = [
    ...def.auth.map((m) => ({ value: m.type, label: methodLabel(m) })),
    ...(def.authOptional ? [{ value: NONE, label: 'No authentication' }] : []),
  ];
  const setValue = (k: string, v: string | undefined) => {
    const next = { ...doc.auth! };
    if (v === undefined) delete next[k];
    else next[k] = v;
    set({ auth: next });
  };
  return (
    <Stack gap="md">
      <Select
        label="Method"
        data={options}
        value={doc.auth?.type ?? (def.authOptional ? NONE : null)}
        allowDeselect={false}
        description={method?.description}
        onChange={(t) => set({ auth: !t || t === NONE ? null : { type: t as AuthType } })}
      />
      {method && Object.keys(method.set ?? {}).length > 0 && (
        <Input.Wrapper label="Set by the connector">
          <Stack gap="4xs" mt="3xs">
            {Object.entries(method.set).map(([k, v]) => (
              <Text key={k} fz="sm">
                <Mono>{k}</Mono>: <Mono>{typeof v === 'string' ? v || '(empty)' : JSON.stringify(v)}</Mono>
              </Text>
            ))}
          </Stack>
        </Input.Wrapper>
      )}
      {method?.type === 'header' && (
        <Input.Wrapper label="Headers sent">
          <Stack gap="4xs" mt="3xs">
            {Object.entries(method.headers ?? {}).map(([k, v]) => (
              <Text key={k} fz="sm">
                <Mono>
                  {k}: {v}
                </Mono>
              </Text>
            ))}
          </Stack>
        </Input.Wrapper>
      )}
      {method && (
        <SimpleGrid cols={{ base: 1, sm: 2 }}>
          {authInputs(method).map((f) => (
            <AuthInput key={f.key} field={f} value={doc.auth?.[f.key]} error={errors[f.key]} onChange={(v) => setValue(f.key, v)} />
          ))}
        </SimpleGrid>
      )}
      {method && authInputs(method).some((f) => f.secret) && (
        <Alert color="gray" variant="light" icon={<IconShieldLock size={ICON.md} />}>
          {CREDENTIAL_HELP}. The platform resolves them when the connection is used; values never appear in the configuration, the API or the logs.
        </Alert>
      )}
    </Stack>
  );
}

function AccessTab({ doc, set }: FormContext<ConnectionDoc>) {
  const teams = useQuery({ queryKey: ['teams'], queryFn: api.teams, staleTime: 30_000 });
  const actions = useQuery({ queryKey: ['actions'], queryFn: () => api.actions(), staleTime: 30_000 });
  const listOf = (cur: string[] | undefined, known: { value: string; label: string }[]) => [
    ...known,
    ...(cur ?? []).filter((x) => !known.some((k) => k.value === x)).map((x) => ({ value: x, label: x })),
  ];
  return (
    <Stack gap="md">
      <Input.Wrapper label="Access" description="Ingestion and read-only operations only, or also operations that change things">
        <SegmentedControl
          mt="2xs"
          display="flex"
          w="fit-content"
          data={[
            { value: 'read', label: 'Read' },
            { value: 'read-write', label: 'Read and write' },
          ]}
          value={doc.access}
          onChange={(v) => set({ access: v as ConnectionDoc['access'] })}
        />
      </Input.Wrapper>
      <SimpleGrid cols={{ base: 1, sm: 2 }}>
        <MultiSelect
          label="Workflows allowed"
          description="Empty: any workflow"
          searchable
          data={listOf(
            doc.allowed.workflows,
            (actions.data ?? []).map((a) => ({ value: a.identifier, label: a.title })),
          )}
          value={doc.allowed.workflows ?? []}
          onChange={(v) => set({ allowed: { ...doc.allowed, workflows: v } })}
        />
        <MultiSelect
          label="Teams allowed"
          description="Runs of these teams; empty: any team"
          searchable
          data={listOf(
            doc.allowed.teams,
            (teams.data ?? []).map((t) => ({ value: t.identifier, label: t.title })),
          )}
          value={doc.allowed.teams ?? []}
          onChange={(v) => set({ allowed: { ...doc.allowed, teams: v } })}
        />
      </SimpleGrid>
      <Switch
        label="Allow raw API calls from workflows"
        description="Requests the connector does not describe, limited to these methods and path prefixes"
        checked={!!doc.api}
        onChange={(e) => set({ api: e.currentTarget.checked ? { methods: ['GET'], paths: ['/'] } : undefined })}
      />
      {doc.api && (
        <Stack gap="sm">
          <Input.Wrapper label="Methods">
            <Chip.Group multiple value={doc.api.methods} onChange={(v) => set({ api: { ...doc.api!, methods: v as HttpMethod[] } })}>
              <Group gap="2xs" mt="3xs">
                {HTTP_METHODS.map((m) => (
                  <Chip key={m} value={m} size="xs">
                    {m}
                  </Chip>
                ))}
              </Group>
            </Chip.Group>
          </Input.Wrapper>
          <TagsInput
            label="Path prefixes"
            description="Relative to the base URL, e.g. /api/v2/tickets"
            value={doc.api.paths}
            onChange={(v) => set({ api: { ...doc.api!, paths: v } })}
            styles={MONO_INPUT}
          />
        </Stack>
      )}
    </Stack>
  );
}

export function ConnectionBuilder(props: EditorProps) {
  const connectors = useQuery({ queryKey: ['connectors'], queryFn: api.connectors, staleTime: 60_000 });
  const defOf = (d: ConnectionDoc) => connectors.data?.find((c) => c.identifier === d.connector);
  return (
    <FormBuilder<ConnectionDoc>
      {...props}
      size="lg"
      noun="connection"
      toDoc={toConnectionDoc}
      toBody={connectionBody}
      versioned={{
        reload: async (id) => {
          const { managed: _m, createdAt: _c, updatedAt: _u, ...rest } = await api.connection(id);
          return rest;
        },
      }}
      problems={(d) => (connectors.data ? connectionProblems(d, defOf(d)) : identityProblems(d))}
      tabs={[
        {
          value: 'general',
          label: 'General',
          icon: <IconWritingSign size={ICON.md} />,
          render: (ctx) => <GeneralTab {...ctx} def={defOf(ctx.doc)} />,
        },
        { value: 'auth', label: 'Authentication', icon: <IconKey size={ICON.md} />, render: (ctx) => <AuthTab {...ctx} def={defOf(ctx.doc)} /> },
        { value: 'access', label: 'Access', icon: <IconPlug size={ICON.md} />, render: (ctx) => <AccessTab {...ctx} /> },
      ]}
    />
  );
}
