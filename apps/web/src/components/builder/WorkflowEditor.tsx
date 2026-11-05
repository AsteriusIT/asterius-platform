import { useMemo, useState, type KeyboardEvent } from 'react';
import {
  Accordion,
  ActionIcon,
  Alert,
  Badge,
  Button,
  Box,
  Card,
  Checkbox,
  Grid,
  Group,
  Input,
  Menu,
  MultiSelect,
  NumberInput,
  SegmentedControl,
  Select,
  SimpleGrid,
  Stack,
  Switch,
  Text,
  Textarea,
  TextInput,
  ThemeIcon,
  Title,
  Tooltip,
  UnstyledButton,
} from '@mantine/core';
import { modals } from '@mantine/modals';
import { useQuery } from '@tanstack/react-query';
import { IconArrowDown, IconArrowUp, IconBolt, IconCode, IconPlus, IconRobot, IconShieldCheck, IconTrash } from '@tabler/icons-react';
import type {
  AgentStep,
  FormTrigger,
  ApprovalStep,
  InvokeStep,
  InvokerConfig,
  ObjectSchema,
  PluginInfo,
  TransformStep,
  WorkflowStep,
  WorkflowStepType,
} from '@asterius/shared';
import { api } from '../../lib/api';
import { needsOf, STEP_TYPES } from '../../lib/workflow';
import { newFormTrigger, TriggerEditor, TRIGGER_TYPES, triggerSummary } from './TriggerEditor';
import { Empty } from '../ui';
import { fieldProblems, fieldsToSchema, nameFromLabel, schemaToFields, type FieldDraft } from './fields';
import { FieldsEditor, type FieldsMode } from './FieldsEditor';
import { JsonEditor, KeyValueEditor, MONO_INPUT, PluginFieldInput, SubjectsEditor, VariableChips } from './blocks';

/**
 * The "Workflow" tab of the action builder: a canvas of nodes — the trigger (what starts the workflow: a form
 * submission) then the steps (integration calls, approvals, AI agents, transforms), added one by one with "+".
 * The selected node is edited on the right: settings, condition, dependencies, retries and timeout.
 */

const STEP_ID = /^[A-Za-z_][A-Za-z0-9_]{0,40}$/;
const TYPE_ICON = { invoke: IconBolt, approval: IconShieldCheck, agent: IconRobot, transform: IconCode } as const;

