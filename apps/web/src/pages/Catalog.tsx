import { useEffect, useMemo, useState } from 'react';
import { Badge, Button, Group, Menu, Select, Stack, Text, TextInput } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useDebouncedValue } from '@mantine/hooks';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams, useSearchParams } from 'react-router';
import { IconBolt, IconDownload, IconPlus, IconSearch } from '@tabler/icons-react';
import type { Action, Blueprint, Entity } from '@asterius/shared';
import { api } from '../lib/api';
import { formOf, isRunnable } from '../lib/permissions';
import { useAuth } from '../lib/auth';
import { DataTable, type Column } from '../components/DataTable';
import { ColumnPicker, FilterBar, ViewsMenu } from '../components/CatalogToolbar';
import {
  downloadText,
  formatFilters,
  formatSort,
  listableProps,
  loadColumns,
  loadViews,
  nextSort,
  parseFilters,
  parseSort,
  saveColumns,
  saveViews,
  toApiSort,
  toCsv,
  type SavedView,
} from '../lib/catalogView';
import { useUrlParams } from '../lib/urlState';
import { canRunOn } from '../lib/permissions';
import { notifyError } from '../lib/queryClient';
import { PropertyValue } from '../components/PropertyValue';
import { orderedFields } from '../components/SchemaForm';
import { DashboardView } from '../components/DashboardView';
import { EntityEditor } from '../components/EntityEditor';
import { AskCatalog } from '../components/AiAssistant';
import { ActionRunModal } from '../components/ActionRunModal';
import { EntityActionsMenu } from '../components/EntityActionsMenu';
import { LevelBadge, Markdown, PageHeader, QueryView, TimeAgo } from '../components/ui';

const PAGE = 25;

/** Table columns: title, team, the first visible properties, last update. */
const defaultProps = (bp: Blueprint) => orderedFields(bp.schema).filter((k) => listableProps(bp).includes(k));

