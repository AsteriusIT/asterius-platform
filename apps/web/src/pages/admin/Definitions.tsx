import { useState } from 'react';
import { ActionIcon, Anchor, Badge, Code, CopyButton, Drawer, Group, Stack, Text, Tooltip } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';
import { IconCopy, IconRefresh, IconSend } from '@tabler/icons-react';
import type { Action, Blueprint, Integration, Webhook } from '@asterius/shared';
import { api, errorText } from '../../lib/api';
import { DataTable } from '../../components/DataTable';
import { EntityIcon } from '../../components/icons';
import { Mono, TimeAgo } from '../../components/ui';
import { ResourceAdmin, strip } from './ResourceAdmin';
import { ActionBuilder } from '../../components/builder/ActionBuilder';
import { workflowSummary } from '../../lib/workflow';
import { BlueprintBuilder } from '../../components/builder/BlueprintBuilder';

const meta = () => ({ queryKey: ['meta'], queryFn: api.meta, staleTime: Infinity });

export function BlueprintsAdmin() {
  return (
    <ResourceAdmin<Blueprint>
      title="Blueprints"
      description="Entity types of the catalog: properties (JSON Schema) and relations."
      queryKey="blueprints"
      list={api.blueprints}
      columns={[
        { key: 'i', label: 'Icon', render: (b) => <EntityIcon name={b.icon} /> },
        { key: 'p', label: 'Properties', render: (b) => Object.keys(b.schema.properties ?? {}).length },
        {
          key: 'r',
          label: 'Relations',
          render: (b) =>
            Object.entries(b.relations).map(([k, r]) => (
              <Badge key={k} mr={4} color="gray">
                {k} → {r.target}
              </Badge>
            )),
        },
        {
          key: 'n',
          label: 'Entities',
          render: (b) => (
            <Anchor component={Link} to={`/catalog/${b.identifier}`} onClick={(e) => e.stopPropagation()}>
              {b.entityCount}
            </Anchor>
          ),
        },
      ]}
      templates={[{ label: 'Blueprint', value: { identifier: '', title: '', description: '', icon: null, schema: { properties: {} }, relations: {} } }]}
      editor={(p) => <BlueprintBuilder {...p} />}
      toEditable={(b) => strip(b, ['managed', 'createdAt', 'updatedAt'])} // entityCount: shown as a warning, never saved
      save={api.saveBlueprint}
      remove={(b) => api.deleteBlueprint(b.identifier)}
      removeWarning={() => 'Only possible when no entity, action or relation uses it.'}
    />
  );
}

/** New workflows start empty: general settings first, then the trigger and the steps in the editor. */
const blankAction = { identifier: '', title: '', description: '', icon: null, enabled: true, trigger: null, steps: [] };

export function ActionsAdmin() {
  return (
    <ResourceAdmin<Action>
      title="Actions"
      description="Self-service workflows: a trigger (a form users submit) followed by steps (integrations, approvals, AI agents)."
      queryKey="admin-actions"
      list={() => api.actions()}
      columns={[
        {
          key: 't',
          label: 'Trigger',
          render: (a) =>
            a.trigger ? (
              <Badge color={a.trigger.on === 'delete' ? 'red' : a.trigger.on === 'create' ? 'green' : 'blue'} variant="light">
                form · {a.trigger.on}
              </Badge>
            ) : (
              <Badge color="gray" variant="outline">
                no trigger
              </Badge>
            ),
        },
        { key: 'b', label: 'Blueprint', render: (a) => a.trigger?.blueprint ?? '—' },
        { key: 'i', label: 'Steps', render: (a) => <Mono>{workflowSummary(a)}</Mono> },
        { key: 'a', label: 'Approval', render: (a) => (a.trigger?.approval.required ? <Badge color="yellow">required</Badge> : '—') },
        { key: 'e', label: 'Enabled', render: (a) => (a.enabled ? 'yes' : <Badge color="gray">disabled</Badge>) },
      ]}
      templates={[{ label: 'Workflow', value: blankAction }]}
      editor={(p) => <ActionBuilder {...p} />}
      help={
        <Text fz="xs" c="dimmed">
          Templates: <Code>{'{{ inputs.x }}'}</Code>, <Code>{'{{ entity.properties.x }}'}</Code>, <Code>{'{{ trigger.user.email }}'}</Code>,{' '}
          <Code>{'{{ run.callback.url }}'}</Code> (JSONata). Secrets: <Code>{'${secret:NAME}'}</Code>.
        </Text>
      }
      toEditable={(a) => strip(a, ['managed', 'allowedForMe'])}
      save={api.saveAction}
      remove={(a) => api.deleteAction(a.identifier)}
    />
  );
}

