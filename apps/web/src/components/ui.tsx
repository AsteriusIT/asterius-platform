import { useState, type ReactNode } from 'react';
import {
  ActionIcon,
  Alert,
  Anchor,
  Badge,
  Box,
  Breadcrumbs,
  Center,
  Code,
  Group,
  Loader,
  Stack,
  Text,
  ThemeIcon,
  Title,
  Tooltip,
  type BoxProps,
  type TextProps,
} from '@mantine/core';
import { Link } from 'react-router';
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { IconAlertTriangle, IconInbox, IconRefresh } from '@tabler/icons-react';
import type { RunStatus } from '@asterius/shared';
import { errorText } from '../lib/api';
import { EntityIcon } from './icons';
import { ICON, ICON_DISPLAY } from '@asterius/brand';

/** Small building blocks shared by every page. */

/**
 * Uppercase label above a group of things (admin tabs, template groups, the type of a graph node).
 * `size="xs"` in a page, `"3xs"` inside a graph node.
 */
export function Kicker({ size = 'xs', ...props }: TextProps & { size?: 'xs' | '3xs'; children: ReactNode }) {
  return <Text fz={size} fw={600} tt="uppercase" c="dimmed" {...props} />;
}

/** Dense secondary text, one step under `xs` (third line of a graph node, group titles in a picker). */
export function Caption(props: TextProps & { children: ReactNode }) {
  return <Text fz="2xs" c="dimmed" {...props} />;
}

/** The big figure of a stat card or tile. `lg` for a figure alone in its card. */
export function StatValue({ size = 'md', ...props }: TextProps & { size?: 'md' | 'lg'; children: ReactNode }) {
  return <Text fz={size === 'lg' ? 'h1' : 'h2'} fw={700} {...props} />;
}

/** Flat tinted block for a hint or generated text inside a card, a panel or a modal (no shadow, no border). */
export function SurfaceBox({ children, ...props }: BoxProps & { children: ReactNode }) {
  return (
    <Box p="sm" bg="var(--surface)" bdrs="md" {...props}>
      {children}
    </Box>
  );
}

/** What a refresh button reloads: one or several queries (TanStack Query results). */
export type Refreshable = { refetch: () => unknown };

/** Reload the data of a page; the icon spins until the requests it started are done (not on background polls). */
export function RefreshButton({ queries, label = 'Refresh' }: { queries: Refreshable | Refreshable[]; label?: string }) {
  const [fetching, setFetching] = useState(false);
  const refresh = async () => {
    setFetching(true);
    try {
      await Promise.allSettled((Array.isArray(queries) ? queries : [queries]).map((q) => q.refetch()));
    } finally {
      setFetching(false);
    }
  };
  return (
    <Tooltip label={label}>
      <ActionIcon variant="default" size={36} onClick={() => void refresh()} aria-label={label} aria-busy={fetching}>
        <IconRefresh size={ICON.md} className={fetching ? 'spin' : undefined} />
      </ActionIcon>
    </Tooltip>
  );
}

export function PageHeader(props: {
  title: ReactNode;
  description?: ReactNode;
  icon?: string | null;
  actions?: ReactNode;
  /** Adds a refresh button reloading these queries. */
  refresh?: Refreshable | Refreshable[];
  crumbs?: { label: string; to?: string }[];
}) {
  return (
    <Stack gap="2xs" mb="lg">
      {props.crumbs && (
        <Breadcrumbs separatorMargin="2xs" fz="sm">
          {props.crumbs.map((c) =>
            c.to ? (
              <Anchor component={Link} to={c.to} key={c.label} c="dimmed">
                {c.label}
              </Anchor>
            ) : (
              <Text key={c.label} c="dimmed" fz="sm">
                {c.label}
              </Text>
            ),
          )}
        </Breadcrumbs>
      )}
      <Group justify="space-between" align="flex-start" wrap="wrap" gap="sm">
        <Group gap="sm" wrap="nowrap" miw={0}>
          {props.icon !== undefined && (
            <ThemeIcon size={38} variant="light" radius="md">
              <EntityIcon name={props.icon} size={22} />
            </ThemeIcon>
          )}
          <Box miw={0}>
            <Title order={2} className="wrap-anywhere">
              {props.title}
            </Title>
            {props.description && (
              <Text c="dimmed" fz="sm">
                {props.description}
              </Text>
            )}
          </Box>
        </Group>
        {(props.actions || props.refresh) && (
          <Group gap="xs">
            {props.refresh && <RefreshButton queries={props.refresh} />}
            {props.actions}
          </Group>
        )}
      </Group>
    </Stack>
  );
}