function columnsFor(bp: Blueprint, props: string[]): Column<Entity>[] {
  return [
    {
      key: 'title',
      label: 'Name',
      sortable: true,
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
    { key: 'team', label: 'Team', sortable: true, render: (e) => (e.team ? <Badge color="gray">{e.team}</Badge> : <Text c="dimmed">—</Text>) },
    ...props.map((k) => ({
      key: k,
      label: bp.schema.properties[k].title ?? k,
      sortable: true,
      render: (e: Entity) => <PropertyValue schema={bp.schema.properties[k]} value={e.properties[k]} compact />,
    })),
    ...Object.entries(bp.computed ?? {})
      .slice(0, 3)
      .map(([k, c]) => ({ key: `computed-${k}`, label: c.title ?? k, render: (e: Entity) => <PropertyValue value={e.computed?.[k]} compact /> })),
    { key: 'updated', label: 'Updated', sortable: true, render: (e) => <TimeAgo at={e.updatedAt} /> },
  ];
}

export function CatalogList() {
  const { bp = '' } = useParams();
  const blueprint = useQuery({ queryKey: ['blueprint', bp], queryFn: () => api.blueprint(bp) });
  return <QueryView q={blueprint}>{(b) => <CatalogTable key={b.identifier} bp={b} />}</QueryView>;
}

function CatalogTable({ bp }: { bp: Blueprint }) {
  const [params, set, setParams] = useUrlParams();
  const navigate = useNavigate();
  const [search, setSearch] = useState(params.get('q') ?? '');
  const [debounced] = useDebouncedValue(search, 250);
  const page = Number(params.get('page') ?? 1);
  const team = params.get('team');
  const [runAction, setRunAction] = useState<Action | null>(null);
  const [runOn, setRunOn] = useState<Entity | null>(null);
  const { user, isAdmin } = useAuth();
  const [creating, setCreating] = useState(false);
  const qc = useQueryClient();
  const canCreate = isAdmin || (user?.teams.length ?? 0) > 0;
  const teams = useQuery({ queryKey: ['teams'], queryFn: api.teams, staleTime: 60_000 });
  const createActions = useQuery({
    queryKey: ['actions', bp.identifier, 'create'],
    queryFn: async () => (await api.actions({ blueprint: bp.identifier, trigger: 'create' })).filter(isRunnable),
  });
  // Day-2 / delete actions of this blueprint, loaded once for the "⋯" menu of every row.
  const entityActions = useQuery({
    queryKey: ['actions', bp.identifier, 'entity'],
    queryFn: async () =>
      (await api.actions({ blueprint: bp.identifier })).filter((a) => !!formOf(a) && formOf(a)?.on !== 'create' && a.enabled && isRunnable(a)),
  });
  const runOnEntity = (a: Action, e: Entity) => {
    setRunOn(e);
    setRunAction(a);
  };
  const allProps = useMemo(() => defaultProps(bp), [bp]);
  const [pickedCols, setPickedCols] = useState<string[] | null>(() => loadColumns(bp.identifier));
  const visibleProps = (pickedCols ?? allProps.slice(0, 5)).filter((k) => allProps.includes(k));
  const sort = parseSort(params.get('sort'));
  const filters = useMemo(() => parseFilters(params.getAll('f')), [params]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [views, setViews] = useState<SavedView[]>(() => loadViews(bp.identifier));
  const baseColumns: Column<Entity>[] = [
    ...columnsFor(bp, visibleProps),
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
  const dashboard = useQuery({ queryKey: ['dashboard-resolve', bp.identifier], queryFn: () => api.resolveDashboard(bp.identifier) });
  const cards = useQuery({ queryKey: ['scorecards', bp.identifier], queryFn: () => api.scorecards(bp.identifier), staleTime: 60_000 });
  const entities = useQuery({
    queryKey: ['entities', bp.identifier, debounced, team, page, sort, filters],
    queryFn: () => api.entities({ blueprint: bp.identifier, ...viewQuery(), limit: PAGE, offset: (page - 1) * PAGE }),
    placeholderData: keepPreviousData,
  });

  const ids = (entities.data?.items ?? []).map((e) => e.identifier);
  const levels = useQuery({
    queryKey: ['scorecard-levels', bp.identifier, ids],
    queryFn: () => api.scorecardLevels(bp.identifier, ids),
    enabled: !!cards.data?.length && ids.length > 0,
  });
  const columns = [
    ...baseColumns,
    ...(cards.data ?? []).map((sc) => ({
      key: `sc-${sc.identifier}`,
      label: sc.title,
      render: (e: Entity) => (
        <LevelBadge
          level={levels.data?.[sc.identifier]?.[e.identifier]}
          color={sc.levels.find((l) => l.name === levels.data?.[sc.identifier]?.[e.identifier])?.color}
        />
      ),
    })),
  ];

  /** Search, team, sort and filters shared by the table and the CSV export. */
  const viewQuery = () => ({
    search: debounced,
    team: team ?? undefined,
    sort: sort ? toApiSort(sort.key, allProps) : undefined,
    order: sort?.dir,
    filters,
  });

  const setFilters = (next: Record<string, string>) =>
    setParams(
      (prev) => {
        const out = new URLSearchParams(prev);
        out.delete('f');
        out.delete('page');
        for (const f of formatFilters(next)) out.append('f', f);
        return out;
      },
      { replace: true },
    );

  const exportCsv = async () => {
    try {
      const res = await api.entities({ blueprint: bp.identifier, ...viewQuery(), limit: 1000, offset: 0 });
      downloadText(`${bp.identifier}.csv`, toCsv(res.items, visibleProps));
      if ((res.total ?? 0) > res.items.length) notifications.show({ color: 'yellow', message: `Exported the first ${res.items.length} of ${res.total} rows` });
    } catch (e) {
      notifyError(e, 'Export failed');
    }
  };

  const saveView = (name: string) => {
    const search = new URLSearchParams(params);
    search.delete('page');
    const next = [...views.filter((v) => v.name !== name), { name, search: search.toString() }];
    setViews(next);
    saveViews(bp.identifier, next);
  };
  const deleteView = (name: string) => {
    const next = views.filter((v) => v.name !== name);
    setViews(next);
    saveViews(bp.identifier, next);
  };

  const selectedEntities = (entities.data?.items ?? []).filter((e) => selected.has(e.identifier));
  // Bulk actions: day-2 / delete actions that need no input.
  const bulkActions = (entityActions.data ?? []).filter((a) => !!formOf(a) && !formOf(a)?.inputs.required?.length);
  const [bulkBusy, setBulkBusy] = useState(false);
  const runBulk = async (a: Action) => {
    setBulkBusy(true);
    const targets = selectedEntities.filter((e) => canRunOn(a, user, e.team));
    const results = await Promise.allSettled(targets.map((e) => api.trigger(a.identifier, { entity: e.identifier, inputs: {} })));
    const failed = results.filter((r) => r.status === 'rejected').length;
    notifications.show({
      color: failed ? 'orange' : 'green',
      message: `${a.title}: started ${targets.length - failed} run(s)${failed ? `, ${failed} failed` : ''}${targets.length < selectedEntities.length ? `, ${selectedEntities.length - targets.length} not allowed` : ''}`,
    });
    setBulkBusy(false);
    setSelected(new Set());
    void qc.invalidateQueries({ queryKey: ['entities'] });
    void qc.invalidateQueries({ queryKey: ['runs'] });
  };

  // Persist the (debounced) search text in the URL so it survives reloads and can be shared.
  const urlQ = params.get('q') ?? '';
  useEffect(() => {
    if (debounced !== urlQ) set('q', debounced || null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debounced]);

  return (
    <Stack>
      <PageHeader
        title={bp.title}
        icon={bp.icon}
        refresh={entities}
        description={bp.description ? <Markdown>{bp.description}</Markdown> : undefined}
        actions={
          <>
            {canCreate && (
              <Button variant="default" leftSection={<IconPlus size={16} />} onClick={() => setCreating(true)}>
                New entity
              </Button>
            )}
            {createActions.data
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
          </>
        }
      />
      {dashboard.data && <DashboardView dashboard={dashboard.data} />}
      <AskCatalog />
      <Group>
        <TextInput
          placeholder={`Search ${bp.title.toLowerCase()}`}
          leftSection={<IconSearch size={16} />}
          value={search}
          onChange={(e) => setSearch(e.currentTarget.value)}
          aria-label={`Search ${bp.title.toLowerCase()}`}
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
        <ViewsMenu
          views={views}
          onApply={(v) => setParams(new URLSearchParams(v.search), { replace: true })}
          onSave={saveView}
          onDelete={deleteView}
          onCopyLink={() => {
            void navigator.clipboard?.writeText(window.location.href);
            notifications.show({ message: 'Link copied' });
          }}
        />
        <ColumnPicker
          bp={bp}
          props={allProps}
          visible={visibleProps}
          onChange={(cols) => {
            setPickedCols(cols);
            saveColumns(bp.identifier, cols);
          }}
        />
        <Button variant="default" leftSection={<IconDownload size={16} />} onClick={() => void exportCsv()}>
          Export CSV
        </Button>
      </Group>
      <FilterBar bp={bp} props={allProps} filters={filters} onChange={setFilters} />
      {selectedEntities.length > 0 && (
        <Group gap="sm">
          <Text fz="sm">{selectedEntities.length} selected</Text>
          <Menu position="bottom-start">
            <Menu.Target>
              <Button size="xs" leftSection={<IconBolt size={14} />} loading={bulkBusy} disabled={!bulkActions.length}>
                Run action
              </Button>
            </Menu.Target>
            <Menu.Dropdown>
              {bulkActions.map((a) => (
                <Menu.Item key={a.identifier} color={formOf(a)?.on === 'delete' ? 'red' : undefined} onClick={() => void runBulk(a)}>
                  {a.title}
                </Menu.Item>
              ))}
            </Menu.Dropdown>
          </Menu>
          <Button size="xs" variant="subtle" onClick={() => setSelected(new Set())}>
            Clear
          </Button>
        </Group>
      )}
      <DataTable
        sort={{ value: sort, onChange: (key) => set('sort', formatSort(nextSort(sort, key))) }}
        selection={bulkActions.length ? { selected, onChange: setSelected } : undefined}
        columns={columns}
        rows={entities.data?.items}
        loading={entities.isPending}
        error={entities.error}
        rowKey={(e) => e.identifier}
        onRowClick={(e) => navigate(`/catalog/${bp.identifier}/${encodeURIComponent(e.identifier)}`)}
        empty={debounced || team || Object.keys(filters).length ? 'No match' : `No ${bp.title.toLowerCase()} yet`}
        page={{ page, pageSize: PAGE, total: entities.data?.total ?? 0, onChange: (p) => set('page', String(p)) }}
      />
      <ActionRunModal action={runAction} entity={runOn} onClose={() => setRunAction(null)} />
      <EntityEditor
        blueprint={bp}
        opened={creating}
        onClose={() => setCreating(false)}
        onSaved={(e) => {
          void qc.invalidateQueries({ queryKey: ['entities'] });
          navigate(`/catalog/${bp.identifier}/${encodeURIComponent(e.identifier)}`);
        }}
      />
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
      <PageHeader title={`Results for “${q}”`} description={res.data ? `${res.data.total} entities` : undefined} refresh={res} />
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
