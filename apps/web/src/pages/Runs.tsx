import { useState } from 'react';
import {
  Alert,
  Anchor,
  Badge,
  Box,
  Button,
  Card,
  Code,
  Grid,
  Group,
  MultiSelect,
  SegmentedControl,
  Select,
  Stack,
  Table,
  Text,
  Textarea,
  Timeline,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { IconCheck, IconExternalLink, IconPlayerStop, IconRepeat, IconX } from '@tabler/icons-react';
import type { Run, RunStatus, RunStep } from '@asterius/shared';
import { api, errorText } from '../lib/api';
import { DataTable } from '../components/DataTable';
import { LogViewer } from '../components/LogViewer';
import { duration, Empty, Markdown, PageHeader, QueryView, StatusBadge, STATUS_COLORS, STATUS_LABELS, TimeAgo } from '../components/ui';
import { WorkflowGraph } from '../components/WorkflowGraph';
import { STEP_STATUS_COLORS, STEP_STATUS_LABELS, STEP_TYPES } from '../lib/workflow';
import { PropertyValue } from '../components/PropertyValue';

const PAGE = 30;
const ACTIVE: RunStatus[] = ['PENDING_APPROVAL', 'QUEUED', 'IN_PROGRESS'];

const runColumns = [
  {
    key: 'a',
    label: 'Action',
    render: (r: Run) => (
      <div>
        <Text fz="sm" fw={500}>
          {r.actionTitle}
        </Text>
        {r.entity && (
          <Text fz="xs" c="dimmed">
            {r.blueprint}/{r.entity}
          </Text>
        )}
      </div>
    ),
  },
  { key: 's', label: 'Status', render: (r: Run) => <StatusBadge status={r.status} label={r.statusLabel} /> },
  { key: 'u', label: 'Requested by', render: (r: Run) => r.triggeredBy.name },
  { key: 't', label: 'When', render: (r: Run) => <TimeAgo at={r.createdAt} /> },
  { key: 'd', label: 'Duration', render: (r: Run) => <Text fz="sm">{r.startedAt ? duration(r.startedAt, r.endedAt) : '—'}</Text> },
];

export function Runs() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const scope = params.get('scope') ?? 'mine';
  const status = params.get('status')?.split(',').filter(Boolean) ?? [];
  const page = Number(params.get('page') ?? 1);
  const action = params.get('action');
  const actions = useQuery({ queryKey: ['actions', 'all'], queryFn: () => api.actions(), staleTime: 60_000 });
  const q = useQuery({
    queryKey: ['runs', scope, status.join(','), action, page],
    queryFn: () =>
      api.runs({ mine: scope === 'mine', status: status.join(',') || undefined, action: action ?? undefined, limit: PAGE, offset: (page - 1) * PAGE }),
    placeholderData: keepPreviousData,
    refetchInterval: (query) => (query.state.data?.items.some((r) => ACTIVE.includes(r.status)) ? 5_000 : 30_000),
  });
  const set = (k: string, v: string) => {
    const n = new URLSearchParams(params);
    if (v) n.set(k, v);
    else n.delete(k);
    if (k !== 'page') n.delete('page');
    setParams(n, { replace: true });
  };
  return (
    <Stack>
      <PageHeader title="Runs" description="Every self-service request and its execution." />
      <Group>
        <SegmentedControl
          value={scope}
          onChange={(v) => set('scope', v)}
          data={[
            { value: 'mine', label: 'Mine' },
            { value: 'all', label: 'Everyone' },
          ]}
        />
        <MultiSelect
          placeholder="Any status"
          aria-label="Filter by status"
          clearable
          data={(Object.keys(STATUS_COLORS) as RunStatus[]).map((k) => ({ value: k, label: STATUS_LABELS[k] }))}
          value={status}
          onChange={(v) => set('status', v.join(','))}
          w={320}
        />
        <Select
          placeholder="Any action"
          aria-label="Filter by action"
          searchable
          clearable
          data={(actions.data ?? []).map((a) => ({ value: a.identifier, label: a.title }))}
          value={action}
          onChange={(v) => set('action', v ?? '')}
          w={240}
        />
      </Group>
      <DataTable
        rows={q.data?.items}
        loading={q.isPending}
        error={q.error}
        rowKey={(r) => r.id}
        onRowClick={(r) => navigate(`/runs/${r.id}`)}
        empty="No runs"
        columns={runColumns}
        page={{ page, pageSize: PAGE, total: q.data?.total ?? 0, onChange: (p) => set('page', String(p)) }}
      />
    </Stack>
  );
}

