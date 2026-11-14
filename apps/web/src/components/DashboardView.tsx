import { Anchor, Badge, Card, Grid, Group, Progress, SimpleGrid, Stack, Text, Title } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router';
import type { Blueprint, Dashboard, DashboardWidget, DoraBand, Entity, WidgetData } from '@asterius/shared';
import { api } from '../lib/api';
import { ChartWidget } from './ChartWidget';
import { DataTable } from './DataTable';
import { EntityProperties, entityLinks, EntityRelations, EntityScorecards, LinkList } from './EntitySections';
import { PropertyValue } from './PropertyValue';
import { Empty, ErrorAlert, Loading, Markdown, StatusBadge, StatValue, TimeAgo } from './ui';
import { deadlineLabel, pct, STATUS_LOOK, teamLabel } from '../lib/initiatives';

type Data<T extends string> = Extract<WidgetData, { type: T }>;

const LEVEL_COLORS = ['orange', 'gray', 'yellow', 'teal', 'blue', 'grape', 'pink', 'cyan'];

/** The entity an entity-page dashboard is shown for, with its blueprint (`entity` widgets render its sections). */
interface EntityCtx {
  entity: Entity;
  blueprint: Blueprint;
}

/**
 * Renders a dashboard: its widgets in a 12-column grid, data computed by the server for the viewer. On an entity page
 * (`scope: entity`) pass the entity: the server filters the widgets to it.
 */
export function DashboardView({ dashboard, entity, blueprint }: { dashboard: Dashboard; entity?: Entity; blueprint?: Blueprint }) {
  const ctx = entity && blueprint ? { entity, blueprint } : undefined;
  const data = useQuery({
    queryKey: ['dashboard-data', dashboard.identifier, entity?.identifier ?? null],
    queryFn: () => api.dashboardData(dashboard.identifier, entity?.identifier),
    refetchInterval: 60_000,
  });
  if (data.isPending) return <Loading />;
  if (data.error) return <ErrorAlert error={data.error} />;
  return (
    <Grid>
      {dashboard.widgets.map((w, i) => (
        <Grid.Col key={i} span={{ base: 12, md: w.width }}>
          <Widget widget={w} data={data.data[i]} ctx={ctx} />
        </Grid.Col>
      ))}
    </Grid>
  );
}

const DEFAULT_TITLES: Partial<Record<string, string>> = {
  runs: 'Runs',
  approvals: 'Waiting for approval',
  chart: 'Trend',
};
const ENTITY_TITLES = { properties: 'Properties', scorecards: 'Scorecards', relations: 'Relations', links: 'Links' } as const;

function Widget({ widget, data, ctx }: { widget: DashboardWidget; data: WidgetData | undefined; ctx?: EntityCtx }) {
  const title = widget.title ?? (widget.type === 'entity' ? ENTITY_TITLES[widget.show] : DEFAULT_TITLES[widget.type]);
  // Markdown of an entity-page dashboard comes back rendered (its `{{ }}` templates evaluated over the entity).
  const markdown = widget.type === 'markdown' ? (data && 'type' in data && data.type === 'markdown' && data.content) || widget.content : null;
  return (
    <Card h="100%">
      {title && (
        <Title order={5} mb="sm">
          {title}
        </Title>
      )}
      {markdown !== null ? <Markdown>{markdown}</Markdown> : <WidgetBody widget={widget} data={data} title={title ?? ''} ctx={ctx} />}
    </Card>
  );
}

function WidgetBody({ widget, data, title, ctx }: { widget: DashboardWidget; data: WidgetData | undefined; title: string; ctx?: EntityCtx }) {
  if (!data) return <Loading />;
  if ('error' in data) return <ErrorAlert error={data.error} />;
  switch (data.type) {
    case 'chart':
      return widget.type === 'chart' ? <ChartWidget widget={widget} data={data} title={title} /> : null;
    case 'entity':
      return widget.type === 'entity' ? <EntityWidget widget={widget} ctx={ctx} /> : null;
    case 'count':
      return <Count data={data} />;
    case 'scorecard':
      return <ScorecardBar data={data} />;
    case 'runs':
    case 'approvals':
      return <RunsList data={data} />;
    case 'insights':
      return <Insights data={data} />;
    case 'initiative':
      return <InitiativeCard data={data} />;
    case 'table':
      return <EntityTable widget={widget as Extract<DashboardWidget, { type: 'table' }>} data={data} />;
    default:
      return null;
  }
}

