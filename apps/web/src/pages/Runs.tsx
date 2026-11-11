import { useState } from 'react';
import {
  Alert,
  Anchor,
  Badge,
  Box,
  Button,
  Code,
  Group,
  Modal,
  MultiSelect,
  NativeSelect,
  SegmentedControl,
  Select,
  SimpleGrid,
  Stack,
  Table,
  Text,
  Textarea,
  TextInput,
  Timeline,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, Navigate, useLocation, useNavigate, useParams, useSearchParams } from 'react-router';
import {
  IconCheck,
  IconCircleCheck,
  IconDownload,
  IconExternalLink,
  IconFileText,
  IconInfoCircle,
  IconPlayerPause,
  IconPlayerPlay,
  IconPlayerSkipForward,
  IconPlayerStop,
  IconRepeat,
  IconX,
} from '@tabler/icons-react';
import type { Run, RunArtifact, RunStatus, RunStep } from '@asterius/shared';
import { api, downloadArtifact, errorText } from '../lib/api';
import { DataTable } from '../components/DataTable';
import { useUrlParams } from '../lib/urlState';
import { useRunStream } from '../lib/runStream';
import { LogViewer } from '../components/LogViewer';
import { Section } from '../components/Section';
import { SIDE_PANEL_WIDTHS, SidePanel } from '../components/SidePanel';
import { Caption, duration, Markdown, PageHeader, QueryView, StatusBadge, STATUS_COLORS, STATUS_LABELS, SurfaceBox, TimeAgo } from '../components/ui';
import { EntityIcon } from '../components/icons';
import { ICON } from '../components/iconScale';
import { TRIGGER_ID, WorkflowFlow, type FlowStep, type FlowTrigger } from '../components/WorkflowFlow';
import { FlowShell } from '../components/FlowShell';
import { ExplainRun } from '../components/AiAssistant';
import { controlBadges, splitJobLog, STEP_STATUS_COLORS, STEP_STATUS_LABELS, STEP_TYPES, stepTone } from '../lib/workflow';
import { PropertyValue } from '../components/PropertyValue';
import { initialValues, SchemaForm, validateValues, type FormValues } from '../components/SchemaForm';
import { UserChip } from '../components/UserChip';
import { appHref } from '../lib/orgUrl';

const PAGE = 30;
const onError = (e: unknown) => notifications.show({ color: 'red', message: errorText(e) });
const ACTIVE: RunStatus[] = ['PENDING_APPROVAL', 'QUEUED', 'IN_PROGRESS'];

export const runColumns = [
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
  { key: 's', label: 'Status', render: (r: Run) => <StatusBadge status={r.status} label={r.paused ? 'Paused' : r.statusLabel} /> },
  { key: 'u', label: 'Requested by', render: (r: Run) => <UserChip user={r.triggeredBy} /> },
  { key: 't', label: 'When', render: (r: Run) => <TimeAgo at={r.createdAt} /> },
  { key: 'd', label: 'Duration', render: (r: Run) => <Text fz="sm">{r.startedAt ? duration(r.startedAt, r.endedAt) : '—'}</Text> },
];

/** The filters grow in the row of the scope switch and go to their own row under this width (px). */
const FILTERS_FLEX = '1 1 640px';

