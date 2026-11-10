import { ActionIcon, Alert, Button, Card, Code, Group, MultiSelect, SegmentedControl, Select, Stack, Switch, Text, Textarea, TextInput } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { IconArrowDown, IconArrowUp, IconFilter, IconGavel, IconListCheck, IconPlus, IconStairs, IconTrash } from '@tabler/icons-react';
import { api } from '../../lib/api';
import { MONO_INPUT } from './blocks';
import { ExpressionStatus } from './ExpressionTools';
import { FormBuilder, identityProblems, IdentityFields, SLUG, type EditorProps } from './FormBuilder';

/** Form editors of policies and scorecards (with the YAML / JSON views of FormBuilder). */

const OPERATIONS = ['create', 'update', 'delete'] as const;
const FIELD = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const COLORS = ['gray', 'red', 'pink', 'grape', 'violet', 'indigo', 'blue', 'cyan', 'teal', 'green', 'lime', 'yellow', 'orange'];

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);
const moveItem = <T,>(list: T[], i: number, by: number): T[] => {
  const j = i + by;
  if (j < 0 || j >= list.length) return list;
  const next = [...list];
  [next[i], next[j]] = [next[j], next[i]];
  return next;
};

// ---------- policies ----------

export interface PolicyDoc {
  identifier: string;
  title: string;
  description: string;
  enabled: boolean;
  target: 'run' | 'entity';
  match: { actions?: string[]; blueprints?: string[]; operations?: string[] };
  expression: string;
  message: string;
  [k: string]: unknown;
}

export const toPolicyDoc = (v: Record<string, unknown>): PolicyDoc => {
  const m = (v.match ?? {}) as Record<string, unknown>;
  return {
    ...v,
    identifier: String(v.identifier ?? ''),
    title: String(v.title ?? ''),
    description: String(v.description ?? ''),
    enabled: v.enabled !== false,
    target: v.target === 'entity' ? 'entity' : 'run',
    match: { actions: strings(m.actions), blueprints: strings(m.blueprints), operations: strings(m.operations) },
    expression: String(v.expression ?? ''),
    message: String(v.message ?? 'Denied by policy'),
  };
};

/** Only the filters relevant to the target, and none when empty ("all"). */
export const policyBody = (d: PolicyDoc): Record<string, unknown> => {
  const match: Record<string, string[]> = {};
  const keys = d.target === 'run' ? ['actions'] : ['blueprints', 'operations'];
  for (const k of keys) {
    const list = (d.match as Record<string, string[] | undefined>)[k] ?? [];
    if (list.length) match[k] = list;
  }
  return { ...d, match };
};

export const policyProblems = (d: PolicyDoc): string[] => {
  const out = identityProblems(d);
  if (!d.expression.trim()) out.push('Expression is required');
  if (d.target === 'run' && d.match.operations?.length) out.push('Operations only apply to entity policies');
  return out;
};

const POLICY_CONTEXT: [string, string][] = [
  ['inputs', 'values submitted with the run (runs)'],
  ['entity', 'entity being written: identifier, title, properties, relations, team (entities)'],
  ['previous', 'the entity before the change (update, delete)'],
  ['principal', 'who acts: id, name, role, teams'],
  ['action', 'the action being run (runs)'],
  ['blueprint', 'the blueprint of the entity (entities)'],
  ['operation', 'create, update or delete (entities)'],
];