function Count({ data }: { data: Data<'count'> }) {
  if (!data.groups) return <StatValue size="lg">{data.value}</StatValue>;
  if (!data.groups.length) return <Empty title="No data" />;
  const max = Math.max(...data.groups.map((g) => g.count));
  return (
    <Stack gap="2xs">
      {data.groups.slice(0, 10).map((g) => (
        <div key={g.key}>
          <Group justify="space-between" gap="xs">
            <Text fz="sm">{g.key}</Text>
            <Text fz="sm" fw={500}>
              {g.count}
            </Text>
          </Group>
          <Progress value={(g.count / max) * 100} size="sm" />
        </div>
      ))}
    </Stack>
  );
}

function ScorecardBar({ data }: { data: Data<'scorecard'> }) {
  if (!data.total) return <Empty title="No entities scored yet" />;
  const levels = [{ name: 'none', color: 'red' }, ...data.levels.map((l, i) => ({ name: l.name, color: l.color || LEVEL_COLORS[i % LEVEL_COLORS.length] }))];
  return (
    <Stack gap="xs">
      <Text fz="xs" c="dimmed">
        {data.title} · {data.total} entities
      </Text>
      <Progress.Root size={22}>
        {levels.map((l) => (
          <Progress.Section key={l.name} value={((data.distribution[l.name] ?? 0) / data.total) * 100} color={l.color}>
            <Progress.Label>{data.distribution[l.name] || ''}</Progress.Label>
          </Progress.Section>
        ))}
      </Progress.Root>
      <Group gap="md">
        {levels.map((l) => (
          <Text key={l.name} fz="xs" c="dimmed">
            {l.name === 'none' ? 'Below first level' : l.name}: {data.distribution[l.name] ?? 0}
          </Text>
        ))}
      </Group>
    </Stack>
  );
}

function RunsList({ data }: { data: Data<'runs'> | Data<'approvals'> }) {
  const navigate = useNavigate();
  return (
    <>
      <DataTable
        rows={data.items}
        rowKey={(r) => r.id}
        onRowClick={(r) => navigate(`/runs/${r.id}`)}
        empty="Nothing here"
        columns={[
          {
            key: 'a',
            label: 'Action',
            render: (r) => (
              <Text fz="sm" fw={500}>
                {r.actionTitle}
                {r.entity ? ` · ${r.entity}` : ''}
              </Text>
            ),
          },
          { key: 's', label: 'Status', render: (r) => <StatusBadge status={r.status} /> },
          { key: 't', label: 'When', render: (r) => <TimeAgo at={r.createdAt} /> },
        ]}
      />
      {data.total > data.items.length && (
        <Anchor component={Link} to={data.type === 'approvals' ? '/todo' : '/runs'} fz="sm" mt="xs" display="block">
          All {data.total}
        </Anchor>
      )}
    </>
  );
}

function EntityTable({ widget, data }: { widget: Extract<DashboardWidget, { type: 'table' }>; data: Data<'table'> }) {
  const navigate = useNavigate();
  const bp = useQuery({ queryKey: ['blueprint', widget.blueprint], queryFn: () => api.blueprint(widget.blueprint), enabled: widget.columns.length > 0 });
  return (
    <>
      <DataTable
        rows={data.items}
        rowKey={(e) => e.identifier}
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
          ...widget.columns.map((k) => ({
            key: k,
            label: bp.data?.schema.properties[k]?.title ?? k,
            render: (e: (typeof data.items)[number]) => (
              <PropertyValue schema={bp.data?.schema.properties[k]} value={e.properties[k] ?? e.computed?.[k]} compact />
            ),
          })),
        ]}
      />
      {data.total > data.items.length && (
        <Anchor component={Link} to={`/catalog/${widget.blueprint}`} fz="sm" mt="xs" display="block">
          All {data.total}
        </Anchor>
      )}
    </>
  );
}

