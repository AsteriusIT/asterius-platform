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
  NativeSelect,
  ScrollArea,
  SegmentedControl,
  Stack,
  Table,
  Text,
  Select,
  Textarea,
  Timeline,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { IconCheck, IconExternalLink, IconPlayerPlay, IconPlayerStop, IconRepeat, IconX } from '@tabler/icons-react';
import type { Run, RunStatus, RunStep } from '@asterius/shared';
import { api, errorText } from '../lib/api';
import { DataTable } from '../components/DataTable';
import { duration, Empty, Markdown, PageHeader, QueryView, StatusBadge, STATUS_COLORS, TimeAgo } from '../components/ui';
import { WorkflowGraph } from '../components/WorkflowGraph';
import { splitJobLog, STEP_STATUS_COLORS, STEP_STATUS_LABELS, STEP_TYPES } from '../lib/workflow';
import { PropertyValue } from '../components/PropertyValue';
import { initialValues, SchemaForm, validateValues, type FormValues } from '../components/SchemaForm';

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
  const q = useQuery({
    queryKey: ['runs', scope, status.join(','), page],
    queryFn: () => api.runs({ mine: scope === 'mine', status: status.join(',') || undefined, limit: PAGE, offset: (page - 1) * PAGE }),
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
        <MultiSelect placeholder="Any status" clearable data={Object.keys(STATUS_COLORS)} value={status} onChange={(v) => set('status', v.join(','))} w={360} />
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
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['run', id],
    // Poll incrementally: fetch only the log lines past the last one we hold and append them.
    queryFn: async () => {
      const prev = qc.getQueryData<Run>(['run', id]);
      const after = prev?.logs?.length ? prev.logs[prev.logs.length - 1].seq : undefined;
      const r = await api.run(id, after);
      return after === undefined ? r : { ...r, logs: [...(prev?.logs ?? []), ...(r.logs ?? [])] };
    },
    refetchInterval: (query) => (query.state.data && !ACTIVE.includes(query.state.data.status) ? false : 2_500),
  });
  return <QueryView q={q}>{(r) => <RunView r={r} />}</QueryView>;
}

