import { useState } from 'react';
import { Alert, Badge, Button, Code, Group, Select, Stack, Tabs, Text } from '@mantine/core';
import { modals } from '@mantine/modals';
import { notifications } from '@mantine/notifications';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';
import { IconCopy, IconHistory, IconListDetails, IconPencil, IconPlayerPlay, IconPlus, IconTrash } from '@tabler/icons-react';
import type { ConnectorDefinition, ObjectSchema } from '@asterius/shared';
import { api, errorText } from '../../lib/api';
import { useCan } from '../../lib/auth';
import { useUrlParams } from '../../lib/urlState';
import { authInputs, categoryLabel, methodLabel, pickerOrder } from '../../lib/connectors';
import { DataTable } from '../../components/DataTable';
import { EntityIcon } from '../../components/icons';
import { ICON } from '@asterius/brand';
import { ResourceEditor } from '../../components/ResourceEditor';
import { SchemaForm, initialValues, type FormValues } from '../../components/SchemaForm';
import { Section } from '../../components/Section';
import { SidePanel } from '../../components/SidePanel';
import { JsonBlock } from '../../components/CodeEditor';
import { VersionHistory } from '../../components/builder/ActionHistory';
import { Caption, ManagedBadge, Mono, PageHeader, TimeAgo } from '../../components/ui';
import { strip } from './ResourceAdmin';

/**
 * Admin → Connectors: the connector definitions (built-in and the organization's own). Readable by integration
 * admins; created, changed, rolled back and deleted by admins only (they decide which requests the platform sends).
 */

const STORED = ['builtin', 'managed', 'version', 'updatedAt'];

const TEMPLATE: Record<string, unknown> = {
  identifier: 'my-tool',
  title: 'My tool',
  description: 'What this system is and what the connector reads and does.',
  icon: 'plug',
  category: 'internal',
  fields: { properties: { baseUrl: { type: 'string', title: 'API URL', format: 'url' } }, required: ['baseUrl'] },
  auth: [{ type: 'bearer', title: 'API token' }],
  test: { path: '/health' },
  kinds: { item: { title: 'Items', path: '/items', itemsPath: 'items' } },
  operations: {
    'create-item': {
      title: 'Create an item',
      method: 'POST',
      path: '/items',
      inputs: { properties: { name: { type: 'string', title: 'Name' } }, required: ['name'] },
      body: { name: '{{ inputs.name }}' },
      output: { id: 'body.id' },
    },
  },
};

const HELP = (
  <Alert color="gray" variant="light">
    <Text fz="sm">
      <b>fields</b> is the connection form (it must declare <Code>baseUrl</Code>); <b>auth</b> lists the methods connections choose from; <b>kinds</b> are what
      integrations list; <b>operations</b> are what workflow steps call. Templates are <Code>{'{{ }}'}</Code> JSONata over <Code>connection</Code>,{' '}
      <Code>inputs</Code> and <Code>output</Code>. Never put credentials here: connections hold them as secret references.
    </Text>
  </Alert>
);

function NameCell({ d }: { d: ConnectorDefinition }) {
  return (
    <Group gap="xs" wrap="nowrap">
      <EntityIcon name={d.icon ?? 'plug'} size={ICON.lg} />
      <div>
        <Text fz="sm" fw={500}>
          {d.title}
        </Text>
        <Text fz="xs" c="dimmed">
          {d.identifier}
        </Text>
      </div>
      {d.builtin ? (
        <Badge size="sm" variant="light" color="gray">
          built-in
        </Badge>
      ) : (
        <Badge size="sm" variant="light">
          custom
        </Badge>
      )}
      {/* Built-ins are read-only by nature, not declared in the configuration repository. */}
      <ManagedBadge managed={d.managed && !d.builtin} />
    </Group>
  );
}

