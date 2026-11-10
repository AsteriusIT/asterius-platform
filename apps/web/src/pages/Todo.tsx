import { useState } from 'react';
import { Badge, Button, Card, Group, Stack, Text, Textarea, Title } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import { IconBell, IconCheck, IconX } from '@tabler/icons-react';
import type { Run, WaitingOn } from '@asterius/shared';
import { api, errorText } from '../lib/api';
import { DataTable } from '../components/DataTable';
import { openNotifications } from '../components/NotificationCenter';
import { Empty, PageHeader, TimeAgo } from '../components/ui';
import { runColumns } from './Runs';

const onError = (e: unknown) => notifications.show({ color: 'red', message: errorText(e) });
const approvalKey = (r: Run) => `${r.id}/${r.pendingStep?.id ?? ''}`;
const runLink = (r: Run) => `/runs/${r.id}${r.pendingStep ? `?step=${r.pendingStep.id}` : ''}`;

/** What the run waits for: a pre-start approval, or the name of the approval/input step. */
export function PendingWhat({ r }: { r: Run }) {
  if (!r.pendingStep) return <Text fz="sm">Approval of the request</Text>;
  return (
    <div>
      <Text fz="sm" fw={500}>
        {r.pendingStep.kind === 'input' ? 'Input' : 'Step'}: {r.pendingStep.name}
      </Text>
      {r.pendingStep.message && (
        <Text fz="xs" c="dimmed" lineClamp={1}>
          {r.pendingStep.message.replace(/[*_`#>]/g, '')}
        </Text>
      )}
    </div>
  );
}

/** Who a run waits on, as badges: teams, users (emails) and roles. */
export function WaitingOnBadges({ w }: { w?: WaitingOn | null }) {
  if (!w || (!w.teams.length && !w.users.length && !w.roles.length))
    return (
      <Text fz="sm" c="dimmed">
        —
      </Text>
    );
  return (
    <Group gap={4}>
      {w.teams.map((t) => (
        <Badge key={`t:${t}`} size="sm" variant="light" color="blue">
          team {t}
        </Badge>
      ))}
      {w.users.map((u) => (
        <Badge key={`u:${u}`} size="sm" variant="light" color="gray" tt="none">
          {u}
        </Badge>
      ))}
      {w.roles.map((r) => (
        <Badge key={`r:${r}`} size="sm" variant="light" color="grape">
          role {r}
        </Badge>
      ))}
    </Group>
  );
}

/** Requests and workflow steps waiting for a decision (or an input) the caller can give, with bulk approve/reject. */
export function Decisions() {
  const q = useQuery({ queryKey: ['approvals'], queryFn: api.approvals, refetchInterval: 15_000 });
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [comment, setComment] = useState('');
  const decide = useMutation({
    mutationFn: async (d: 'approve' | 'reject') => {
      const targets = (q.data ?? []).filter((r) => selected.has(approvalKey(r)));
      const results = await Promise.allSettled(
        targets.map((r) => {
          if (r.pendingStep) return d === 'approve' ? api.approveStep(r.id, r.pendingStep.id, comment) : api.rejectStep(r.id, r.pendingStep.id, comment);
          return d === 'approve' ? api.approve(r.id, comment) : api.reject(r.id, comment);
        }),
      );
      return { d, ok: results.filter((x) => x.status === 'fulfilled').length, failed: results.filter((x) => x.status === 'rejected').length };
    },
    onSuccess: ({ d, ok, failed }) => {
      notifications.show({
        color: failed ? 'orange' : 'green',
        message: `${ok} ${d === 'approve' ? 'approved' : 'rejected'}${failed ? `, ${failed} failed` : ''}`,
      });
      setSelected(new Set());
      setComment('');
      void qc.invalidateQueries({ queryKey: ['approvals'] });
      void qc.invalidateQueries({ queryKey: ['runs'] });
      void qc.invalidateQueries({ queryKey: ['home'] });
    },
    onError,
  });
  return (
    <Stack gap="xs">
      {selected.size > 0 && (
        <Group align="flex-end">
          <Text fz="sm">{selected.size} selected</Text>
          <Textarea
            aria-label="Comment for the decision"
            placeholder="Comment (required to reject)"
            value={comment}
            onChange={(e) => setComment(e.currentTarget.value)}
            autosize
            minRows={1}
            style={{ flex: 1, maxWidth: 420 }}
          />
          <Button color="green" size="xs" leftSection={<IconCheck size={14} />} loading={decide.isPending} onClick={() => decide.mutate('approve')}>
            Approve selected
          </Button>
          <Button
            color="red"
            variant="light"
            size="xs"
            leftSection={<IconX size={14} />}
            loading={decide.isPending}
            disabled={!comment.trim()}
            onClick={() => decide.mutate('reject')}
          >
            Reject selected
          </Button>
        </Group>
      )}
      <DataTable
        selection={{ selected, onChange: setSelected }}
        rows={q.data}
        loading={q.isPending}
        error={q.error}
        rowKey={approvalKey}
        onRowClick={(r) => navigate(runLink(r))}
        empty={<Empty title="Nothing to decide">You are all caught up.</Empty>}
        columns={[
          runColumns[0],
          {
            key: 'what',
            label: 'Decision',
            render: (r: Run) => (
              <div>
                <PendingWhat r={r} />
                {r.onBehalfOf && (
                  <Badge size="xs" variant="light" color="grape">
                    as delegate of {r.onBehalfOf.name}
                  </Badge>
                )}
              </div>
            ),
          },
          runColumns[2],
          runColumns[3],
        ]}
      />
    </Stack>
  );
}

/** The caller's own requests stopped at someone else's approval or input. */
export function WaitingOnOthers() {
  const q = useQuery({ queryKey: ['runs-waiting'], queryFn: () => api.runsWaiting(), refetchInterval: 30_000 });
  const navigate = useNavigate();
  return (
    <DataTable
      rows={q.data}
      loading={q.isPending}
      error={q.error}
      rowKey={approvalKey}
      onRowClick={(r) => navigate(runLink(r))}
      empty={<Empty title="Nothing waiting">None of your requests waits on someone else.</Empty>}
      columns={[
        runColumns[0],
        { key: 'what', label: 'Waiting for', render: (r: Run) => <PendingWhat r={r} /> },
        { key: 'who', label: 'Waiting on', render: (r: Run) => <WaitingOnBadges w={r.waitingOn} /> },
        { key: 't', label: 'Requested', render: (r: Run) => <TimeAgo at={r.createdAt} /> },
      ]}
    />
  );
}

/** One inbox for what needs the caller: decisions to make, their requests waiting on others, and notifications. */
export function Todo() {
  const approvals = useQuery({ queryKey: ['approvals'], queryFn: api.approvals, refetchInterval: 15_000 });
  const waiting = useQuery({ queryKey: ['runs-waiting'], queryFn: () => api.runsWaiting(), refetchInterval: 30_000 });
  const inbox = useQuery({ queryKey: ['notifications'], queryFn: () => api.notifications({ limit: 50 }), refetchInterval: 30_000 });
  const count = (n?: number) =>
    n ? (
      <Badge size="sm" variant="light" circle={n < 10}>
        {n}
      </Badge>
    ) : null;
  const unread = inbox.data?.unread ?? 0;
  return (
    <Stack gap="lg">
      <PageHeader title="To do" description="Decisions waiting for you, and your requests waiting on others." refresh={[approvals, waiting, inbox]} />
      <section aria-label="Waiting for your decision">
        <Group gap="xs" mb="xs">
          <Title order={4}>Waiting for your decision</Title>
          {count(approvals.data?.length)}
        </Group>
        <Decisions />
      </section>
      <section aria-label="Your requests waiting on others">
        <Group gap="xs" mb="xs">
          <Title order={4}>Your requests waiting on others</Title>
          {count(waiting.data?.length)}
        </Group>
        <WaitingOnOthers />
      </section>
      <Card padding="md">
        <Group justify="space-between">
          <Group gap="sm">
            <IconBell size={18} stroke={1.6} />
            <Text fz="sm">{unread ? `${unread} unread notification${unread > 1 ? 's' : ''}` : 'No unread notification'}: run outcomes and updates.</Text>
          </Group>
          <Button size="xs" variant="light" onClick={openNotifications}>
            Open notifications
          </Button>
        </Group>
      </Card>
    </Stack>
  );
}