export const AGENT_MODELS = [
  { value: 'claude-opus-5-5', label: 'Claude Opus 5.5', description: 'Default · best reasoning · $4 / $20 per M tokens' },
  { value: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5', description: 'Fast and capable · $2 / $10 per M tokens' },
  { value: 'claude-haiku-5-5', label: 'Claude Haiku 5.5', description: 'Fastest, cheapest · $0.10 / $0.50 per M tokens' },
  { value: 'claude-fable-5-1', label: 'Claude Fable 5.1', description: 'Most capable · $10 / $50 per M tokens' },
];

function uniqueId(base: string, steps: WorkflowStep[]) {
  const clean = nameFromLabel(base) || 'step';
  let id = clean;
  for (let n = 2; steps.some((s) => s.id === id); n++) id = `${clean}${n}`;
  return id;
}

export function newStep(type: WorkflowStepType, steps: WorkflowStep[], invokers: PluginInfo[]): WorkflowStep {
  const name = { invoke: 'Call an integration', approval: 'Approval', agent: 'AI review', transform: 'Compute values' }[type];
  const id = uniqueId({ invoke: 'call', approval: 'approval', agent: 'review', transform: 'compute' }[type], steps);
  if (type === 'invoke') {
    const example = invokers.find((i) => i.type === 'webhook')?.example ?? { type: 'webhook' };
    return { id, name, type, invoker: example as InvokerConfig };
  }
  if (type === 'approval') return { id, name, type, minApprovals: 1 };
  if (type === 'agent') return { id, name, type, model: 'claude-opus-5-5', effort: 'medium', prompt: '', tools: [] };
  return { id, name, type, output: {} };
}

/** Problems found before saving (the server validates everything again). */
export function stepProblems(steps: WorkflowStep[], invokers: PluginInfo[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  steps.forEach((s, i) => {
    const where = `Step ${i + 1} (${s.name || s.id})`;
    if (!STEP_ID.test(s.id)) out.push(`${where}: the id must start with a letter and contain only letters, digits and _`);
    else if (seen.has(s.id)) out.push(`${where}: the id "${s.id}" is used twice`);
    for (const n of s.needs ?? []) if (!seen.has(n)) out.push(`${where}: it can only run after earlier steps ("${n}")`);
    seen.add(s.id);
    if (s.type === 'invoke') {
      const info = invokers.find((x) => x.type === s.invoker?.type);
      for (const f of info?.fields?.filter((x) => x.required) ?? [])
        if (s.invoker[f.key] === undefined || s.invoker[f.key] === '') out.push(`${where}: "${f.label}" is required`);
    }
    if (s.type === 'agent') {
      if (!s.prompt?.trim()) out.push(`${where}: write the prompt`);
      if (s.output) out.push(...fieldProblems(schemaToFields(s.output), `${where}: output field`));
    }
    if (s.type === 'transform')
      for (const k of Object.keys(s.output ?? {})) if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) out.push(`${where}: invalid output key "${k}"`);
  });
  return out;
}

/** Selected node of the canvas: the trigger, or a step id. */
type Selection = { kind: 'trigger' } | { kind: 'step'; id: string } | null;

export function WorkflowEditor(props: {
  trigger: FormTrigger | null;
  onTriggerChange: (t: FormTrigger | null) => void;
  /** The form fields of the trigger (edited as drafts; the builder turns them into `trigger.inputs`). */
  fields: FieldDraft[];
  onFieldsChange: (f: FieldDraft[]) => void;
  steps: WorkflowStep[];
  onChange: (steps: WorkflowStep[]) => void;
}) {
  const { steps, onChange, trigger } = props;
  const meta = useQuery({ queryKey: ['meta'], queryFn: api.meta, staleTime: Infinity });
  const invokers = meta.data?.invokers ?? [];
  const [selected, setSelected] = useState<Selection>(() => (trigger ? { kind: 'trigger' } : steps[0] ? { kind: 'step', id: steps[0].id } : null));
  const index = selected?.kind === 'step' ? steps.findIndex((s) => s.id === selected.id) : -1;
  const step = index >= 0 ? steps[index] : null;
  const onEntity = !!trigger && trigger.on !== 'create' && !!trigger.blueprint;
  const selectStep = (id: string) => setSelected({ kind: 'step', id });

  const update = (patch: Partial<WorkflowStep>) => {
    if (!step) return;
    const next = steps.map((s, i) => (i === index ? ({ ...s, ...patch } as WorkflowStep) : s));
    // Renaming an id keeps the dependencies pointing at it.
    if (patch.id && patch.id !== step.id) {
      for (const s of next) if (s.needs) s.needs = s.needs.map((n) => (n === step.id ? patch.id! : n));
      selectStep(patch.id);
    }
    onChange(next);
  };
  /** Insert a step at `at` (0 = right after the trigger). */
  const insert = (type: WorkflowStepType, at: number) => {
    const s = newStep(type, steps, invokers);
    onChange([...steps.slice(0, at), s, ...steps.slice(at)]);
    selectStep(s.id);
  };
  const remove = () => {
    if (!step) return;
    const next = steps.filter((_, i) => i !== index).map((s) => (s.needs ? { ...s, needs: s.needs.filter((n) => n !== step.id) } : s));
    onChange(next);
    const neighbour = next[Math.max(0, index - 1)];
    setSelected(neighbour ? { kind: 'step', id: neighbour.id } : trigger ? { kind: 'trigger' } : null);
  };
  const move = (d: -1 | 1) => {
    const next = [...steps];
    [next[index], next[index + d]] = [next[index + d], next[index]];
    // A step may only depend on earlier steps: drop dependencies that would now point forward.
    const ids = next.map((s) => s.id);
    onChange(next.map((s, i) => (s.needs ? { ...s, needs: s.needs.filter((n) => ids.indexOf(n) < i) } : s)));
  };
  const addTrigger = () => {
    props.onTriggerChange(newFormTrigger());
    props.onFieldsChange([]);
    setSelected({ kind: 'trigger' });
  };
  const removeTrigger = () =>
    modals.openConfirmModal({
      title: 'Remove the trigger?',
      children: <Text fz="sm">Its form fields are removed too. Without a trigger, the workflow cannot be started.</Text>,
      labels: { confirm: 'Remove', cancel: 'Keep' },
      confirmProps: { color: 'red' },
      onConfirm: () => {
        props.onTriggerChange(null);
        props.onFieldsChange([]);
        setSelected(steps[0] ? { kind: 'step', id: steps[0].id } : null);
      },
    });

  return (
    <Grid gap="lg" align="flex-start">
      <Grid.Col span={{ base: 12, md: 4 }}>
        <Stack gap={0} align="stretch" className="workflow-canvas" p="md" style={{ background: 'var(--surface)', borderRadius: 16 }}>
          {trigger ? (
            <CanvasNode
              icon={TRIGGER_TYPES.form.icon}
              color="brand"
              kicker="Trigger"
              title={TRIGGER_TYPES.form.label}
              subtitle={triggerSummary(trigger)}
              badges={[
                ...(props.fields.length ? [`${props.fields.length} field${props.fields.length > 1 ? 's' : ''}`] : []),
                ...(trigger.approval.required ? ['approval'] : []),
              ]}
              active={selected?.kind === 'trigger'}
              onClick={() => setSelected({ kind: 'trigger' })}
            />
          ) : (
            <Menu position="bottom" width={320}>
              <Menu.Target>
                <UnstyledButton className="canvas-placeholder" aria-label="Add a trigger">
                  <Group gap="xs" justify="center">
                    <IconPlus size={16} />
                    <Text fz="sm" fw={500}>
                      Add a trigger
                    </Text>
                  </Group>
                  <Text fz="xs" c="dimmed" ta="center">
                    What starts the workflow
                  </Text>
                </UnstyledButton>
              </Menu.Target>
              <Menu.Dropdown>
                <Menu.Item leftSection={<TRIGGER_TYPES.form.icon size={16} />} onClick={addTrigger}>
                  <Text fz="sm" fw={500}>
                    {TRIGGER_TYPES.form.label}
                  </Text>
                  <Text fz="xs" c="dimmed">
                    {TRIGGER_TYPES.form.hint}
                  </Text>
                </Menu.Item>
              </Menu.Dropdown>
            </Menu>
          )}

          {steps.map((s, i) => {
            const Icon = TYPE_ICON[s.type];
            const needs = needsOf(steps, i);
            const sequential = s.needs === undefined;
            return (
              <Stack key={`${s.id}:${i}`} gap={0}>
                <Connector onAdd={(t) => insert(t, i)} label={`Insert a step before ${s.name || s.id}`} />
                <CanvasNode
                  icon={Icon}
                  color={STEP_TYPES[s.type].color}
                  kicker={STEP_TYPES[s.type].label}
                  title={s.name || s.id}
                  subtitle={sequential ? undefined : needs.length ? `after ${needs.join(', ')}` : 'starts with the workflow (parallel)'}
                  badges={[...(s.if ? ['if'] : []), ...(s.retries ? [`${s.retries} retries`] : []), ...(s.continueOnError ? ['may fail'] : [])]}
                  active={selected?.kind === 'step' && selected.id === s.id}
                  onClick={() => selectStep(s.id)}
                />
              </Stack>
            );
          })}
          <Connector onAdd={(t) => insert(t, steps.length)} label="Add a step" last />
        </Stack>
      </Grid.Col>

      <Grid.Col span={{ base: 12, md: 8 }}>
        {selected?.kind === 'trigger' && trigger ? (
          <Card padding="lg" shadow="none" withBorder>
            <Group gap="xs" mb="md">
              <Badge color="brand">Trigger</Badge>
              <Text fz="sm" fw={500}>
                {TRIGGER_TYPES.form.label}
              </Text>
            </Group>
            <TriggerEditor
              trigger={trigger}
              onChange={props.onTriggerChange}
              fields={props.fields}
              onFieldsChange={props.onFieldsChange}
              onRemove={removeTrigger}
            />
          </Card>
        ) : step ? (
          <Card padding="lg" shadow="none" withBorder key={`${step.id}:${index}`}>
            <Group justify="space-between" mb="md">
              <Group gap="xs">
                <Badge color={STEP_TYPES[step.type].color}>{STEP_TYPES[step.type].label}</Badge>
                <Text fz="xs" c="dimmed">
                  Step {index + 1} of {steps.length}
                </Text>
              </Group>
              <Group gap={2}>
                <ActionIcon variant="subtle" color="gray" disabled={index === 0} onClick={() => move(-1)} aria-label="Move earlier">
                  <IconArrowUp size={16} />
                </ActionIcon>
                <ActionIcon variant="subtle" color="gray" disabled={index === steps.length - 1} onClick={() => move(1)} aria-label="Move later">
                  <IconArrowDown size={16} />
                </ActionIcon>
                <ActionIcon variant="subtle" color="red" onClick={remove} aria-label="Remove step">
                  <IconTrash size={16} />
                </ActionIcon>
              </Group>
            </Group>
            <Stack gap="md">
              <SimpleGrid cols={{ base: 1, sm: 2 }}>
                <TextInput label="Name" value={step.name ?? ''} onChange={(e) => update({ name: e.currentTarget.value })} />
                <TextInput
                  label="Id"
                  description={
                    <>
                      Later steps read <code>{`{{ steps.${step.id}.output }}`}</code>
                    </>
                  }
                  value={step.id}
                  error={!STEP_ID.test(step.id) ? 'Letters, digits and _' : steps.some((s, i) => i !== index && s.id === step.id) ? 'Already used' : undefined}
                  onChange={(e) => update({ id: e.currentTarget.value })}
                  styles={MONO_INPUT}
                />
              </SimpleGrid>
              <Variables steps={steps} index={index} inputFields={trigger ? props.fields : []} blueprint={trigger?.blueprint ?? null} onEntity={onEntity} />
              {step.type === 'invoke' && <InvokeEditor step={step} invokers={invokers} onChange={update} />}
              {step.type === 'approval' && <ApprovalEditor step={step} onEntity={onEntity} onChange={update} />}
              {step.type === 'agent' && <AgentEditor step={step} onChange={update} />}
              {step.type === 'transform' && <TransformEditor step={step} onChange={update} />}
              <FlowEditor steps={steps} index={index} onChange={update} />
            </Stack>
          </Card>
        ) : (
          <Empty title={trigger ? 'Add the first step' : 'Start with a trigger'}>
            {trigger
              ? 'Click + under the trigger to add what the workflow does: call an integration, ask for an approval, run an AI agent…'
              : 'A workflow is a trigger followed by steps. Add a trigger (a form users submit), then add steps one by one.'}
          </Empty>
        )}
      </Grid.Col>
    </Grid>
  );
}

/** A node of the canvas (trigger or step). */
function CanvasNode(props: {
  icon: typeof IconBolt;
  color: string;
  kicker: string;
  title: string;
  subtitle?: string;
  badges: string[];
  active: boolean;
  onClick: () => void;
}) {
  const Icon = props.icon;
  return (
    // A div, not a <button>: nodes stay selectable in read-only views (a disabled fieldset disables buttons).
    <UnstyledButton
      component="div"
      role="button"
      tabIndex={0}
      onClick={props.onClick}
      onKeyDown={(e: KeyboardEvent) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), props.onClick())}
      aria-pressed={props.active}
      className="canvas-node"
      data-active={props.active || undefined}
    >
      <Group gap="sm" wrap="nowrap" align="flex-start">
        <ThemeIcon size={30} variant="light" color={props.color}>
          <Icon size={17} />
        </ThemeIcon>
        <Box style={{ minWidth: 0, flex: 1 }}>
          <Text fz={11} c="dimmed" tt="uppercase" fw={600} lh={1.4}>
            {props.kicker}
          </Text>
          <Text fz="sm" fw={500} truncate>
            {props.title}
          </Text>
          {props.subtitle && (
            <Text fz="xs" c="dimmed" truncate>
              {props.subtitle}
            </Text>
          )}
          {props.badges.length > 0 && (
            <Group gap={4} mt={4}>
              {props.badges.map((b) => (
                <Badge key={b} size="xs" variant="light" color="gray">
                  {b}
                </Badge>
              ))}
            </Group>
          )}
        </Box>
      </Group>
    </UnstyledButton>
  );
}

