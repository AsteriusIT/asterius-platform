import { useMemo, useState } from 'react';
import {
  Accordion,
  ActionIcon,
  Alert,
  Badge,
  Code,
  Button,
  Group,
  Input,
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
  Title,
} from '@mantine/core';
import { modals } from '@mantine/modals';
import { useQuery } from '@tanstack/react-query';
import { IconPlus, IconRobot, IconTrash } from '@tabler/icons-react';
import type {
  AgentMcpServer,
  AgentStep,
  InputStep,
  WaitStep,
  WorkflowCallStep,
  AgentTool,
  ApprovalStep,
  InvokeStep,
  InlineForEach,
  InvokerConfig,
  ObjectSchema,
  PluginInfo,
  SwitchStep,
  TransformStep,
  WorkflowStep,
  WorkflowStepType,
} from '@asterius/shared';
import { api } from '../../lib/api';
import { caseOptions, needsOf } from '../../lib/workflow';
import { fieldProblems, fieldsToSchema, nameFromLabel, schemaToFields, type FieldDraft } from './fields';
import { FieldsEditor, type FieldsMode } from './FieldsEditor';
import { ExpressionStatus } from './ExpressionTools';
import { JsonEditor, KeyValueEditor, MONO_INPUT, PluginFieldInput, SubjectsEditor, VariableChips } from './blocks';

/**
 * Settings of the workflow steps, shown in the editor page's dialogs (pages/admin/WorkflowFlow.tsx): per type
 * (integration, approval, AI agent, transform, wait, input, sub-workflow), then condition, dependencies, retries and
 * timeout. Also the helpers to create a step and to list a workflow's problems before saving.
 */

const SAMPLE_CONTEXT = { inputs: {}, entity: null, steps: {} };
const STEP_ID = /^[A-Za-z_][A-Za-z0-9_]{0,40}$/;
/** Offline fallback; the real list (with prices) comes from /api/meta. */
export const AGENT_MODELS = [{ value: 'claude-opus-5-5', label: 'Claude Opus 5.5', description: 'Default' }];
const priceText = (m: { inputPrice?: number; outputPrice?: number }) =>
  m.inputPrice !== undefined ? ` · $${m.inputPrice} / $${m.outputPrice} per M tokens` : '';

function uniqueId(base: string, steps: WorkflowStep[]) {
  const clean = nameFromLabel(base) || 'step';
  let id = clean;
  for (let n = 2; steps.some((s) => s.id === id); n++) id = `${clean}${n}`;
  return id;
}

