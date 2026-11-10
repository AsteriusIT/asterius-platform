import { useState } from 'react';
import { ActionIcon, Anchor, Badge, Code, CopyButton, Group, Select, Text, Tooltip } from '@mantine/core';
import { AiDraft, JsonPreview } from '../../components/AiAssistant';
import { notifications } from '@mantine/notifications';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';
import { IconCopy, IconRefresh, IconSend } from '@tabler/icons-react';
import type { Action, Blueprint, Dashboard, Fragment, Integration, Policy, Scorecard, Webhook } from '@asterius/shared';
import { blankFragment, FragmentBuilder } from '../../components/builder/FragmentBuilder';
import { useAppMutation } from '../../lib/queryClient';
import { FormEditor } from '../../components/builder/FormEditor';
import { IntegrationForm } from '../../components/builder/IntegrationForm';
import { WebhookForm } from '../../components/builder/WebhookForm';
import { api, errorText } from '../../lib/api';
import { DataTable } from '../../components/DataTable';
import { Section } from '../../components/Section';
import { SidePanel } from '../../components/SidePanel';
import { EntityIcon } from '../../components/icons';
import { Mono, TimeAgo } from '../../components/ui';
import { ResourceAdmin, strip } from './ResourceAdmin';
import { ActionBuilder } from '../../components/builder/ActionBuilder';
import { formOf } from '../../lib/permissions';
import { triggerBadge, workflowSummary } from '../../lib/workflow';
import { BlueprintBuilder } from '../../components/builder/BlueprintBuilder';
import { PolicyBuilder, ScorecardBuilder } from '../../components/builder/GovernanceBuilders';
import { DashboardBuilder } from '../../components/builder/DashboardBuilder';