export function ConnectorsAdmin() {
  const canWrite = useCan()('admin');
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['connectors'], queryFn: api.connectors });
  const connections = useQuery({ queryKey: ['connections'], queryFn: api.connections });
  const [params, setParam] = useUrlParams();
  const shown = q.data?.find((d) => d.identifier === params.get('open')) ?? null;
  const [editing, setEditing] = useState<{ value: Record<string, unknown>; isNew: boolean; version?: number; readOnly?: boolean } | null>(null);
  const count = (id: string) => (connections.data ?? []).filter((c) => c.connector === id).length;

  const save = async (id: string, body: Record<string, unknown>) => {
    const r = await api.saveConnectorAt(id, body, editing?.isNew ? undefined : editing?.version);
    void qc.invalidateQueries({ queryKey: ['connectors'] });
    void qc.invalidateQueries({ queryKey: ['connector-versions', id] });
    return r;
  };
  const edit = (d: ConnectorDefinition) => setEditing({ value: strip(d, STORED), isNew: false, version: d.version, readOnly: d.managed || !canWrite });
  const duplicate = (d: ConnectorDefinition) => {
    setParam('open', null);
    setEditing({ value: { ...strip(d, STORED), identifier: `${d.identifier}-custom`, title: `${d.title} (custom)` }, isNew: true });
  };
  const remove = (d: ConnectorDefinition) =>
    modals.openConfirmModal({
      title: `Delete ${d.title}?`,
      children: <Text fz="sm">Only possible when no connection uses it. Its version history is deleted too.</Text>,
      labels: { confirm: 'Delete', cancel: 'Cancel' },
      confirmProps: { color: 'red' },
      onConfirm: async () => {
        try {
          await api.deleteConnector(d.identifier);
          setParam('open', null);
          void qc.invalidateQueries({ queryKey: ['connectors'] });
          notifications.show({ message: `${d.identifier} deleted` });
        } catch (e) {
          notifications.show({ color: 'red', title: 'Cannot delete', message: errorText(e) });
        }
      },
    });

  return (
    <Stack>
      <PageHeader
        title="Connectors"
        description="How the platform talks to a kind of system: connection settings, authentication methods, what integrations can list and what workflows can call. Built-in connectors ship with the platform; duplicate one to change it."
        refresh={q}
        actions={
          canWrite && (
            <Button leftSection={<IconPlus size={ICON.md} />} onClick={() => setEditing({ value: TEMPLATE, isNew: true })}>
              New
            </Button>
          )
        }
      />
      <DataTable
        rows={q.data && pickerOrder(q.data)}
        loading={q.isPending}
        error={q.error}
        rowKey={(d) => d.identifier}
        onRowClick={(d) => setParam('open', d.identifier)}
        empty="No connectors"
        columns={[
          { key: 'n', label: 'Name', render: (d) => <NameCell d={d} /> },
          { key: 'c', label: 'Category', render: (d) => categoryLabel(d.category) },
          { key: 'a', label: 'Authentication', truncate: true, render: (d) => (d.auth.length ? d.auth.map((m) => m.type).join(', ') : 'none') },
          { key: 'k', label: 'Kinds', render: (d) => Object.keys(d.kinds).length || '—' },
          { key: 'o', label: 'Operations', render: (d) => Object.keys(d.operations).length || '—' },
          { key: 'u', label: 'Connections', render: (d) => count(d.identifier) || '—' },
          { key: 'v', label: 'Version', render: (d) => (d.builtin ? '—' : <Badge variant="light">v{d.version}</Badge>) },
        ]}
      />
      <ConnectorPanel def={shown} canWrite={canWrite} onClose={() => setParam('open', null)} onEdit={edit} onDuplicate={duplicate} onDelete={remove} />
      <ResourceEditor
        title={editing?.isNew ? 'New connector' : `${editing?.readOnly ? 'View' : 'Edit'} ${String(editing?.value.identifier ?? '')}`}
        value={editing?.value ?? null}
        isNew={!!editing?.isNew}
        readOnly={editing?.readOnly}
        help={HELP}
        readOnlyNotice={canWrite ? undefined : 'Only admins change connector definitions. You can copy this YAML.'}
        onClose={() => setEditing(null)}
        onSave={save}
      />
    </Stack>
  );
}

