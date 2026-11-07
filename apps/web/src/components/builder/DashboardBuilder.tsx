import { useState, type ReactNode } from 'react';
import {
  ActionIcon,
  Badge,
  Button,
  Card,
  Collapse,
  Group,
  Menu,
  MultiSelect,
  NumberInput,
  SegmentedControl,
  Select,
  SimpleGrid,
  Stack,
  Switch,
  TagsInput,
  Text,
  Textarea,
  TextInput,
  Tooltip,
} from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import {
  IconArrowDown,
  IconArrowUp,
  IconChartBar,
  IconChevronDown,
  IconChevronRight,
  IconCopy,
  IconHash,
  IconHistory,
  IconLayoutDashboard,
  IconMarkdown,
  IconPlayerPlay,
  IconPlus,
  IconStack2,
  IconTable,
  IconTrash,
  IconTrophy,
  IconLayoutGrid,
} from '@tabler/icons-react';
import { api } from '../../lib/api';
import { Markdown } from '../ui';
import { KeyValueEditor, MONO_INPUT } from './blocks';
import { FormBuilder, identityProblems, IdentityFields, SLUG, type EditorProps, type FormContext } from './FormBuilder';

/** Form editor of dashboards: identity + placement, and an ordered list of widgets with a per-type form. */

type Widget = Record<string, unknown> & { type: string };
type Placement = 'none' | 'home' | 'team' | 'blueprint';

export interface DashboardDoc {
  identifier: string;
  title: string;
  description: string;
  default: boolean;
  team: string | null;
  blueprint: string | null;
  widgets: Widget[];
  [k: string]: unknown;
}

export const toDashboardDoc = (v: Record<string, unknown>): DashboardDoc => ({
  ...v,
  identifier: String(v.identifier ?? ''),
  title: String(v.title ?? ''),
  description: String(v.description ?? ''),
  default: v.default === true,
  team: (v.team as string) || null,
  blueprint: (v.blueprint as string) || null,
  widgets: Array.isArray(v.widgets) ? (v.widgets as Widget[]).filter((w) => w && typeof w === 'object') : [],
});

const placementOf = (d: DashboardDoc): Placement => (d.blueprint ? 'blueprint' : d.team ? 'team' : d.default ? 'home' : 'none');

const WIDGET_TYPES: { type: string; label: string; description: string; icon: ReactNode; initial: Record<string, unknown> }[] = [
  {
    type: 'count',
    label: 'Count',
    description: 'Number of entities, or their distribution by a property',
    icon: <IconHash size={18} />,
    initial: { blueprint: '' },
  },
  { type: 'scorecard', label: 'Scorecard', description: 'Entities per level of a scorecard', icon: <IconTrophy size={18} />, initial: { scorecard: '' } },
  { type: 'runs', label: 'Runs', description: 'Latest action runs', icon: <IconPlayerPlay size={18} />, initial: { limit: 8 } },
  { type: 'approvals', label: 'Approvals', description: 'Runs waiting for the viewer to approve', icon: <IconHistory size={18} />, initial: { limit: 8 } },
  {
    type: 'table',
    label: 'Table',
    description: 'Saved view: entities with filters, sort and columns',
    icon: <IconTable size={18} />,
    initial: { blueprint: '', sort: 'title', limit: 10 },
  },
  {
    type: 'insights',
    label: 'Insights (DORA)',
    description: 'Deployment frequency, lead time, failure rate, recovery',
    icon: <IconChartBar size={18} />,
    initial: { days: 30 },
  },
  { type: 'markdown', label: 'Markdown', description: 'Free text: links, notes, instructions', icon: <IconMarkdown size={18} />, initial: { content: '' } },
];
const typeInfo = (t: string) => WIDGET_TYPES.find((x) => x.type === t);