const G = {
  scm: 'Source control',
  cicd: 'CI/CD & deployment',
  inc: 'Incidents & observability',
  sec: 'Security & quality',
  cloud: 'Cloud & cluster',
  id: 'Identity & ITSM',
  gen: 'Generic',
};
/** Vendor logo (components/icons names) and category of each source type; unknown types fall back to a generic icon. */
const SOURCE_LOOK: Record<string, { icon: string; group: string }> = {
  github: { icon: 'github', group: G.scm },
  gitlab: { icon: 'gitlab', group: G.scm },
  'azure-devops': { icon: 'azure-devops', group: G.scm },
  'git-descriptors': { icon: 'git-branch', group: G.scm },
  argocd: { icon: 'argo-cd', group: G.cicd },
  'terraform-cloud-workspaces': { icon: 'terraform', group: G.cicd },
  nexus: { icon: 'package', group: G.cicd },
  pagerduty: { icon: 'pagerduty', group: G.inc },
  opsgenie: { icon: 'bell', group: G.inc },
  grafana: { icon: 'grafana', group: G.inc },
  datadog: { icon: 'datadog', group: G.inc },
  snyk: { icon: 'bug', group: G.sec },
  sonarqube: { icon: 'sonarqube', group: G.sec },
  kubernetes: { icon: 'kubernetes', group: G.cloud },
  'aws-resources': { icon: 'aws', group: G.cloud },
  'azure-resource-graph': { icon: 'azure', group: G.cloud },
  'gcp-assets': { icon: 'google-cloud', group: G.cloud },
  jira: { icon: 'jira', group: G.id },
  servicenow: { icon: 'servicenow', group: G.id },
  okta: { icon: 'okta', group: G.id },
  'entra-directory': { icon: 'azure', group: G.id },
  http: { icon: 'globe', group: G.gen },
  graphql: { icon: 'globe', group: G.gen },
  sql: { icon: 'database', group: G.gen },
  external: { icon: 'plug', group: G.gen },
  webhook: { icon: 'bolt', group: G.gen },
};
const sourceLook = (type: string) => SOURCE_LOOK[type] ?? { icon: 'plug', group: G.gen };

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
              <Badge color={triggerBadge(a.trigger).color} variant="light">
                {triggerBadge(a.trigger).label}
              </Badge>
            ) : (
              <Badge color="gray" variant="outline">
                no trigger
              </Badge>
            ),
        },
        { key: 'b', label: 'Blueprint', render: (a) => (a.trigger && 'blueprint' in a.trigger ? a.trigger.blueprint : null) ?? '—' },
        { key: 'i', label: 'Steps', render: (a) => <Mono>{workflowSummary(a)}</Mono> },
        { key: 'a', label: 'Approval', render: (a) => (formOf(a)?.approval.required ? <Badge color="yellow">required</Badge> : '—') },
        { key: 'e', label: 'Enabled', render: (a) => (a.enabled ? 'yes' : <Badge color="gray">disabled</Badge>) },
      ]}
      templates={[{ label: 'Workflow', value: blankAction }]}
      editor={(p) => <ActionBuilder {...p} />}
      openPath={(a) => `/admin/actions/${encodeURIComponent(a.identifier)}`}
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
                <Badge
                  color={
                    i.lastSync.status === 'success' ? 'green' : i.lastSync.status === 'running' ? 'blue' : i.lastSync.status === 'partial' ? 'yellow' : 'red'
                  }
                >
                  {i.lastSync.status}
                </Badge>
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
        description: s.description,
        ...sourceLook(s.type),
        badge: s.type === 'webhook' ? 'webhook' : 'pull',
        keywords: [s.type],
        value: {
          identifier: '',
          title: '',
          enabled: true,
          intervalMinutes: s.type === 'webhook' ? 0 : 60,
          deleteMissing: false,
          ...s.example,
        },
      }))}
      toEditable={(i) => strip(i, ['managed', 'lastSync', 'lastSuccessAt', 'webhookUrl'])}
      save={api.saveIntegration}
      remove={(i) => api.deleteIntegration(i.identifier)}
      removeWarning={() => 'Entities it ingested stay in the catalog.'}
      editor={(p) => (
        <FormEditor
          {...p}
          title={p.isNew ? 'New integration' : `${p.readOnly ? 'View' : 'Edit'} ${String(p.value?.identifier ?? '')}`}
          form={(doc, patch) => <IntegrationForm doc={doc} patch={patch} isNew={p.isNew} />}
        />
      )}
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
    <SidePanel opened={!!integration} onClose={onClose} width="wide" title={integration?.title} subtitle={integration?.identifier} actions={<MappingSuggest />}>
      {integration && (
        <>
          {integration.webhookUrl && (
            <Section title="Webhook URL">
              <Group gap="xs" wrap="nowrap" mb={4}>
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
            </Section>
          )}
          <Section title="History">
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
          </Section>
          {syncs.data?.[0]?.logs.length ? (
            <Section title="Last run log">
              <pre className="code-block" style={{ fontSize: 12 }}>
                {syncs.data[0].logs.join('\n')}
              </pre>
            </Section>
          ) : null}
        </>
      )}
    </SidePanel>
  );
}

export function ScorecardsAdmin() {
  return (
    <ResourceAdmin<Scorecard>
      title="Scorecards"
      description="Quality rules per blueprint, grouped into levels. Rules are JSONata expressions over the entity (properties, relations, related, team)."
      queryKey="scorecards"
      list={() => api.scorecards()}
      columns={[
        { key: 'b', label: 'Blueprint', render: (s) => <Badge color="gray">{s.blueprint}</Badge> },
        { key: 'l', label: 'Levels', render: (s) => s.levels.map((l) => l.name).join(' < ') },
        { key: 'r', label: 'Rules', render: (s) => s.rules.length },
      ]}
      templates={[
        {
          label: 'Scorecard',
          value: {
            identifier: 'production-readiness',
            title: 'Production readiness',
            description: '',
            blueprint: 'service',
            levels: [
              { name: 'Bronze', color: 'orange' },
              { name: 'Silver', color: 'gray' },
              { name: 'Gold', color: 'yellow' },
            ],
            rules: [
              { identifier: 'has_owner', title: 'Has an owner team', level: 'Bronze', expression: 'team != null' },
              { identifier: 'has_docs', title: 'Links to documentation', level: 'Silver', expression: 'properties.docs != null' },
            ],
          },
        },
      ]}
      toEditable={(s) => strip(s, ['managed'])}
      editor={(p) => <ScorecardBuilder {...p} />}
      save={api.saveScorecard}
      remove={(s) => api.deleteScorecard(s.identifier)}
    />
  );
}