const LOG_COLORS = { info: undefined, warn: 'var(--mantine-color-yellow-6)', error: 'var(--mantine-color-red-6)' } as const;

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
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [comment, setComment] = useState('');
  const [selected, setSelected] = useState<string | null>(() => defaultStep(r, params.get('step')));
  const [allLogs, setAllLogs] = useState(false);
  const [job, setJob] = useState<string | null>(null);
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
  const cancel = useMutation({ mutationFn: () => api.cancel(r.id), onSuccess: refresh, onError });
  const resume = useMutation({ mutationFn: () => api.resume(r.id), onSuccess: refresh, onError });
  const rerun = useMutation({
    mutationFn: () => api.rerun(r.id),
    onSuccess: (run) => {
      void qc.invalidateQueries({ queryKey: ['runs'] });
      void navigate(`/runs/${run.id}`);
    },
    onError,
  });
  const steps = r.steps ?? [];
  const step = steps.find((s) => s.id === selected) ?? null;
  const stepLogs = (r.logs ?? []).filter((l) => allLogs || !step || l.stepId === step.id);
  const jobs = [...new Set(stepLogs.map((l) => splitJobLog(l.message).job).filter((j): j is string => !!j))];
  const logs = stepLogs.filter((l) => !job || splitJobLog(l.message).job === job);

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
            {r.canResume && (
              <Button variant="light" leftSection={<IconPlayerPlay size={16} />} loading={resume.isPending} onClick={() => resume.mutate()}>
                Resume
              </Button>
            )}
            {r.canRerun && (
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
                  {r.trigger && r.trigger.type !== 'form' && <Row k="Started by" v={r.trigger.type} />}
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
                  {jobs.length > 1 && (
                    <NativeSelect
                      size="xs"
                      aria-label="Filter by job"
                      value={job ?? ''}
                      onChange={(e) => setJob(e.currentTarget.value || null)}
                      data={[{ value: '', label: 'All jobs' }, ...jobs.map((j) => ({ value: j, label: j }))]}
                    />
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
              <ScrollArea h={420} type="auto">
                <pre
                  className="log-view"
                  style={{ margin: 0, padding: 14, minHeight: '100%', fontSize: 12.5, lineHeight: 1.6, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}
                >
                  {logs.length === 0 && <span style={{ opacity: 0.55 }}>No log lines yet.</span>}
                  {logs.map((l, i) => (
                    <div key={i} style={{ color: LOG_COLORS[l.level] }}>
                      <span style={{ opacity: 0.55 }}>{new Date(l.at).toLocaleTimeString()} </span>
                      {allLogs && l.stepId && <span style={{ opacity: 0.7 }}>[{l.stepId}] </span>}
                      {(() => {
                        const { job: j, text } = splitJobLog(l.message);
                        return j ? (
                          <>
                            <span style={{ opacity: 0.7, fontWeight: 600 }}>[{j}] </span>
                            {text}
                          </>
                        ) : (
                          text
                        );
                      })()}
                    </div>
                  ))}
                </pre>
              </ScrollArea>
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
  const form = step.form ?? { properties: {} };
  const [values, setValues] = useState<FormValues>(() => initialValues(form));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [choice, setChoice] = useState<string | null>(null);
  const onError = (e: unknown) => notifications.show({ color: 'red', message: errorText(e) });
  const decide = useMutation({
    mutationFn: (d: 'approve' | 'reject') =>
      d === 'approve'
        ? api.approveStep(run.id, step.id, comment, { choice: choice ?? undefined, values: step.form ? values : undefined })
        : api.rejectStep(run.id, step.id, comment),
    onSuccess: (r) => {
      setComment('');
      onDone(r);
    },
    onError,
  });
  const submitInput = useMutation({ mutationFn: () => api.submitInput(run.id, step.id, values), onSuccess: onDone, onError });
  const validated = (go: () => void) => {
    const e = validateValues(form, values);
    setErrors(e);
    if (!Object.keys(e).length) go();
  };
  const retry = useMutation({
    mutationFn: () => api.retryStep(run.id, step.id),
    onSuccess: onDone,
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
        <Group gap="xs">
          {step.canRetry && (
            <Button size="xs" variant="light" leftSection={<IconRepeat size={14} />} loading={retry.isPending} onClick={() => retry.mutate()}>
              Retry step
            </Button>
          )}
          {step.link && (
            <Button size="xs" component="a" href={step.link} target="_blank" variant="default" rightSection={<IconExternalLink size={14} />}>
              Open
            </Button>
          )}
        </Group>
      </Group>

      {step.message && (
        <Box p="sm" my="xs" style={{ background: 'var(--surface)', borderRadius: 12 }}>
          <Markdown>{step.message}</Markdown>
        </Box>
      )}
      {step.type === 'input' && step.canSubmit && (
        <Stack gap="xs" mt="xs">
          <SchemaForm schema={form} values={values} onChange={setValues} errors={errors} />
          <Group>
            <Button leftSection={<IconCheck size={16} />} loading={submitInput.isPending} onClick={() => validated(() => submitInput.mutate())}>
              Submit
            </Button>
          </Group>
        </Stack>
      )}
      {step.children && step.children.length > 0 && (
        <Stack gap={4} mt="xs">
          <Text fz="sm" fw={500}>
            {step.children.length > 1 ? 'Child runs' : 'Child run'}
          </Text>
          {step.children.map((c) => (
            <Group key={c.runId} gap="xs">
              <Badge variant="light" color={STATUS_COLORS[c.status as RunStatus] ?? 'gray'}>
                {c.status}
              </Badge>
              <Text component={Link} to={`/runs/${c.runId}`} fz="sm">
                {c.item !== undefined ? `${typeof c.item === 'string' ? c.item : JSON.stringify(c.item)} · ` : ''}
                {c.runId.slice(0, 8)}
              </Text>
            </Group>
          ))}
        </Stack>
      )}
      {step.canApprove && (
        <Stack gap="xs" mt="xs">
          {step.choices && step.choices.length > 0 && <Select label="Your decision" data={step.choices} value={choice} onChange={setChoice} />}
          {step.type === 'approval' && step.form && <SchemaForm schema={form} values={values} onChange={setValues} errors={errors} />}
          <Textarea placeholder="Comment (required to reject)" value={comment} onChange={(e) => setComment(e.currentTarget.value)} autosize minRows={2} />
          <Group>
            <Button
              color="green"
              leftSection={<IconCheck size={16} />}
              loading={decide.isPending && decide.variables === 'approve'}
              onClick={() => (step.form ? validated(() => decide.mutate('approve')) : decide.mutate('approve'))}
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