export function dashboardProblems(doc: DashboardDoc): string[] {
  const out = identityProblems(doc);
  if (doc.team === '') out.push('Placement: choose a team');
  if (doc.blueprint === '') out.push('Placement: choose a blueprint');
  if (!doc.widgets.length) out.push('Add at least one widget');
  doc.widgets.forEach((w, i) => {
    const at = `Widget ${i + 1} (${w.type})`;
    const missing = (key: string, label: string) => {
      if (!String(w[key] ?? '').trim()) out.push(`${at}: ${label} is required`);
    };
    if (w.type === 'count' || w.type === 'table') missing('blueprint', 'blueprint');
    if (w.type === 'scorecard') missing('scorecard', 'scorecard');
    if (w.type === 'markdown') missing('content', 'content');
    for (const key of ['blueprint', 'scorecard', 'action', 'team']) {
      const v = w[key];
      if (typeof v === 'string' && v && !SLUG.test(v)) out.push(`${at}: ${key} must be a valid identifier`);
    }
  });
  return out;
}

export function DashboardBuilder(props: EditorProps) {
  return (
    <FormBuilder<DashboardDoc>
      {...props}
      size="76rem"
      noun="dashboard"
      toDoc={toDashboardDoc}
      toBody={(d) => ({ ...d, team: d.team || null, blueprint: d.blueprint || null })}
      problems={dashboardProblems}
      tabs={[
        { value: 'general', label: 'Dashboard', icon: <IconLayoutDashboard size={16} />, render: (ctx) => <General {...ctx} /> },
        { value: 'widgets', label: 'Widgets', icon: <IconLayoutGrid size={16} />, count: (d) => d.widgets.length, render: (ctx) => <Widgets {...ctx} /> },
      ]}
    />
  );
}

function General(ctx: FormContext<DashboardDoc>) {
  const { doc, set } = ctx;
  const teams = useQuery({ queryKey: ['teams'], queryFn: api.teams });
  const blueprints = useQuery({ queryKey: ['blueprints'], queryFn: api.blueprints });
  const placement = placementOf(doc);
  const choose = (p: string) => {
    // A pending choice keeps its empty value until the Select fills it, so the control stays on that option.
    if (p === 'home') set({ default: true, team: null, blueprint: null });
    else if (p === 'team') set({ default: false, team: doc.team ?? '', blueprint: null });
    else if (p === 'blueprint') set({ default: false, team: null, blueprint: doc.blueprint ?? '' });
    else set({ default: false, team: null, blueprint: null });
  };
  const [pending, setPending] = useState<Placement | null>(null);
  const shown = pending ?? placement;
  return (
    <Stack gap="md">
      <IdentityFields {...ctx} placeholder="Platform overview" />
      <Textarea label="Description" autosize minRows={2} value={doc.description} onChange={(e) => set({ description: e.currentTarget.value })} />
      <Stack gap={6}>
        <Text fz="sm" fw={500}>
          Where is it shown?
        </Text>
        <SegmentedControl
          value={shown}
          onChange={(p) => {
            setPending(p as Placement);
            choose(p);
          }}
          data={[
            { value: 'none', label: 'Nowhere (link only)' },
            { value: 'home', label: 'Home page (everyone)' },
            { value: 'team', label: 'Team home' },
            { value: 'blueprint', label: 'Blueprint page' },
          ]}
        />
        {shown === 'team' && (
          <Select
            label="Team"
            description="Default dashboard of the home page for members of this team"
            searchable
            data={(teams.data ?? []).map((t) => ({ value: t.identifier, label: t.title }))}
            value={doc.team || null}
            onChange={(v) => set({ team: v ?? '' })}
          />
        )}
        {shown === 'blueprint' && (
          <Select
            label="Blueprint"
            description="Shown on the catalog page of this blueprint"
            searchable
            data={(blueprints.data ?? []).map((b) => ({ value: b.identifier, label: b.title }))}
            value={doc.blueprint || null}
            onChange={(v) => set({ blueprint: v ?? '' })}
          />
        )}
      </Stack>
    </Stack>
  );
}