/** The link between two nodes, with a "+" to insert a step there (or at the end). */
function Connector({ onAdd, label, last }: { onAdd: (t: WorkflowStepType) => void; label: string; last?: boolean }) {
  return (
    <Stack gap={0} align="center">
      <Box w={2} h={12} style={{ background: 'var(--mantine-color-default-border)' }} />
      <Menu position="right" width={300} withinPortal>
        <Menu.Target>
          {last ? (
            <Button size="xs" variant="default" leftSection={<IconPlus size={14} />} aria-label={label}>
              Add step
            </Button>
          ) : (
            <Tooltip label={label} position="left">
              <ActionIcon size="sm" radius="xl" variant="default" aria-label={label}>
                <IconPlus size={12} />
              </ActionIcon>
            </Tooltip>
          )}
        </Menu.Target>
        <Menu.Dropdown>
          {(Object.keys(STEP_TYPES) as WorkflowStepType[]).map((t) => {
            const Icon = TYPE_ICON[t];
            return (
              <Menu.Item key={t} leftSection={<Icon size={16} />} onClick={() => onAdd(t)}>
                <Text fz="sm" fw={500}>
                  {STEP_TYPES[t].label}
                </Text>
                <Text fz="xs" c="dimmed">
                  {STEP_TYPES[t].hint}
                </Text>
              </Menu.Item>
            );
          })}
        </Menu.Dropdown>
      </Menu>
      {!last && <Box w={2} h={12} style={{ background: 'var(--mantine-color-default-border)' }} />}
    </Stack>
  );
}