export function ConnectorPanel({
  def,
  canWrite,
  onClose,
  onEdit,
  onDuplicate,
  onDelete,
}: {
  def: ConnectorDefinition | null;
  canWrite: boolean;
  onClose: () => void;
  onEdit: (d: ConnectorDefinition) => void;
  onDuplicate: (d: ConnectorDefinition) => void;
  onDelete: (d: ConnectorDefinition) => void;
}) {
  const [tab, setTab] = useState<string | null>('overview');
  const editable = !!def && !def.builtin && !def.managed && canWrite;
  return (
    <SidePanel
      opened={!!def}
      onClose={onClose}
      width="wide"
      title={def && <Group gap="xs">{def.title}</Group>}
      subtitle={def && `${def.identifier} · ${categoryLabel(def.category)}${def.builtin ? ' · built-in' : ` · v${def.version}`}`}
      actions={
        def && (
          <>
            <Button
              size="xs"
              variant="default"
              leftSection={<IconPlus size={ICON.sm} />}
              component={Link}
              to={`/admin/connections?new=${encodeURIComponent(def.identifier)}`}
            >
              New connection
            </Button>
            {canWrite && (
              <Button size="xs" variant="default" leftSection={<IconCopy size={ICON.sm} />} onClick={() => onDuplicate(def)}>
                Duplicate
              </Button>
            )}
            {!def.builtin && (
              <Button size="xs" variant="default" leftSection={<IconPencil size={ICON.sm} />} onClick={() => onEdit(def)}>
                {editable ? 'Edit' : 'View'}
              </Button>
            )}
            {editable && (
              <Button size="xs" variant="subtle" color="red" leftSection={<IconTrash size={ICON.sm} />} onClick={() => onDelete(def)}>
                Delete
              </Button>
            )}
          </>
        )
      }
    >
      {def && (
        <Tabs value={tab} onChange={setTab} keepMounted={false}>
          <Tabs.List mb="md">
            <Tabs.Tab value="overview" leftSection={<IconListDetails size={ICON.md} />}>
              Definition
            </Tabs.Tab>
            <Tabs.Tab value="try" leftSection={<IconPlayerPlay size={ICON.md} />} disabled={!Object.keys(def.operations).length}>
              Try an operation
            </Tabs.Tab>
            {!def.builtin && (
              <Tabs.Tab value="history" leftSection={<IconHistory size={ICON.md} />}>
                History
              </Tabs.Tab>
            )}
          </Tabs.List>
          <Tabs.Panel value="overview">
            <DefinitionView def={def} />
          </Tabs.Panel>
          <Tabs.Panel value="try">
            <TryOperation def={def} />
          </Tabs.Panel>
          {!def.builtin && (
            <Tabs.Panel value="history">
              <VersionHistory
                queryKey={['connector-versions', def.identifier]}
                list={() => api.connectorVersions(def.identifier)}
                diff={(from, to) => api.connectorDiff(def.identifier, from, to)}
                restore={(version) => api.rollbackConnector(def.identifier, version)}
                current={def.version}
                intro="Every change creates a version. Restoring creates a new version with the old definition, refused if it would break a connection."
                onRestored={() => notifications.show({ color: 'green', message: `${def.identifier} restored` })}
                readOnly={!editable}
              />
            </Tabs.Panel>
          )}
        </Tabs>
      )}
    </SidePanel>
  );
}

const typeOf = (p: { type?: unknown; format?: unknown; enum?: unknown }) =>
  [String(p.type ?? 'string'), p.format ? String(p.format) : null, Array.isArray(p.enum) ? `one of ${p.enum.join(', ')}` : null].filter(Boolean).join(' · ');