export function PolicyBuilder(props: EditorProps) {
  const blueprints = useQuery({ queryKey: ['blueprints'], queryFn: api.blueprints });
  const actions = useQuery({ queryKey: ['actions'], queryFn: () => api.actions() });
  return (
    <FormBuilder<PolicyDoc>
      {...props}
      size="xl"
      noun="policy"
      toDoc={toPolicyDoc}
      toBody={policyBody}
      problems={policyProblems}
      tabs={[
        {
          value: 'policy',
          label: 'Policy',
          icon: <IconGavel size={16} />,
          render: (ctx) => (
            <Stack gap="md">
              <IdentityFields {...ctx} placeholder="Production runs need a ticket" />
              <Textarea
                label="Description"
                autosize
                minRows={2}
                value={ctx.doc.description}
                onChange={(e) => ctx.set({ description: e.currentTarget.value })}
              />
              <Switch label="Enabled" checked={ctx.doc.enabled} onChange={(e) => ctx.set({ enabled: e.currentTarget.checked })} />
              <div>
                <Text fz="sm" fw={500} mb="3xs">
                  Applies to
                </Text>
                <SegmentedControl
                  aria-label="Target"
                  value={ctx.doc.target}
                  onChange={(t) => ctx.set({ target: t as PolicyDoc['target'] })}
                  data={[
                    { value: 'run', label: 'Action runs' },
                    { value: 'entity', label: 'Entity writes' },
                  ]}
                />
              </div>
            </Stack>
          ),
        },
        {
          value: 'scope',
          label: 'Scope',
          icon: <IconFilter size={16} />,
          render: (ctx) => {
            const set = (patch: PolicyDoc['match']) => ctx.set({ match: { ...ctx.doc.match, ...patch } });
            return ctx.doc.target === 'run' ? (
              <MultiSelect
                label="Actions"
                description="Leave empty to apply to all actions"
                placeholder="All actions"
                searchable
                clearable
                data={(actions.data ?? []).map((a) => ({ value: a.identifier, label: `${a.title} (${a.identifier})` }))}
                value={ctx.doc.match.actions ?? []}
                onChange={(actions) => set({ actions })}
              />
            ) : (
              <Stack gap="md">
                <MultiSelect
                  label="Blueprints"
                  description="Leave empty to apply to all blueprints"
                  placeholder="All blueprints"
                  searchable
                  clearable
                  data={(blueprints.data ?? []).map((b) => ({ value: b.identifier, label: `${b.title} (${b.identifier})` }))}
                  value={ctx.doc.match.blueprints ?? []}
                  onChange={(blueprints) => set({ blueprints })}
                />
                <MultiSelect
                  label="Operations"
                  description="Leave empty to apply to all operations"
                  placeholder="All operations"
                  clearable
                  data={[...OPERATIONS]}
                  value={ctx.doc.match.operations ?? []}
                  onChange={(operations) => set({ operations })}
                />
              </Stack>
            );
          },
        },
        {
          value: 'rule',
          label: 'Rule',
          icon: <IconListCheck size={16} />,
          render: (ctx) => (
            <Stack gap="md">
              <Textarea
                label="Expression"
                withAsterisk
                description="JSONata: must evaluate to true to allow; anything else, and any error, denies"
                autosize
                minRows={3}
                value={ctx.doc.expression}
                onChange={(e) => ctx.set({ expression: e.currentTarget.value })}
                styles={MONO_INPUT}
              />
              <ExpressionStatus expression={ctx.doc.expression} context={{}} />
              <Alert variant="light" color="gray" title="Context variables" p="xs">
                <Stack gap="4xs">
                  {POLICY_CONTEXT.map(([k, d]) => (
                    <Text key={k} fz="xs">
                      <Code>{k}</Code> {d}
                    </Text>
                  ))}
                </Stack>
              </Alert>
              <TextInput
                label="Deny message"
                description="May embed {{ expression }} over the same context"
                value={ctx.doc.message}
                onChange={(e) => ctx.set({ message: e.currentTarget.value })}
              />
            </Stack>
          ),
        },
      ]}
    />
  );
}

// ---------- scorecards ----------

interface Level {
  name: string;
  color?: string;
  [k: string]: unknown;
}
interface Rule {
  identifier: string;
  title: string;
  level: string;
  expression: string;
  description?: string;
  [k: string]: unknown;
}

export interface ScorecardDoc {
  identifier: string;
  title: string;
  description: string;
  blueprint: string;
  levels: Level[];
  rules: Rule[];
  [k: string]: unknown;
}

export const toScorecardDoc = (v: Record<string, unknown>): ScorecardDoc => ({
  ...v,
  identifier: String(v.identifier ?? ''),
  title: String(v.title ?? ''),
  description: String(v.description ?? ''),
  blueprint: String(v.blueprint ?? ''),
  levels: Array.isArray(v.levels) ? (v.levels as Level[]) : [],
  rules: Array.isArray(v.rules) ? (v.rules as Rule[]) : [],
});