export function IntegrationsAdmin() {
  const m = useQuery(meta());
  const qc = useQueryClient();
  const [detail, setDetail] = useState<Integration | null>(null);
  const sync = async (i: Integration) => {
    try {
      await api.syncNow(i.identifier);
      notifications.show({ message: `Sync of ${i.title} queued` });
      setTimeout(() => void qc.invalidateQueries({ queryKey: ['integrations'] }), 3000);
    } catch (e) {
      notifications.show({ color: 'red', message: errorText(e) });
    }
  };
  return (
    <ResourceAdmin<Integration>
      title="Integrations"
      description="Ingest data from third-party systems: pull on a schedule, or receive webhooks. Mappings are JSONata."
      queryKey="integrations"
      list={api.integrations}
      columns={[
        { key: 't', label: 'Type', render: (i) => <Mono>{i.type}</Mono> },
        { key: 'e', label: 'Enabled', render: (i) => (i.enabled ? 'yes' : <Badge color="gray">disabled</Badge>) },
        { key: 's', label: 'Schedule', render: (i) => (i.type === 'webhook' ? 'push' : i.intervalMinutes ? `every ${i.intervalMinutes} min` : 'manual') },
        {
          key: 'l',
          label: 'Last sync',
          render: (i) =>
            i.lastSync ? (
              <Group gap={6} wrap="nowrap">
                <Badge color={i.lastSync.status === 'success' ? 'green' : i.lastSync.status === 'running' ? 'blue' : 'red'}>{i.lastSync.status}</Badge>
                <Text fz="xs" c="dimmed">
                  <TimeAgo at={i.lastSync.startedAt} />
                </Text>
              </Group>
            ) : (
              '—'
            ),
        },
      ]}
      rowActions={(i) =>
        i.type !== 'webhook' && i.enabled ? (
          <Tooltip label="Sync now">
            <ActionIcon variant="subtle" onClick={() => void sync(i)} aria-label="Sync now">
              <IconRefresh size={16} />
            </ActionIcon>
          </Tooltip>
        ) : null
      }
      onRowClick={setDetail}
      templates={(m.data?.sources ?? []).map((s) => ({
        label: s.title,
        value: {
          identifier: `my-${s.type}`,
          title: s.title,
          enabled: true,
          intervalMinutes: s.type === 'webhook' ? 0 : 60,
          deleteMissing: false,
          ...s.example,
        },
      }))}
      toEditable={(i) => strip(i, ['managed', 'lastSync', 'webhookUrl'])}
      save={api.saveIntegration}
      remove={(i) => api.deleteIntegration(i.identifier)}
      removeWarning={() => 'Entities it ingested stay in the catalog.'}
    >
      <IntegrationDrawer integration={detail} onClose={() => setDetail(null)} />
    </ResourceAdmin>
  );
}

function IntegrationDrawer({ integration, onClose }: { integration: Integration | null; onClose: () => void }) {
  const syncs = useQuery({
    queryKey: ['syncs', integration?.identifier],
    queryFn: () => api.syncs(integration!.identifier),
    enabled: !!integration,
    refetchInterval: 5000,
  });
  return (
    <Drawer opened={!!integration} onClose={onClose} position="right" size="xl" title={<Text fw={600}>{integration?.title}</Text>}>
      {integration && (
        <Stack>
          {integration.webhookUrl && (
            <Stack gap={4}>
              <Text fz="sm" fw={500}>
                Webhook URL
              </Text>
              <Group gap="xs" wrap="nowrap">
                <Code style={{ overflowWrap: 'anywhere' }}>{integration.webhookUrl}</Code>
                <CopyButton value={integration.webhookUrl}>
                  {({ copy }) => (
                    <ActionIcon variant="subtle" onClick={copy} aria-label="Copy">
                      <IconCopy size={16} />
                    </ActionIcon>
                  )}
                </CopyButton>
              </Group>
              <Text fz="xs" c="dimmed">
                Authenticate with <Code>X-Asterius-Token: &lt;secret&gt;</Code>, or an HMAC signature header (<Code>signatureHeader</Code> in the config).
              </Text>
            </Stack>
          )}
          <Text fz="sm" fw={500}>
            History
          </Text>
          <DataTable
            rows={syncs.data}
            loading={syncs.isPending}
            rowKey={(s) => s.id}
            empty="Never synced"
            columns={[
              { key: 'a', label: 'When', render: (s) => <TimeAgo at={s.startedAt} /> },
              { key: 't', label: 'Trigger', render: (s) => s.trigger },
              {
                key: 's',
                label: 'Status',
                render: (s) => <Badge color={s.status === 'success' ? 'green' : s.status === 'running' ? 'blue' : 'red'}>{s.status}</Badge>,
              },
              { key: 'n', label: 'Upserted / deleted / failed', render: (s) => `${s.stats.upserted} / ${s.stats.deleted} / ${s.stats.failed}` },
            ]}
          />
          {syncs.data?.[0]?.logs.length ? (
            <>
              <Text fz="sm" fw={500}>
                Last run log
              </Text>
              <pre style={{ fontSize: 12, margin: 0, whiteSpace: 'pre-wrap' }}>{syncs.data[0].logs.join('\n')}</pre>
            </>
          ) : null}
        </Stack>
      )}
    </Drawer>
  );
}

