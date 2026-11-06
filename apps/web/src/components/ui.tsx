import type { ReactNode } from 'react';
import { Alert, Anchor, Badge, Box, Breadcrumbs, Center, Code, Group, Loader, Stack, Text, ThemeIcon, Title, Tooltip } from '@mantine/core';
import { Link } from 'react-router';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { IconAlertTriangle, IconInbox } from '@tabler/icons-react';
import type { RunStatus } from '@asterius/shared';
import { errorText } from '../lib/api';
import { EntityIcon } from './icons';

/** Small building blocks shared by every page. */

export function PageHeader(props: {
  title: ReactNode;
  description?: ReactNode;
  icon?: string | null;
  actions?: ReactNode;
  crumbs?: { label: string; to?: string }[];
}) {
  return (
    <Stack gap={6} mb="lg">
      {props.crumbs && (
        <Breadcrumbs separatorMargin={6} fz="sm">
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
        <Group gap="sm" wrap="nowrap" style={{ minWidth: 0 }}>
          {props.icon !== undefined && (
            <ThemeIcon size={38} variant="light" radius="md">
              <EntityIcon name={props.icon} size={22} />
            </ThemeIcon>
          )}
          <Box style={{ minWidth: 0 }}>
            <Title order={2} style={{ overflowWrap: 'anywhere' }}>
              {props.title}
            </Title>
            {props.description && (
              <Text c="dimmed" fz="sm">
                {props.description}
              </Text>
            )}
          </Box>
        </Group>
        {props.actions && <Group gap="xs">{props.actions}</Group>}
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
    <Alert color="red" icon={<IconAlertTriangle size={18} />} title="Something went wrong">
      {errorText(error)}
    </Alert>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <Stack align="center" gap={6} py="xl" c="dimmed">
      <IconInbox size={32} stroke={1.4} />
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
const STATUS_LABELS: Record<RunStatus, string> = {
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
    <Badge color={STATUS_COLORS[status]} variant={status === 'IN_PROGRESS' ? 'dot' : 'light'}>
      {STATUS_LABELS[status]}
    </Badge>
  );
  return label ? <Tooltip label={label}>{badge}</Tooltip> : badge;
}

export function Markdown({ children }: { children: string }) {
  return (
    <Box fz="sm" style={{ lineHeight: 1.55 }} className="markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{children}</ReactMarkdown>
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