export const scorecardProblems = (d: ScorecardDoc): string[] => {
  const out = identityProblems(d);
  if (!SLUG.test(d.blueprint)) out.push('Blueprint is required');
  if (!d.levels.length) out.push('At least one level is required');
  const names = d.levels.map((l) => l.name.trim());
  if (names.some((n) => !n)) out.push('Every level needs a name');
  if (new Set(names).size !== names.length) out.push('Level names must be unique');
  if (!d.rules.length) out.push('At least one rule is required');
  const ids = d.rules.map((r) => r.identifier);
  if (ids.some((i) => !FIELD.test(i))) out.push('Rule identifiers: letters, digits and _, starting with a letter');
  if (new Set(ids).size !== ids.length) out.push('Rule identifiers must be unique');
  for (const r of d.rules) {
    if (!r.title.trim()) out.push(`Rule ${r.identifier || '?'}: title is required`);
    if (!names.includes(r.level)) out.push(`Rule ${r.identifier || '?'}: level "${r.level}" is not defined`);
    if (!r.expression.trim()) out.push(`Rule ${r.identifier || '?'}: expression is required`);
  }
  return out;
};

function RowControls({ i, count, onMove, onRemove, label }: { i: number; count: number; onMove: (by: number) => void; onRemove: () => void; label: string }) {
  return (
    <Group gap="4xs" wrap="nowrap">
      <ActionIcon variant="subtle" color="gray" aria-label={`Move ${label} up`} disabled={i === 0} onClick={() => onMove(-1)}>
        <IconArrowUp size={16} />
      </ActionIcon>
      <ActionIcon variant="subtle" color="gray" aria-label={`Move ${label} down`} disabled={i === count - 1} onClick={() => onMove(1)}>
        <IconArrowDown size={16} />
      </ActionIcon>
      <ActionIcon variant="subtle" color="red" aria-label={`Remove ${label}`} onClick={onRemove}>
        <IconTrash size={16} />
      </ActionIcon>
    </Group>
  );
}