// Stable keys for the widget cards, kept when a widget is edited (uncontrolled sub-editors survive reordering).
const ids = new WeakMap<object, number>();
let seq = 0;
const idOf = (w: object) => {
  let id = ids.get(w);
  if (id === undefined) ids.set(w, (id = seq++));
  return id;
};
const withId = (next: Widget, prev: Widget): Widget => {
  ids.set(next, idOf(prev));
  return next;
};

function Widgets({ doc, set }: FormContext<DashboardDoc>) {
  const list = doc.widgets;
  const [open, setOpen] = useState<Record<number, boolean>>({});
  const put = (widgets: Widget[]) => set({ widgets });
  const move = (i: number, d: number) => {
    const next = [...list];
    [next[i], next[i + d]] = [next[i + d], next[i]];
    put(next);
  };
  const add = (type: string) => {
    const info = typeInfo(type)!;
    const w: Widget = { type, width: 6, ...info.initial };
    setOpen((o) => ({ ...o, [idOf(w)]: true }));
    put([...list, w]);
  };
  return (
    <Stack gap="md">
      {list.length === 0 && (
        <Text c="dimmed" fz="sm">
          No widget yet. Add one below.
        </Text>
      )}
      {list.map((w, i) => {
        const id = idOf(w);
        const isOpen = open[id] ?? false;
        const info = typeInfo(w.type);
        return (
          <Card key={id} withBorder padding="sm" data-testid="widget">
            <Group justify="space-between" wrap="nowrap">
              <Group gap="xs" style={{ cursor: 'pointer', flex: 1 }} onClick={() => setOpen((o) => ({ ...o, [id]: !isOpen }))}>
                {isOpen ? <IconChevronDown size={16} /> : <IconChevronRight size={16} />}
                {info?.icon}
                <Text fw={500}>{String(w.title || info?.label || w.type)}</Text>
                <Badge variant="light" color="gray">
                  {info?.label ?? w.type}
                </Badge>
                <Badge variant="outline" color="gray">
                  width {String(w.width ?? 6)}
                </Badge>
              </Group>
              <Group gap={2} wrap="nowrap">
                <Tooltip label="Move up">
                  <ActionIcon variant="subtle" color="gray" disabled={i === 0} onClick={() => move(i, -1)} aria-label="Move widget up">
                    <IconArrowUp size={16} />
                  </ActionIcon>
                </Tooltip>
                <Tooltip label="Move down">
                  <ActionIcon variant="subtle" color="gray" disabled={i === list.length - 1} onClick={() => move(i, 1)} aria-label="Move widget down">
                    <IconArrowDown size={16} />
                  </ActionIcon>
                </Tooltip>
                <Tooltip label="Duplicate">
                  <ActionIcon
                    variant="subtle"
                    color="gray"
                    aria-label="Duplicate widget"
                    onClick={() => put([...list.slice(0, i + 1), structuredClone(w), ...list.slice(i + 1)])}
                  >
                    <IconCopy size={16} />
                  </ActionIcon>
                </Tooltip>
                <Tooltip label="Remove">
                  <ActionIcon variant="subtle" color="red" aria-label="Remove widget" onClick={() => put(list.filter((_, j) => j !== i))}>
                    <IconTrash size={16} />
                  </ActionIcon>
                </Tooltip>
              </Group>
            </Group>
            <Collapse expanded={isOpen}>
              {isOpen && <WidgetForm widget={w} onChange={(next) => put(list.map((x, j) => (j === i ? withId(next, w) : x)))} />}
            </Collapse>
          </Card>
        );
      })}
      <Group>
        <Menu position="bottom-start" width={380}>
          <Menu.Target>
            <Button variant="light" leftSection={<IconPlus size={16} />} disabled={list.length >= 30}>
              Add widget
            </Button>
          </Menu.Target>
          <Menu.Dropdown>
            {WIDGET_TYPES.map((t) => (
              <Menu.Item key={t.type} leftSection={t.icon} onClick={() => add(t.type)}>
                <Text fz="sm" fw={500}>
                  {t.label}
                </Text>
                <Text fz="xs" c="dimmed">
                  {t.description}
                </Text>
              </Menu.Item>
            ))}
          </Menu.Dropdown>
        </Menu>
      </Group>
    </Stack>
  );
}

