import { useState } from 'react';
import { Badge, Button, Card, Group, Modal, Progress, Select, SimpleGrid, Stack, Text, TextInput, Title, Tooltip } from '@mantine/core';
import { modals } from '@mantine/modals';
import { notifications } from '@mantine/notifications';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router';
import { IconShieldOff, IconTrash } from '@tabler/icons-react';
import type { Initiative, InitiativeEntity, InitiativeExemption, InitiativeStatus, InitiativeView } from '@asterius/shared';
import { api, errorText } from '../lib/api';
import { useAuth } from '../lib/auth';
import { DataTable } from '../components/DataTable';
import { ProgressTrend } from '../components/ProgressTrend';
import { Empty, ErrorAlert, Loading, PageHeader, StatValue, TimeAgo } from '../components/ui';
import { deadlineLabel, expectedOn, pct, STATUS_LOOK, teamLabel, trendSeries } from '../lib/initiatives';
import { InitiativeBuilder } from '../components/builder/InitiativeBuilder';
import { ResourceAdmin, strip } from './admin/ResourceAdmin';

export function InitiativeStatusBadge({ status }: { status: InitiativeStatus }) {
  const s = STATUS_LOOK[status];
  return (
    <Badge color={s.color} variant="light">
      {s.label}
    </Badge>
  );
}

/** Done / in scope as a bar with the numbers. */
export function InitiativeProgress({ passing, total, ratio }: { passing: number; total: number; ratio: number }) {
  return (
    <Stack gap="3xs" miw={140}>
      <Group justify="space-between" gap="xs">
        <Text fz="xs" fw={500}>
          {pct(ratio)}
        </Text>
        <Text fz="xs" c="dimmed">
          {passing} / {total}
        </Text>
      </Group>
      <Progress value={ratio * 100} size="sm" color={ratio >= 1 ? 'teal' : 'blue'} aria-label={`${passing} of ${total} at the target`} />
    </Stack>
  );
}

const target = (i: Pick<Initiative, 'targetLevel' | 'rules'>) =>
  [i.targetLevel ? `${i.targetLevel} or above` : null, i.rules.length ? `rules ${i.rules.join(', ')}` : null].filter(Boolean).join(' + ');

/** Every initiative the viewer can see, with its status and progress. */
export function Initiatives() {
  const q = useQuery({ queryKey: ['initiatives'], queryFn: api.initiatives });
  const navigate = useNavigate();
  return (
    <Stack>
      <PageHeader title="Initiatives" description="Scorecard targets with a deadline: who is done, who is behind." refresh={q} />
      <DataTable
        rows={q.data?.filter((i) => i.enabled)}
        loading={q.isPending}
        error={q.error}
        rowKey={(i) => i.identifier}
        onRowClick={(i) => navigate(`/initiatives/${i.identifier}`)}
        empty={<Empty title="No initiative yet">Admins declare them in Administration → Governance → Initiatives, or in the configuration files.</Empty>}
        columns={[
          {
            key: 't',
            label: 'Initiative',
            render: (i: InitiativeView) => (
              <div>
                <Text fz="sm" fw={500}>
                  {i.title}
                </Text>
                <Text fz="xs" c="dimmed">
                  {i.scorecardTitle}: {target(i)}
                </Text>
              </div>
            ),
          },
          {
            key: 's',
            label: 'Status',
            render: (i: InitiativeView) => (i.error ? <Badge color="gray">{i.error}</Badge> : <InitiativeStatusBadge status={i.status} />),
          },
          { key: 'p', label: 'Progress', render: (i: InitiativeView) => <InitiativeProgress {...i.progress} /> },
          {
            key: 'd',
            label: 'Deadline',
            render: (i: InitiativeView) => (
              <div>
                <Text fz="sm">{i.deadline}</Text>
                <Text fz="xs" c="dimmed">
                  {i.status === 'done' ? 'Complete' : deadlineLabel(i.daysLeft)}
                </Text>
              </div>
            ),
          },
        ]}
      />
    </Stack>
  );
}