function SchemaTable({ schema, empty }: { schema: ObjectSchema; empty: string }) {
  const required = new Set(schema.required ?? []);
  return (
    <DataTable
      rows={Object.entries(schema.properties ?? {})}
      rowKey={([k]) => k}
      empty={empty}
      columns={[
        { key: 'k', label: 'Name', render: ([k]) => <Mono>{k}</Mono> },
        { key: 't', label: 'Title', render: ([k, p]) => p.title ?? k, truncate: true },
        { key: 'y', label: 'Type', render: ([, p]) => typeOf(p) },
        { key: 'r', label: 'Required', render: ([k]) => (required.has(k) ? 'yes' : '—') },
        { key: 'd', label: 'Default', render: ([, p]) => (p.default === undefined ? '—' : <Mono>{String(p.default)}</Mono>), truncate: true },
      ]}
    />
  );
}

export function DefinitionView({ def }: { def: ConnectorDefinition }) {
  const kinds = Object.entries(def.kinds);
  const operations = Object.entries(def.operations);
  return (
    <>
      {def.description && (
        <Text fz="sm" mb="md">
          {def.description}
        </Text>
      )}
      <Section title="Connection fields">
        <SchemaTable schema={def.fields} empty="No fields" />
      </Section>
      <Section title="Authentication">
        {def.auth.length ? (
          <Stack gap="sm">
            {def.auth.map((m, i) => {
              const inputs = authInputs(m);
              return (
                <Stack key={m.type} gap="4xs">
                  <Group gap="xs">
                    <Text fz="sm" fw={500}>
                      {methodLabel(m)}
                    </Text>
                    <Mono>{m.type}</Mono>
                    {i === 0 && (
                      <Badge size="xs" variant="light" color="gray">
                        default
                      </Badge>
                    )}
                  </Group>
                  {m.description && <Caption>{m.description}</Caption>}
                  <Caption>
                    Connection supplies: {inputs.length ? inputs.map((f) => `${f.key}${f.secret ? ' (secret)' : ''}`).join(', ') : 'nothing'}
                    {Object.keys(m.set ?? {}).length ? ` · set by the connector: ${Object.keys(m.set).join(', ')}` : ''}
                  </Caption>
                </Stack>
              );
            })}
            {def.authOptional && <Caption>Authentication is optional.</Caption>}
          </Stack>
        ) : (
          <Caption>None: the API is read anonymously.</Caption>
        )}
      </Section>
      {def.test && (
        <Section title="Test request">
          <Mono>
            {def.test.method} {def.test.path}
          </Mono>
        </Section>
      )}
      <Section title="Kinds (ingestion)">
        <DataTable
          rows={kinds}
          rowKey={([k]) => k}
          empty="No kinds: integrations cannot list anything"
          columns={[
            { key: 'k', label: 'Kind', render: ([k, v]) => (v.title ? `${v.title} (${k})` : k) },
            {
              key: 'r',
              label: 'Request',
              truncate: true,
              render: ([, v]) => (
                <Mono>
                  {v.method} {v.path}
                </Mono>
              ),
            },
            { key: 'p', label: 'Pagination', render: ([, v]) => v.pagination?.type ?? 'none' },
            { key: 'i', label: 'Incremental', render: ([, v]) => (v.since ? 'yes' : '—') },
          ]}
        />
      </Section>
      <Section title="Operations (workflows)">
        <DataTable
          rows={operations}
          rowKey={([k]) => k}
          empty="No operations"
          columns={[
            {
              key: 'o',
              label: 'Operation',
              render: ([k, o]) => (
                <div>
                  <Text fz="sm">{o.title}</Text>
                  <Text fz="xs" c="dimmed">
                    {k}
                  </Text>
                </div>
              ),
            },
            {
              key: 'r',
              label: 'Request',
              truncate: true,
              render: ([, o]) => (
                <Mono>
                  {o.method} {o.path}
                </Mono>
              ),
            },
            { key: 'i', label: 'Inputs', truncate: true, render: ([, o]) => Object.keys(o.inputs.properties ?? {}).join(', ') || '—' },
            {
              key: 'w',
              label: 'Effect',
              render: ([, o]) =>
                (o.readOnly ?? o.method === 'GET') ? (
                  <Badge variant="light" color="gray">
                    reads
                  </Badge>
                ) : (
                  <Badge variant="light" color="orange">
                    writes
                  </Badge>
                ),
            },
            { key: 'p', label: 'Polls', render: ([, o]) => (o.poll ? 'yes' : '—') },
          ]}
        />
      </Section>
      {def.updatedAt && !def.builtin && (
        <Caption mt="md">
          Version {def.version}, changed <TimeAgo at={def.updatedAt} />
        </Caption>
      )}
    </>
  );
}