/** Variables available to the step at `index`, click to copy. */
function Variables({
  steps,
  index,
  inputFields,
  blueprint,
  onEntity,
}: {
  steps: WorkflowStep[];
  index: number;
  inputFields: FieldDraft[];
  blueprint: string | null;
  onEntity: boolean;
}) {
  const bp = useQuery({ queryKey: ['blueprint', blueprint], queryFn: () => api.blueprint(blueprint!), enabled: onEntity && !!blueprint });
  const vars = useMemo(() => {
    const earlier = steps.slice(0, index).flatMap((s) => {
      if (s.type === 'agent') return s.output ? Object.keys(s.output.properties).map((k) => `steps.${s.id}.output.${k}`) : [`steps.${s.id}.output.text`];
      if (s.type === 'transform') return Object.keys(s.output ?? {}).map((k) => `steps.${s.id}.output.${k}`);
      if (s.type === 'approval') return [`steps.${s.id}.output.approved`, `steps.${s.id}.output.by`];
      return [`steps.${s.id}.output`, `steps.${s.id}.link`];
    });
    return [
      ...inputFields.filter((f) => f.name).map((f) => `inputs.${f.name}`),
      ...(onEntity
        ? ['entity.identifier', 'entity.title', 'entity.team', ...Object.keys(bp.data?.schema.properties ?? {}).map((p) => `entity.properties.${p}`)]
        : []),
      ...earlier,
      'trigger.user.email',
      'trigger.user.name',
      'run.url',
      'run.callback.url',
      'run.callback.token',
    ];
  }, [steps, index, inputFields, onEntity, bp.data]);
  return (
    <Stack gap={6} p="sm" style={{ background: 'var(--surface)', borderRadius: 12 }}>
      <Text fz="xs" c="dimmed">
        Templates: <code>{'{{ expression }}'}</code> (JSONata) in any text below. Click a variable to copy it.
      </Text>
      <VariableChips variables={vars} />
    </Stack>
  );
}