const SORTS = [
  { value: 'title', label: 'Title' },
  { value: 'updated', label: 'Last updated' },
  { value: 'identifier', label: 'Identifier' },
];
const STATUSES = ['PENDING_APPROVAL', 'QUEUED', 'IN_PROGRESS', 'SUCCESS', 'FAILURE', 'REJECTED', 'CANCELLED'];

function WidgetForm({ widget, onChange }: { widget: Widget; onChange: (w: Widget) => void }) {
  const blueprints = useQuery({ queryKey: ['blueprints'], queryFn: api.blueprints });
  const blueprintData = (blueprints.data ?? []).map((b) => ({ value: b.identifier, label: b.title }));
  /** Sets a key; empty values are removed so the document stays minimal. */
  const setKey = (key: string, value: unknown) => {
    const next = { ...widget };
    if (value === undefined || value === '' || value === null || (Array.isArray(value) && !value.length)) delete next[key];
    else next[key] = value;
    onChange(next);
  };
  const num = (key: string, label: string, min: number, max: number, description?: string) => (
    <NumberInput
      label={label}
      description={description}
      min={min}
      max={max}
      allowDecimal={false}
      value={typeof widget[key] === 'number' ? (widget[key] as number) : ''}
      onChange={(v) => setKey(key, typeof v === 'number' ? v : undefined)}
    />
  );
  const bp = (
    <Select
      label="Blueprint"
      withAsterisk
      searchable
      data={blueprintData}
      value={(widget.blueprint as string) || null}
      onChange={(v) => setKey('blueprint', v ?? '')}
    />
  );
  const filters = (
    <Stack gap={4}>
      <Text fz="sm" fw={500}>
        Filters
      </Text>
      <Text fz="xs" c="dimmed">
        Property = value; only entities that match are included
      </Text>
      <KeyValueEditor
        value={widget.filters as Record<string, unknown> | undefined}
        onChange={(v) => setKey('filters', Object.keys(v).length ? v : undefined)}
        keyPlaceholder="property"
        valuePlaceholder="value"
      />
    </Stack>
  );
  return (
    <Stack gap="md" pt="md">
      <SimpleGrid cols={{ base: 1, sm: 2 }}>
        <TextInput
          label="Title"
          placeholder={typeInfo(widget.type)?.label}
          value={(widget.title as string) ?? ''}
          onChange={(e) => setKey('title', e.currentTarget.value)}
        />
        <NumberInput
          label="Width"
          description="Columns out of 12 (3 = a quarter, 6 = half, 12 = full row)"
          min={1}
          max={12}
          allowDecimal={false}
          value={typeof widget.width === 'number' ? widget.width : 6}
          onChange={(v) => setKey('width', typeof v === 'number' ? v : 6)}
        />
      </SimpleGrid>
      {widget.type === 'count' && (
        <>
          <SimpleGrid cols={{ base: 1, sm: 2 }}>
            {bp}
            <TextInput
              label="Group by"
              description="Empty: a single number. Otherwise a property name, team or source"
              placeholder="tier"
              value={(widget.groupBy as string) ?? ''}
              onChange={(e) => setKey('groupBy', e.currentTarget.value.trim())}
              styles={MONO_INPUT}
              rightSection={<IconStack2 size={14} />}
            />
          </SimpleGrid>
          {filters}
        </>
      )}
      {widget.type === 'scorecard' && <ScorecardSelect value={(widget.scorecard as string) ?? ''} onChange={(v) => setKey('scorecard', v)} />}
      {widget.type === 'runs' && (
        <>
          <SimpleGrid cols={{ base: 1, sm: 2 }}>
            {num('limit', 'Rows', 1, 20)}
            <ActionSelect value={(widget.action as string) ?? null} onChange={(v) => setKey('action', v)} label="Only this action" />
          </SimpleGrid>
          <MultiSelect
            label="Statuses"
            description="Empty: every status"
            data={STATUSES}
            value={(widget.status as string[]) ?? []}
            onChange={(v) => setKey('status', v)}
            clearable
          />
          <Switch label="Only my runs" checked={widget.mine === true} onChange={(e) => setKey('mine', e.currentTarget.checked || undefined)} />
        </>
      )}
      {widget.type === 'approvals' && num('limit', 'Rows', 1, 20)}
      {widget.type === 'table' && (
        <>
          <SimpleGrid cols={{ base: 1, sm: 2 }}>
            {bp}
            <TextInput
              label="Search"
              description="Text the entities must match"
              value={(widget.search as string) ?? ''}
              onChange={(e) => setKey('search', e.currentTarget.value)}
            />
            <Select
              label="Sort by"
              data={SORTS}
              allowDeselect={false}
              value={(widget.sort as string) ?? 'title'}
              onChange={(v) => setKey('sort', v ?? 'title')}
            />
            {num('limit', 'Rows', 1, 50)}
          </SimpleGrid>
          <TagsInput
            label="Columns"
            description="Property names (up to 8); empty: the default columns"
            maxTags={8}
            value={(widget.columns as string[]) ?? []}
            onChange={(v) => setKey('columns', v)}
          />
          {filters}
        </>
      )}
      {widget.type === 'insights' && <InsightsFields widget={widget} setKey={setKey} num={num} />}
      {widget.type === 'markdown' && (
        <SimpleGrid cols={{ base: 1, sm: 2 }}>
          <Textarea
            label="Content"
            withAsterisk
            autosize
            minRows={6}
            maxLength={10000}
            value={(widget.content as string) ?? ''}
            onChange={(e) => setKey('content', e.currentTarget.value)}
            styles={MONO_INPUT}
          />
          <Stack gap={4}>
            <Text fz="sm" fw={500}>
              Preview
            </Text>
            <Card withBorder padding="sm" data-testid="markdown-preview">
              <Markdown>{String(widget.content ?? '') || '_Nothing to preview_'}</Markdown>
            </Card>
          </Stack>
        </SimpleGrid>
      )}
    </Stack>
  );
}

function ScorecardSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const scorecards = useQuery({ queryKey: ['scorecards'], queryFn: () => api.scorecards() });
  return (
    <Select
      label="Scorecard"
      withAsterisk
      searchable
      data={(scorecards.data ?? []).map((s) => ({ value: s.identifier, label: s.title }))}
      value={value || null}
      onChange={(v) => onChange(v ?? '')}
    />
  );
}

function ActionSelect({ value, onChange, label }: { value: string | null; onChange: (v: string | null) => void; label: string }) {
  const actions = useQuery({ queryKey: ['actions'], queryFn: () => api.actions() });
  return (
    <Select
      label={label}
      searchable
      clearable
      data={(actions.data ?? []).map((a) => ({ value: a.identifier, label: a.title }))}
      value={value}
      onChange={onChange}
    />
  );
}

function InsightsFields({
  widget,
  setKey,
  num,
}: {
  widget: Widget;
  setKey: (key: string, value: unknown) => void;
  num: (key: string, label: string, min: number, max: number, description?: string) => ReactNode;
}) {
  const teams = useQuery({ queryKey: ['teams'], queryFn: api.teams });
  const [advanced, setAdvanced] = useState(false);
  const group = (key: 'deployments' | 'incidents') => (widget[key] as Record<string, unknown> | undefined) ?? {};
  const setIn = (key: 'deployments' | 'incidents', field: string, value: unknown) => {
    const next = { ...group(key) };
    if (value === '' || value === undefined || (Array.isArray(value) && !value.length)) delete next[field];
    else next[field] = value;
    setKey(key, Object.keys(next).length ? next : undefined);
  };
  const text = (key: 'deployments' | 'incidents', field: string, label: string, placeholder: string) => (
    <TextInput
      label={label}
      placeholder={placeholder}
      value={(group(key)[field] as string) ?? ''}
      onChange={(e) => setIn(key, field, e.currentTarget.value.trim())}
      styles={MONO_INPUT}
    />
  );
  const list = (key: 'deployments', field: string, label: string, placeholder: string) => (
    <TagsInput label={label} placeholder={placeholder} value={(group(key)[field] as string[]) ?? []} onChange={(v) => setIn(key, field, v)} />
  );
  return (
    <>
      <SimpleGrid cols={{ base: 1, sm: 3 }}>
        {num('days', 'Window (days)', 1, 365, 'Ending now')}
        <Select
          label="Team"
          description="Empty: every team"
          searchable
          clearable
          data={(teams.data ?? []).map((t) => ({ value: t.identifier, label: t.title }))}
          value={(widget.team as string) ?? null}
          onChange={(v) => setKey('team', v ?? undefined)}
        />
        <TextInput
          label="Service"
          description="Empty: every service"
          value={(widget.service as string) ?? ''}
          onChange={(e) => setKey('service', e.currentTarget.value.trim())}
        />
      </SimpleGrid>
      <Button
        variant="subtle"
        color="gray"
        size="xs"
        w="fit-content"
        onClick={() => setAdvanced((a) => !a)}
        leftSection={advanced ? <IconChevronDown size={14} /> : <IconChevronRight size={14} />}
      >
        Advanced: deployments, incidents and property names
      </Button>
      <Collapse expanded={advanced}>
        {advanced && (
          <Stack gap="md">
            <MultiActions value={(widget.deploymentActions as string[]) ?? []} onChange={(v) => setKey('deploymentActions', v)} />
            <Text fz="sm" fw={600}>
              Deployments
            </Text>
            <SimpleGrid cols={{ base: 1, sm: 3 }}>
              {text('deployments', 'blueprint', 'Blueprint', 'deployment')}
              {text('deployments', 'timeProperty', 'Deploy time property', 'deployedAt')}
              {text('deployments', 'statusProperty', 'Status property', 'status')}
              {text('deployments', 'mergedProperty', 'Merged time property', 'mergedAt')}
              {text('deployments', 'serviceRelation', 'Service relation', 'service')}
            </SimpleGrid>
            <SimpleGrid cols={{ base: 1, sm: 2 }}>
              {list('deployments', 'successValues', 'Success values', 'success')}
              {list('deployments', 'failureValues', 'Failure values', 'failed')}
            </SimpleGrid>
            <Text fz="sm" fw={600}>
              Incidents
            </Text>
            <SimpleGrid cols={{ base: 1, sm: 3 }}>
              {text('incidents', 'blueprint', 'Blueprint', 'incident')}
              {text('incidents', 'createdProperty', 'Created property', 'createdAt')}
              {text('incidents', 'resolvedProperty', 'Resolved property', 'resolvedAt')}
              {text('incidents', 'serviceRelation', 'Service relation', 'service')}
            </SimpleGrid>
          </Stack>
        )}
      </Collapse>
    </>
  );
}

function MultiActions({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  const actions = useQuery({ queryKey: ['actions'], queryFn: () => api.actions() });
  return (
    <MultiSelect
      label="Deployment actions"
      description="Runs of these actions count as deployments (success) or failed deployments"
      searchable
      data={(actions.data ?? []).map((a) => ({ value: a.identifier, label: a.title }))}
      value={value}
      onChange={onChange}
    />
  );
}