/** Preview the request of an operation with a connection's settings and sample inputs: nothing is sent. */
export function TryOperation({ def }: { def: ConnectorDefinition }) {
  const connections = useQuery({ queryKey: ['connections'], queryFn: api.connections });
  const mine = (connections.data ?? []).filter((c) => c.connector === def.identifier);
  const ops = Object.entries(def.operations);
  const [connection, setConnection] = useState<string | null>(null);
  const [op, setOp] = useState<string | null>(ops[0]?.[0] ?? null);
  const operation = op ? def.operations[op] : undefined;
  const [inputs, setInputs] = useState<FormValues>(() => (operation ? initialValues(operation.inputs) : {}));
  const conn = mine.find((c) => c.identifier === connection);
  // Errors (a missing input, a template error) show under the button, not as a toast.
  const render = useMutation({
    mutationFn: () => api.renderConnectorOperation(def.identifier, op!, { fields: conn?.fields ?? {}, inputs }),
  });
  return (
    <Stack gap="md">
      <Caption>
        Shows the request an operation sends: nothing is sent and no credential is added (the connection's authentication is applied when it runs).
      </Caption>
      <Group grow align="flex-start">
        <Select
          label="Connection"
          placeholder="None: field defaults"
          description={mine.length ? undefined : 'No connection of this connector yet'}
          data={mine.map((c) => ({ value: c.identifier, label: c.title }))}
          value={connection}
          onChange={setConnection}
          clearable
        />
        <Select
          label="Operation"
          data={ops.map(([k, o]) => ({ value: k, label: o.title }))}
          value={op}
          allowDeselect={false}
          onChange={(v) => {
            setOp(v);
            setInputs(v ? initialValues(def.operations[v]!.inputs) : {});
            render.reset();
          }}
        />
      </Group>
      {operation && (
        <Section title="Inputs">
          {operation.description && <Caption mb="xs">{operation.description}</Caption>}
          {Object.keys(operation.inputs.properties ?? {}).length ? (
            <SchemaForm key={op} schema={operation.inputs} values={inputs} onChange={setInputs} />
          ) : (
            <Caption>This operation has no inputs.</Caption>
          )}
          <Group mt="sm">
            <Button size="xs" leftSection={<IconPlayerPlay size={ICON.sm} />} loading={render.isPending} onClick={() => render.mutate()}>
              Render the request
            </Button>
          </Group>
        </Section>
      )}
      {render.error && (
        <Alert color="red" variant="light" className="pre-wrap" role="alert">
          {errorText(render.error)}
        </Alert>
      )}
      {render.data && (
        <Section title="Request">
          <Stack gap="xs" aria-label="Rendered request">
            <Code block>
              {render.data.method} {render.data.url}
            </Code>
            {Object.keys(render.data.headers).length > 0 && (
              <Code block>
                {Object.entries(render.data.headers)
                  .map(([k, v]) => `${k}: ${v}`)
                  .join('\n')}
              </Code>
            )}
            {render.data.body !== undefined && render.data.body !== null && <JsonBlock value={render.data.body} aria-label="Request body" />}
          </Stack>
        </Section>
      )}
    </Stack>
  );
}