function InvokeEditor({ step, invokers, onChange }: { step: InvokeStep; invokers: PluginInfo[]; onChange: (p: Partial<InvokeStep>) => void }) {
  const info = invokers.find((i) => i.type === step.invoker.type);
  const [generation, setGeneration] = useState(0);
  const changeType = (type: string) => {
    const apply = () => {
      onChange({ invoker: { ...(invokers.find((i) => i.type === type)?.example ?? {}), type } as InvokerConfig });
      setGeneration((g) => g + 1);
    };
    if (!Object.keys(step.invoker).some((k) => k !== 'type')) return apply();
    modals.openConfirmModal({
      title: 'Change the integration?',
      children: <Text fz="sm">Its settings are replaced by an example for the new type.</Text>,
      labels: { confirm: 'Change', cancel: 'Keep' },
      onConfirm: apply,
    });
  };
  const setKey = (k: string, v: unknown) => {
    const next: InvokerConfig = { ...step.invoker };
    if (v === undefined) delete next[k];
    else next[k] = v;
    onChange({ invoker: next });
  };
  const basic = info?.fields?.filter((f) => !f.advanced) ?? [];
  const advanced = info?.fields?.filter((f) => f.advanced) ?? [];
  return (
    <Stack gap="sm" key={generation}>
      <Select
        label="Runs with"
        allowDeselect={false}
        data={invokers.map((i) => ({ value: i.type, label: i.title }))}
        value={step.invoker.type}
        onChange={(t) => t && changeType(t)}
        description={info?.description}
      />
      {info?.fields?.length ? (
        <>
          {basic.map((f) => (
            <PluginFieldInput key={f.key} field={f} value={step.invoker[f.key]} onChange={(v) => setKey(f.key, v)} />
          ))}
          {advanced.length > 0 && (
            <Accordion variant="contained" radius="lg">
              <Accordion.Item value="advanced">
                <Accordion.Control>Advanced</Accordion.Control>
                <Accordion.Panel>
                  <Stack gap="sm">
                    {advanced.map((f) => (
                      <PluginFieldInput key={f.key} field={f} value={step.invoker[f.key]} onChange={(v) => setKey(f.key, v)} />
                    ))}
                  </Stack>
                </Accordion.Panel>
              </Accordion.Item>
            </Accordion>
          )}
        </>
      ) : (
        <JsonEditor
          label="Settings"
          value={Object.fromEntries(Object.entries(step.invoker).filter(([k]) => k !== 'type'))}
          onChange={(v) => onChange({ invoker: { ...((v as object) ?? {}), type: step.invoker.type } })}
          minRows={8}
        />
      )}
    </Stack>
  );
}

