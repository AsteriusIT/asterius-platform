import { useState } from 'react';
import { Badge, Button, Card, Grid, Group, Menu, SegmentedControl, Stack, Tabs, Text, Tooltip } from '@mantine/core';
import { modals } from '@mantine/modals';
import { notifications } from '@mantine/notifications';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams, useSearchParams } from 'react-router';
import { IconDots, IconPencil, IconTrash } from '@tabler/icons-react';
import type { Action, Blueprint, Entity } from '@asterius/shared';
import { api, errorText } from '../lib/api';
import { useAuth } from '../lib/auth';
import { formOf } from '../lib/permissions';
import { DashboardView } from '../components/DashboardView';
import { EntityProperties, entityLinks, LinkList, RelationGroups, ScorecardRules } from '../components/EntitySections';
import { ActionRunModal } from '../components/ActionRunModal';
import { EntityHistory } from '../components/EntityHistory';
import { DataTable } from '../components/DataTable';
import { EntityEditor } from '../components/EntityEditor';
import { CodeBlock } from '../components/CodeEditor';
import { EntityIcon } from '../components/icons';
import { RelationGraph } from '../components/RelationGraph';
import { Markdown, Mono, PageHeader, QueryView, StatusBadge, TimeAgo } from '../components/ui';
import { UserChip } from '../components/UserChip';

export function EntityPage() {
  const { bp = '', id = '' } = useParams();
  const blueprint = useQuery({ queryKey: ['blueprint', bp], queryFn: () => api.blueprint(bp) });
  const entity = useQuery({ queryKey: ['entity', bp, id], queryFn: () => api.entity(bp, id) });
  return <QueryView q={blueprint}>{(b) => <QueryView q={entity}>{(e) => <EntityView bp={b} e={e} />}</QueryView>}</QueryView>;
}

const TABS = ['overview', 'docs', 'graph', 'history', 'runs', 'json'];

