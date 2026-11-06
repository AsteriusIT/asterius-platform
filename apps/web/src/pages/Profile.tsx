import { useState } from 'react';
import { Alert, Badge, Button, Card, Checkbox, Code, CopyButton, Group, NumberInput, Stack, Text, TextInput, Title } from '@mantine/core';
import { modals } from '@mantine/modals';
import { notifications } from '@mantine/notifications';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { IconCopy, IconTrash } from '@tabler/icons-react';
import type { ApiToken } from '@asterius/shared';
import { api, errorText } from '../lib/api';
import { useAuth } from '../lib/auth';
import { DataTable } from '../components/DataTable';
import { PageHeader, TimeAgo } from '../components/ui';

/** Shows a freshly created token once. */
export function NewTokenAlert({ token, onClose }: { token: string | null; onClose: () => void }) {
  if (!token) return null;
  return (
    <Alert color="green" title="Copy your token now: it will not be shown again" withCloseButton onClose={onClose}>
      <Group gap="xs" wrap="nowrap">
        <Code style={{ overflowWrap: 'anywhere' }}>{token}</Code>
        <CopyButton value={token}>
          {({ copied, copy }) => (
            <Button size="xs" variant="light" leftSection={<IconCopy size={14} />} onClick={copy}>
              {copied ? 'Copied' : 'Copy'}
            </Button>
          )}
        </CopyButton>
      </Group>
    </Alert>
  );
}

export function TokenTable({ all }: { all?: boolean }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['tokens', !!all], queryFn: () => api.tokens(all) });
  const revoke = (t: ApiToken) =>
    modals.openConfirmModal({
      title: `Revoke "${t.name}"?`,
      children: <Text fz="sm">Anything using this token stops working immediately.</Text>,
      labels: { confirm: 'Revoke', cancel: 'Cancel' },
      confirmProps: { color: 'red' },
      onConfirm: async () => {
        await api.deleteToken(t.id);
        void qc.invalidateQueries({ queryKey: ['tokens'] });
      },
    });
  return (
    <DataTable
      rows={q.data}
      loading={q.isPending}
      error={q.error}
      rowKey={(t) => t.id}
      empty="No API tokens"
      columns={[
        {
          key: 'n',
          label: 'Name',
          render: (t) => (
            <Text fz="sm" fw={500}>
              {t.name}
            </Text>
          ),
        },
        { key: 'p', label: 'Token', render: (t) => <Code>{t.prefix}…</Code> },
        ...(all ? [{ key: 'u', label: 'Owner', render: (t: ApiToken) => t.userName }] : []),
        { key: 'c', label: 'Created', render: (t) => <TimeAgo at={t.createdAt} /> },
        { key: 'e', label: 'Expires', render: (t) => (t.expiresAt ? <TimeAgo at={t.expiresAt} /> : <Badge color="gray">never</Badge>) },
        { key: 'l', label: 'Last used', render: (t) => <TimeAgo at={t.lastUsedAt} /> },
        {
          key: 'x',
          label: '',
          width: 60,
          render: (t) => (
            <Button size="xs" variant="subtle" color="red" onClick={() => revoke(t)} aria-label="Revoke">
              <IconTrash size={16} />
            </Button>
          ),
        },
      ]}
    />
  );
}

/** Where I want to hear about approvals waiting for me and about the outcome of my runs. */
function NotificationPrefsCard() {
  const qc = useQueryClient();
  const prefs = useQuery({ queryKey: ['my-notifications'], queryFn: api.myNotifications });
  const channels = useQuery({ queryKey: ['notification-channels'], queryFn: api.notificationChannels, staleTime: 60_000 });
  const save = useMutation({
    mutationFn: api.saveMyNotifications,
    onSuccess: (p) => qc.setQueryData(['my-notifications'], p),
    onError: (e) => notifications.show({ color: 'red', message: errorText(e) }),
  });
  const data = prefs.data;
  const group = (key: 'approvals' | 'runs', label: string) => (
    <Checkbox.Group label={label} value={data?.[key] ?? []} onChange={(v) => data && save.mutate({ ...data, [key]: v as ('email' | 'slack')[] })}>
      <Group mt="xs">
        <Checkbox value="email" label="Email" disabled={!channels.data?.email} />
        <Checkbox value="slack" label="Slack" disabled={!channels.data?.slack} />
      </Group>
    </Checkbox.Group>
  );
  return (
    <>
      <Title order={4} mt="md">
        Notifications
      </Title>
      <Card>
        <Group align="flex-start" gap="xl">
          {group('approvals', 'Approvals and inputs waiting for me')}
          {group('runs', 'Outcome of the runs I requested')}
        </Group>
        {channels.data && !channels.data.email && !channels.data.slack && (
          <Text fz="sm" c="dimmed" mt="xs">
            No channel is set up yet: an admin configures email and Slack in Admin → Notifications.
          </Text>
        )}
      </Card>
    </>
  );
}

export function Profile() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [days, setDays] = useState<number | string>(90);
  const [created, setCreated] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: () => api.createToken(name, typeof days === 'number' ? days : null),
    onSuccess: (r) => {
      setCreated(r.token);
      setName('');
      void qc.invalidateQueries({ queryKey: ['tokens'] });
    },
  });
  return (
    <Stack>
      <PageHeader title={user?.name} description={user?.email} />
      <Group gap="xs">
        <Badge color={user?.role === 'admin' ? 'grape' : 'gray'}>{user?.role}</Badge>
        {user?.teams.map((t) => (
          <Badge key={t.identifier} color="gray">
            {t.title}
          </Badge>
        ))}
      </Group>
      <NotificationPrefsCard />
      <Title order={4} mt="md">
        Personal API tokens
      </Title>
      <Text fz="sm" c="dimmed">
        Call the API with <Code>Authorization: Bearer &lt;token&gt;</Code>: same permissions as you. For CI pipelines, ask an admin for a service account.
      </Text>
      <Card>
        <Group align="flex-end">
          <TextInput label="Name" placeholder="my laptop" value={name} onChange={(e) => setName(e.currentTarget.value)} style={{ flex: 1 }} />
          <NumberInput label="Expires in (days)" min={1} max={730} value={days} onChange={setDays} w={160} />
          <Button disabled={!name.trim()} loading={create.isPending} onClick={() => create.mutate()}>
            Create token
          </Button>
        </Group>
        {create.error && (
          <Text c="red" fz="sm" mt="xs">
            {errorText(create.error)}
          </Text>
        )}
      </Card>
      <NewTokenAlert token={created} onClose={() => setCreated(null)} />
      <TokenTable />
    </Stack>
  );
}