function ApprovalEditor({ step, onEntity, onChange }: { step: ApprovalStep; onEntity: boolean; onChange: (p: Partial<ApprovalStep>) => void }) {
  return (
    <Stack gap="sm">
      <Title order={6}>Approvers</Title>
      <SubjectsEditor value={step.approvers} onChange={(approvers) => onChange({ approvers })} allowOwnerTeam={onEntity} emptyMeans="admins approve" />
      <Group align="flex-end">
        <NumberInput
          label="Approvals needed"
          min={1}
          max={10}
          w={180}
          value={step.minApprovals ?? 1}
          onChange={(n) => onChange({ minApprovals: Number(n) || 1 })}
        />
        <Switch
          mb={8}
          label="The requester may approve"
          checked={!!step.allowSelfApproval}
          onChange={(e) => onChange({ allowSelfApproval: e.currentTarget.checked || undefined })}
        />
      </Group>
      <Textarea
        label="Message to approvers"
        description="Markdown template, e.g. the summary of an AI review: {{ steps.review.output.summary }}"
        autosize
        minRows={3}
        value={step.message ?? ''}
        onChange={(e) => onChange({ message: e.currentTarget.value || undefined })}
        styles={MONO_INPUT}
      />
    </Stack>
  );
}

function AgentEditor({ step, onChange }: { step: AgentStep; onChange: (p: Partial<AgentStep>) => void }) {
  const [fields, setFields] = useState<FieldDraft[]>(() => schemaToFields(step.output));
  const mode: FieldsMode = {
    templatePath: (n) => `steps.${step.id}.output.${n}`,
    noun: 'field',
    emptyTitle: 'No fields',
    emptyHint: 'Add the fields Claude must return.',
    previewTitle: 'Output shape',
  };
  return (
    <Stack gap="sm">
      <Alert variant="light" color="grape" icon={<IconRobot size={18} />}>
        Claude answers the prompt below. Its answer becomes the step output, either text or the structured fields you define. Calls use the platform&apos;s
        ANTHROPIC_API_KEY unless the step sets its own.
      </Alert>
      <SimpleGrid cols={{ base: 1, sm: 2 }}>
        <Select
          label="Model"
          allowDeselect={false}
          data={AGENT_MODELS.map((m) => ({ value: m.value, label: m.label }))}
          value={step.model ?? 'claude-opus-5-5'}
          onChange={(m) => onChange({ model: m ?? undefined })}
          description={AGENT_MODELS.find((m) => m.value === (step.model ?? 'claude-opus-5-5'))?.description}
        />
        <Input.Wrapper label="Effort" description="Depth of reasoning: higher is more thorough, slower and costlier">
          <SegmentedControl
            fullWidth
            value={step.effort ?? 'medium'}
            onChange={(e) => onChange({ effort: e as AgentStep['effort'] })}
            data={['low', 'medium', 'high', 'xhigh', 'max']}
          />
        </Input.Wrapper>
      </SimpleGrid>
      <Textarea
        label="Instructions (system prompt)"
        description="Who the model is and how to judge, e.g. your platform rules"
        autosize
        minRows={3}
        value={step.system ?? ''}
        onChange={(e) => onChange({ system: e.currentTarget.value || undefined })}
      />
      <Textarea
        label="Prompt"
        withAsterisk
        description="The task, with the request details as templates"
        autosize
        minRows={4}
        value={step.prompt}
        onChange={(e) => onChange({ prompt: e.currentTarget.value })}
        styles={MONO_INPUT}
      />
      <Checkbox
        label="Can look things up in the catalog (read-only: list blueprints, search entities, get an entity)"
        checked={step.tools?.includes('catalog') ?? false}
        onChange={(e) => onChange({ tools: e.currentTarget.checked ? ['catalog'] : [] })}
      />
      <Switch
        label="Structured output"
        description="Claude returns JSON with the fields below (validated), usable in conditions and later steps"
        checked={!!step.output}
        onChange={(e) => {
          if (e.currentTarget.checked) {
            const initial = fields.length ? fields : schemaToFields({ properties: { summary: { type: 'string', title: 'Summary' } }, required: ['summary'] });
            setFields(initial);
            onChange({ output: fieldsToSchema(initial) as ObjectSchema });
          } else onChange({ output: undefined });
        }}
      />
      {step.output && (
        <FieldsEditor
          fields={fields}
          mode={mode}
          onChange={(f) => {
            setFields(f);
            onChange({ output: fieldsToSchema(f) });
          }}
        />
      )}
      <Accordion variant="contained" radius="lg">
        <Accordion.Item value="advanced">
          <Accordion.Control>Advanced</Accordion.Control>
          <Accordion.Panel>
            <SimpleGrid cols={{ base: 1, sm: 3 }}>
              <NumberInput label="Max tool turns" min={1} max={20} value={step.maxTurns ?? 6} onChange={(n) => onChange({ maxTurns: Number(n) || 6 })} />
              <NumberInput
                label="Max output tokens"
                min={256}
                max={64000}
                step={1000}
                value={step.maxTokens ?? 16000}
                onChange={(n) => onChange({ maxTokens: Number(n) || 16000 })}
              />
              <TextInput
                label="API key"
                placeholder="${secret:ANTHROPIC_TEAM_KEY}"
                description="Default: the platform key"
                value={step.apiKey ?? ''}
                onChange={(e) => onChange({ apiKey: e.currentTarget.value || undefined })}
                styles={MONO_INPUT}
              />
            </SimpleGrid>
          </Accordion.Panel>
        </Accordion.Item>
      </Accordion>
    </Stack>
  );
}