export function PoliciesAdmin() {
  return (
    <ResourceAdmin<Policy>
      title="Policies"
      description="Guard rails evaluated before a run is queued or an entity is written. The JSONata expression must evaluate to true to allow; errors deny."
      queryKey="policies"
      list={api.policies}
      columns={[
        {
          key: 't',
          label: 'Applies to',
          render: (p) => <Badge color={p.target === 'run' ? 'blue' : 'grape'}>{p.target === 'run' ? 'runs' : 'entity writes'}</Badge>,
        },
        {
          key: 'm',
          label: 'Match',
          render: (p) => [...(p.match.actions ?? []), ...(p.match.blueprints ?? []), ...(p.match.operations ?? [])].join(', ') || 'everything',
        },
        { key: 'e', label: 'Enabled', render: (p) => (p.enabled ? 'yes' : <Badge color="gray">disabled</Badge>) },
      ]}
      templates={[
        {
          label: 'Run policy',
          value: {
            identifier: 'no-prod-without-ticket',
            title: 'Production runs need a ticket',
            description: '',
            enabled: true,
            target: 'run',
            match: { actions: [] },
            expression: 'inputs.environment != "production" or $exists(inputs.ticket)',
            message: 'Production runs must reference a ticket ({{ action.title }})',
          },
        },
        {
          label: 'Entity policy',
          value: {
            identifier: 'service-needs-owner',
            title: 'Services need an owner team',
            description: '',
            enabled: true,
            target: 'entity',
            match: { blueprints: ['service'], operations: ['create', 'update'] },
            expression: 'entity.team != null',
            message: 'A service must have an owner team',
          },
        },
      ]}
      toEditable={(p) => strip(p, ['managed'])}
      editor={(p) => <PolicyBuilder {...p} />}
      save={api.savePolicy}
      remove={(p) => api.deletePolicy(p.identifier)}
    />
  );
}

export function FragmentsAdmin() {
  return (
    <ResourceAdmin<Fragment>
      title="Fragments"
      description="Reusable groups of steps (notify and wait for approval, open a ticket…) that workflows include with a Fragment step. Changes apply to new runs; a fragment in use cannot be deleted."
      queryKey="fragments"
      list={api.fragments}
      columns={[
        { key: 'p', label: 'Parameters', render: (f) => Object.keys(f.params.properties ?? {}).join(', ') || '—' },
        { key: 's', label: 'Steps', render: (f) => f.steps.length },
        { key: 'v', label: 'Version', render: (f) => <Badge variant="light">v{f.version}</Badge> },
        { key: 'u', label: 'Updated', render: (f) => <TimeAgo at={f.updatedAt} /> },
      ]}
      templates={[{ label: 'Fragment', value: blankFragment }]}
      toEditable={(f) => strip(f, ['managed', 'version', 'updatedAt'])}
      editor={(p) => <FragmentBuilder {...p} />}
      save={api.saveFragment}
      remove={(f) => api.deleteFragment(f.identifier)}
      removeWarning={() => 'Workflows that include it must stop using it first. Past runs keep their copy of its steps.'}
    />
  );
}

