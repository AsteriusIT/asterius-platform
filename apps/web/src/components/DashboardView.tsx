import { Anchor, Badge, Card, Grid, Group, Progress, SimpleGrid, Stack, Text, Title } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router';
import type { Dashboard, DashboardWidget, DoraBand, WidgetData } from '@asterius/shared';
import { api } from '../lib/api';
import { DataTable } from './DataTable';
import { PropertyValue } from './PropertyValue';
import { Empty, ErrorAlert, Loading, Markdown, StatusBadge, TimeAgo } from './ui';

type Data<T extends string> = Extract<WidgetData, { type: T }>;

const LEVEL_COLORS = ['orange', 'gray', 'yellow', 'teal', 'blue', 'grape', 'pink', 'cyan'];

/** Renders a dashboard: its widgets in a 12-column grid, data computed by the server for the viewer. */
export function DashboardView({ dashboard }: { dashboard: Dashboard }) {
  const data = useQuery({
    queryKey: ['dashboard-data', dashboard.identifier],
    queryFn: () => api.dashboardData(dashboard.identifier),
    refetchInterval: 60_000,
  });
  if (data.isPending) return <Loading />;
  if (data.error) return <ErrorAlert error={data.error} />;
  return (
    <Grid>
      {dashboard.widgets.map((w, i) => (
        <Grid.Col key={i} span={{ base: 12, md: w.width }}>
          <Widget widget={w} data={data.data[i]} />
        </Grid.Col>
      ))}
    </Grid>
  );
}

function Widget({ widget, data }: { widget: DashboardWidget; data: WidgetData | undefined }) {
  const title = widget.title ?? (widget.type === 'runs' ? 'Runs' : widget.type === 'approvals' ? 'Waiting for approval' : undefined);
  return (
    <Card h="100%">
      {title && (
        <Title order={5} mb="sm">
          {title}
        </Title>
      )}
      {widget.type === 'markdown' ? <Markdown>{widget.content}</Markdown> : <WidgetBody widget={widget} data={data} />}
    </Card>
  );
}

function WidgetBody({ widget, data }: { widget: DashboardWidget; data: WidgetData | undefined }) {
  if (!data) return <Loading />;
  if ('error' in data) return <ErrorAlert error={data.error} />;
  switch (data.type) {
    case 'count':
      return <Count data={data} />;
    case 'scorecard':
      return <ScorecardBar data={data} />;
    case 'runs':
    case 'approvals':
      return <RunsList data={data} />;
    case 'insights':
      return <Insights data={data} />;
    case 'table':
      return <EntityTable widget={widget as Extract<DashboardWidget, { type: 'table' }>} data={data} />;
    default:
      return null;
  }
}

function Count({ data }: { data: Data<'count'> }) {
  if (!data.groups)
    return (
      <Text fz={34} fw={700}>
        {data.value}
      </Text>
    );
  if (!data.groups.length) return <Empty title="No data" />;
  const max = Math.max(...data.groups.map((g) => g.count));
  return (
    <Stack gap={6}>
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
        <Anchor component={Link} to={data.type === 'approvals' ? '/approvals' : '/runs'} fz="sm" mt="xs" display="block">
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

const BAND_COLORS: Record<DoraBand, string> = { elite: 'teal', high: 'green', medium: 'yellow', low: 'red' };

const fmtDuration = (hours: number) => (hours < 1 ? `${Math.round(hours * 60)} min` : hours < 48 ? `${+hours.toFixed(1)} h` : `${+(hours / 24).toFixed(1)} d`);

function Stat({ label, value, hint, band }: { label: string; value: string; hint: string; band: DoraBand | null }) {
  return (
    <Card withBorder padding="sm" data-testid={`dora-${label}`}>
      <Text fz="xs" c="dimmed">
        {label}
      </Text>
      <Text fz={26} fw={700}>
        {value}
      </Text>
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