/** One initiative: overview, trend, per-team table, failing entities and exemptions. */
export function InitiativePage() {
  const { id = '' } = useParams();
  const { user, isAdmin } = useAuth();
  const q = useQuery({ queryKey: ['initiative', id], queryFn: () => api.initiative(id) });
  const [team, setTeam] = useState<string | null>(null);
  const [exempting, setExempting] = useState<{ entity: string; rule: string | null } | null>(null);
  if (q.isPending) return <Loading />;
  if (q.error) return <ErrorAlert error={q.error} />;
  const i = q.data;
  const mayExempt = isAdmin || (!!i.owner && i.owner === user?.email?.toLowerCase());
  const series = trendSeries(i.trend, team ?? undefined);
  return (
    <Stack>
      <PageHeader
        title={i.title}
        description={i.description || undefined}
        crumbs={[{ label: 'Initiatives', to: '/initiatives' }, { label: i.title }]}
        actions={<InitiativeStatusBadge status={i.status} />}
        refresh={q}
      />
      {i.error && <ErrorAlert error={i.error} />}
      <SimpleGrid cols={{ base: 1, sm: 2, lg: 4 }}>
        <Card withBorder padding="sm">
          <Text fz="xs" c="dimmed">
            At the target
          </Text>
          <StatValue>{pct(i.progress.ratio)}</StatValue>
          <Text fz="xs" c="dimmed">
            {i.progress.passing} of {i.progress.total} {i.blueprint} entities
            {i.progress.exempted ? `, ${i.progress.exempted} exempted` : ''}
          </Text>
        </Card>
        <Card withBorder padding="sm">
          <Text fz="xs" c="dimmed">
            Expected today
          </Text>
          <StatValue>{pct(i.expected)}</StatValue>
          <Text fz="xs" c="dimmed">
            Straight line from {i.startDate}
          </Text>
        </Card>
        <Card withBorder padding="sm">
          <Text fz="xs" c="dimmed">
            Deadline
          </Text>
          <StatValue>{i.deadline}</StatValue>
          <Text fz="xs" c="dimmed">
            {i.status === 'done' ? 'Complete' : deadlineLabel(i.daysLeft)}
          </Text>
        </Card>
        <Card withBorder padding="sm">
          <Text fz="xs" c="dimmed">
            Target
          </Text>
          <Text fz="sm" fw={500}>
            {target(i)}
          </Text>
          <Text fz="xs" c="dimmed">
            Scorecard {i.scorecardTitle}
            {i.teams.length ? ` · teams ${i.teams.join(', ')}` : ''}
            {i.owner ? ` · owner ${i.owner}` : ''}
          </Text>
        </Card>
      </SimpleGrid>

      <Card withBorder>
        <Group justify="space-between" mb="xs">
          <Title order={5}>Trend{team ? ` · ${teamLabel(team)}` : ''}</Title>
          <Select
            aria-label="Team of the trend"
            placeholder="All teams"
            size="xs"
            clearable
            value={team}
            onChange={setTeam}
            data={i.byTeam.map((t) => ({ value: t.team ?? '-', label: teamLabel(t.team) }))}
          />
        </Group>
        {series.length ? (
          <ProgressTrend points={series} start={i.startDate} end={i.deadline} expected={(d) => expectedOn(d, i.startDate, i.deadline)} />
        ) : (
          <Empty title="No data yet">A snapshot is taken every day once the initiative has started.</Empty>
        )}
      </Card>

      <section aria-label="Progress per team">
        <Title order={4} mb="xs">
          Per team
        </Title>
        <DataTable
          rows={i.byTeam}
          rowKey={(t) => t.team ?? '-'}
          onRowClick={(t) => setTeam(t.team ?? '-')}
          empty="No entity in scope"
          columns={[
            { key: 't', label: 'Team', render: (t) => teamLabel(t.team) },
            { key: 'p', label: 'Progress', render: (t) => <InitiativeProgress {...t} /> },
            { key: 'f', label: 'To fix', render: (t) => t.total - t.passing },
            { key: 'x', label: 'Exempted', render: (t) => t.exempted || '—' },
          ]}
        />
      </section>

      <FailingEntities id={i.identifier} blueprint={i.blueprint} team={team} mayExempt={mayExempt} onExempt={setExempting} />
      <Exemptions id={i.identifier} mayExempt={mayExempt} />
      <ExemptionModal id={i.identifier} target={exempting} rules={i.requiredRules} onClose={() => setExempting(null)} />
    </Stack>
  );
}

