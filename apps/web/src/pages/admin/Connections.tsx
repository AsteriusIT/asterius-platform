import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { Anchor, Badge, Button, Group, SimpleGrid, Stack, Tabs, Text, Tooltip } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { IconChartDots3, IconEye, IconListDetails, IconPencil, IconPlugConnected } from '@tabler/icons-react';
import type { Connection, ConnectionTestResult, ConnectorDefinition } from '@asterius/shared';
import { api } from '../../lib/api';
import { useCan } from '../../lib/auth';
import { useAppMutation } from '../../lib/queryClient';
import { useUrlParams } from '../../lib/urlState';
import { blueprintsFed, categoryLabel, connectorOf, pickerOrder, methodLabel, rememberTest, useLastTest } from '../../lib/connectors';
import { blankConnection, ConnectionBuilder } from '../../components/builder/ConnectionBuilder';
import { EntityIcon } from '../../components/icons';
import { ICON } from '../../components/iconScale';
import { Section } from '../../components/Section';
import { SidePanel } from '../../components/SidePanel';
import { Caption, Mono, QueryView, TimeAgo } from '../../components/ui';
import { ResourceAdmin, strip } from './ResourceAdmin';

/** Admin → Connections: configured instances of connector definitions (admins and integration admins). */

const connectorsQuery = { queryKey: ['connectors'], queryFn: api.connectors, staleTime: 60_000 };

export function ConnectorName({ def, id }: { def?: ConnectorDefinition; id: string }) {
  return (
    <Group gap="2xs" wrap="nowrap">
      <EntityIcon name={def?.icon ?? 'plug'} size={ICON.md} />
      <Text fz="sm">{def?.title ?? id}</Text>
    </Group>
  );
}

export function AccessBadge({ access }: { access: Connection['access'] }) {
  return access === 'read-write' ? (
    <Badge color="orange" variant="light">
      read-write
    </Badge>
  ) : (
    <Badge color="gray" variant="light">
      read
    </Badge>
  );
}

function TestResult({ result }: { result: ConnectionTestResult }) {
  const detail = [result.status !== null ? `HTTP ${result.status}` : null, result.latencyMs !== null ? `${result.latencyMs} ms` : null]
    .filter(Boolean)
    .join(' · ');
  return (
    <Group gap="2xs" wrap="nowrap">
      <Badge color={result.ok ? 'green' : 'red'}>{result.ok ? 'ok' : 'failed'}</Badge>
      <Text fz="xs" c="dimmed">
        {detail}
        {detail ? ' · ' : ''}
        <TimeAgo at={result.checkedAt} />
      </Text>
    </Group>
  );
}

function LastTest({ id }: { id: string }) {
  const last = useLastTest(id);
  if (!last) return <Caption>not tested</Caption>;
  return (
    <Tooltip label={last.error ?? 'Last test from this browser'} multiline maw={320}>
      <div>
        <TestResult result={last} />
      </div>
    </Tooltip>
  );
}

const usageQuery = (id: string) => ({ queryKey: ['connection-usage', id], queryFn: () => api.connectionUsage(id), staleTime: 30_000 });

function UsageCount({ id }: { id: string }) {
  const q = useQuery(usageQuery(id));
  if (!q.data) return <Caption>—</Caption>;
  const n = q.data.integrations.length + q.data.actions.length + q.data.fragments.length;
  return n ? (
    <Text fz="sm">
      {n} {n === 1 ? 'use' : 'uses'}
    </Text>
  ) : (
    <Caption>unused</Caption>
  );
}