export function newStep(type: WorkflowStepType, steps: WorkflowStep[], invokers: PluginInfo[]): WorkflowStep {
  const name = {
    invoke: 'Call an integration',
    approval: 'Approval',
    agent: 'AI review',
    transform: 'Compute values',
    wait: 'Wait',
    input: 'Ask for input',
    workflow: 'Run a workflow',
    switch: 'Branch',
  }[type];
  const id = uniqueId(
    { invoke: 'call', approval: 'approval', agent: 'review', transform: 'compute', wait: 'wait', input: 'ask', workflow: 'sub', switch: 'route' }[type],
    steps,
  );
  if (type === 'invoke') {
    const example = invokers.find((i) => i.type === 'webhook')?.example ?? { type: 'webhook' };
    return { id, name, type, invoker: example as InvokerConfig };
  }
  if (type === 'approval') return { id, name, type, minApprovals: 1 };
  if (type === 'agent') return { id, name, type, model: 'claude-opus-5-5', effort: 'medium', prompt: '', tools: [] };
  if (type === 'wait') return { id, name, type, duration: '15m' };
  if (type === 'input') return { id, name, type, inputs: { properties: {} } };
  if (type === 'workflow') return { id, name, type, action: '', inputs: {} };
  if (type === 'switch') return { id, name, type, cases: [{ id: 'yes', when: 'true' }], default: 'no' };
  return { id, name, type: 'transform', output: {} };
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
      if (s.tools?.includes('upsert_entity') && !s.guardrails?.entityBlueprints?.length) out.push(`${where}: list the blueprints the agent may write`);
      if (s.tools?.includes('trigger_action') && !s.guardrails?.actions?.length) out.push(`${where}: list the actions the agent may start`);
      if (s.tools?.includes('http') && !s.guardrails?.httpHosts?.length) out.push(`${where}: list the hosts the agent may call`);
      for (const m of s.mcpServers ?? []) if (!m.name || !m.url.startsWith('https://')) out.push(`${where}: MCP servers need a name and an https:// URL`);
    }
    if (s.type === 'wait' && [s.duration, s.until, s.event].filter(Boolean).length !== 1) out.push(`${where}: set exactly one of duration, until or event`);
    if (s.type === 'workflow' && !s.action) out.push(`${where}: choose the workflow to run`);
    if (s.type === 'input') out.push(...fieldProblems(schemaToFields(s.inputs), `${where}: field`));
    if (s.type === 'transform')
      for (const k of Object.keys(s.output ?? {})) if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) out.push(`${where}: invalid output key "${k}"`);
    if (s.type === 'switch' && !s.cases?.length) out.push(`${where}: add at least one case`);
    if (s.when === 'failure' && !needsOf(steps, i).length) out.push(`${where}: "on failure" needs a step to watch`);
    const options = caseOptions(steps, i);
    for (const c of s.case === undefined ? [] : Array.isArray(s.case) ? s.case : [s.case])
      if (!options.includes(c)) out.push(`${where}: unknown branch "${c}"`);
    if ('forEach' in s && s.forEach && s.type !== 'workflow' && s.retries) out.push(`${where}: retries cannot be combined with "for each"`);
  });
  return out;
}

/** Settings of one step: name and id, the variables it can use, its type's settings, then condition, dependencies and retries. */
export function StepSettings({
  steps,
  index,
  invokers,
  inputFields,
  blueprint: triggerBlueprint,
  onEntity,
  warnings,
  update,
}: {
  steps: WorkflowStep[];
  index: number;
  invokers: PluginInfo[];
  inputFields: FieldDraft[];
  blueprint: string | null;
  onEntity: boolean;
  warnings: string[];
  update: (patch: Partial<WorkflowStep>) => void;
}) {
  const step = steps[index]!;
  return (
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
      <Variables steps={steps} index={index} inputFields={inputFields} blueprint={triggerBlueprint} onEntity={onEntity} />
      {step.type === 'invoke' && <InvokeEditor step={step} invokers={invokers} onChange={update} />}
      {step.type === 'approval' && <ApprovalEditor step={step} onEntity={onEntity} onChange={update} />}
      {step.type === 'agent' && <AgentEditor step={step} onChange={update} />}
      {step.type === 'transform' && <TransformEditor step={step} onChange={update} />}
      {step.type === 'wait' && <WaitEditor step={step} onChange={update} />}
      {step.type === 'input' && <InputEditor step={step} onChange={update} />}
      {step.type === 'workflow' && <WorkflowCallEditor step={step} onChange={update} />}
      {step.type === 'switch' && <SwitchEditor step={step} onChange={update} />}
      {(step.type === 'invoke' || step.type === 'agent' || step.type === 'transform') && (
        <LoopEditor value={step.forEach} parallel={step.type === 'agent'} onChange={(forEach) => update({ forEach })} />
      )}
      {warnings
        .filter((w) => w.startsWith(`Step "${step.name || step.id}"`))
        .map((w) => (
          <Alert key={w} color="yellow" variant="light" title="Review the AI output before acting on it">
            {w}
          </Alert>
        ))}
      <FlowEditor steps={steps} index={index} onChange={update} />
    </Stack>
  );
}