function FailingEntities(props: {
  id: string;
  blueprint: string;
  team: string | null;
  mayExempt: boolean;
  onExempt: (t: { entity: string; rule: string | null }) => void;
}) {
  const q = useQuery({
    queryKey: ['initiative-entities', props.id, props.team],
    queryFn: () => api.initiativeEntities(props.id, { status: 'failing', team: props.team ?? undefined }),
  });
  const navigate = useNavigate();
  return (
    <section aria-label="Entities below the target">
      <Title order={4} mb="xs">
        Below the target{props.team ? ` · ${teamLabel(props.team)}` : ''}
      </Title>
      <DataTable
        rows={q.data?.items}
        loading={q.isPending}
        error={q.error}
        rowKey={(e) => e.identifier}
        onRowClick={(e) => navigate(`/catalog/${props.blueprint}/${encodeURIComponent(e.identifier)}`)}
        empty={<Empty title="Nothing to fix">Every entity in scope is at the target.</Empty>}
        columns={[
          {
            key: 'n',
            label: 'Entity',
            render: (e: InitiativeEntity) => (
              <Text fz="sm" fw={500}>
                {e.title}
              </Text>
            ),
          },
          { key: 't', label: 'Team', render: (e: InitiativeEntity) => teamLabel(e.team) },
          { key: 'l', label: 'Level', render: (e: InitiativeEntity) => e.level ?? '—' },
          {
            key: 'f',
            label: 'Failing rules',
            wrap: true,
            render: (e: InitiativeEntity) => (
              <Group gap="3xs">
                {e.failing.map((f) => (
                  <Badge key={f.rule} size="sm" variant="light" color="red" tt="none">
                    {f.title}
                  </Badge>
                ))}
              </Group>
            ),
          },
          ...(props.mayExempt
            ? [
                {
                  key: 'x',
                  label: '',
                  render: (e: InitiativeEntity) => (
                    <Group justify="flex-end" onClick={(ev) => ev.stopPropagation()}>
                      <Tooltip label="Exempt this entity">
                        <Button
                          size="compact-xs"
                          variant="subtle"
                          leftSection={<IconShieldOff size={14} />}
                          onClick={() => props.onExempt({ entity: e.identifier, rule: null })}
                        >
                          Exempt
                        </Button>
                      </Tooltip>
                    </Group>
                  ),
                },
              ]
            : []),
        ]}
      />
    </section>
  );
}

function Exemptions({ id, mayExempt }: { id: string; mayExempt: boolean }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['initiative-exemptions', id], queryFn: () => api.initiativeExemptions(id) });
  const revoke = (x: InitiativeExemption) =>
    modals.openConfirmModal({
      title: `Revoke the exemption of ${x.entity}?`,
      children: <Text fz="sm">The entity counts again from now on.</Text>,
      labels: { confirm: 'Revoke', cancel: 'Cancel' },
      confirmProps: { color: 'red' },
      onConfirm: async () => {
        try {
          await api.revokeExemption(id, x.id);
          void qc.invalidateQueries({ queryKey: ['initiative-exemptions', id] });
          void qc.invalidateQueries({ queryKey: ['initiative', id] });
          void qc.invalidateQueries({ queryKey: ['initiative-entities', id] });
        } catch (e) {
          notifications.show({ color: 'red', message: errorText(e) });
        }
      },
    });
  return (
    <section aria-label="Exemptions">
      <Title order={4} mb="xs">
        Exemptions
      </Title>
      <DataTable
        rows={q.data}
        loading={q.isPending}
        error={q.error}
        rowKey={(x) => x.id}
        empty="No exemption"
        columns={[
          { key: 'e', label: 'Entity', render: (x) => x.entity },
          { key: 'r', label: 'Scope', render: (x) => (x.rule ? `rule ${x.rule}` : 'whole entity') },
          { key: 'w', label: 'Reason', wrap: true, render: (x) => x.reason },
          {
            key: 'u',
            label: 'Until',
            render: (x) => (x.active ? new Date(x.expiresAt).toISOString().slice(0, 10) : <Badge color="gray">expired</Badge>),
          },
          {
            key: 'g',
            label: 'Granted',
            render: (x) => (
              <Text fz="xs">
                {x.grantedBy.email ?? '—'} · <TimeAgo at={x.createdAt} />
              </Text>
            ),
          },
          ...(mayExempt
            ? [
                {
                  key: 'a',
                  label: '',
                  render: (x: InitiativeExemption) => (
                    <Button size="compact-xs" variant="subtle" color="red" leftSection={<IconTrash size={14} />} onClick={() => revoke(x)}>
                      Revoke
                    </Button>
                  ),
                },
              ]
            : []),
        ]}
      />
    </section>
  );
}

