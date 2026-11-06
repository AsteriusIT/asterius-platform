import { useState } from 'react';
import { Badge, Button, Group, Select, Stack, Text, TextInput } from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useNavigate, useParams, useSearchParams } from 'react-router';
import { IconPlus, IconSearch } from '@tabler/icons-react';
import type { Action, Blueprint, Entity } from '@asterius/shared';
import { api } from '../lib/api';
import { isRunnable } from '../lib/permissions';
import { useAuth } from '../lib/auth';
import { DataTable, type Column } from '../components/DataTable';
import { PropertyValue } from '../components/PropertyValue';
import { orderedFields } from '../components/SchemaForm';
import { AskCatalog } from '../components/AiAssistant';
import { ActionRunModal } from '../components/ActionRunModal';
import { EntityActionsMenu } from '../components/EntityActionsMenu';
import { Markdown, PageHeader, QueryView, TimeAgo } from '../components/ui';

const PAGE = 25;

/** Table columns: title, team, the first visible properties, last update. */
function columnsFor(bp: Blueprint): Column<Entity>[] {
  const props = orderedFields(bp.schema)
    .filter((k) => !bp.schema.properties[k].hidden && bp.schema.properties[k].format !== 'markdown')
    .slice(0, 5);
  return [
    {
      key: 'title',
      label: 'Name',
      render: (e) => (
        <div>
          <Text fz="sm" fw={500}>
            {e.title}
          </Text>
          {e.title !== e.identifier && (
            <Text fz="xs" c="dimmed">
              {e.identifier}
            </Text>
          )}
        </div>
      ),
    },
    { key: 'team', label: 'Team', render: (e) => (e.team ? <Badge color="gray">{e.team}</Badge> : <Text c="dimmed">—</Text>) },
    ...props.map((k) => ({
      key: k,
      label: bp.schema.properties[k].title ?? k,
      render: (e: Entity) => <PropertyValue schema={bp.schema.properties[k]} value={e.properties[k]} compact />,
    })),
    { key: 'updated', label: 'Updated', render: (e) => <TimeAgo at={e.updatedAt} /> },
  ];
}

export function CatalogList() {
  const { bp = '' } = useParams();
  const blueprint = useQuery({ queryKey: ['blueprint', bp], queryFn: () => api.blueprint(bp) });
  return <QueryView q={blueprint}>{(b) => <CatalogTable key={b.identifier} bp={b} />}</QueryView>;
}