export function Runs() {
  const [params, set] = useUrlParams();
  const navigate = useNavigate();
  const scope = params.get('scope') ?? 'mine';
  const status = params.get('status')?.split(',').filter(Boolean) ?? [];
  const page = Number(params.get('page') ?? 1);
  const action = params.get('action');
  const blueprint = params.get('blueprint');
  const entity = params.get('entity');
  const blueprints = useQuery({ queryKey: ['blueprints'], queryFn: api.blueprints, staleTime: 30_000 });
  const actions = useQuery({ queryKey: ['actions', 'all'], queryFn: () => api.actions(), staleTime: 60_000 });
  const q = useQuery({
    queryKey: ['runs', scope, status.join(','), action, blueprint, entity, page],
    queryFn: () =>
      api.runs({
        mine: scope === 'mine',
        myTeams: scope === 'team',
        status: status.join(',') || undefined,
        action: action ?? undefined,
        blueprint: blueprint ?? undefined,
        entity: entity ?? undefined,
        limit: PAGE,
        offset: (page - 1) * PAGE,
      }),
    placeholderData: keepPreviousData,
    refetchInterval: (query) => (query.state.data?.items.some((r) => ACTIVE.includes(r.status)) ? 5_000 : 30_000),
  });
  return (
    <Stack>
      <PageHeader title="Runs" description="Every self-service request and its execution." refresh={q} />
      {/* The four filters share the row left by the scope switch, in equal widths; short of room they wrap together under it. */}
      <Group align="flex-start">
        <SegmentedControl
          value={scope}
          onChange={(v) => set('scope', v)}
          data={[
            { value: 'mine', label: 'Mine' },
            { value: 'team', label: 'My teams' },
            { value: 'all', label: 'Everyone' },
          ]}
        />
        <SimpleGrid cols={{ base: 1, xs: 2, md: 4 }} spacing="sm" flex={FILTERS_FLEX} miw={0}>
          <MultiSelect
            placeholder={status.length ? undefined : 'Any status'}
            aria-label="Filter by status"
            clearable
            data={(Object.keys(STATUS_COLORS) as RunStatus[]).map((k) => ({ value: k, label: STATUS_LABELS[k] }))}
            value={status}
            onChange={(v) => set('status', v.join(','))}
          />
          <Select
            placeholder="Any blueprint"
            aria-label="Filter by blueprint"
            clearable
            data={(blueprints.data ?? []).map((b) => ({ value: b.identifier, label: b.title }))}
            value={blueprint}
            onChange={(v) => set('blueprint', v ?? '')}
          />
          <TextInput
            placeholder="Entity identifier"
            aria-label="Filter by entity"
            value={entity ?? ''}
            onChange={(e) => set('entity', e.currentTarget.value)}
          />
          <Select
            placeholder="Any action"
            aria-label="Filter by action"
            searchable
            clearable
            data={(actions.data ?? []).map((a) => ({ value: a.identifier, label: a.title }))}
            value={action}
            onChange={(v) => set('action', v ?? '')}
          />
        </SimpleGrid>
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

/** A run, kept live: server-sent events, polling only while the stream is not connected. */
function useLiveRun(id: string) {
  const qc = useQueryClient();
  const live = useRunStream(id, true);
  return useQuery({
    queryKey: ['run', id],
    // Poll incrementally: fetch only the log lines past the last one we hold and append them.
    queryFn: async () => {
      const prev = qc.getQueryData<Run>(['run', id]);
      const after = prev?.logs?.length ? prev.logs[prev.logs.length - 1].seq : undefined;
      const r = await api.run(id, after);
      return after === undefined ? r : { ...r, logs: [...(prev?.logs ?? []), ...(r.logs ?? [])] };
    },
    refetchInterval: (query) => (live || (query.state.data && !ACTIVE.includes(query.state.data.status)) ? false : 2_500),
  });
}

/** Stores a run returned by an action (approve, cancel…) and refreshes the lists that show it. */
function useRunRefresh(id: string) {
  const qc = useQueryClient();
  return (run: Run) => {
    qc.setQueryData(['run', id], run);
    void qc.invalidateQueries({ queryKey: ['approvals'] });
    void qc.invalidateQueries({ queryKey: ['runs'] });
  };
}

/**
 * A run as a full-panel graph (the sidebar and top bar stay): the trigger and the steps coloured by status, the run's
 * buttons on top. Clicking a node opens its details on the side, next to the live graph: a step's status, decision
 * form and logs; the trigger's request, inputs, approvals and AI explanation. ?step= opens that step.
 */
export function RunPage() {
  const { id = '' } = useParams();
  const q = useLiveRun(id);
  return <QueryView q={q}>{(r) => <RunFlow key={r.id} r={r} />}</QueryView>;
}

/** The former full-view URL. */
export function RunFlowPage() {
  const { id = '' } = useParams();
  const { search } = useLocation();
  return <Navigate to={`/runs/${id}${search}`} replace />;
}

/** Open, resume, run again, cancel: the run's buttons. */
function RunActions({ r, onDone, size }: { r: Run; onDone: (run: Run) => void; size?: 'xs' | 'sm' }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const cancel = useMutation({ mutationFn: () => api.cancel(r.id), onSuccess: onDone, onError });
  const resume = useMutation({ mutationFn: () => api.resume(r.id), onSuccess: onDone, onError });
  const pause = useMutation({ mutationFn: () => (r.paused ? api.unpause(r.id) : api.pause(r.id)), onSuccess: onDone, onError });
  const rerun = useMutation({
    mutationFn: () => api.rerun(r.id),
    onSuccess: (run) => {
      void qc.invalidateQueries({ queryKey: ['runs'] });
      void navigate(`/runs/${run.id}`);
    },
    onError,
  });
  return (
    <>
      {r.link && (
        <Button
          size={size}
          component="a"
          href={appHref(r.link)}
          target={r.link.startsWith('/') || r.link.startsWith(window.location.origin) ? undefined : '_blank'}
          variant="default"
          rightSection={<IconExternalLink size={16} />}
        >
          Open
        </Button>
      )}
      {r.canResume && (
        <Button size={size} variant="light" leftSection={<IconPlayerPlay size={16} />} loading={resume.isPending} onClick={() => resume.mutate()}>
          Resume
        </Button>
      )}
      {(r.canPause || r.canUnpause) && (
        <Button
          size={size}
          variant="light"
          color="yellow"
          leftSection={r.canUnpause ? <IconPlayerPlay size={16} /> : <IconPlayerPause size={16} />}
          loading={pause.isPending}
          onClick={() => pause.mutate()}
        >
          {r.canUnpause ? 'Unpause' : 'Pause'}
        </Button>
      )}
      {r.canRerun && (
        <Button size={size} variant="default" leftSection={<IconRepeat size={16} />} loading={rerun.isPending} onClick={() => rerun.mutate()}>
          Run again
        </Button>
      )}
      {r.canCancel && (
        <Button size={size} color="red" variant="light" leftSection={<IconPlayerStop size={16} />} loading={cancel.isPending} onClick={() => cancel.mutate()}>
          Cancel
        </Button>
      )}
    </>
  );
}

/** The request waits for the caller's approval before any step starts. */
function RequestApproval({ r, onDone }: { r: Run; onDone: (run: Run) => void }) {
  const [comment, setComment] = useState('');
  const decide = useMutation({
    mutationFn: (d: 'approve' | 'reject') => (d === 'approve' ? api.approve(r.id, comment) : api.reject(r.id, comment)),
    onSuccess: (run) => {
      onDone(run);
      setComment('');
    },
    onError,
  });
  return (
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
  );
}

/** The run's steps as graph nodes, coloured by status. */
function runFlowSteps(r: Run): FlowStep[] {
  return (r.steps ?? []).map((s) => ({
    id: s.id,
    name: s.name,
    type: s.type,
    needs: s.needs,
    tone: stepTone(s.status),
    detail: s.statusLabel || (s.status === 'PENDING' ? null : STEP_STATUS_LABELS[s.status]),
    badges: [
      ...(s.maxAttempts > 1 && s.attempt > 1 ? [`attempt ${s.attempt}/${s.maxAttempts}`] : []),
      ...(s.canApprove || s.canSubmit ? ['needs you'] : []),
      ...(s.slaBreachedAt ? ['SLA breached'] : []),
      ...controlBadges(s),
    ],
  }));
}

/** The node before the steps: what started the run, coloured by the request's own approval. */
function runTrigger(r: Run): FlowTrigger {
  const type = r.trigger?.type ?? 'form';
  return {
    title: type === 'form' ? 'Form submitted' : `${type[0]!.toUpperCase()}${type.slice(1)} trigger`,
    subtitle: r.triggeredBy.name,
    tone: r.status === 'PENDING_APPROVAL' ? 'pending' : r.status === 'REJECTED' ? 'failure' : 'success',
    badges: r.status === 'PENDING_APPROVAL' ? ['awaiting approval'] : r.approvals.length ? ['approved'] : [],
  };
}

/** Tiers, escalation, reminders and expiry of an approval. */
function ApprovalProgressView({ p }: { p: Run['approval'] }) {
  if (!p) return null;
  return (
    <Stack gap="3xs">
      {p.tiers && (
        <Group gap="xs">
          {p.tiers.map((t, i) => (
            <Badge key={t.name} variant={t.state === 'open' ? 'filled' : 'light'} color={t.state === 'done' ? 'green' : t.state === 'open' ? 'blue' : 'gray'}>
              {i + 1}. {t.name} · {t.approved}/{t.minApprovals}
            </Badge>
          ))}
        </Group>
      )}
      {p.escalatedAt && (
        <Text fz="xs" c="orange">
          Escalated <TimeAgo at={p.escalatedAt} />
        </Text>
      )}
      {!p.escalatedAt && p.escalateAt && (
        <Text fz="xs" c="dimmed">
          Escalates <TimeAgo at={p.escalateAt} />
        </Text>
      )}
      {(p.reminders ?? 0) > 0 && (
        <Text fz="xs" c="dimmed">
          {p.reminders} reminder(s) sent{p.nextReminderAt ? ' · next ' : ''}
          {p.nextReminderAt && <TimeAgo at={p.nextReminderAt} />}
        </Text>
      )}
      {p.expiresAt && (
        <Text fz="xs" c="dimmed">
          Expires <TimeAgo at={p.expiresAt} />
        </Text>
      )}
    </Stack>
  );
}

function ApprovalTimeline({ approvals, tiers }: { approvals: Run['approvals']; tiers?: string[] }) {
  return (
    <Timeline bulletSize={20} lineWidth={2}>
      {approvals.map((a) => (
        <Timeline.Item
          key={a.userId + a.at}
          color={a.decision === 'approved' ? 'green' : 'red'}
          bullet={a.decision === 'approved' ? <IconCheck size={14} /> : <IconX size={14} />}
          title={
            <Group gap="2xs">
              <UserChip user={{ id: a.userId, name: a.userName }} />
              <Text span fz="sm">
                {a.decision}
              </Text>
              {a.onBehalfOf && (
                <>
                  <Text span fz="sm" c="dimmed">
                    on behalf of
                  </Text>
                  <UserChip user={a.onBehalfOf} />
                </>
              )}
              {a.tier != null && tiers?.[a.tier] && (
                <Badge size="xs" variant="light">
                  {tiers[a.tier]}
                </Badge>
              )}
            </Group>
          }
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

type Panel = { kind: 'request' } | { kind: 'logs' } | { kind: 'step'; id: string } | null;

function RunFlow({ r }: { r: Run }) {
  const refresh = useRunRefresh(r.id);
  const [params] = useSearchParams();
  const steps = r.steps ?? [];
  const [panel, setPanel] = useState<Panel>(() => {
    const requested = params.get('step');
    return requested && steps.some((s) => s.id === requested) ? { kind: 'step', id: requested } : null;
  });
  const [job, setJob] = useState<string | null>(null);
  const flowSteps = runFlowSteps(r);
  const step = panel?.kind === 'step' ? (steps.find((s) => s.id === panel.id) ?? null) : null;
  const needsMe = steps.find((x) => x.canApprove || x.canSubmit);
  const waiting: Panel = r.canApprove ? { kind: 'request' } : needsMe ? { kind: 'step', id: needsMe.id } : null;
  const live = ACTIVE.includes(r.status);
  const allLogs = r.logs ?? [];
  const jobs = [...new Set(allLogs.map((l) => splitJobLog(l.message).job).filter((j): j is string => !!j))];
  const shownLogs = allLogs.filter((l) => !job || splitJobLog(l.message).job === job);
  const selected = panel?.kind === 'step' ? panel.id : panel?.kind === 'request' ? TRIGGER_ID : null;

  return (
    <>
      <FlowShell
        back={{ to: '/runs', label: 'Back to runs' }}
        title={r.actionTitle}
        meta={
          <>
            <StatusBadge status={r.status} />
            {r.slaBreachedAt && <SlaBadge at={r.slaBreachedAt} />}
            {r.paused && (
              <Badge color="yellow" variant="light">
                paused
              </Badge>
            )}
            {queueLabel(r) ? (
              <Text span fz="xs" c="dimmed" truncate>
                {queueLabel(r)}
              </Text>
            ) : (
              r.statusLabel && (
                <Text span fz="xs" c="dimmed" truncate>
                  {r.statusLabel}
                </Text>
              )
            )}
          </>
        }
        actions={
          <>
            <Button size="xs" variant="default" leftSection={<IconInfoCircle size={14} />} onClick={() => setPanel({ kind: 'request' })}>
              Request
            </Button>
            <Button size="xs" variant="default" leftSection={<IconFileText size={14} />} onClick={() => setPanel({ kind: 'logs' })}>
              All logs
            </Button>
            <RunActions r={r} onDone={refresh} size="xs" />
          </>
        }
        banner={
          waiting &&
          !panel && (
            <Alert color="orange" py="xs">
              <Group justify="space-between" wrap="nowrap">
                <Text fz="sm" fw={500}>
                  {waiting.kind === 'request' ? 'Your approval is requested to start this request' : 'A step is waiting for you'}
                </Text>
                <Button size="xs" color="orange" onClick={() => setPanel(waiting)}>
                  Review
                </Button>
              </Group>
            </Alert>
          )
        }
        hint="Click a node for its details and logs."
        reserve={panel ? SIDE_PANEL_WIDTHS.default : 0}
      >
        <WorkflowFlow
          bare
          height="100%"
          focus={selected}
          trigger={runTrigger(r)}
          steps={flowSteps}
          selected={selected}
          onSelect={(id) => setPanel(id === TRIGGER_ID ? { kind: 'request' } : { kind: 'step', id })}
        />
      </FlowShell>

      <SidePanel
        opened={!!panel}
        onClose={() => setPanel(null)}
        // No overlay: the graph stays visible (and live) next to the details.
        overlay={false}
        flush={panel?.kind === 'logs'}
        title={panel?.kind === 'request' ? 'Request' : panel?.kind === 'logs' ? 'All logs' : (step?.name ?? '')}
        subtitle={panel?.kind === 'request' ? r.actionTitle : panel?.kind === 'logs' ? `${shownLogs.length} line(s)` : step ? stepSummary(step) : undefined}
        actions={
          panel?.kind === 'logs' ? (
            <>
              {live && <LiveBadge />}
              {jobs.length > 1 && (
                <NativeSelect
                  size="xs"
                  aria-label="Filter by job"
                  value={job ?? ''}
                  onChange={(e) => setJob(e.currentTarget.value || null)}
                  data={[{ value: '', label: 'All jobs' }, ...jobs.map((j) => ({ value: j, label: j }))]}
                />
              )}
            </>
          ) : (
            step && (
              <Badge color={STEP_STATUS_COLORS[step.status]} variant={step.status === 'RUNNING' ? 'dot' : 'light'}>
                {STEP_STATUS_LABELS[step.status]}
              </Badge>
            )
          )
        }
      >
        {panel?.kind === 'request' && (
          <>
            {r.canApprove && <RequestApproval r={r} onDone={refresh} />}
            {['SUCCESS', 'FAILURE', 'CANCELLED', 'REJECTED'].includes(r.status) && <ExplainRun runId={r.id} failed={r.status === 'FAILURE'} />}
            <Table withRowBorders={false} verticalSpacing="3xs" highlightOnHover={false} fz="sm">
              <Table.Tbody>
                <Row k="Requested by" v={<UserChip user={r.triggeredBy} />} />
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
                {!!r.priority && <Row k="Priority" v={r.priority} />}
                {r.concurrency && <Row k="Concurrency group" v={`${r.concurrency.group} (at most ${r.concurrency.max} at a time)`} />}
                {!!r.costUsd && <Row k="AI cost" v={`$${r.costUsd.toFixed(4)}`} />}
              </Table.Tbody>
            </Table>
            <Section title="Inputs">
              {Object.keys(r.inputs).length ? (
                <Table withRowBorders={false} verticalSpacing="3xs" highlightOnHover={false} fz="sm">
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
            </Section>
            {(r.approvals.length > 0 || r.approval) && (
              <Section title="Request approvals">
                <Stack gap="sm">
                  {r.approvals.length > 0 && <ApprovalTimeline approvals={r.approvals} />}
                  <ApprovalProgressView p={r.approval} />
                </Stack>
              </Section>
            )}
          </>
        )}
        {/* The panel is the container: the log fills it, its toolbar right under the panel header. */}
        {panel?.kind === 'logs' && <LogViewer fill lines={shownLogs} showStep filename={`run-${r.id}.log`} follow={live} />}
        {step && (
          <>
            <StepPanel key={step.id} run={r} step={step} onDone={refresh} />
            <StepArtifacts runId={r.id} artifacts={(r.artifacts ?? []).filter((a) => a.stepId === step.id)} />
            <Section title="Logs" actions={live && <LiveBadge />}>
              <LogViewer lines={allLogs.filter((l) => l.stepId === step.id)} filename={`run-${r.id}-${step.id}.log`} follow={live} />
            </Section>
          </>
        )}
      </SidePanel>
    </>
  );
}

const LiveBadge = () => (
  <Badge variant="dot" color="blue">
    live
  </Badge>
);

/** "Waiting for approval · 2m · attempt 1/3": the line under the step name. */
const stepSummary = (step: RunStep) =>
  [
    step.statusLabel,
    step.startedAt ? duration(step.startedAt, step.endedAt) : 'not started',
    step.maxAttempts > 1 && `attempt ${Math.max(step.attempt, 1)}/${step.maxAttempts}`,
    !!step.costUsd && `AI cost $${step.costUsd.toFixed(4)}`,
    step.continueOnError && 'may fail without failing the workflow',
  ]
    .filter(Boolean)
    .join(' · ');

/** One step, bare (the side panel gives its name and status): kind, actions, message, forms, approvals, output. */
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
  const [forcing, setForcing] = useState<'skip' | 'complete' | null>(null);
  const output = step.output as Record<string, unknown> | null;
  const textOnly = output && Object.keys(output).length === 1 && typeof output.text === 'string';
  return (
    <Section>
      <Group justify="space-between" align="flex-start" gap="xs">
        <Group gap="xs">
          <Badge color={STEP_TYPES[step.type].color}>{STEP_TYPES[step.type].label}</Badge>
          {step.fragment && (
            // Inlined from a fragment: its steps are `<fragment step>__<inner id>`, the step `<fragment step>` gives its outputs.
            <Badge color={STEP_TYPES.fragment.color} variant="outline">
              {step.fragment === step.id ? 'fragment outputs' : `fragment ${step.fragment}`}
            </Badge>
          )}
          {step.slaBreachedAt && <SlaBadge at={step.slaBreachedAt} />}
        </Group>
        <Group gap="xs">
          {step.canRetry && (
            <Button size="xs" variant="light" leftSection={<IconRepeat size={14} />} loading={retry.isPending} onClick={() => retry.mutate()}>
              Retry step
            </Button>
          )}
          {step.canSkip && (
            <Button size="xs" variant="default" leftSection={<IconPlayerSkipForward size={14} />} onClick={() => setForcing('skip')}>
              Skip
            </Button>
          )}
          {step.canComplete && (
            <Button size="xs" variant="default" leftSection={<IconCircleCheck size={14} />} onClick={() => setForcing('complete')}>
              Mark done
            </Button>
          )}
          {step.link && (
            <Button size="xs" component="a" href={appHref(step.link)} target="_blank" variant="default" rightSection={<IconExternalLink size={14} />}>
              Open
            </Button>
          )}
        </Group>
      </Group>

      {step.connector && (
        // Steps going through a connection: the operation (or raw call) and the connection it used.
        <Group gap="3xs" mt="3xs" wrap="nowrap">
          <EntityIcon name={step.connector.icon ?? 'plug'} size={ICON.sm} />
          <Caption>
            {step.connector.operationTitle ?? `${step.connector.method ?? 'GET'} API call`} · connection {step.connector.connectionTitle}
          </Caption>
        </Group>
      )}
      {forcing && <ForceStepDialog run={run} step={step} kind={forcing} onClose={() => setForcing(null)} onDone={onDone} />}
      {step.message && (
        <SurfaceBox my="xs">
          <Markdown>{step.message}</Markdown>
        </SurfaceBox>
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
        <Stack gap="3xs" mt="xs">
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
      {step.approval && (
        <Box mt="xs">
          <ApprovalProgressView p={step.approval} />
        </Box>
      )}
      {step.approvals.length > 0 && (
        <Box mt="sm">
          <ApprovalTimeline approvals={step.approvals} tiers={step.approval?.tiers?.map((t) => t.name)} />
        </Box>
      )}
      {output != null && step.type !== 'approval' && (
        <Box mt="sm">
          <Text fz="sm" fw={500} mb="3xs">
            Output
          </Text>
          {textOnly ? (
            <SurfaceBox>
              <Markdown>{String(output.text)}</Markdown>
            </SurfaceBox>
          ) : typeof output === 'object' && !Array.isArray(output) ? (
            <Table withRowBorders={false} verticalSpacing="3xs" highlightOnHover={false}>
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
    </Section>
  );
}

/** Shown on runs and steps that passed their `slaMinutes` without finishing. */
function SlaBadge({ at }: { at: string }) {
  return (
    <Badge color="orange" variant="filled" title={`SLA breached ${new Date(at).toLocaleString()}`}>
      SLA breached
    </Badge>
  );
}

const fileSize = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

/** Files attached to a step (reports, plans…), downloaded with the session. */
function StepArtifacts({ runId, artifacts }: { runId: string; artifacts: RunArtifact[] }) {
  if (!artifacts.length) return null;
  return (
    <Section title="Artifacts">
      <Table withRowBorders={false} verticalSpacing="3xs" highlightOnHover={false} fz="sm">
        <Table.Tbody>
          {artifacts.map((a) => (
            <Table.Tr key={a.id}>
              <Table.Td className="wrap-anywhere">
                <Anchor component="button" fz="sm" onClick={() => void downloadArtifact(runId, a).catch(onError)}>
                  <Group gap="3xs" wrap="nowrap">
                    <IconDownload size={14} />
                    {a.name}
                  </Group>
                </Anchor>
              </Table.Td>
              <Table.Td c="dimmed">{a.contentType}</Table.Td>
              <Table.Td c="dimmed">{fileSize(a.size)}</Table.Td>
              <Table.Td c="dimmed">
                <TimeAgo at={a.createdAt} />
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </Section>
  );
}

/** "Waiting for 2 run(s) in group deploy-prod": a queued run held by its concurrency group. */
function queueLabel(r: Run) {
  if (r.status !== 'QUEUED' || !r.concurrency || !r.concurrency.ahead) return null;
  return `Waiting for ${r.concurrency.ahead} run(s) in group ${r.concurrency.group}`;
}

/** Admins: force a step to SKIPPED or SUCCESS, with a required reason (logged on the run and audited). */
function ForceStepDialog(props: { run: Run; step: RunStep; kind: 'skip' | 'complete'; onClose: () => void; onDone: (r: Run) => void }) {
  const { run, step, kind } = props;
  const [comment, setComment] = useState('');
  const [output, setOutput] = useState('');
  const [error, setError] = useState<string | null>(null);
  const force = useMutation({
    mutationFn: () => {
      let value: unknown;
      if (kind === 'complete' && output.trim()) value = JSON.parse(output) as unknown; // invalid JSON: shown by onError
      return api.forceStep(run.id, step.id, kind, comment, value);
    },
    onSuccess: (r) => {
      props.onDone(r);
      props.onClose();
    },
    onError: (e) => setError(errorText(e)),
  });
  return (
    <Modal opened onClose={props.onClose} title={<Text fw={600}>{kind === 'skip' ? `Skip "${step.name}"` : `Mark "${step.name}" as done`}</Text>}>
      <Stack>
        <Text fz="sm" c="dimmed">
          {kind === 'skip'
            ? 'The step ends as skipped and the workflow continues with the next steps.'
            : 'The step ends as successful with the output below and the workflow continues.'}{' '}
          {step.status === 'RUNNING' ? 'The work in flight can no longer report a result.' : ''}
        </Text>
        <Textarea label="Reason" withAsterisk autosize minRows={2} value={comment} onChange={(e) => setComment(e.currentTarget.value)} />
        {kind === 'complete' && (
          <Textarea
            label="Output (JSON, optional)"
            description="What later steps read as steps.<id>.output"
            autosize
            minRows={3}
            styles={{ input: { fontFamily: 'var(--mantine-font-family-monospace)' } }}
            value={output}
            onChange={(e) => setOutput(e.currentTarget.value)}
          />
        )}
        {error && (
          <Alert color="red" py="xs">
            {error}
          </Alert>
        )}
        <Group justify="flex-end">
          <Button variant="default" onClick={props.onClose}>
            Cancel
          </Button>
          <Button disabled={!comment.trim()} loading={force.isPending} onClick={() => force.mutate()}>
            {kind === 'skip' ? 'Skip step' : 'Mark as done'}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <Table.Tr>
      <Table.Td c="dimmed" w="40%" fz="sm" className="align-top">
        {k}
      </Table.Td>
      <Table.Td fz="sm" className="wrap-anywhere">
        {v}
      </Table.Td>
    </Table.Tr>
  );
}
