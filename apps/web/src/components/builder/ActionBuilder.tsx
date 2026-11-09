import { useState } from 'react';
import { Modal, NumberInput, Select, SimpleGrid, Stack, Switch, Text, Textarea, TextInput } from '@mantine/core';
import { useNavigate } from 'react-router';
import type { ActionTrigger, FormTrigger, InvokerConfig, ObjectSchema, PluginInfo, RunConcurrency, WorkflowStep, WorkflowTrigger } from '@asterius/shared';
import { IconPicker } from '../IconPicker';
import { fieldProblems, type FieldDraft } from './fields';
import { MONO_INPUT } from './blocks';
import { stepProblems } from './WorkflowEditor';
import { isFormLike } from './TriggerEditor';
import { BuilderFooter, slugify, useSave } from './shell';

export { slugify };

/**
 * A self-service workflow: a trigger (a form submission, an API call, a schedule…) followed by steps. This module
 * holds the document helpers shared with the editor page (pages/admin/WorkflowFlow.tsx) and the "New workflow"
 * dialog: creating one only asks for the general settings, the trigger and the steps are then built on the graph.
 * The document is exactly what PUT /api/v1/actions/:id and the configuration files accept.
 */

export interface ActionDoc {
  identifier: string;
  title: string;
  description?: string;
  icon?: string | null;
  trigger: WorkflowTrigger | null;
  steps: WorkflowStep[];
  enabled: boolean;
  [k: string]: unknown;
}

const SLUG = /^[a-z][a-z0-9_-]{0,63}$/;
const LEGACY_KEYS = ['blueprint', 'inputs', 'allowed', 'approval'];

/** Accepts the current form, the flat (legacy) form and single-invoker actions (opened as a one-step workflow). */
export function toActionDoc(input: Record<string, unknown>): ActionDoc {
  const { invoker, ...v } = input;
  const steps =
    (v.steps as WorkflowStep[] | undefined) ??
    (invoker ? [{ id: 'run', name: String(v.title ?? 'Run'), type: 'invoke' as const, invoker: invoker as InvokerConfig }] : []);
  let trigger: WorkflowTrigger | null = null;
  const other = (v.trigger as { type?: string } | undefined)?.type;
  if (other && other !== 'form') {
    trigger = v.trigger as WorkflowTrigger; // api (form-like fields), schedule, event, webhook: edited as they are
  } else if (v.trigger && typeof v.trigger === 'object') {
    const t = v.trigger as Partial<FormTrigger>;
    trigger = {
      type: 'form',
      on: t.on ?? 'create',
      blueprint: t.blueprint ?? null,
      inputs: t.inputs ?? { properties: {} },
      allowed: t.allowed ?? {},
      approval: t.approval ?? { required: false },
    };
  } else if (typeof v.trigger === 'string' || invoker || LEGACY_KEYS.some((k) => k in v)) {
    trigger = {
      type: 'form',
      on: (v.trigger as ActionTrigger) ?? 'create',
      blueprint: (v.blueprint as string) ?? null,
      inputs: (v.inputs as ObjectSchema) ?? { properties: {} },
      allowed: (v.allowed as FormTrigger['allowed']) ?? {},
      approval: (v.approval as FormTrigger['approval']) ?? { required: false },
    };
  }
  const rest = Object.fromEntries(Object.entries(v).filter(([k]) => !LEGACY_KEYS.includes(k)));
  return {
    ...rest,
    identifier: String(v.identifier ?? ''),
    title: String(v.title ?? ''),
    description: (v.description as string) ?? '',
    icon: (v.icon as string) ?? null,
    trigger,
    steps,
    enabled: v.enabled !== false,
  };
}

/** Problems found before calling the server (which validates everything again). A workflow may be saved unfinished. */
export function docProblems(doc: ActionDoc, fields: FieldDraft[], invokers: PluginInfo[]): string[] {
  const out: string[] = [];
  if (!SLUG.test(doc.identifier)) out.push('Identifier: lowercase letters, digits, - and _, starting with a letter');
  if (!doc.title.trim()) out.push('Title is required');
  if (isFormLike(doc.trigger)) {
    if (doc.trigger.on !== 'create' && !doc.trigger.blueprint) out.push('Trigger: forms on an entity need a blueprint');
    out.push(...fieldProblems(fields, 'Trigger: form field'));
  }
  if (doc.trigger?.type === 'schedule' && doc.trigger.cron.trim().split(/\s+/).length !== 5) out.push('Trigger: a cron expression has five fields');
  out.push(...stepProblems(doc.steps, invokers));
  return out;
}

type EditorProps = {
  value: Record<string, unknown> | null;
  isNew: boolean;
  readOnly?: boolean;
  onSave: (identifier: string, body: Record<string, unknown>) => Promise<unknown>;
  onClose: () => void;
};

/**
 * New workflow: a small dialog with the general settings only; once created, the workflow opens in the editor page
 * (/admin/actions/:id), where the trigger and the steps are built on the graph. Existing workflows open there directly.
 */
export function ActionBuilder(props: EditorProps) {
  const navigate = useNavigate();
  return (
    <CreateAction
      value={props.value}
      onClose={props.onClose}
      onCreate={async (id, body) => {
        await props.onSave(id, body);
        props.onClose();
        void navigate(`/admin/actions/${encodeURIComponent(id)}`);
      }}
    />
  );
}