export function WebhooksAdmin() {
  const [detail, setDetail] = useState<Webhook | null>(null);
  return (
    <ResourceAdmin<Webhook>
      title="Webhooks"
      description="Notify other systems of catalog changes and runs. Signed with HMAC-SHA256, retried with backoff."
      queryKey="webhooks"
      list={api.webhooks}
      columns={[
        {
          key: 'u',
          label: 'URL',
          render: (w) => (
            <Text fz="sm" truncate maw={280}>
              {w.url}
            </Text>
          ),
        },
        {
          key: 'e',
          label: 'Events',
          render: (w) =>
            w.events.map((e) => (
              <Badge key={e} mr={4} color="gray">
                {e}
              </Badge>
            )),
        },
        { key: 's', label: 'Signed', render: (w) => (w.hasSecret ? 'yes' : '—') },
        { key: 'x', label: 'Enabled', render: (w) => (w.enabled ? 'yes' : <Badge color="gray">disabled</Badge>) },
      ]}
      onRowClick={setDetail}
      templates={[
        {
          label: 'Webhook',
          value: {
            identifier: 'my-webhook',
            title: 'My webhook',
            url: 'https://example.internal/hook',
            events: ['entity.*', 'run.updated'],
            blueprints: [],
            secret: '${secret:WEBHOOK_SIGNING_KEY}',
            enabled: true,
          },
        },
      ]}
      toEditable={async (w) => strip(await api.webhook(w.identifier), ['managed', 'hasSecret'])}
      save={api.saveWebhook}
      remove={(w) => api.deleteWebhook(w.identifier)}
    >
      <DeliveriesDrawer webhook={detail} onClose={() => setDetail(null)} />
    </ResourceAdmin>
  );
}

function DeliveriesDrawer({ webhook, onClose }: { webhook: Webhook | null; onClose: () => void }) {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['deliveries', webhook?.identifier],
    queryFn: () => api.deliveries(webhook!.identifier),
    enabled: !!webhook,
    refetchInterval: 5000,
  });
  return (
    <Drawer opened={!!webhook} onClose={onClose} position="right" size="xl" title={<Text fw={600}>Deliveries · {webhook?.title}</Text>}>
      <DataTable
        rows={q.data}
        loading={q.isPending}
        rowKey={(d) => d.id}
        empty="No deliveries yet"
        columns={[
          { key: 'w', label: 'When', render: (d) => <TimeAgo at={d.createdAt} /> },
          { key: 'e', label: 'Event', render: (d) => <Mono>{d.event}</Mono> },
          {
            key: 's',
            label: 'Status',
            render: (d) => <Badge color={d.status === 'success' ? 'green' : d.status === 'pending' ? 'blue' : 'red'}>{d.status}</Badge>,
          },
          { key: 'a', label: 'Attempts', render: (d) => d.attempts },
          {
            key: 'r',
            label: 'Response',
            render: (d) => (
              <Tooltip label={d.lastError ?? ''} disabled={!d.lastError} multiline w={300}>
                <Text fz="sm">{d.responseStatus ?? (d.lastError ? 'error' : '—')}</Text>
              </Tooltip>
            ),
          },
          {
            key: 'x',
            label: '',
            render: (d) =>
              d.status === 'failed' ? (
                <Tooltip label="Redeliver">
                  <ActionIcon
                    variant="subtle"
                    onClick={async () => {
                      await api.redeliver(d.id);
                      void qc.invalidateQueries({ queryKey: ['deliveries'] });
                    }}
                  >
                    <IconSend size={16} />
                  </ActionIcon>
                </Tooltip>
              ) : null,
          },
        ]}
      />
    </Drawer>
  );
}