function InitiativeCard({ data }: { data: Data<'initiative'> }) {
  const s = STATUS_LOOK[data.status];
  return (
    <Stack gap="xs">
      <Group justify="space-between" gap="xs">
        <Anchor component={Link} to={`/initiatives/${data.initiative}`} fz="sm" fw={500}>
          {data.title}
        </Anchor>
        <Badge color={s.color} variant="light">
          {s.label}
        </Badge>
      </Group>
      <Group justify="space-between" align="flex-end">
        <StatValue size="lg">{pct(data.progress.ratio)}</StatValue>
        <Text fz="xs" c="dimmed">
          {data.progress.passing} of {data.progress.total} · {data.status === 'done' ? 'complete' : deadlineLabel(data.daysLeft)}
        </Text>
      </Group>
      <Progress value={data.progress.ratio * 100} size="sm" color={data.progress.ratio >= 1 ? 'teal' : 'blue'} />
      {data.teams.length > 1 && (
        <Stack gap="3xs">
          <Text fz="xs" c="dimmed">
            Furthest behind
          </Text>
          {data.teams.slice(0, 3).map((t) => (
            <Group key={t.team ?? '-'} justify="space-between" gap="xs">
              <Text fz="xs">{teamLabel(t.team)}</Text>
              <Text fz="xs" fw={500}>
                {t.passing} / {t.total}
              </Text>
            </Group>
          ))}
        </Stack>
      )}
    </Stack>
  );
}

/** A section of the current entity; outside an entity page there is none to show. */
function EntityWidget({ widget, ctx }: { widget: Extract<DashboardWidget, { type: 'entity' }>; ctx?: EntityCtx }) {
  if (!ctx) return <Empty title="Shown on the entity pages of the blueprint" />;
  const { entity: e, blueprint: bp } = ctx;
  switch (widget.show) {
    case 'properties':
      return <EntityProperties bp={bp} e={e} only={widget.properties} />;
    case 'scorecards':
      return <EntityScorecards e={e} />;
    case 'relations':
      return <EntityRelations bp={bp} e={e} />;
    case 'links':
      return <LinkList links={entityLinks(bp, e)} />;
  }
}

const BAND_COLORS: Record<DoraBand, string> = { elite: 'teal', high: 'green', medium: 'yellow', low: 'red' };

const fmtDuration = (hours: number) => (hours < 1 ? `${Math.round(hours * 60)} min` : hours < 48 ? `${+hours.toFixed(1)} h` : `${+(hours / 24).toFixed(1)} d`);

function Stat({ label, value, hint, band }: { label: string; value: string; hint: string; band: DoraBand | null }) {
  return (
    <Card withBorder padding="sm" data-testid={`dora-${label}`}>
      <Text fz="xs" c="dimmed">
        {label}
      </Text>
      <StatValue>{value}</StatValue>
      <Group justify="space-between" gap="xs">
        <Text fz="xs" c="dimmed">
          {hint}
        </Text>
        {band && (
          <Badge color={BAND_COLORS[band]} variant="light">
            {band}
          </Badge>
        )}
      </Group>
    </Card>
  );
}

/** The four DORA metrics as stat tiles; a metric without data shows an em dash. */
function Insights({ data }: { data: Data<'insights'> }) {
  const f = data.deploymentFrequency;
  const l = data.leadTime;
  const c = data.changeFailureRate;
  const m = data.mttr;
  return (
    <SimpleGrid cols={{ base: 1, sm: 2, lg: 4 }}>
      <Stat
        label="Deployment frequency"
        value={f.value === null ? '—' : f.value >= 1 ? `${+f.value.toFixed(1)} / day` : `${+(f.value * 7).toFixed(1)} / week`}
        hint={`${f.count} in ${data.days} days`}
        band={f.band}
      />
      <Stat label="Lead time for changes" value={l.value === null ? '—' : fmtDuration(l.value)} hint={`${l.samples} changes`} band={l.band} />
      <Stat label="Change failure rate" value={c.value === null ? '—' : `${+(c.value * 100).toFixed(1)} %`} hint={`${c.failed} of ${c.total}`} band={c.band} />
      <Stat label="Time to restore" value={m.value === null ? '—' : fmtDuration(m.value)} hint={`${m.incidents} incidents`} band={m.band} />
    </SimpleGrid>
  );
}