export function ConnectionsAdmin() {
  const connectors = useQuery(connectorsQuery);
  const connections = useQuery({ queryKey: ['connections'], queryFn: api.connections });
  const [params, setParam] = useUrlParams();
  const openId = params.get('open');
  const newFor = params.get('new');
  const shown = connections.data?.find((c) => c.identifier === openId) ?? null;
  const [editRequest, setEditRequest] = useState<{ item: Connection } | null>(null);
  const newDef = newFor ? connectors.data?.find((d) => d.identifier === newFor) : undefined;
  const openEditor = useMemo(() => editRequest ?? (newDef ? { value: blankConnection(newDef) } : null), [editRequest, newDef]);
  const onOpened = useCallback(() => {
    setEditRequest(null);
    setParam('new', null);
  }, [setParam]);

  return (
    <ResourceAdmin<Connection>
      title="Connections"
      description="Configured instances of connectors (an Azure DevOps organization, a PagerDuty account…): settings, credentials as secret references, and who may use them. Integrations and workflows use a connection by its identifier."
      queryKey="connections"
      list={api.connections}
      picker="modal"
      columns={[
        { key: 'c', label: 'Connector', render: (c) => <ConnectorName def={connectorOf(c, connectors.data)} id={c.connector} /> },
        { key: 'a', label: 'Access', render: (c) => <AccessBadge access={c.access} /> },
        { key: 'm', label: 'Authentication', render: (c) => <AuthLabel connection={c} def={connectorOf(c, connectors.data)} /> },
        { key: 't', label: 'Last test', render: (c) => <LastTest id={c.identifier} /> },
        { key: 'u', label: 'Used by', render: (c) => <UsageCount id={c.identifier} /> },
      ]}
      templates={pickerOrder(connectors.data ?? []).map((def) => ({
        label: def.title,
        description: def.description,
        icon: def.icon ?? 'plug',
        group: def.builtin ? categoryLabel(def.category) : 'Your connectors',
        keywords: [def.identifier, def.category],
        value: blankConnection(def),
      }))}
      onRowClick={(c) => setParam('open', c.identifier)}
      // Opened fresh with its version: saves are pinned to it (a colleague's newer save shows a conflict dialog).
      toEditable={async (c) => strip(await api.connection(c.identifier), ['managed', 'createdAt', 'updatedAt'])}
      editor={(p) => <ConnectionBuilder {...p} />}
      save={(id, body, o) => api.saveConnectionAt(id, body, o?.ifMatch)}
      remove={(c) => api.deleteConnection(c.identifier)}
      removeWarning={() => 'Only possible when no integration, workflow or fragment uses it.'}
      openEditor={openEditor}
      onOpened={onOpened}
    >
      <ConnectionPanel
        connection={shown}
        def={shown ? connectorOf(shown, connectors.data) : undefined}
        onClose={() => setParam('open', null)}
        onEdit={(c) => {
          setParam('open', null);
          setEditRequest({ item: c });
        }}
      />
    </ResourceAdmin>
  );
}

function AuthLabel({ connection, def }: { connection: Connection; def?: ConnectorDefinition }) {
  if (!connection.auth) return <Caption>none</Caption>;
  const m = def?.auth.find((x) => x.type === connection.auth!.type);
  return <Text fz="sm">{m ? methodLabel(m) : connection.auth.type}</Text>;
}

/** Label / value pairs of a panel. */
export function Facts({ items }: { items: [string, ReactNode][] }) {
  return (
    <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="sm" verticalSpacing="sm">
      {items.map(([label, value]) => (
        <Stack key={label} gap="4xs" miw={0}>
          <Caption>{label}</Caption>
          <div className="wrap-anywhere">{value}</div>
        </Stack>
      ))}
    </SimpleGrid>
  );
}

const show = (v: unknown) => (v === undefined || v === null || v === '' ? <Caption>—</Caption> : <Mono>{typeof v === 'string' ? v : JSON.stringify(v)}</Mono>);

export function ConnectionPanel({
  connection,
  def,
  onClose,
  onEdit,
}: {
  connection: Connection | null;
  def?: ConnectorDefinition;
  onClose: () => void;
  onEdit: (c: Connection) => void;
}) {
  const [tab, setTab] = useState<string | null>('overview');
  const usage = useQuery({ ...usageQuery(connection?.identifier ?? ''), enabled: !!connection });
  const n = usage.data ? usage.data.integrations.length + usage.data.actions.length + usage.data.fragments.length : 0;
  return (
    <SidePanel
      opened={!!connection}
      onClose={onClose}
      title={connection?.title}
      subtitle={connection && `${connection.identifier} · ${def?.title ?? connection.connector}`}
      actions={
        connection && (
          <Button
            size="xs"
            variant="default"
            leftSection={connection.managed ? <IconEye size={ICON.sm} /> : <IconPencil size={ICON.sm} />}
            onClick={() => onEdit(connection)}
          >
            {connection.managed ? 'View' : 'Edit'}
          </Button>
        )
      }
    >
      {connection && (
        <Tabs value={tab} onChange={setTab} keepMounted={false}>
          <Tabs.List mb="md">
            <Tabs.Tab value="overview" leftSection={<IconListDetails size={ICON.md} />}>
              Overview
            </Tabs.Tab>
            <Tabs.Tab value="usage" leftSection={<IconChartDots3 size={ICON.md} />} rightSection={n ? <Badge size="xs">{n}</Badge> : undefined}>
              Usage
            </Tabs.Tab>
          </Tabs.List>
          <Tabs.Panel value="overview">
            <Overview connection={connection} def={def} />
          </Tabs.Panel>
          <Tabs.Panel value="usage">
            <Usage id={connection.identifier} />
          </Tabs.Panel>
        </Tabs>
      )}
    </SidePanel>
  );
}

