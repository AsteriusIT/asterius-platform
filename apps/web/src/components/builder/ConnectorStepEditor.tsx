import { Alert, Badge, Button, Code, Group, Input, SegmentedControl, Select, Stack, Text, TextInput } from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { useQuery } from '@tanstack/react-query';
import { IconWand } from '@tabler/icons-react';
import type { InvokerConfig, StepConnection } from '@asterius/shared';
import { api, errorText } from '../../lib/api';
import { useCan } from '../../lib/auth';
import { entityPrefill, operationFields, previewInputs } from '../../lib/connectorSteps';
import { CodeBlock } from '../CodeEditor';
import { EntityIcon } from '../icons';
import { ICON } from '../iconScale';
import { Caption, SurfaceBox } from '../ui';
import { JsonEditor, KeyValueEditor, MONO_INPUT, PluginFieldInput } from './blocks';

/**
 * Settings of an integration step that goes through a connection: an operation of the connection's connector
 * (`connector` invoker: connection → operation → inputs, with a preview of the request) or, for admins, a raw API call
 * (`connector-api`: method, path, query, body) limited by the connection's allow-list.
 */
export function ConnectorStepEditor({
  invoker,
  onChange,
  blueprint,
  onEntity,
}: {
  invoker: InvokerConfig;
  onChange: (invoker: InvokerConfig) => void;
  /** The trigger's blueprint (day-2 workflows): operations of that kind can be prefilled from the entity. */
  blueprint: string | null;
  onEntity: boolean;
}) {
  const isAdmin = useCan()('admin');
  const conns = useQuery({ queryKey: ['step-connections'], queryFn: api.connectionsForSteps, staleTime: 30_000 });
  const raw = invoker.type === 'connector-api';
  const conn = conns.data?.find((c) => c.identifier === invoker.connection);
  const set = (patch: Record<string, unknown>) => {
    const next: InvokerConfig = { ...invoker, ...patch };
    for (const [k, v] of Object.entries(patch)) if (v === undefined) delete next[k];
    onChange(next);
  };
  const connectionOptions = (conns.data ?? []).map((c) => ({
    value: c.identifier,
    label: `${c.title} (${c.connector.title})`,
    disabled: raw && !c.api,
  }));
  return (
    <Stack gap="sm">
      {(isAdmin || raw) && (
        <SegmentedControl
          size="xs"
          value={raw ? 'raw' : 'operation'}
          onChange={(m) =>
            onChange(
              m === 'raw'
                ? { type: 'connector-api', connection: invoker.connection, method: 'GET', path: '' }
                : { type: 'connector', connection: invoker.connection },
            )
          }
          data={[
            { value: 'operation', label: 'Operation' },
            { value: 'raw', label: 'API call (admins)' },
          ]}
        />
      )}
      {conns.error && <Alert color="red">{errorText(conns.error)}</Alert>}
      <Select
        label="Connection"
        withAsterisk
        searchable
        placeholder={conns.isPending ? 'Loading…' : 'Choose a connection'}
        data={connectionOptions}
        value={typeof invoker.connection === 'string' ? invoker.connection : null}
        onChange={(v) => v && set(raw ? { connection: v } : { connection: v, operation: undefined, inputs: undefined })}
        renderOption={({ option }) => {
          const c = conns.data?.find((x) => x.identifier === option.value);
          return c ? <ConnectionOption c={c} raw={raw} /> : option.label;
        }}
        leftSection={conn ? <EntityIcon name={conn.connector.icon ?? 'plug'} size={ICON.md} /> : undefined}
        description={
          conn ? (
            <>
              {conn.connector.title} · {conn.access === 'read' ? 'read-only' : 'read-write'}
              {conn.allowed.workflows?.length || conn.allowed.teams?.length ? ' · restricted to some workflows / teams' : ''}
            </>
          ) : raw ? (
            'Only connections that allow raw API calls can be used.'
          ) : undefined
        }
      />
      {conn && !raw && <OperationEditor conn={conn} invoker={invoker} set={set} blueprint={blueprint} onEntity={onEntity} />}
      {conn && raw && <RawCallEditor conn={conn} invoker={invoker} set={set} />}
    </Stack>
  );
}

function ConnectionOption({ c, raw }: { c: StepConnection; raw: boolean }) {
  return (
    <Group gap="xs" wrap="nowrap" miw={0}>
      <EntityIcon name={c.connector.icon ?? 'plug'} size={ICON.md} />
      <Stack gap="4xs" miw={0}>
        <Text fz="sm">{c.title}</Text>
        <Caption>
          {c.connector.title} · {c.access === 'read' ? 'read-only' : 'read-write'}
          {raw && !c.api ? ' · no raw calls allowed' : ''}
        </Caption>
      </Stack>
    </Group>
  );
}

