import { lazy, Suspense, useState } from 'react';
import { ActionIcon, Anchor, Box, Group, Stack, Table, Text, Tooltip } from '@mantine/core';
import { Link, useNavigate } from 'react-router';
import { IconChartLine, IconTable } from '@tabler/icons-react';
import type { ChartData, DashboardWidget } from '@asterius/shared';
import { bucketTitle, drillHref, formatValue, seriesColors } from '../lib/charts';
import { Empty, Loading } from './ui';

/** The chart library is loaded on first use, in its own chunk (see vite.config.ts). */
const TrendChart = lazy(() => import('./charts/TrendChart'));

type ChartWidgetDef = Extract<DashboardWidget, { type: 'chart' }>;

/** Diameter of a legend swatch (geometry). */
const SWATCH = 10;

const INTERVAL_NOUN = { day: 'days', week: 'weeks', month: 'months' } as const;

/**
 * A `chart` widget: the plot (lazy), a legend whose items open the list behind each series, and a table view of every
 * value (the accessible alternative to the plot, and what the toggle shows). A click on a point opens the list behind it.
 */
export function ChartWidget({ widget, data, title }: { widget: ChartWidgetDef; data: ChartData; title: string }) {
  const navigate = useNavigate();
  const [asTable, setAsTable] = useState(false);
  const colors = seriesColors(data);
  const empty = !data.series.length || data.series.every((s) => s.values.every((v) => !v));
  const summary = `${title}: ${widget.chart} chart of ${data.series.map((s) => s.label).join(', ') || 'no series'} over ${data.buckets.length} ${INTERVAL_NOUN[data.interval]}`;
  const open = (key: string | null, index: number | null) => {
    const href = drillHref(data, key, index);
    if (href) navigate(href);
  };
  return (
    <Stack gap="xs">
      <Group justify="space-between" gap="xs" wrap="nowrap">
        <Group gap="sm" role="list" aria-label="Series">
          {data.series.map((s, i) => {
            const href = drillHref(data, s.key, null);
            const swatch = <Box component="span" w={SWATCH} h={SWATCH} bdrs="xl" display="inline-block" bg={colors[i]} aria-hidden />;
            return (
              <Group key={s.key} gap="3xs" wrap="nowrap" role="listitem">
                {swatch}
                {href ? (
                  <Anchor component={Link} to={href} fz="xs" c="var(--mantine-color-text)">
                    {s.label}
                  </Anchor>
                ) : (
                  <Text fz="xs">{s.label}</Text>
                )}
              </Group>
            );
          })}
        </Group>
        <Tooltip label={asTable ? 'Show as chart' : 'Show as table'}>
          <ActionIcon
            variant="subtle"
            color="gray"
            aria-label={asTable ? 'Show as chart' : 'Show as table'}
            aria-pressed={asTable}
            onClick={() => setAsTable((t) => !t)}
          >
            {asTable ? <IconChartLine size={16} /> : <IconTable size={16} />}
          </ActionIcon>
        </Tooltip>
      </Group>
      {asTable ? (
        <ChartTable data={data} title={summary} />
      ) : empty ? (
        <Empty title="No data in this window" />
      ) : (
        <div role="img" aria-label={summary} data-testid="trend-chart">
          <Suspense fallback={<Loading />}>
            <TrendChart data={data} chart={widget.chart} stacked={widget.stacked} colors={colors} onPoint={data.drill ? open : undefined} />
          </Suspense>
        </div>
      )}
    </Stack>
  );
}

/** Every value, one row per bucket; a cell links to the list behind it. */
function ChartTable({ data, title }: { data: ChartData; title: string }) {
  return (
    <div className="scroll-x">
      <Table fz="xs" verticalSpacing="3xs" highlightOnHover={false}>
        <Table.Caption>{title}</Table.Caption>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Period</Table.Th>
            {data.series.map((s) => (
              <Table.Th key={s.key} ta="right">
                {s.label}
              </Table.Th>
            ))}
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {data.buckets.map((b, i) => (
            <Table.Tr key={b}>
              <Table.Td>{bucketTitle(data.interval, b)}</Table.Td>
              {data.series.map((s) => {
                const text = formatValue(data.unit, s.values[i]);
                const href = s.values[i] ? drillHref(data, s.key, i) : null;
                return (
                  <Table.Td key={s.key} ta="right">
                    {href ? (
                      <Anchor component={Link} to={href} fz="xs">
                        {text}
                      </Anchor>
                    ) : (
                      text
                    )}
                  </Table.Td>
                );
              })}
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </div>
  );
}