/** `patch` applied to the step at `index`; renaming its id keeps the dependencies pointing at it. */
export function patchStep(steps: WorkflowStep[], index: number, patch: Partial<WorkflowStep>): WorkflowStep[] {
  const old = steps[index]!;
  const next = steps.map((s, i) => (i === index ? ({ ...s, ...patch } as WorkflowStep) : s));
  if (patch.id && patch.id !== old.id)
    for (const s of next) {
      if (s.needs) s.needs = s.needs.map((n) => (n === old.id ? patch.id! : n));
      // Branches name their switch: `<switch>.<case>`.
      const rename = (c: string) => (c.startsWith(`${old.id}.`) ? `${patch.id}${c.slice(old.id.length)}` : c);
      if (s.case !== undefined) s.case = Array.isArray(s.case) ? s.case.map(rename) : rename(s.case);
    }
  return next;
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
      if (s.type === 'approval') return [`steps.${s.id}.output.approved`, `steps.${s.id}.output.by`, `steps.${s.id}.output.choice`];
      if (s.type === 'input') return Object.keys(s.inputs?.properties ?? {}).map((k) => `steps.${s.id}.output.${k}`);
      if (s.type === 'workflow') return [`steps.${s.id}.output.result`, `steps.${s.id}.output.status`];
      if (s.type === 'switch') return [`steps.${s.id}.output.case`];
      return [`steps.${s.id}.output`, `steps.${s.id}.link`];
    });
    const current = steps[index];
    const loop = current && 'forEach' in current && current.forEach ? ['item', 'index'] : [];
    return [
      ...inputFields.filter((f) => f.name).map((f) => `inputs.${f.name}`),
      ...(onEntity
        ? ['entity.identifier', 'entity.title', 'entity.team', ...Object.keys(bp.data?.schema.properties ?? {}).map((p) => `entity.properties.${p}`)]
        : []),
      ...loop,
      ...earlier,
      'vars.<name>',
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

function WaitEditor({ step, onChange }: { step: WaitStep; onChange: (p: Partial<WaitStep>) => void }) {
  const mode = step.event ? 'event' : step.until === undefined ? 'duration' : 'until';
  return (
    <Stack gap="sm">
      <SegmentedControl
        value={mode}
        data={[
          { value: 'duration', label: 'For a duration' },
          { value: 'until', label: 'Until a time' },
          { value: 'event', label: 'For an event' },
        ]}
        onChange={(m) =>
          onChange({
            duration: m === 'duration' ? '15m' : undefined,
            until: m === 'until' ? '{{ inputs.when }}' : undefined,
            event: m === 'event' ? { name: 'ready' } : undefined,
          })
        }
      />
      {mode === 'duration' && (
        <TextInput
          label="Duration"
          description="30s, 15m, 2h or 7d"
          w={200}
          value={step.duration ?? ''}
          onChange={(e) => onChange({ duration: e.currentTarget.value })}
        />
      )}
      {mode === 'until' && (
        <TextInput
          label="Until"
          description="ISO date-time template, e.g. {{ inputs.window }}"
          value={step.until ?? ''}
          onChange={(e) => onChange({ until: e.currentTarget.value })}
          styles={MONO_INPUT}
        />
      )}
      {mode === 'event' && (
        <>
          <TextInput
            label="Event name"
            description={
              <>
                Post it to <code>/api/v1/runs/&lt;run&gt;/steps/{step.id}/events</code> with the step token (
                <code>{`{{ steps.${step.id}.events.token }}`}</code>) or an admin token
              </>
            }
            value={step.event?.name ?? ''}
            onChange={(e) => onChange({ event: { ...step.event, name: e.currentTarget.value } })}
          />
          <TextInput
            label="Payload filter (optional)"
            description='JSONata over the payload, e.g. event.env = "prod"'
            value={step.event?.filter ?? ''}
            onChange={(e) => onChange({ event: { name: step.event?.name ?? '', filter: e.currentTarget.value || undefined } })}
            styles={MONO_INPUT}
          />
        </>
      )}
      <Text fz="xs" c="dimmed">
        Use the timeout under Flow to bound how long the step may wait (default 7 days).
      </Text>
    </Stack>
  );
}

function InputEditor({ step, onChange }: { step: InputStep; onChange: (p: Partial<InputStep>) => void }) {
  const [fields, setFields] = useState<FieldDraft[]>(() => schemaToFields(step.inputs));
  return (
    <Stack gap="sm">
      <Textarea
        label="Message"
        description="Markdown template shown above the form"
        autosize
        minRows={2}
        value={step.message ?? ''}
        onChange={(e) => onChange({ message: e.currentTarget.value || undefined })}
        styles={MONO_INPUT}
      />
      <Title order={6}>Who answers</Title>
      <SubjectsEditor value={step.assignees} onChange={(assignees) => onChange({ assignees })} allowOwnerTeam emptyMeans="the requester and admins" />
      <Title order={6}>Form</Title>
      <FieldsEditor
        fields={fields}
        onChange={(f) => {
          setFields(f);
          onChange({ inputs: fieldsToSchema(f) });
        }}
      />
    </Stack>
  );
}

function WorkflowCallEditor({ step, onChange }: { step: WorkflowCallStep; onChange: (p: Partial<WorkflowCallStep>) => void }) {
  const actions = useQuery({ queryKey: ['actions', 'all'], queryFn: () => api.actions() });
  return (
    <Stack gap="sm">
      <Select
        label="Workflow to run"
        searchable
        data={(actions.data ?? []).map((a) => ({ value: a.identifier, label: `${a.title} (${a.identifier})` }))}
        value={step.action || null}
        onChange={(v) => onChange({ action: v ?? '' })}
      />
      <Input.Wrapper label="Inputs" description="Values for the child form; templates may use inputs.*, steps.* and, in a fan-out, item">
        <KeyValueEditor
          value={(step.inputs ?? {}) as Record<string, string>}
          onChange={(o) => onChange({ inputs: o })}
          keyPlaceholder="input"
          valuePlaceholder="value or {{ template }}"
        />
      </Input.Wrapper>
      <TextInput
        label="Entity (day-2 workflows)"
        value={step.entity ?? ''}
        placeholder="{{ entity.identifier }}"
        onChange={(e) => onChange({ entity: e.currentTarget.value || undefined })}
        styles={MONO_INPUT}
      />
      <Switch
        label="Run once for each item of a list"
        checked={!!step.forEach}
        onChange={(e) => onChange({ forEach: e.currentTarget.checked ? { items: 'inputs.items', maxConcurrency: 3 } : undefined })}
      />
      {step.forEach && (
        <SimpleGrid cols={{ base: 1, sm: 3 }}>
          <TextInput
            label="List (JSONata)"
            value={step.forEach.items}
            onChange={(e) => onChange({ forEach: { ...step.forEach!, items: e.currentTarget.value } })}
            styles={MONO_INPUT}
          />
          <NumberInput
            label="At most in parallel"
            min={1}
            max={20}
            value={step.forEach.maxConcurrency ?? 3}
            onChange={(n) => onChange({ forEach: { ...step.forEach!, maxConcurrency: Number(n) || 3 } })}
          />
          <Switch
            mt={28}
            label="Stop at the first failure"
            checked={!!step.forEach.failFast}
            onChange={(e) => onChange({ forEach: { ...step.forEach!, failFast: e.currentTarget.checked } })}
          />
        </SimpleGrid>
      )}
    </Stack>
  );
}

/** Cases of a switch, in order (case id → JSONata condition), and the default case. */
function SwitchEditor({ step, onChange }: { step: SwitchStep; onChange: (p: Partial<SwitchStep>) => void }) {
  return (
    <Stack gap="sm">
      <Input.Wrapper
        label="Cases"
        description={
          <>
            Case id → JSONata condition, checked in order: the first true one is taken (<code>{`steps.${step.id}.output.case`}</code>). Steps join a branch with{' '}
            <code>{`case: ${step.id}.<case>`}</code> in their flow settings.
          </>
        }
      >
        <KeyValueEditor
          value={Object.fromEntries(step.cases.map((c) => [c.id, c.when]))}
          onChange={(o) => onChange({ cases: Object.entries(o).map(([id, when]) => ({ id, when: String(when) })) })}
          keyPlaceholder="case id"
          valuePlaceholder='JSONata, e.g. inputs.env = "prod"'
        />
      </Input.Wrapper>
      <TextInput
        label="Default case"
        description="Taken when no condition holds (empty: no branch runs)"
        placeholder="none"
        value={step.default ?? ''}
        onChange={(e) => onChange({ default: e.currentTarget.value || undefined })}
        styles={MONO_INPUT}
      />
    </Stack>
  );
}

/** Inline loop of integration, AI and transform steps (no child runs). */
function LoopEditor({ value, parallel, onChange }: { value?: InlineForEach; parallel: boolean; onChange: (v: InlineForEach | undefined) => void }) {
  return (
    <Stack gap="sm">
      <Switch
        label="Run for each item of a list"
        description={`item and index in the templates; output { results: [{ item, status, output }], succeeded, failed }${parallel ? '' : '. Items run one at a time'}`}
        checked={!!value}
        onChange={(e) => onChange(e.currentTarget.checked ? { items: 'inputs.items', maxConcurrency: 1 } : undefined)}
      />
      {value && (
        <SimpleGrid cols={{ base: 1, sm: 3 }}>
          <TextInput label="List (JSONata)" value={value.items} onChange={(e) => onChange({ ...value, items: e.currentTarget.value })} styles={MONO_INPUT} />
          {parallel ? (
            <NumberInput
              label="At most in parallel"
              min={1}
              max={20}
              value={value.maxConcurrency ?? 1}
              onChange={(n) => onChange({ ...value, maxConcurrency: Number(n) || 1 })}
            />
          ) : (
            <div />
          )}
          <Switch
            mt={28}
            label="Stop at the first failure"
            checked={!!value.failFast}
            onChange={(e) => onChange({ ...value, failFast: e.currentTarget.checked })}
          />
        </SimpleGrid>
      )}
    </Stack>
  );
}

function AgentEditor({ step, onChange }: { step: AgentStep; onChange: (p: Partial<AgentStep>) => void }) {
  const meta = useQuery({ queryKey: ['meta'], queryFn: api.meta, staleTime: Infinity });
  const models: { value: string; label: string; description: string; inputPrice?: number; outputPrice?: number }[] = meta.data?.models ?? AGENT_MODELS;
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
          data={models.map((m) => ({ value: m.value, label: m.label }))}
          value={step.model ?? 'claude-opus-5-5'}
          onChange={(m) => onChange({ model: m ?? undefined })}
          description={(() => {
            const m = models.find((x) => x.value === (step.model ?? 'claude-opus-5-5'));
            return m ? `${m.description}${priceText(m)}` : undefined;
          })()}
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
      <MultiSelect
        label="Tools"
        description="Look-ups are read-only. Write tools act as the user who started the run, inside the allow-lists below, and every write is audited."
        data={AGENT_TOOL_OPTIONS}
        value={step.tools ?? []}
        onChange={(t) => onChange({ tools: t as AgentTool[] })}
      />
      {(step.tools ?? []).includes('upsert_entity') && (
        <TagsInput
          label="Blueprints the agent may write"
          withAsterisk
          value={step.guardrails?.entityBlueprints ?? []}
          onChange={(v) => onChange({ guardrails: { ...step.guardrails, entityBlueprints: v } })}
        />
      )}
      {(step.tools ?? []).includes('trigger_action') && (
        <TagsInput
          label="Actions the agent may start"
          withAsterisk
          value={step.guardrails?.actions ?? []}
          onChange={(v) => onChange({ guardrails: { ...step.guardrails, actions: v } })}
        />
      )}
      {(step.tools ?? []).includes('http') && (
        <SimpleGrid cols={{ base: 1, sm: 2 }}>
          <TagsInput
            label="Hosts the agent may call"
            withAsterisk
            description="host or host:port; redirects are not followed"
            value={step.guardrails?.httpHosts ?? []}
            onChange={(v) => onChange({ guardrails: { ...step.guardrails, httpHosts: v } })}
          />
          <MultiSelect
            label="HTTP methods"
            data={['GET', 'POST', 'PUT', 'PATCH', 'DELETE']}
            value={step.guardrails?.httpMethods ?? ['GET']}
            onChange={(v) => onChange({ guardrails: { ...step.guardrails, httpMethods: v as NonNullable<AgentStep['guardrails']>['httpMethods'] } })}
          />
        </SimpleGrid>
      )}
      <McpServersEditor value={step.mcpServers ?? []} onChange={(mcpServers) => onChange({ mcpServers })} />
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
                description="Default: the team key (secret anthropic-api-key-<team>), then the platform key"
                value={step.apiKey ?? ''}
                onChange={(e) => onChange({ apiKey: e.currentTarget.value || undefined })}
                styles={MONO_INPUT}
              />
              <NumberInput
                label="Run AI budget ($)"
                description="Stop AI calls once the run has spent this much"
                min={0}
                decimalScale={2}
                value={step.maxCostUsd ?? ''}
                onChange={(n) => onChange({ maxCostUsd: n === '' ? undefined : Number(n) })}
              />
              <Select
                label="Provider"
                description="Where Claude runs"
                clearable
                placeholder="Platform default"
                data={[
                  { value: 'anthropic', label: 'Anthropic API' },
                  { value: 'bedrock', label: 'Amazon Bedrock' },
                  { value: 'vertex', label: 'Google Vertex AI' },
                ]}
                value={step.provider ?? null}
                onChange={(p) => onChange({ provider: (p as AgentStep['provider']) ?? undefined })}
              />
            </SimpleGrid>
          </Accordion.Panel>
        </Accordion.Item>
      </Accordion>
    </Stack>
  );
}