function EntityView({ bp, e }: { bp: Blueprint; e: Entity }) {
  const { user, isAdmin } = useAuth();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [runAction, setRunAction] = useState<Action | null>(null);
  const [editing, setEditing] = useState(false);
  const [params, setParams] = useSearchParams();
  const tab = TABS.includes(params.get('tab') ?? '') ? params.get('tab')! : 'overview';
  const links = entityLinks(bp, e);
  // An entity-page dashboard of the blueprint (`scope: entity`) replaces the built-in overview.
  const dashboard = useQuery({
    queryKey: ['dashboard-resolve', bp.identifier, 'entity'],
    queryFn: () => api.resolveDashboard(bp.identifier, 'entity'),
    staleTime: 60_000,
  });
  const hasDocs = Object.entries(bp.schema.properties).some(([k, p]) => p.format === 'docs' && typeof e.properties[k] === 'string' && !!e.properties[k]);
  const related = useQuery({ queryKey: ['related', bp.identifier, e.identifier], queryFn: () => api.related(bp.identifier, e.identifier) });
  const actions = useQuery({ queryKey: ['entity-actions', bp.identifier, e.identifier], queryFn: () => api.entityActions(bp.identifier, e.identifier) });
  const runs = useQuery({
    queryKey: ['runs', 'entity', bp.identifier, e.identifier],
    queryFn: () => api.runs({ blueprint: bp.identifier, entity: e.identifier, limit: 20 }),
    refetchInterval: 15_000,
  });
  const scorecards = useQuery({
    queryKey: ['entity-scorecards', bp.identifier, e.identifier],
    queryFn: () => api.entityScorecards(bp.identifier, e.identifier),
  });
  const canEdit = (isAdmin || (!!e.team && user?.teams.some((t) => t.identifier === e.team))) && !e.source.startsWith('integration:');

  const day2 = (actions.data ?? []).filter((a) => formOf(a)?.on === 'day-2');
  const deletes = (actions.data ?? []).filter((a) => formOf(a)?.on === 'delete');

  const remove = () =>
    modals.openConfirmModal({
      title: `Delete ${e.title}?`,
      children: (
        <Text fz="sm">
          This removes the entity from the catalog only (an admin can restore it for a limited time). Use a decommission action to also remove the real
          resources.
        </Text>
      ),
      labels: { confirm: 'Delete', cancel: 'Cancel' },
      confirmProps: { color: 'red' },
      onConfirm: async () => {
        try {
          await api.deleteEntity(bp.identifier, e.identifier);
          void qc.invalidateQueries({ queryKey: ['entities'] });
          navigate(`/catalog/${bp.identifier}`);
        } catch (err) {
          notifications.show({ color: 'red', message: errorText(err) });
        }
      },
    });

  return (
    <Stack>
      <PageHeader
        crumbs={[{ label: 'Catalog', to: '/catalog' }, { label: bp.title, to: `/catalog/${bp.identifier}` }, { label: e.identifier }]}
        title={e.title}
        icon={bp.icon}
        refresh={[related, actions, runs, { refetch: () => qc.refetchQueries({ queryKey: ['entity', bp.identifier, e.identifier] }) }]}
        description={
          <Group gap="xs" component="span">
            {e.team && <Badge color="gray">{e.team}</Badge>}
            <Text span fz="sm" c="dimmed">
              source <Mono>{e.source}</Mono> · updated <TimeAgo at={e.updatedAt} />
            </Text>
          </Group>
        }
        actions={
          <>
            {day2.map((a) => (
              <Tooltip
                key={a.identifier}
                label={a.allowedForMe ? a.description : 'You are not allowed to run this action'}
                disabled={!a.description && a.allowedForMe}
                multiline
                w={260}
              >
                <Button
                  variant="light"
                  color="gray"
                  c="var(--mantine-color-text)"
                  leftSection={<EntityIcon name={a.icon} size={16} />}
                  disabled={!a.allowedForMe}
                  onClick={() => setRunAction(a)}
                >
                  {a.title}
                </Button>
              </Tooltip>
            ))}
            {(canEdit || deletes.length > 0) && (
              <Menu position="bottom-end">
                <Menu.Target>
                  <Button variant="default" px="xs" aria-label="More">
                    <IconDots size={18} />
                  </Button>
                </Menu.Target>
                <Menu.Dropdown>
                  {canEdit && (
                    <Menu.Item leftSection={<IconPencil size={16} />} onClick={() => setEditing(true)}>
                      Edit
                    </Menu.Item>
                  )}
                  {deletes.map((a) => (
                    <Menu.Item
                      key={a.identifier}
                      color="red"
                      leftSection={<EntityIcon name={a.icon} size={16} />}
                      disabled={!a.allowedForMe}
                      onClick={() => setRunAction(a)}
                    >
                      {a.title}
                    </Menu.Item>
                  ))}
                  {canEdit && (
                    <Menu.Item color="red" leftSection={<IconTrash size={16} />} onClick={remove}>
                      Delete from catalog
                    </Menu.Item>
                  )}
                </Menu.Dropdown>
              </Menu>
            )}
          </>
        }
      />

      <Tabs value={tab} onChange={(t) => setParams(t && t !== 'overview' ? { tab: t } : {}, { replace: true })} keepMounted={false}>
        <Tabs.List mb="md">
          <Tabs.Tab value="overview">Overview</Tabs.Tab>
          {hasDocs && <Tabs.Tab value="docs">Docs</Tabs.Tab>}
          <Tabs.Tab value="graph">Graph</Tabs.Tab>
          <Tabs.Tab value="history">History</Tabs.Tab>
          <Tabs.Tab value="runs" rightSection={runs.data?.total ? <Badge size="xs">{runs.data.total}</Badge> : undefined}>
            Runs
          </Tabs.Tab>
          <Tabs.Tab value="json">Raw</Tabs.Tab>
        </Tabs.List>

        <Tabs.Panel value="overview">
          {dashboard.data ? (
            <DashboardView dashboard={dashboard.data} entity={e} blueprint={bp} />
          ) : (
            <Grid>
              <Grid.Col span={{ base: 12, md: 7 }}>
                <Card>
                  <Text fw={600} mb="sm">
                    Properties
                  </Text>
                  <EntityProperties bp={bp} e={e} />
                </Card>
              </Grid.Col>
              <Grid.Col span={{ base: 12, md: 5 }}>
                <Stack>
                  {(scorecards.data ?? []).map((sc) => (
                    <Card key={sc.scorecard}>
                      <ScorecardRules result={sc} />
                    </Card>
                  ))}
                  {links.length > 0 && (
                    <Card>
                      <Text fw={600} mb="xs">
                        Links
                      </Text>
                      <LinkList links={links} />
                    </Card>
                  )}
                  <QueryView q={related}>
                    {(rel) => (
                      <>
                        <Card>
                          <Text fw={600} mb="sm">
                            Relations
                          </Text>
                          <RelationGroups groups={Object.entries(bp.relations).map(([name, r]) => [r.title ?? name, rel.outgoing[name] ?? []])} />
                        </Card>
                        <Card>
                          <Text fw={600} mb="sm">
                            Referenced by
                          </Text>
                          <RelationGroups groups={Object.entries(rel.incoming).map(([k, list]) => [rel.incomingTitles?.[k] ?? k.replace('.', ' · '), list])} />
                        </Card>
                      </>
                    )}
                  </QueryView>
                </Stack>
              </Grid.Col>
            </Grid>
          )}
        </Tabs.Panel>

        {hasDocs && (
          <Tabs.Panel value="docs">
            <DocsPanel bp={bp.identifier} id={e.identifier} />
          </Tabs.Panel>
        )}

        <Tabs.Panel value="graph">
          <GraphPanel bp={bp.identifier} id={e.identifier} />
        </Tabs.Panel>

        <Tabs.Panel value="runs">
          <DataTable
            rows={runs.data?.items}
            loading={runs.isPending}
            error={runs.error}
            rowKey={(r) => r.id}
            onRowClick={(r) => navigate(`/runs/${r.id}`)}
            empty="No action has run on this entity yet"
            columns={[
              {
                key: 'a',
                label: 'Action',
                render: (r) => (
                  <Text fz="sm" fw={500}>
                    {r.actionTitle}
                  </Text>
                ),
              },
              { key: 's', label: 'Status', render: (r) => <StatusBadge status={r.status} label={r.statusLabel} /> },
              { key: 'u', label: 'By', render: (r) => <UserChip user={r.triggeredBy} /> },
              { key: 't', label: 'When', render: (r) => <TimeAgo at={r.createdAt} /> },
            ]}
          />
        </Tabs.Panel>

        <Tabs.Panel value="history">
          <EntityHistory blueprint={bp.identifier} identifier={e.identifier} canEdit={!!canEdit} />
        </Tabs.Panel>

        <Tabs.Panel value="json">
          <Card>
            <CodeBlock code={JSON.stringify(e, null, 2)} />
          </Card>
        </Tabs.Panel>
      </Tabs>

      <ActionRunModal action={runAction} entity={e} onClose={() => setRunAction(null)} />
      <EntityEditor
        blueprint={bp}
        entity={e}
        opened={editing}
        onClose={() => setEditing(false)}
        onSaved={(saved) => {
          qc.setQueryData(['entity', bp.identifier, e.identifier], saved);
          void qc.invalidateQueries({ queryKey: ['related'] });
          void qc.invalidateQueries({ queryKey: ['history'] });
          void qc.invalidateQueries({ queryKey: ['entity-scorecards'] });
          void qc.invalidateQueries({ queryKey: ['dashboard-data'] });
        }}
      />
    </Stack>
  );
}

function DocsPanel({ bp, id }: { bp: string; id: string }) {
  const q = useQuery({ queryKey: ['entity-docs', bp, id], queryFn: () => api.entityDocs(bp, id) });
  return (
    <QueryView q={q}>
      {(d) => (
        <Card withBorder>
          <Markdown baseUrl={d.url}>{d.markdown}</Markdown>
        </Card>
      )}
    </QueryView>
  );
}

function GraphPanel({ bp, id }: { bp: string; id: string }) {
  const [depth, setDepth] = useState('2');
  const q = useQuery({ queryKey: ['entity-graph', bp, id, depth], queryFn: () => api.entityGraph(bp, id, Number(depth)) });
  return (
    <Card>
      <Group justify="space-between" mb="sm">
        <Text fw={600}>Relations</Text>
        <SegmentedControl
          size="xs"
          value={depth}
          onChange={setDepth}
          aria-label="Depth"
          data={[
            { value: '1', label: '1 hop' },
            { value: '2', label: '2 hops' },
            { value: '3', label: '3 hops' },
          ]}
        />
      </Group>
      <QueryView q={q}>{(g) => <RelationGraph graph={g} />}</QueryView>
    </Card>
  );
}