export function Loading() {
  return (
    <Center py="xl">
      <Loader size="sm" />
    </Center>
  );
}

export function ErrorAlert({ error }: { error: unknown }) {
  return (
    <Alert color="red" icon={<IconAlertTriangle size={ICON.lg} />} title="Something went wrong">
      {errorText(error)}
    </Alert>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <Stack align="center" gap="2xs" py="xl" c="dimmed">
      <IconInbox size={ICON_DISPLAY.md} />
      <Text fw={500}>{title}</Text>
      {children && <Text fz="sm">{children}</Text>}
    </Stack>
  );
}

/** Render a query: loading, error, or the data. */
export function QueryView<T>({ q, children }: { q: { data?: T; error: unknown; isPending: boolean }; children: (data: T) => ReactNode }) {
  if (q.isPending) return <Loading />;
  if (q.error) return <ErrorAlert error={q.error} />;
  return <>{children(q.data as T)}</>;
}

export const STATUS_COLORS: Record<RunStatus, string> = {
  PENDING_APPROVAL: 'yellow',
  QUEUED: 'gray',
  IN_PROGRESS: 'blue',
  SUCCESS: 'brand',
  FAILURE: 'red',
  REJECTED: 'orange',
  CANCELLED: 'gray',
};
export const STATUS_LABELS: Record<RunStatus, string> = {
  PENDING_APPROVAL: 'Waiting for approval',
  QUEUED: 'Queued',
  IN_PROGRESS: 'In progress',
  SUCCESS: 'Succeeded',
  FAILURE: 'Failed',
  REJECTED: 'Rejected',
  CANCELLED: 'Cancelled',
};

export function StatusBadge({ status, label }: { status: RunStatus; label?: string | null }) {
  const badge = (
    // Never cut: in a row, what shrinks is the text next to it.
    <Badge color={STATUS_COLORS[status]} variant={status === 'IN_PROGRESS' ? 'dot' : 'light'} flex="none">
      {STATUS_LABELS[status]}
    </Badge>
  );
  return label ? <Tooltip label={label}>{badge}</Tooltip> : badge;
}

/** Resolves a relative link / image against the document it came from (`#anchors` stay as they are). */
export function resolveAgainst(value: string, base: string) {
  if (value.startsWith('#')) return value;
  try {
    return new URL(value, base).toString();
  } catch {
    return value;
  }
}

export function Markdown({ children, baseUrl }: { children: string; baseUrl?: string }) {
  return (
    <Box fz="sm" lh="md" className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        urlTransform={baseUrl ? (url) => defaultUrlTransform(resolveAgainst(url, baseUrl)) : undefined}
        components={baseUrl ? { a: ({ node: _n, ...p }) => <a {...p} target="_blank" rel="noreferrer" /> } : undefined}
      >
        {children}
      </ReactMarkdown>
    </Box>
  );
}

const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
export function timeAgo(iso: string | null | undefined) {
  if (!iso) return '—';
  const s = (Date.parse(iso) - Date.now()) / 1000;
  const abs = Math.abs(s);
  if (abs < 60) return rtf.format(Math.round(s), 'second');
  if (abs < 3600) return rtf.format(Math.round(s / 60), 'minute');
  if (abs < 86400) return rtf.format(Math.round(s / 3600), 'hour');
  return rtf.format(Math.round(s / 86400), 'day');
}

export function TimeAgo({ at }: { at: string | null | undefined }) {
  if (!at)
    return (
      <Text span c="dimmed">
        —
      </Text>
    );
  return (
    <Tooltip label={new Date(at).toLocaleString()}>
      <Text span fz="inherit">
        {timeAgo(at)}
      </Text>
    </Tooltip>
  );
}

export function Mono({ children }: { children: ReactNode }) {
  return <Code fz="xs">{children}</Code>;
}

export function ManagedBadge({ managed }: { managed: boolean }) {
  if (!managed) return null;
  return (
    <Tooltip label="Declared in the configuration repository (CONFIG_DIR): edit it there">
      <Badge color="grape" variant="outline" size="sm">
        config
      </Badge>
    </Tooltip>
  );
}

/** Short duration between two timestamps. */
export function duration(from: string | null, to: string | null) {
  if (!from) return '—';
  const s = Math.max(0, Math.round(((to ? Date.parse(to) : Date.now()) - Date.parse(from)) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

/** Level reached on a scorecard (colors come from the scorecard's levels). */
export function LevelBadge({ level, color }: { level: string | null | undefined; color?: string | null }) {
  return level ? (
    <Badge color={color || 'brand'} variant="light">
      {level}
    </Badge>
  ) : (
    <Badge color="gray" variant="outline">
      —
    </Badge>
  );
}