const AGENT_TOOL_OPTIONS = [
  { value: 'catalog', label: 'Catalog look-ups (read-only)' },
  { value: 'upsert_entity', label: 'Create or update catalog entities' },
  { value: 'trigger_action', label: 'Start self-service actions' },
  { value: 'http', label: 'Call HTTP APIs (allow-listed hosts)' },
];

/** Remote MCP servers the model may use (the Claude API connects to them, so they must be public HTTPS endpoints). */
function McpServersEditor({ value, onChange }: { value: AgentMcpServer[]; onChange: (v: AgentMcpServer[]) => void }) {
  const set = (i: number, patch: Partial<AgentMcpServer>) => onChange(value.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  return (
    <Input.Wrapper
      label="MCP servers"
      description="Give the model the tools of remote Model Context Protocol servers (HTTPS). The token is a secret reference."
    >
      <Stack gap="xs" mt={4}>
        {value.map((s, i) => (
          <SimpleGrid key={i} cols={{ base: 1, sm: 4 }} style={{ alignItems: 'flex-end' }}>
            <TextInput
              placeholder="name"
              aria-label="MCP server name"
              value={s.name}
              onChange={(e) => set(i, { name: e.currentTarget.value })}
              styles={MONO_INPUT}
            />
            <TextInput
              placeholder="https://mcp.example.com/mcp"
              aria-label="MCP server URL"
              value={s.url}
              onChange={(e) => set(i, { url: e.currentTarget.value })}
            />
            <TextInput
              placeholder="${secret:MCP_TOKEN}"
              aria-label="MCP server token"
              value={s.token ?? ''}
              onChange={(e) => set(i, { token: e.currentTarget.value || undefined })}
              styles={MONO_INPUT}
            />
            <Group gap="xs" wrap="nowrap">
              <TagsInput
                placeholder="allowed tools (all)"
                aria-label="Allowed MCP tools"
                value={s.allowedTools ?? []}
                onChange={(v) => set(i, { allowedTools: v.length ? v : undefined })}
                style={{ flex: 1 }}
              />
              <ActionIcon variant="subtle" color="red" aria-label="Remove MCP server" onClick={() => onChange(value.filter((_, j) => j !== i))}>
                <IconTrash size={16} />
              </ActionIcon>
            </Group>
          </SimpleGrid>
        ))}
        <div>
          <Button size="xs" variant="default" leftSection={<IconPlus size={14} />} onClick={() => onChange([...value, { name: '', url: 'https://' }])}>
            Add MCP server
          </Button>
        </div>
      </Stack>
    </Input.Wrapper>
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
      <Stack gap={2} mt="xs">
        {Object.entries(step.output).map(([k, expr]) => (
          <Group key={k} gap="xs" align="flex-start" wrap="nowrap">
            <Code fz="xs">{k}</Code>
            <ExpressionStatus expression={expr} context={SAMPLE_CONTEXT} />
          </Group>
        ))}
      </Stack>
    </Input.Wrapper>
  );
}

/** Dependencies, condition, retries, timeout, error handling. */
function FlowEditor({ steps, index, onChange }: { steps: WorkflowStep[]; index: number; onChange: (p: Partial<WorkflowStep>) => void }) {
  const step = steps[index];
  const earlier = steps.slice(0, index).map((s) => ({ value: s.id, label: s.name ? `${s.name} (${s.id})` : s.id }));
  const mode = step.needs === undefined ? 'previous' : step.needs.length ? 'custom' : 'start';
  const branches = caseOptions(steps, index);
  const cases = step.case === undefined ? [] : Array.isArray(step.case) ? step.case : [step.case];
  const looping = 'forEach' in step && !!step.forEach && step.type !== 'workflow';
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
            <ExpressionStatus expression={step.if ?? ''} context={SAMPLE_CONTEXT} />
            <Input.Wrapper
              label="Run when"
              description="After its dependencies succeeded (default), only when one of them failed (fallback, compensation: it recovers the workflow when it succeeds), or always (cleanup)"
            >
              <SegmentedControl
                fullWidth
                value={step.when ?? 'success'}
                onChange={(w) => onChange({ when: w === 'success' ? undefined : (w as WorkflowStep['when']) })}
                data={[
                  { value: 'success', label: 'They succeeded' },
                  { value: 'failure', label: 'One failed', disabled: index === 0 && !step.needs?.length },
                  { value: 'always', label: 'Always' },
                ]}
              />
            </Input.Wrapper>
            {(branches.length > 0 || cases.length > 0) && (
              <MultiSelect
                label="Branch"
                description="Runs only when one of these switch cases is taken (skipped otherwise); the switch must run before this step"
                placeholder="every branch"
                data={[...new Set([...branches, ...cases])]}
                value={cases}
                onChange={(c) => onChange({ case: c.length ? (c.length === 1 ? c[0] : c) : undefined })}
              />
            )}
            <SimpleGrid cols={{ base: 1, sm: 3 }}>
              <NumberInput
                label="Retries"
                min={0}
                max={10}
                value={step.retries ?? 0}
                onChange={(n) => onChange({ retries: Number(n) || 0 })}
                disabled={step.type === 'approval' || step.type === 'switch' || looping}
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
            <Select
              label="On timeout"
              data={[
                { value: 'fail', label: 'Fail the step' },
                { value: 'skip', label: 'Skip the step (the workflow continues)' },
                { value: 'continue', label: 'Fail the step, but continue the workflow' },
              ]}
              value={step.onTimeout ?? 'fail'}
              onChange={(v) => onChange({ onTimeout: !v || v === 'fail' ? undefined : (v as WorkflowStep['onTimeout']) })}
            />
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