function OperationEditor({
  conn,
  invoker,
  set,
  blueprint,
  onEntity,
}: {
  conn: StepConnection;
  invoker: InvokerConfig;
  set: (patch: Record<string, unknown>) => void;
  blueprint: string | null;
  onEntity: boolean;
}) {
  const op = conn.operations.find((o) => o.name === invoker.operation);
  const inputs = (invoker.inputs as Record<string, unknown> | undefined) ?? {};
  const setInput = (k: string, v: unknown) => {
    const next = { ...inputs };
    if (v === undefined) delete next[k];
    else next[k] = v;
    set({ inputs: Object.keys(next).length ? next : undefined });
  };
  const day2 = !!op && onEntity && !!blueprint && op.blueprints.includes(blueprint);
  const bp = useQuery({ queryKey: ['blueprint', blueprint], queryFn: () => api.blueprint(blueprint!), enabled: day2 });
  return (
    <Stack gap="sm">
      <Select
        label="Operation"
        withAsterisk
        searchable
        data={conn.operations.map((o) => ({ value: o.name, label: o.title, disabled: !o.usable }))}
        value={op?.name ?? null}
        onChange={(v) => v && set({ operation: v, inputs: undefined })}
        renderOption={({ option }) => {
          const o = conn.operations.find((x) => x.name === option.value)!;
          return (
            <Stack gap="4xs">
              <Text fz="sm">{o.title}</Text>
              <Caption>{o.usable ? o.description || o.name : o.reason}</Caption>
            </Stack>
          );
        }}
        description={op?.description}
        nothingFoundMessage="This connector defines no operation"
      />
      {conn.access === 'read' && conn.operations.some((o) => !o.usable) && (
        <Caption>Greyed-out operations change things: this connection is read-only (an administrator can make it read-write).</Caption>
      )}
      {op && !op.usable && (
        <Alert color="yellow" variant="light">
          {op.reason}. Choose a read-write connection for this operation.
        </Alert>
      )}
      {op && (
        <>
          <Group gap="xs">
            {op.readOnly && <Badge variant="light">read-only</Badge>}
            {op.polls && <Badge variant="light">waits until finished</Badge>}
            {op.kind && <Badge variant="outline">{op.kind}</Badge>}
            <Caption>Output: {op.outputs.map((o) => `output.${o}`).join(', ')}</Caption>
          </Group>
          {day2 && (
            <Group justify="space-between" wrap="nowrap">
              <Caption>
                This operation applies to {blueprint} entities (an integration of this connection maps {op.kind} to {blueprint}).
              </Caption>
              <Button
                size="xs"
                variant="light"
                leftSection={<IconWand size={ICON.sm} />}
                onClick={() => set({ inputs: entityPrefill(op.inputs, Object.keys(bp.data?.schema.properties ?? {}), inputs) })}
              >
                Fill from the entity
              </Button>
            </Group>
          )}
          {operationFields(op.inputs).map((f) => (
            <PluginFieldInput key={f.key} field={f} value={inputs[f.key]} onChange={(v) => setInput(f.key, v)} />
          ))}
          <RequestPreview conn={conn} operation={op.name} schemaInputs={previewInputs(op.inputs, inputs)} />
        </>
      )}
    </Stack>
  );
}

/** The request the operation would send (rendered by the server; never contains credentials). */
function RequestPreview({ conn, operation, schemaInputs }: { conn: StepConnection; operation: string; schemaInputs: Record<string, unknown> }) {
  const [inputs] = useDebouncedValue(schemaInputs, 400);
  const q = useQuery({
    queryKey: ['operation-render', conn.connector.identifier, operation, conn.fields, inputs],
    queryFn: () => api.renderConnectorOperation(conn.connector.identifier, operation, { fields: conn.fields, inputs }),
    retry: false,
  });
  return (
    <Input.Wrapper label="Request preview" description="Templates are shown unrendered; credentials are added by the connection when the step runs.">
      <SurfaceBox mt="3xs">
        {q.error ? (
          <Caption c="dimmed">{errorText(q.error)}</Caption>
        ) : q.data ? (
          <Stack gap="3xs">
            <Code className="wrap-anywhere">
              {q.data.method} {q.data.url}
            </Code>
            {q.data.body !== undefined && <CodeBlock code={JSON.stringify(q.data.body, null, 2)} aria-label="Request body" />}
          </Stack>
        ) : (
          <Caption>Rendering…</Caption>
        )}
      </SurfaceBox>
    </Input.Wrapper>
  );
}

function RawCallEditor({ conn, invoker, set }: { conn: StepConnection; invoker: InvokerConfig; set: (patch: Record<string, unknown>) => void }) {
  if (!conn.api) return <Alert color="yellow">This connection does not allow raw API calls. An administrator can list allowed methods and paths on it.</Alert>;
  const method = String(invoker.method ?? 'GET');
  const methods = conn.api.methods.map((m) => ({ value: m, label: m, disabled: m !== 'GET' && conn.access !== 'read-write' }));
  return (
    <Stack gap="sm">
      <Group grow align="flex-start">
        <Select
          label="Method"
          allowDeselect={false}
          data={methods}
          value={method}
          onChange={(v) => v && set({ method: v, ...(v === 'GET' ? { body: undefined } : {}) })}
        />
        <TextInput
          label="Path"
          withAsterisk
          placeholder={conn.api.paths[0] ?? '/'}
          value={String(invoker.path ?? '')}
          onChange={(e) => set({ path: e.currentTarget.value })}
          styles={MONO_INPUT}
        />
      </Group>
      <Caption>
        Allowed: {conn.api.methods.join(', ')} under {conn.api.paths.join(', ')} (relative to {String(conn.fields.baseUrl ?? 'the base URL')})
        {conn.access === 'read' ? ' · read-only connection: GET only' : ''}
      </Caption>
      <Input.Wrapper label="Query">
        <KeyValueEditor value={invoker.query as Record<string, unknown> | undefined} onChange={(v) => set({ query: Object.keys(v).length ? v : undefined })} />
      </Input.Wrapper>
      {method !== 'GET' && <JsonEditor label="Body" value={invoker.body} onChange={(v) => set({ body: v })} minRows={4} />}
    </Stack>
  );
}
