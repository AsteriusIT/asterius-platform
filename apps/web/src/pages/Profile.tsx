import { useState } from 'react';
import { Alert, Badge, Button, Card, Code, CopyButton, Group, NumberInput, Stack, Text, TextInput, Title } from '@mantine/core';
import { modals } from '@mantine/modals';
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