const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

function ExemptionModal(props: {
  id: string;
  target: { entity: string; rule: string | null } | null;
  rules: { rule: string; title: string }[];
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [rule, setRule] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [until, setUntil] = useState(inDays(30));
  const save = useMutation({
    mutationFn: () => api.grantExemption(props.id, { entity: props.target!.entity, rule, reason, expiresAt: new Date(`${until}T23:59:59Z`).toISOString() }),
    onSuccess: () => {
      notifications.show({ color: 'green', message: `${props.target?.entity} exempted until ${until}` });
      for (const k of ['initiative', 'initiative-entities', 'initiative-exemptions']) void qc.invalidateQueries({ queryKey: [k, props.id] });
      setReason('');
      setRule(null);
      props.onClose();
    },
    onError: (e) => notifications.show({ color: 'red', message: errorText(e) }),
  });
  return (
    <Modal opened={!!props.target} onClose={props.onClose} title={`Exempt ${props.target?.entity ?? ''}`}>
      <Stack gap="sm">
        <Select
          label="Scope"
          description="The whole entity leaves the counts; a single rule counts as passing"
          data={[{ value: '', label: 'Whole entity' }, ...props.rules.map((r) => ({ value: r.rule, label: `Rule: ${r.title}` }))]}
          value={rule ?? ''}
          onChange={(v) => setRule(v || null)}
        />
        <TextInput label="Reason" withAsterisk value={reason} onChange={(e) => setReason(e.currentTarget.value)} />
        <TextInput label="Until" type="date" withAsterisk value={until} min={inDays(1)} max={inDays(365)} onChange={(e) => setUntil(e.currentTarget.value)} />
        <Group justify="flex-end">
          <Button variant="default" onClick={props.onClose}>
            Cancel
          </Button>
          <Button loading={save.isPending} disabled={reason.trim().length < 3 || !until} onClick={() => save.mutate()}>
            Exempt
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

/** Admin page: define initiatives (form editor with JSON / YAML views; managed ones are read-only). */
export function InitiativesAdmin() {
  return (
    <ResourceAdmin<Initiative>
      title="Initiatives"
      description="Scorecard targets with a deadline. Failing entities land in the To do of their owner teams; status changes emit initiative.* events."
      queryKey="initiatives"
      list={api.initiatives}
      columns={[
        { key: 's', label: 'Scorecard', render: (i) => <Badge color="gray">{i.scorecard}</Badge> },
        { key: 'g', label: 'Target', render: (i) => target(i) },
        { key: 'd', label: 'Deadline', render: (i) => i.deadline },
        { key: 'e', label: 'Enabled', render: (i) => (i.enabled ? 'yes' : <Badge color="gray">disabled</Badge>) },
        {
          key: 'v',
          label: '',
          render: (i) => (
            <Text component={Link} to={`/initiatives/${i.identifier}`} fz="sm" c="blue" onClick={(e) => e.stopPropagation()}>
              Open
            </Text>
          ),
        },
      ]}
      templates={[
        {
          label: 'Initiative',
          value: {
            identifier: 'silver-by-q3',
            title: 'Every service at Silver',
            description: '',
            scorecard: 'production-readiness',
            targetLevel: 'Silver',
            rules: [],
            startDate: inDays(0),
            deadline: inDays(90),
            teams: [],
            owner: null,
            enabled: true,
            reminderDays: 7,
          },
        },
      ]}
      toEditable={(i) => strip(i, ['managed', 'blueprint', 'scorecardTitle', 'status', 'progress', 'expected', 'daysLeft', 'error'])}
      editor={(p) => <InitiativeBuilder {...p} />}
      save={api.saveInitiative}
      remove={(i) => api.deleteInitiative(i.identifier)}
      removeWarning={() => 'Its snapshots and exemptions are deleted with it.'}
    />
  );
}