export function Approvals() {
  const q = useQuery({ queryKey: ['approvals'], queryFn: api.approvals, refetchInterval: 15_000 });
  const navigate = useNavigate();
  return (
    <Stack>
      <PageHeader title="Approvals" description="Requests and workflow steps waiting for a decision you can make." />
      <DataTable
        rows={q.data}
        loading={q.isPending}
        error={q.error}
        rowKey={(r) => `${r.id}/${r.pendingStep?.id ?? ''}`}
        onRowClick={(r) => navigate(`/runs/${r.id}${r.pendingStep ? `?step=${r.pendingStep.id}` : ''}`)}
        empty={<Empty title="Nothing to approve">You are all caught up.</Empty>}
        columns={[
          runColumns[0],
          {
            key: 'what',
            label: 'Decision',
            render: (r: Run) =>
              r.pendingStep ? (
                <div>
                  <Text fz="sm" fw={500}>
                    Step: {r.pendingStep.name}
                  </Text>
                  {r.pendingStep.message && (
                    <Text fz="xs" c="dimmed" lineClamp={1}>
                      {r.pendingStep.message.replace(/[*_`#>]/g, '')}
                    </Text>
                  )}
                </div>
              ) : (
                <Text fz="sm">Start of the request</Text>
              ),
          },
          runColumns[2],
          runColumns[3],
        ]}
      />
    </Stack>
  );
}

export function RunPage() {
  const { id = '' } = useParams();
  const q = useQuery({
    queryKey: ['run', id],
    queryFn: () => api.run(id),
    refetchInterval: (query) => (query.state.data && !ACTIVE.includes(query.state.data.status) ? false : 2_500),
  });
  return <QueryView q={q}>{(r) => <RunView r={r} />}</QueryView>;
}

/** The step to show first: ?step=, else the one needing attention, else the last that ran. */
function defaultStep(r: Run, requested: string | null) {
  const steps = r.steps ?? [];
  if (requested && steps.some((s) => s.id === requested)) return requested;
  return (
    steps.find((s) => s.canApprove)?.id ??
    steps.find((s) => s.status === 'RUNNING' || s.status === 'WAITING_APPROVAL')?.id ??
    [...steps].reverse().find((s) => s.startedAt)?.id ??
    steps[0]?.id ??
    null
  );
}

function RunView({ r }: { r: Run }) {
  const qc = useQueryClient();
  const [params] = useSearchParams();
  const [comment, setComment] = useState('');
  const [selected, setSelected] = useState<string | null>(() => defaultStep(r, params.get('step')));
  const [allLogs, setAllLogs] = useState(false);
  const refresh = (run: Run) => {
    qc.setQueryData(['run', r.id], run);
    void qc.invalidateQueries({ queryKey: ['approvals'] });
    void qc.invalidateQueries({ queryKey: ['runs'] });
  };
  const onError = (e: unknown) => notifications.show({ color: 'red', message: errorText(e) });
  const decide = useMutation({
    mutationFn: (d: 'approve' | 'reject') => (d === 'approve' ? api.approve(r.id, comment) : api.reject(r.id, comment)),
    onSuccess: (run) => {
      refresh(run);
      setComment('');
    },
    onError,
  });
  const navigate = useNavigate();
  const rerun = useMutation({
    mutationFn: () => api.trigger(r.action, { entity: r.entity, inputs: r.inputs }),
    onSuccess: (run) => {
      void qc.invalidateQueries({ queryKey: ['runs'] });
      navigate(`/runs/${run.id}`);
    },
    onError,
  });
  const cancel = useMutation({ mutationFn: () => api.cancel(r.id), onSuccess: refresh, onError });
  const steps = r.steps ?? [];
  const step = steps.find((s) => s.id === selected) ?? null;
  const logs = (r.logs ?? []).filter((l) => allLogs || !step || l.stepId === step.id);

  return (
    <Stack>
      <PageHeader
        crumbs={[{ label: 'Runs', to: '/runs' }, { label: r.id.slice(0, 8) }]}
        title={r.actionTitle}
        description={
          <Group gap="xs" component="span">
            <StatusBadge status={r.status} />
            {r.statusLabel && (
              <Text span fz="sm" c="dimmed">
                {r.statusLabel}
              </Text>
            )}
          </Group>
        }
        actions={
          <>
            {r.link && (
              <Button
                component="a"
                href={r.link}
                target={r.link.startsWith(window.location.origin) ? undefined : '_blank'}
                variant="default"
                rightSection={<IconExternalLink size={16} />}
              >
                Open
              </Button>
            )}
            {!ACTIVE.includes(r.status) && (
              <Button variant="default" leftSection={<IconRepeat size={16} />} loading={rerun.isPending} onClick={() => rerun.mutate()}>
                Run again
              </Button>
            )}
            {r.canCancel && (
              <Button color="red" variant="light" leftSection={<IconPlayerStop size={16} />} loading={cancel.isPending} onClick={() => cancel.mutate()}>
                Cancel
              </Button>
            )}
          </>
        }
      />

      {r.canApprove && (
        <Alert color="yellow" title="Your approval is requested to start this request">
          <Stack gap="xs">
            <Textarea placeholder="Comment (required to reject)" value={comment} onChange={(e) => setComment(e.currentTarget.value)} autosize minRows={2} />
            <Group>
              <Button
                color="green"
                leftSection={<IconCheck size={16} />}
                loading={decide.isPending && decide.variables === 'approve'}
                onClick={() => decide.mutate('approve')}
              >
                Approve
              </Button>
              <Button
                color="red"
                variant="light"
                leftSection={<IconX size={16} />}
                loading={decide.isPending && decide.variables === 'reject'}
                onClick={() => decide.mutate('reject')}
              >
                Reject
              </Button>
            </Group>
          </Stack>
        </Alert>
      )}

      {steps.length > 0 && (
        <Card padding="md">
          <Text fw={600} mb="sm">
            Workflow
          </Text>
          <WorkflowGraph
            steps={steps.map((s) => ({ id: s.id, name: s.name, type: s.type, needs: s.needs, status: s.status }))}
            selected={selected}
            onSelect={(id) => {
              setSelected(id);
              setAllLogs(false);
            }}
          />
        </Card>
      )}

      <Grid>
        <Grid.Col span={{ base: 12, md: 4 }}>
          <Stack>
            <Card>
              <Table withRowBorders={false} verticalSpacing={4} highlightOnHover={false} fz="sm">
                <Table.Tbody>
                  <Row k="Requested by" v={`${r.triggeredBy.name} <${r.triggeredBy.email}>`} />
                  {r.entity && (
                    <Row
                      k="Entity"
                      v={
                        <Anchor component={Link} to={`/catalog/${r.blueprint}/${encodeURIComponent(r.entity)}`} fz="sm">
                          {r.blueprint}/{r.entity}
                        </Anchor>
                      }
                    />
                  )}
                  <Row k="Created" v={<TimeAgo at={r.createdAt} />} />
                  <Row k="Started" v={<TimeAgo at={r.startedAt} />} />
                  <Row k="Duration" v={r.startedAt ? duration(r.startedAt, r.endedAt) : '—'} />
                  <Row k="Action" v={<Code>{r.action}</Code>} />
                </Table.Tbody>
              </Table>
            </Card>
            <Card>
              <Text fw={600} mb="xs">
                Inputs
              </Text>
              {Object.keys(r.inputs).length ? (
                <Table withRowBorders={false} verticalSpacing={4} highlightOnHover={false}>
                  <Table.Tbody>
                    {Object.entries(r.inputs).map(([k, v]) => (
                      <Row key={k} k={k} v={<PropertyValue value={v} />} />
                    ))}
                  </Table.Tbody>
                </Table>
              ) : (
                <Text c="dimmed" fz="sm">
                  No inputs
                </Text>
              )}
            </Card>
            {r.approvals.length > 0 && (
              <Card>
                <Text fw={600} mb="xs">
                  Request approvals
                </Text>
                <ApprovalTimeline approvals={r.approvals} />
              </Card>
            )}
          </Stack>
        </Grid.Col>
        <Grid.Col span={{ base: 12, md: 8 }}>
          <Stack>
            {step && <StepPanel run={r} step={step} onDone={refresh} />}
            <Card p={0}>
              <Group justify="space-between" p="sm" style={{ borderBottom: '1px solid var(--hairline)' }}>
                <Group gap="xs">
                  <Text fw={600}>Logs</Text>
                  {step && !allLogs && (
                    <Badge color="gray" variant="light">
                      {step.name}
                    </Badge>
                  )}
                </Group>
                <Group gap="xs">
                  {ACTIVE.includes(r.status) && (
                    <Badge variant="dot" color="blue">
                      live
                    </Badge>
                  )}
                  {step && (
                    <SegmentedControl
                      size="xs"
                      value={allLogs ? 'all' : 'step'}
                      onChange={(v) => setAllLogs(v === 'all')}
                      data={[
                        { value: 'step', label: 'This step' },
                        { value: 'all', label: 'All' },
                      ]}
                    />
                  )}
                </Group>
              </Group>
              <LogViewer lines={logs} showStep={allLogs} filename={`run-${r.id}.log`} follow={ACTIVE.includes(r.status)} />
            </Card>
          </Stack>
        </Grid.Col>
      </Grid>
    </Stack>
  );
}

function ApprovalTimeline({ approvals }: { approvals: Run['approvals'] }) {
  return (
    <Timeline bulletSize={20} lineWidth={2}>
      {approvals.map((a) => (
        <Timeline.Item
          key={a.userId + a.at}
          color={a.decision === 'approved' ? 'green' : 'red'}
          bullet={a.decision === 'approved' ? <IconCheck size={12} /> : <IconX size={12} />}
          title={`${a.userName} ${a.decision}`}
        >
          {a.comment && <Text fz="sm">{a.comment}</Text>}
          <Text fz="xs" c="dimmed">
            <TimeAgo at={a.at} />
          </Text>
        </Timeline.Item>
      ))}
    </Timeline>
  );
}

/** One step: status, output, approval decision. */
function StepPanel({ run, step, onDone }: { run: Run; step: RunStep; onDone: (r: Run) => void }) {
  const [comment, setComment] = useState('');
  const decide = useMutation({
    mutationFn: (d: 'approve' | 'reject') => (d === 'approve' ? api.approveStep(run.id, step.id, comment) : api.rejectStep(run.id, step.id, comment)),
    onSuccess: (r) => {
      setComment('');
      onDone(r);
    },
    onError: (e) => notifications.show({ color: 'red', message: errorText(e) }),
  });
  const output = step.output as Record<string, unknown> | null;
  const textOnly = output && Object.keys(output).length === 1 && typeof output.text === 'string';
  return (
    <Card>
      <Group justify="space-between" align="flex-start" mb="xs">
        <div>
          <Group gap="xs">
            <Text fw={600}>{step.name}</Text>
            <Badge color={STEP_TYPES[step.type].color}>{STEP_TYPES[step.type].label}</Badge>
            <Badge color={STEP_STATUS_COLORS[step.status]} variant={step.status === 'RUNNING' ? 'dot' : 'light'}>
              {STEP_STATUS_LABELS[step.status]}
            </Badge>
          </Group>
          <Text fz="xs" c="dimmed" mt={4}>
            {step.statusLabel ? `${step.statusLabel} · ` : ''}
            {step.startedAt ? duration(step.startedAt, step.endedAt) : 'not started'}
            {step.maxAttempts > 1 ? ` · attempt ${Math.max(step.attempt, 1)}/${step.maxAttempts}` : ''}
            {step.continueOnError ? ' · may fail without failing the workflow' : ''}
          </Text>
        </div>
        {step.link && (
          <Button size="xs" component="a" href={step.link} target="_blank" variant="default" rightSection={<IconExternalLink size={14} />}>
            Open
          </Button>
        )}
      </Group>

      {step.message && (
        <Box p="sm" my="xs" style={{ background: 'var(--surface)', borderRadius: 12 }}>
          <Markdown>{step.message}</Markdown>
        </Box>
      )}
      {step.canApprove && (
        <Stack gap="xs" mt="xs">
          <Textarea placeholder="Comment (required to reject)" value={comment} onChange={(e) => setComment(e.currentTarget.value)} autosize minRows={2} />
          <Group>
            <Button
              color="green"
              leftSection={<IconCheck size={16} />}
              loading={decide.isPending && decide.variables === 'approve'}
              onClick={() => decide.mutate('approve')}
            >
              Approve
            </Button>
            <Button
              color="red"
              variant="light"
              leftSection={<IconX size={16} />}
              loading={decide.isPending && decide.variables === 'reject'}
              onClick={() => decide.mutate('reject')}
            >
              Reject
            </Button>
          </Group>
        </Stack>
      )}
      {step.approvals.length > 0 && (
        <Box mt="sm">
          <ApprovalTimeline approvals={step.approvals} />
        </Box>
      )}
      {output != null && step.type !== 'approval' && (
        <Box mt="sm">
          <Text fz="sm" fw={500} mb={4}>
            Output
          </Text>
          {textOnly ? (
            <Box p="sm" style={{ background: 'var(--surface)', borderRadius: 12 }}>
              <Markdown>{String(output.text)}</Markdown>
            </Box>
          ) : typeof output === 'object' && !Array.isArray(output) ? (
            <Table withRowBorders={false} verticalSpacing={4} highlightOnHover={false}>
              <Table.Tbody>
                {Object.entries(output).map(([k, v]) => (
                  <Row key={k} k={k} v={<PropertyValue value={v} />} />
                ))}
              </Table.Tbody>
            </Table>
          ) : (
            <PropertyValue value={output} />
          )}
        </Box>
      )}
    </Card>
  );
}

function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <Table.Tr>
      <Table.Td c="dimmed" w="40%" fz="sm" style={{ verticalAlign: 'top' }}>
        {k}
      </Table.Td>
      <Table.Td fz="sm" style={{ overflowWrap: 'anywhere' }}>
        {v}
      </Table.Td>
    </Table.Tr>
  );
}