/** Step 1 of a new workflow: what it is called and how it looks. The trigger and the steps come next, in the editor. */
function CreateAction({
  value,
  onCreate,
  onClose,
}: {
  value: Record<string, unknown> | null;
  onCreate: (identifier: string, body: Record<string, unknown>) => Promise<void>;
  onClose: () => void;
}) {
  const [doc, setDoc] = useState(() => ({ identifier: '', title: '', description: '', icon: null as string | null }));
  const [idTouched, setIdTouched] = useState(false);
  const saver = useSave(
    () => onCreate(doc.identifier, { ...doc, enabled: true, trigger: null, steps: [] }),
    () => undefined, // the editor opens on the created workflow
  );
  const problems = () => {
    const out: string[] = [];
    if (!doc.title.trim()) out.push('Title is required');
    if (!SLUG.test(doc.identifier)) out.push('Identifier: lowercase letters, digits, - and _, starting with a letter');
    return out;
  };
  return (
    <Modal opened={!!value} onClose={onClose} title={<Text fw={600}>New workflow</Text>} size="lg">
      <Stack>
        <GeneralFields doc={doc} isNew onChange={(patch) => setDoc((d) => ({ ...d, ...patch }))} idTouched={idTouched} onIdTouched={() => setIdTouched(true)} />
        <Text fz="xs" c="dimmed">
          Next: add its trigger (the form users submit) and its steps, one by one.
        </Text>
        <BuilderFooter
          problems={saver.problems}
          saving={saver.saving}
          saveLabel="Create and add steps"
          onSave={() => void saver.save(problems())}
          onClose={onClose}
        />
      </Stack>
    </Modal>
  );
}

const CONCURRENCY_MODES: { value: RunConcurrency['mode']; label: string }[] = [
  { value: 'queue', label: 'Queue: extra runs wait for a free slot' },
  { value: 'cancel-in-progress', label: 'Cancel in progress: a new run cancels the older ones' },
  { value: 'reject', label: 'Reject: refuse new runs while the group is full' },
];

/** How runs are scheduled: concurrency group (limit, mode) and claim priority. Absent fields keep the defaults. */
export function RunOptionsFields({
  doc,
  onChange,
}: {
  doc: { concurrency?: RunConcurrency; priority?: number };
  onChange: (patch: { concurrency?: RunConcurrency; priority?: number }) => void;
}) {
  const c = doc.concurrency;
  const set = (patch: Partial<RunConcurrency>) => onChange({ concurrency: { max: 1, mode: 'queue', ...c, ...patch } });
  return (
    <Stack gap="xs">
      <Switch
        label="Limit concurrent runs"
        description="At most N runs of a group at a time (for example one deployment per environment)"
        checked={!!c}
        onChange={(e) => onChange({ concurrency: e.currentTarget.checked ? { max: 1, mode: 'queue' } : undefined })}
      />
      {c && (
        <SimpleGrid cols={{ base: 1, sm: 2 }}>
          <TextInput
            label="Group"
            description="Template; empty: the workflow identifier"
            placeholder="deploy-{{ entity.identifier }}"
            value={c.group ?? ''}
            onChange={(e) => set({ group: e.currentTarget.value || undefined })}
            styles={MONO_INPUT}
          />
          <NumberInput label="At most" min={1} max={100} value={c.max} onChange={(v) => set({ max: Math.max(1, Number(v) || 1) })} />
          <Select
            label="When the group is full"
            data={CONCURRENCY_MODES}
            value={c.mode}
            allowDeselect={false}
            onChange={(v) => v && set({ mode: v as RunConcurrency['mode'] })}
            style={{ gridColumn: '1 / -1' }}
          />
        </SimpleGrid>
      )}
      <NumberInput
        label="Priority"
        description="Queued runs start by priority (higher first), then age; -100 to 100, default 0"
        min={-100}
        max={100}
        value={doc.priority ?? 0}
        onChange={(v) => onChange({ priority: Number(v) || undefined })}
        w={200}
      />
    </Stack>
  );
}

export function GeneralFields({
  doc,
  isNew,
  onChange,
  idTouched,
  onIdTouched,
}: {
  doc: { identifier: string; title: string; description?: string; icon?: string | null };
  isNew: boolean;
  onChange: (patch: { identifier?: string; title?: string; description?: string; icon?: string | null }) => void;
  idTouched?: boolean;
  onIdTouched?: () => void;
}) {
  return (
    <>
      <SimpleGrid cols={{ base: 1, sm: 2 }}>
        <TextInput
          label="Title"
          withAsterisk
          placeholder="Create a database"
          data-autofocus
          value={doc.title}
          onChange={(e) => {
            const title = e.currentTarget.value;
            // New workflows: derive the identifier from the title until it is edited by hand.
            onChange(isNew && !idTouched ? { title, identifier: slugify(title) } : { title });
          }}
        />
        <TextInput
          label="Identifier"
          withAsterisk
          description={isNew ? 'From the title; cannot be changed later' : 'Cannot be changed'}
          disabled={!isNew}
          placeholder="create-database"
          value={doc.identifier}
          onChange={(e) => {
            onIdTouched?.();
            onChange({ identifier: e.currentTarget.value });
          }}
          error={doc.identifier && !SLUG.test(doc.identifier) ? 'lowercase, digits, - and _' : undefined}
          styles={MONO_INPUT}
        />
      </SimpleGrid>
      <Textarea
        label="Description"
        description="Markdown; shown on the self-service card and above the form"
        autosize
        minRows={2}
        value={doc.description ?? ''}
        onChange={(e) => onChange({ description: e.currentTarget.value })}
      />
      <IconPicker value={doc.icon ?? null} onChange={(i) => onChange({ icon: i })} />
    </>
  );
}
