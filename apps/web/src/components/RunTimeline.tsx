import { Badge, Group, Stack, Text, ThemeIcon, Timeline, Tooltip } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { IconCheck, IconLoader2, IconPointFilled, IconX } from '@tabler/icons-react';
import { api, type RunTimeline as Data, type TimelineEvent } from '../lib/api';
import { Empty, Mono, QueryView } from './ui';

const COLORS: Record<TimelineEvent['status'], string> = { success: 'green', failure: 'red', running: 'blue', info: 'gray' };
const ICONS: Record<TimelineEvent['status'], typeof IconCheck> = { success: IconCheck, failure: IconX, running: IconLoader2, info: IconPointFilled };
const SOURCE_COLORS: Record<string, string> = { ok: 'green', unconfigured: 'gray', error: 'red' };

const clock = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });

/**
 * The step timeline of a run (V2.md §9): what the portal did, what the catalog watcher observed, and what Loki and
 * Tempo hold for the run id, in time order. Refreshes until the run and its service are final.
 */
export function RunTimeline({ runId, limit }: { runId: string; limit?: number }) {
  const q = useQuery({
    queryKey: ['run-timeline', runId],
    queryFn: () => api.runTimeline(runId),
    refetchInterval: (query) => (query.state.data?.terminal ? false : 10_000),
  });
  return <QueryView q={q}>{(t) => <TimelineView t={t} limit={limit} />}</QueryView>;
}

export function TimelineView({ t, limit }: { t: Data; limit?: number }) {
  const events = limit ? t.events.slice(-limit) : t.events;
  return (
    <Stack gap="sm">
      <Group gap={6}>
        {t.sources.map((s) => (
          <Tooltip key={s.name} label={s.error ?? (s.status === 'unconfigured' ? 'Not configured on this platform' : `${s.count} event(s)`)}>
            <Badge size="xs" variant="light" color={SOURCE_COLORS[s.status] ?? 'gray'}>
              {s.name}
              {s.status === 'ok' ? ` · ${s.count}` : s.status === 'error' ? ' · error' : ' · off'}
            </Badge>
          </Tooltip>
        ))}
        {t.cached && (
          <Badge size="xs" variant="outline" color="gray">
            final
          </Badge>
        )}
      </Group>
      {!events.length && <Empty title="Nothing recorded for this run yet" />}
      {events.length > 0 && (
        <Timeline bulletSize={20} lineWidth={2}>
          {events.map((e, i) => {
            const Icon = ICONS[e.status];
            return (
              <Timeline.Item
                key={`${e.time}-${i}`}
                bullet={
                  <ThemeIcon size={20} radius="xl" color={COLORS[e.status]} variant={e.status === 'info' ? 'light' : 'filled'}>
                    <Icon size={12} />
                  </ThemeIcon>
                }
                title={
                  <Group gap="xs" wrap="nowrap">
                    <Mono>{clock(e.time)}</Mono>
                    <Text fz="sm" fw={500} truncate>
                      {e.step}
                    </Text>
                    <Text span fz="sm" c={COLORS[e.status]} aria-label={e.status}>
                      {e.symbol}
                    </Text>
                    <Badge size="xs" variant="outline" color="gray">
                      {e.source}
                    </Badge>
                  </Group>
                }
              >
                {e.message && (
                  <Text fz="xs" c="dimmed" style={{ overflowWrap: 'anywhere' }}>
                    {e.message}
                  </Text>
                )}
              </Timeline.Item>
            );
          })}
        </Timeline>
      )}
      {limit && t.events.length > limit && (
        <Text fz="xs" c="dimmed">
          {t.events.length - limit} earlier event(s) on the run page
        </Text>
      )}
    </Stack>
  );
}