function CatalogTable({ bp }: { bp: Blueprint }) {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const [search, setSearch] = useState(params.get('q') ?? '');
  const [debounced] = useDebouncedValue(search, 250);
  const page = Number(params.get('page') ?? 1);
  const team = params.get('team');
  const [runAction, setRunAction] = useState<Action | null>(null);
  const [runOn, setRunOn] = useState<Entity | null>(null);
  const { user } = useAuth();
  const teams = useQuery({ queryKey: ['teams'], queryFn: api.teams, staleTime: 60_000 });
  const createActions = useQuery({
    queryKey: ['actions', bp.identifier, 'create'],
    queryFn: async () => (await api.actions({ blueprint: bp.identifier, trigger: 'create' })).filter(isRunnable),
  });
  // Day-2 / delete actions of this blueprint, loaded once for the "⋯" menu of every row.
  const entityActions = useQuery({
    queryKey: ['actions', bp.identifier, 'entity'],
    queryFn: async () => (await api.actions({ blueprint: bp.identifier })).filter((a) => a.trigger?.on !== 'create' && a.enabled && isRunnable(a)),
  });
  const runOnEntity = (a: Action, e: Entity) => {
    setRunOn(e);
    setRunAction(a);
  };
  const columns: Column<Entity>[] = [
    ...columnsFor(bp),
    ...(entityActions.data?.length
      ? [
          {
            key: 'actions',
            label: '',
            width: 48,
            render: (e: Entity) => <EntityActionsMenu entity={e} actions={entityActions.data!} user={user} onRun={(a) => runOnEntity(a, e)} />,
          },
        ]
      : []),
  ];
  const entities = useQuery({
    queryKey: ['entities', bp.identifier, debounced, team, page],
    queryFn: () => api.entities({ blueprint: bp.identifier, search: debounced, team: team ?? undefined, limit: PAGE, offset: (page - 1) * PAGE }),
    placeholderData: keepPreviousData,
  });

  const set = (k: string, v: string | null) => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v);
    else next.delete(k);
    if (k !== 'page') next.delete('page');
    setParams(next, { replace: true });
  };

  return (
    <Stack>
      <PageHeader
        title={bp.title}
        icon={bp.icon}
        description={bp.description ? <Markdown>{bp.description}</Markdown> : undefined}
        actions={createActions.data
          ?.filter((a) => a.allowedForMe)
          .map((a) => (
            <Button
              key={a.identifier}
              leftSection={<IconPlus size={16} />}
              onClick={() => {
                setRunOn(null);
                setRunAction(a);
              }}
            >
              {a.title}
            </Button>
          ))}
      />
      <AskCatalog />
      <Group>
        <TextInput
          placeholder={`Search ${bp.title.toLowerCase()}`}
          leftSection={<IconSearch size={16} />}
          value={search}
          onChange={(e) => {
            setSearch(e.currentTarget.value);
            set('page', null);
          }}
          style={{ flex: 1, maxWidth: 360 }}
        />
        <Select
          placeholder="All teams"
          clearable
          data={(teams.data ?? []).map((t) => ({ value: t.identifier, label: t.title }))}
          value={team}
          onChange={(v) => set('team', v)}
          w={200}
        />
      </Group>
      <DataTable
        columns={columns}
        rows={entities.data?.items}
        loading={entities.isPending}
        error={entities.error}
        rowKey={(e) => e.identifier}
        onRowClick={(e) => navigate(`/catalog/${bp.identifier}/${encodeURIComponent(e.identifier)}`)}
        empty={debounced || team ? 'No match' : `No ${bp.title.toLowerCase()} yet`}
        page={{ page, pageSize: PAGE, total: entities.data?.total ?? 0, onChange: (p) => set('page', String(p)) }}
      />
      <ActionRunModal action={runAction} entity={runOn} onClose={() => setRunAction(null)} />
    </Stack>
  );
}

/** Global search across blueprints (header search box). */
export function Search() {
  const [params] = useSearchParams();
  const q = params.get('q') ?? '';
  const navigate = useNavigate();
  const res = useQuery({ queryKey: ['search', q], queryFn: () => api.entities({ search: q, limit: 100 }) });
  return (
    <Stack>
      <PageHeader title={`Results for “${q}”`} description={res.data ? `${res.data.total} entities` : undefined} />
      <DataTable
        rows={res.data?.items}
        loading={res.isPending}
        error={res.error}
        rowKey={(e) => `${e.blueprint}/${e.identifier}`}
        onRowClick={(e) => navigate(`/catalog/${e.blueprint}/${encodeURIComponent(e.identifier)}`)}
        empty="No match"
        columns={[
          {
            key: 'n',
            label: 'Name',
            render: (e) => (
              <Text fz="sm" fw={500}>
                {e.title}
              </Text>
            ),
          },
          { key: 'b', label: 'Type', render: (e) => <Badge color="gray">{e.blueprint}</Badge> },
          {
            key: 'i',
            label: 'Identifier',
            render: (e) => (
              <Text fz="sm" c="dimmed">
                {e.identifier}
              </Text>
            ),
          },
          { key: 't', label: 'Team', render: (e) => e.team ?? '—' },
          { key: 'u', label: 'Updated', render: (e) => <TimeAgo at={e.updatedAt} /> },
        ]}
      />
    </Stack>
  );
}