export function DashboardsAdmin() {
  return (
    <ResourceAdmin<Dashboard>
      title="Dashboards"
      description="Widgets (counts, scorecard levels, runs, approvals, saved tables, DORA insights, markdown) shown on the home page, per team, or on a blueprint's page."
      queryKey="dashboards"
      editor={(p) => <DashboardBuilder {...p} />}
      list={api.dashboards}
      columns={[
        {
          key: 'w',
          label: 'Where',
          render: (d) =>
            d.blueprint ? <Badge color="gray">{d.blueprint} page</Badge> : d.team ? <Badge>{d.team} home</Badge> : d.default ? 'Home (everyone)' : '—',
        },
        { key: 'n', label: 'Widgets', render: (d) => d.widgets.length },
      ]}
      templates={[
        {
          label: 'Home dashboard',
          value: {
            identifier: 'home',
            title: 'Home',
            description: '',
            default: true,
            widgets: [
              { type: 'count', title: 'Services', blueprint: 'service', width: 3 },
              { type: 'count', title: 'By tier', blueprint: 'service', groupBy: 'tier', width: 3 },
              { type: 'approvals', width: 6 },
              { type: 'runs', mine: true, width: 12 },
            ],
          },
        },
      ]}
      toEditable={(d) => strip(d, ['managed'])}
      save={api.saveDashboard}
      remove={(d) => api.deleteDashboard(d.identifier)}
    />
  );
}

/** Paste one item from a source, pick the target blueprint: the assistant proposes the JSONata mapping and shows the entity it gives. */
function MappingSuggest() {
  const blueprints = useQuery({ queryKey: ['blueprints'], queryFn: api.blueprints });
  const [blueprint, setBlueprint] = useState<string | null>(null);
  return (
    <AiDraft
      label="Suggest a mapping with AI"
      title="Suggest a mapping"
      help="Paste one JSON item as the source returns it and choose the blueprint it becomes. Copy the proposed mapping into the integration after checking the preview."
      placeholder='{ "name": "orders-api", "owner": { "login": "payments" }, "language": "Go" }'
      extra={
        <Select
          label="Blueprint"
          data={(blueprints.data ?? []).map((b) => ({ value: b.identifier, label: b.title }))}
          value={blueprint}
          onChange={setBlueprint}
          searchable
        />
      }
      disabled={!blueprint && !blueprints.data?.length}
      run={(text) => api.aiSuggestMapping({ blueprint: blueprint ?? '', sample: JSON.parse(text) as unknown })}
      preview={(d) => <JsonPreview value={{ mapping: d.mapping, preview: d.preview }} />}
      onDraft={(d) => void navigator.clipboard?.writeText(JSON.stringify(d.mapping, null, 2)).then(() => notifications.show({ message: 'Mapping copied' }))}
    />
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
            identifier: '',
            title: '',
            url: '',
            events: ['entity.*', 'run.updated'],
            blueprints: [],
            secret: null,
            enabled: true,
          },
        },
      ]}
      toEditable={async (w) => strip(await api.webhook(w.identifier), ['managed', 'hasSecret', 'hasSecondarySecret'])}
      save={api.saveWebhook}
      remove={(w) => api.deleteWebhook(w.identifier)}
      editor={(p) => (
        <FormEditor
          {...p}
          title={p.isNew ? 'New webhook' : `${p.readOnly ? 'View' : 'Edit'} ${String(p.value?.identifier ?? '')}`}
          form={(doc, patch) => <WebhookForm doc={doc} patch={patch} isNew={p.isNew} />}
        />
      )}
    >
      <DeliveriesDrawer webhook={detail} onClose={() => setDetail(null)} />
    </ResourceAdmin>
  );
}

function DeliveriesDrawer({ webhook, onClose }: { webhook: Webhook | null; onClose: () => void }) {
  const qc = useQueryClient();
  const redeliver = useAppMutation({
    mutationFn: (id: string) => api.redeliver(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['deliveries'] }),
  });
  const q = useQuery({
    queryKey: ['deliveries', webhook?.identifier],
    queryFn: () => api.deliveries(webhook!.identifier),
    enabled: !!webhook,
    refetchInterval: 5000,
  });
  return (
    <SidePanel opened={!!webhook} onClose={onClose} width="wide" flush title="Deliveries" subtitle={webhook?.title}>
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
                  <ActionIcon variant="subtle" aria-label="Redeliver" onClick={() => redeliver.mutate(d.id)}>
                    <IconSend size={16} />
                  </ActionIcon>
                </Tooltip>
              ) : null,
          },
        ]}
      />
    </SidePanel>
  );
}
