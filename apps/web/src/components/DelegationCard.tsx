import { useState } from 'react';
import { Alert, Badge, Button, Card, Group, Select, Stack, Text, TextInput, Title } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { IconTrash } from '@tabler/icons-react';
import type { Delegation } from '@asterius/shared';
import { api, errorText } from '../lib/api';
import { DataTable } from './DataTable';
import { PageHeader, TimeAgo } from './ui';
import { UserChip } from './UserChip';

/** `YYYY-MM-DDTHH:mm` (datetime-local) ↔ ISO. */
const toLocal = (iso: string | null | undefined) =>
  iso ? new Date(new Date(iso).getTime() - new Date().getTimezoneOffset() * 60_000).toISOString().slice(0, 16) : '';
const toIso = (local: string) => (local ? new Date(local).toISOString() : null);

const range = (d: Delegation) =>
  d.startsAt || d.endsAt
    ? `${d.startsAt ? new Date(d.startsAt).toLocaleString() : 'now'} → ${d.endsAt ? new Date(d.endsAt).toLocaleString() : 'until removed'}`
    : 'Always';

/** Out of office: who decides my approvals (and answers my inputs) while I am away. */
export function DelegationCard() {
  const qc = useQueryClient();
  const mine = useQuery({ queryKey: ['my-delegation'], queryFn: api.myDelegation });
  const users = useQuery({ queryKey: ['user-lookup'], queryFn: api.userLookup, staleTime: 60_000 });
  const [draft, setDraft] = useState<{ delegate: string | null; startsAt: string; endsAt: string } | null>(null);
  const current = mine.data?.delegation ?? null;
  const form = draft ?? { delegate: current?.delegate.id ?? null, startsAt: toLocal(current?.startsAt), endsAt: toLocal(current?.endsAt) };
  const done = () => {
    setDraft(null);
    void qc.invalidateQueries({ queryKey: ['my-delegation'] });
    void qc.invalidateQueries({ queryKey: ['delegations'] });
  };
  const onError = (e: unknown) => notifications.show({ color: 'red', message: errorText(e) });
  const save = useMutation({
    mutationFn: () => api.saveMyDelegation({ delegate: form.delegate!, startsAt: toIso(form.startsAt), endsAt: toIso(form.endsAt) }),
    onSuccess: done,
    onError,
  });
  const clear = useMutation({ mutationFn: api.clearMyDelegation, onSuccess: done, onError });
  return (
    <>
      <Title order={4} mt="md">
        Out of office
      </Title>
      <Card>
        <Stack gap="sm">
          <Text fz="sm" c="dimmed">
            Your delegate may decide the approvals and answer the inputs you are asked for, and is notified of them. Never your own requests (unless
            self-approval is allowed); decisions record that they were made on your behalf.
          </Text>
          {current && (
            <Alert color={current.active ? 'blue' : 'gray'} p="xs">
              <Group gap="xs">
                <Text fz="sm">Delegated to</Text>
                <UserChip user={current.delegate} />
                <Text fz="sm">· {range(current)}</Text>
                <Badge color={current.active ? 'green' : 'gray'}>{current.active ? 'active' : 'not in effect'}</Badge>
              </Group>
            </Alert>
          )}
          <Group align="flex-end">
            <Select
              label="Delegate"
              searchable
              placeholder="Choose a person"
              data={(users.data ?? []).map((u) => ({ value: u.id, label: `${u.name} <${u.email}>` }))}
              value={form.delegate}
              onChange={(delegate) => setDraft({ ...form, delegate })}
              flex={1}
            />
            <TextInput
              type="datetime-local"
              label="From (optional)"
              value={form.startsAt}
              onChange={(e) => setDraft({ ...form, startsAt: e.currentTarget.value })}
            />
            <TextInput
              type="datetime-local"
              label="Until (optional)"
              value={form.endsAt}
              onChange={(e) => setDraft({ ...form, endsAt: e.currentTarget.value })}
            />
            <Button disabled={!form.delegate} loading={save.isPending} onClick={() => save.mutate()}>
              Save
            </Button>
            {current && (
              <Button variant="subtle" color="red" loading={clear.isPending} onClick={() => clear.mutate()}>
                Remove
              </Button>
            )}
          </Group>
        </Stack>
      </Card>
    </>
  );
}

/** Admins: every delegation of the organization, with a way to remove one (Access > Delegations). */
export function DelegationsTable() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['delegations'], queryFn: api.delegations });
  const clear = useMutation({
    mutationFn: (userId: string) => api.clearDelegation(userId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['delegations'] }),
    onError: (e) => notifications.show({ color: 'red', message: errorText(e) }),
  });
  return (
    <Stack>
      <PageHeader
        title="Delegations"
        refresh={q}
        description="Out-of-office delegations: while one is in effect, the delegate decides the approvals the person is eligible for. People set theirs on their profile; remove one here when it should no longer apply."
      />
      <DataTable
        rows={q.data}
        loading={q.isPending}
        error={q.error}
        rowKey={(d) => d.user.id}
        empty="Nobody has delegated their approvals"
        columns={[
          { key: 'u', label: 'Person', render: (d) => <UserChip user={d.user} /> },
          { key: 'd', label: 'Delegate', render: (d) => <UserChip user={d.delegate} /> },
          { key: 'r', label: 'When', render: (d) => <Text fz="sm">{range(d)}</Text> },
          { key: 'a', label: '', render: (d) => <Badge color={d.active ? 'green' : 'gray'}>{d.active ? 'active' : 'not in effect'}</Badge> },
          { key: 'c', label: 'Set', render: (d) => <TimeAgo at={d.createdAt} /> },
          {
            key: 'x',
            label: '',
            width: 60,
            render: (d) => (
              <Button size="xs" variant="subtle" color="red" aria-label="Remove" onClick={() => clear.mutate(d.user.id)}>
                <IconTrash size={16} />
              </Button>
            ),
          },
        ]}
      />
    </Stack>
  );
}
