import { useEffect, useMemo, useRef, useState } from 'react';
import { ActionIcon, Group, Switch, Text, TextInput, Tooltip } from '@mantine/core';
import { IconDownload, IconSearch } from '@tabler/icons-react';
import type { RunLog } from '@asterius/shared';
import { downloadText } from '../lib/catalogView';

/** Rendering is capped to the most recent lines so very long logs stay responsive. */
export const MAX_RENDERED_LINES = 2000;

export const LOG_COLORS: Record<string, string | undefined> = {
  error: 'var(--mantine-color-red-6)',
  warn: 'var(--mantine-color-yellow-7)',
};

/** Filter lines by a case-insensitive substring of the message or step id. */
export function filterLogs(lines: RunLog[], query: string): RunLog[] {
  const q = query.trim().toLowerCase();
  if (!q) return lines;
  return lines.filter((l) => l.message.toLowerCase().includes(q) || (l.stepId ?? '').toLowerCase().includes(q));
}

export const logsToText = (lines: RunLog[]) =>
  lines.map((l) => `${l.at} ${l.level.toUpperCase()}${l.stepId ? ` [${l.stepId}]` : ''} ${l.message}`).join('\n') + '\n';

/**
 * Scrollable log with a follow toggle (sticks to the bottom as lines arrive), text search and download.
 * Following pauses automatically when the user scrolls up.
 */
export function LogViewer({
  lines,
  showStep,
  filename = 'run.log',
  follow: followInitially = false,
}: {
  lines: RunLog[];
  showStep?: boolean;
  filename?: string;
  follow?: boolean;
}) {
  const [query, setQuery] = useState('');
  const [follow, setFollow] = useState(followInitially);
  const box = useRef<HTMLDivElement>(null);
  const shown = useMemo(() => filterLogs(lines, query), [lines, query]);
  const visible = shown.length > MAX_RENDERED_LINES ? shown.slice(-MAX_RENDERED_LINES) : shown;

  useEffect(() => {
    if (follow && box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [follow, visible.length]);

  return (
    <>
      <Group justify="space-between" px="sm" py={6} gap="xs" wrap="nowrap">
        <TextInput
          size="xs"
          leftSection={<IconSearch size={14} />}
          placeholder="Search logs"
          aria-label="Search logs"
          value={query}
          onChange={(e) => setQuery(e.currentTarget.value)}
          style={{ flex: 1, maxWidth: 260 }}
        />
        <Group gap="xs" wrap="nowrap">
          {query && (
            <Text fz="xs" c="dimmed">
              {shown.length} / {lines.length}
            </Text>
          )}
          <Switch size="xs" label="Follow" checked={follow} onChange={(e) => setFollow(e.currentTarget.checked)} />
          <Tooltip label="Download log">
            <ActionIcon
              variant="subtle"
              color="gray"
              aria-label="Download log"
              onClick={() => downloadText(filename, logsToText(lines), 'text/plain;charset=utf-8')}
            >
              <IconDownload size={16} />
            </ActionIcon>
          </Tooltip>
        </Group>
      </Group>
      <div
        ref={box}
        role="log"
        aria-label="Run log"
        tabIndex={0}
        style={{ height: 420, overflow: 'auto' }}
        onScroll={(e) => {
          const el = e.currentTarget;
          if (follow && el.scrollHeight - el.scrollTop - el.clientHeight > 40) setFollow(false);
        }}
      >
        <pre
          className="log-view"
          style={{ margin: 0, padding: 14, minHeight: '100%', fontSize: 12.5, lineHeight: 1.6, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}
        >
          {shown.length === 0 && <span style={{ opacity: 0.55 }}>{lines.length ? 'No line matches.' : 'No log lines yet.'}</span>}
          {shown.length > visible.length && (
            <div style={{ opacity: 0.55 }}>… {shown.length - visible.length} earlier lines hidden (download the log to see them)</div>
          )}
          {visible.map((l, i) => (
            <div key={i} style={{ color: LOG_COLORS[l.level] }}>
              <span style={{ opacity: 0.55 }}>{new Date(l.at).toLocaleTimeString()} </span>
              {showStep && l.stepId && <span style={{ opacity: 0.7 }}>[{l.stepId}] </span>}
              {l.message}
            </div>
          ))}
        </pre>
      </div>
    </>
  );
}