function TransformEditor({ step, onChange }: { step: TransformStep; onChange: (p: Partial<TransformStep>) => void }) {
  return (
    <Input.Wrapper label="Output values" description='Key → JSONata expression, e.g. tier → steps.review.output.risk = "high" ? "premium" : "standard"'>
      <KeyValueEditor
        value={step.output}
        onChange={(o) => onChange({ output: o as Record<string, string> })}
        keyPlaceholder="key"
        valuePlaceholder="JSONata expression"
      />
    </Input.Wrapper>
  );
}

/** Dependencies, condition, retries, timeout, error handling. */
function FlowEditor({ steps, index, onChange }: { steps: WorkflowStep[]; index: number; onChange: (p: Partial<WorkflowStep>) => void }) {
  const step = steps[index];
  const earlier = steps.slice(0, index).map((s) => ({ value: s.id, label: s.name ? `${s.name} (${s.id})` : s.id }));
  const mode = step.needs === undefined ? 'previous' : step.needs.length ? 'custom' : 'start';
  return (
    <Accordion variant="contained" radius="lg" defaultValue={step.if || step.needs ? 'flow' : null}>
      <Accordion.Item value="flow">
        <Accordion.Control>
          Flow · conditions, retries, timeout
          {step.if && (
            <Badge ml="xs" size="xs" color="gray">
              if
            </Badge>
          )}
        </Accordion.Control>
        <Accordion.Panel>
          <Stack gap="sm">
            <Input.Wrapper label="Runs after">
              <SegmentedControl
                fullWidth
                value={mode}
                onChange={(m) => onChange({ needs: m === 'previous' ? undefined : m === 'start' ? [] : needsOf(steps, index) })}
                data={[
                  { value: 'previous', label: 'The previous step' },
                  { value: 'start', label: 'Start of the workflow (parallel)' },
                  { value: 'custom', label: 'Chosen steps', disabled: index === 0 },
                ]}
              />
            </Input.Wrapper>
            {mode === 'custom' && (
              <MultiSelect data={earlier} value={step.needs ?? []} onChange={(n) => onChange({ needs: n })} placeholder="Steps to wait for" />
            )}
            <TextInput
              label="Run only if"
              description='JSONata condition; skipped when false. E.g. steps.review.output.risk != "low"'
              placeholder="always"
              value={step.if ?? ''}
              onChange={(e) => onChange({ if: e.currentTarget.value || undefined })}
              styles={MONO_INPUT}
            />
            <SimpleGrid cols={{ base: 1, sm: 3 }}>
              <NumberInput
                label="Retries"
                min={0}
                max={10}
                value={step.retries ?? 0}
                onChange={(n) => onChange({ retries: Number(n) || 0 })}
                disabled={step.type === 'approval'}
              />
              <NumberInput
                label="Retry delay (s)"
                description="Doubles at each attempt"
                min={1}
                max={3600}
                value={step.retryDelaySeconds ?? 30}
                onChange={(n) => onChange({ retryDelaySeconds: Number(n) || 30 })}
                disabled={!step.retries}
              />
              <NumberInput
                label="Timeout (minutes)"
                placeholder={step.type === 'approval' ? '7 days' : 'platform default'}
                min={1}
                value={step.timeoutMinutes ?? ''}
                onChange={(n) => onChange({ timeoutMinutes: n === '' ? undefined : Number(n) })}
              />
            </SimpleGrid>
            <Switch
              label="Continue if this step fails"
              description="The workflow still succeeds and later steps run; use for best-effort steps (notifications, AI hints)"
              checked={!!step.continueOnError}
              onChange={(e) => onChange({ continueOnError: e.currentTarget.checked || undefined })}
            />
          </Stack>
        </Accordion.Panel>
      </Accordion.Item>
    </Accordion>
  );
}