export function ScorecardBuilder(props: EditorProps) {
  const blueprints = useQuery({ queryKey: ['blueprints'], queryFn: api.blueprints });
  return (
    <FormBuilder<ScorecardDoc>
      {...props}
      size="xl"
      noun="scorecard"
      toDoc={toScorecardDoc}
      problems={scorecardProblems}
      tabs={[
        {
          value: 'scorecard',
          label: 'Scorecard',
          icon: <IconListCheck size={16} />,
          render: (ctx) => (
            <Stack gap="md">
              <IdentityFields {...ctx} placeholder="Production readiness" />
              <Textarea
                label="Description"
                autosize
                minRows={2}
                value={ctx.doc.description}
                onChange={(e) => ctx.set({ description: e.currentTarget.value })}
              />
              <Select
                label="Blueprint"
                withAsterisk
                searchable
                data={[...new Set([ctx.doc.blueprint, ...(blueprints.data ?? []).map((b) => b.identifier)].filter(Boolean))]}
                value={ctx.doc.blueprint || null}
                onChange={(b) => ctx.set({ blueprint: b ?? '' })}
              />
            </Stack>
          ),
        },
        {
          value: 'levels',
          label: 'Levels',
          icon: <IconStairs size={16} />,
          count: (d) => d.levels.length,
          render: ({ doc, set }) => {
            const edit = (i: number, patch: Partial<Level>) => set({ levels: doc.levels.map((l, j) => (j === i ? { ...l, ...patch } : l)) });
            return (
              <Stack gap="xs">
                <Text fz="sm" c="dimmed">
                  Ordered from the lowest to the highest. An entity reaches a level when it passes the rules of that level and of the levels below.
                </Text>
                {doc.levels.map((l, i) => (
                  <Group key={i} wrap="nowrap" align="flex-end">
                    <TextInput
                      flex={1}
                      label={i === 0 ? 'Name' : undefined}
                      aria-label={`Level ${i + 1} name`}
                      value={l.name}
                      onChange={(e) => edit(i, { name: e.currentTarget.value })}
                    />
                    <Select
                      w={140}
                      label={i === 0 ? 'Color' : undefined}
                      aria-label={`Level ${i + 1} color`}
                      data={COLORS}
                      clearable
                      value={l.color ?? null}
                      onChange={(c) => edit(i, { color: c ?? undefined })}
                    />
                    <RowControls
                      i={i}
                      count={doc.levels.length}
                      label={`level ${l.name || i + 1}`}
                      onMove={(by) => set({ levels: moveItem(doc.levels, i, by) })}
                      onRemove={() => set({ levels: doc.levels.filter((_, j) => j !== i) })}
                    />
                  </Group>
                ))}
                <Group>
                  <Button size="xs" variant="light" leftSection={<IconPlus size={14} />} onClick={() => set({ levels: [...doc.levels, { name: '' }] })}>
                    Add level
                  </Button>
                </Group>
              </Stack>
            );
          },
        },
        {
          value: 'rules',
          label: 'Rules',
          icon: <IconListCheck size={16} />,
          count: (d) => d.rules.length,
          render: ({ doc, set }) => {
            const edit = (i: number, patch: Partial<Rule>) => set({ rules: doc.rules.map((r, j) => (j === i ? { ...r, ...patch } : r)) });
            const levels = doc.levels.map((l) => l.name).filter(Boolean);
            return (
              <Stack gap="sm">
                <Text fz="sm" c="dimmed">
                  Rules are JSONata expressions over the entity (<Code>properties</Code>, <Code>relations</Code>, <Code>related</Code>, <Code>team</Code>): a
                  rule passes when truthy.
                </Text>
                {doc.rules.map((r, i) => (
                  <Card key={i} withBorder p="sm">
                    <Stack gap="xs">
                      <Group wrap="nowrap" align="flex-end">
                        <TextInput
                          flex={1}
                          label="Title"
                          aria-label={`Rule ${i + 1} title`}
                          value={r.title}
                          onChange={(e) => edit(i, { title: e.currentTarget.value })}
                        />
                        <TextInput
                          w={180}
                          label="Identifier"
                          aria-label={`Rule ${i + 1} identifier`}
                          value={r.identifier}
                          onChange={(e) => edit(i, { identifier: e.currentTarget.value })}
                          styles={MONO_INPUT}
                        />
                        <Select
                          w={150}
                          label="Level"
                          aria-label={`Rule ${i + 1} level`}
                          data={[...new Set([...levels, r.level].filter(Boolean))]}
                          value={r.level || null}
                          onChange={(l) => edit(i, { level: l ?? '' })}
                          error={r.level && !levels.includes(r.level) ? 'not defined' : undefined}
                        />
                        <RowControls
                          i={i}
                          count={doc.rules.length}
                          label={`rule ${r.identifier || i + 1}`}
                          onMove={(by) => set({ rules: moveItem(doc.rules, i, by) })}
                          onRemove={() => set({ rules: doc.rules.filter((_, j) => j !== i) })}
                        />
                      </Group>
                      <Textarea
                        label="Expression"
                        aria-label={`Rule ${i + 1} expression`}
                        autosize
                        minRows={1}
                        value={r.expression}
                        onChange={(e) => edit(i, { expression: e.currentTarget.value })}
                        styles={MONO_INPUT}
                      />
                      <ExpressionStatus expression={r.expression} />
                      <TextInput
                        label="Description"
                        aria-label={`Rule ${i + 1} description`}
                        value={r.description ?? ''}
                        onChange={(e) => edit(i, { description: e.currentTarget.value || undefined })}
                      />
                    </Stack>
                  </Card>
                ))}
                <Group>
                  <Button
                    size="xs"
                    variant="light"
                    leftSection={<IconPlus size={14} />}
                    onClick={() => set({ rules: [...doc.rules, { identifier: '', title: '', level: levels[0] ?? '', expression: '' }] })}
                  >
                    Add rule
                  </Button>
                </Group>
              </Stack>
            );
          },
        },
      ]}
    />
  );
}