function Overview({ connection, def }: { connection: Connection; def?: ConnectorDefinition }) {
  const method = connection.auth ? def?.auth.find((m) => m.type === connection.auth!.type) : undefined;
  const fields = Object.entries(def?.fields.properties ?? {});
  return (
    <>
      {connection.description && (
        <Text fz="sm" mb="md">
          {connection.description}
        </Text>
      )}
      <Section title="Connection">
        <Facts
          items={[
            [
              'Connector',
              <Anchor key="c" component={Link} to={`/admin/connectors?open=${encodeURIComponent(connection.connector)}`} fz="sm">
                <ConnectorName def={def} id={connection.connector} />
              </Anchor>,
            ],
            ['Access', <AccessBadge key="a" access={connection.access} />],
            ['Authentication', connection.auth ? <Text fz="sm">{method ? methodLabel(method) : connection.auth.type}</Text> : <Caption>none</Caption>],
            ...fields.map(([k, p]): [string, ReactNode] => [p.title ?? k, show(connection.fields[k] ?? p.default)]),
          ]}
        />
      </Section>
      <Section title="Automation">
        <Facts
          items={[
            [
              'Workflows allowed',
              connection.allowed.workflows?.length ? (
                connection.allowed.workflows.map((w) => (
                  <Badge key={w} mr="3xs" color="gray">
                    {w}
                  </Badge>
                ))
              ) : (
                <Caption>any</Caption>
              ),
            ],
            [
              'Teams allowed',
              connection.allowed.teams?.length ? (
                connection.allowed.teams.map((t) => (
                  <Badge key={t} mr="3xs" color="gray">
                    {t}
                  </Badge>
                ))
              ) : (
                <Caption>any</Caption>
              ),
            ],
            [
              'Raw API calls',
              connection.api ? (
                <Text fz="sm">
                  {connection.api.methods.join(', ')} on <Mono>{connection.api.paths.join(', ')}</Mono>
                </Text>
              ) : (
                <Caption>not allowed</Caption>
              ),
            ],
          ]}
        />
      </Section>
      <TestSection id={connection.identifier} />
      <FeedsSection id={connection.identifier} />
    </>
  );
}

function TestSection({ id }: { id: string }) {
  const last = useLastTest(id);
  const test = useAppMutation({ mutationFn: () => api.testConnection(id), onSuccess: (r) => rememberTest(id, r) });
  return (
    <Section
      title="Test"
      actions={
        <Button size="xs" variant="default" leftSection={<IconPlugConnected size={ICON.sm} />} loading={test.isPending} onClick={() => test.mutate()}>
          Test connection
        </Button>
      }
    >
      {last ? (
        <Stack gap="2xs">
          <TestResult result={last} />
          {last.error && (
            <Text fz="xs" c="red" role="alert" className="wrap-anywhere">
              {last.error}
            </Text>
          )}
        </Stack>
      ) : (
        <Caption>Sends the connector's test request with this connection's credentials.</Caption>
      )}
    </Section>
  );
}

function FeedsSection({ id }: { id: string }) {
  const usage = useQuery(usageQuery(id));
  const integrations = useQuery({ queryKey: ['integrations'], queryFn: api.integrations, enabled: !!usage.data?.integrations.length });
  const blueprints = useQuery({ queryKey: ['blueprints'], queryFn: api.blueprints, staleTime: 30_000 });
  const fed = blueprintsFed(usage.data?.integrations ?? [], integrations.data ?? []);
  return (
    <Section title="Feeds the catalog">
      {fed.length ? (
        <Group gap="2xs">
          {fed.map((b) => {
            const bp = blueprints.data?.find((x) => x.identifier === b);
            return (
              <Badge
                key={b}
                component={Link}
                to={`/catalog/${encodeURIComponent(b)}`}
                variant="light"
                className="clickable"
                leftSection={<EntityIcon name={bp?.icon} size={ICON.sm} />}
              >
                {bp?.title ?? b}
              </Badge>
            );
          })}
        </Group>
      ) : (
        <Caption>No integration of this connection maps entities yet.</Caption>
      )}
    </Section>
  );
}

function Usage({ id }: { id: string }) {
  const isAdmin = useCan()('admin');
  const usage = useQuery(usageQuery(id));
  const list = (items: string[], link: (x: string) => string | null, empty: string) =>
    items.length ? (
      <Stack gap="3xs">
        {items.map((x) => {
          const to = link(x);
          return to ? (
            <Anchor key={x} component={Link} to={to} fz="sm">
              {x}
            </Anchor>
          ) : (
            <Text key={x} fz="sm">
              {x}
            </Text>
          );
        })}
      </Stack>
    ) : (
      <Caption>{empty}</Caption>
    );
  return (
    <QueryView q={usage}>
      {(u) => (
        <>
          <Section title="Integrations">{list(u.integrations, (x) => `/admin/integrations?open=${encodeURIComponent(x)}`, 'No integration')}</Section>
          <Section title="Workflows">{list(u.actions, (x) => (isAdmin ? `/admin/actions/${encodeURIComponent(x)}` : null), 'No workflow')}</Section>
          <Section title="Fragments">{list(u.fragments, () => (isAdmin ? '/admin/fragments' : null), 'No fragment')}</Section>
          <Caption mt="md">A connection in use cannot be deleted.</Caption>
        </>
      )}
    </QueryView>
  );
}
