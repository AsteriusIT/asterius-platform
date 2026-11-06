import { useState } from 'react';
import { Alert, Badge, Group, Modal, Select, SimpleGrid, Stack, Switch, Tabs, Text, Textarea, TextInput } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { IconHistory, IconInfoCircle, IconSettings, IconSitemap } from '@tabler/icons-react';
import type { ActionTrigger, FormTrigger, InvokerConfig, ObjectSchema, PluginInfo, WorkflowStep, WorkflowTrigger } from '@asterius/shared';
import { api } from '../../lib/api';
import { EntityIcon, ICON_NAMES } from '../icons';
import { fieldProblems, fieldsToSchema, schemaToFields, type FieldDraft } from './fields';
import { MONO_INPUT } from './blocks';
import { stepProblems, WorkflowEditor } from './WorkflowEditor';
import { isFormLike } from './TriggerEditor';
import { ActionHistory } from './ActionHistory';
import { BuilderFooter, BuilderModal, CodePanels, CodeTabs, ManagedNotice, slugify, useCodeView, useSave } from './shell';

export { slugify };

/**
 * Editor of a self-service workflow. A workflow is a trigger (today: a form submission) followed by steps.
 *  - Creating one only asks for the general settings; the workflow is then built node by node in the editor.
 *  - The builder tabs and the JSON / YAML tabs edit the same document, which is exactly what
 *    PUT /api/v1/actions/:id and the configuration files accept.
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

const formInputs = (t: WorkflowTrigger | null): ObjectSchema => (isFormLike(t) ? t.inputs : { properties: {} });

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
 * New workflow: a small dialog with the general settings only, then the full editor on the created workflow.
 * Existing workflow: the full editor.
 */
export function ActionBuilder(props: EditorProps) {
  const [created, setCreated] = useState<Record<string, unknown> | null>(null);
  const close = () => {
    setCreated(null);
    props.onClose();
  };
  if (props.isNew && !created)
    return (
      <CreateAction value={props.value} onClose={close} onCreate={async (id, body) => setCreated((await props.onSave(id, body)) as Record<string, unknown>)} />
    );
  const value = created ? Object.fromEntries(Object.entries(created).filter(([k]) => k !== 'managed' && k !== 'allowedForMe')) : props.value;
  const title = created ? `Edit ${String(value?.identifier)}` : `${props.readOnly ? 'View' : 'Edit'} ${String(value?.identifier)}`;
  return (
    <BuilderModal opened={!!value} onClose={close} title={title}>
      {value && (
        <Builder
          key={String(value.identifier)}
          value={value}
          readOnly={props.readOnly}
          initialTab={created ? 'workflow' : undefined}
          onSave={props.onSave}
          onClose={close}
        />
      )}
    </BuilderModal>
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

function GeneralFields({
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
      <Select
        label="Icon"
        searchable
        clearable
        data={ICON_NAMES}
        value={doc.icon ?? null}
        onChange={(i) => onChange({ icon: i })}
        leftSection={<EntityIcon name={doc.icon} size={16} />}
        renderOption={({ option }) => (
          <Group gap="xs">
            <EntityIcon name={option.value} size={16} />
            {option.label}
          </Group>
        )}
      />
    </>
  );
}

function Builder({
  value,
  readOnly,
  initialTab,
  onSave,
  onClose,
}: {
  value: Record<string, unknown>;
  readOnly?: boolean;
  initialTab?: string;
  onSave: (identifier: string, body: Record<string, unknown>) => Promise<unknown>;
  onClose: () => void;
}) {
  const meta = useQuery({ queryKey: ['meta'], queryFn: api.meta, staleTime: Infinity });
  const [doc, setDoc] = useState<ActionDoc>(() => toActionDoc(value));
  const [fields, setFields] = useState<FieldDraft[]>(() => schemaToFields(formInputs(toActionDoc(value).trigger)));
  const [tab, setTab] = useState<string | null>(initialTab ?? 'workflow');
  const [generation, setGeneration] = useState(0); // remount editors after a JSON/YAML replacement

  const set = (patch: Partial<ActionDoc>) => setDoc((d) => ({ ...d, ...patch }));
  const body = (): Record<string, unknown> => ({ ...doc, trigger: isFormLike(doc.trigger) ? { ...doc.trigger, inputs: fieldsToSchema(fields) } : doc.trigger });

  const code = useCodeView({
    body,
    replace: (parsed) => {
      const next = toActionDoc(parsed);
      next.identifier = doc.identifier;
      setDoc(next);
      setFields(schemaToFields(formInputs(next.trigger)));
      setGeneration((g) => g + 1);
    },
  });
  const openTab = (t: string | null) => {
    code.open(t);
    setTab(t);
  };
  const saver = useSave(() => onSave(doc.identifier, body()), onClose);
  const save = () => {
    const found = docProblems(doc, fields, meta.data?.invokers ?? []);
    if (code.error && (tab === 'json' || tab === 'yaml')) found.unshift(`${tab.toUpperCase()}: ${code.error}`);
    void saver.save(found);
  };
  const missing = [...(doc.trigger ? [] : ['a trigger']), ...(doc.steps.length ? [] : ['a step'])];

  return (
    <Stack>
      {readOnly && <ManagedNotice />}
      <Tabs value={tab} onChange={openTab} keepMounted={false}>
        <Tabs.List mb="md">
          <Tabs.Tab
            value="workflow"
            leftSection={<IconSitemap size={16} />}
            rightSection={doc.steps.length ? <Badge size="xs">{doc.steps.length}</Badge> : undefined}
          >
            Workflow
          </Tabs.Tab>
          <Tabs.Tab value="general" leftSection={<IconSettings size={16} />}>
            General
          </Tabs.Tab>
          {typeof value.version === 'number' && !readOnly && (
            <Tabs.Tab value="history" leftSection={<IconHistory size={16} />}>
              History
            </Tabs.Tab>
          )}
          <CodeTabs />
        </Tabs.List>

        <fieldset disabled={readOnly} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }} key={generation}>
          <Tabs.Panel value="workflow">
            {missing.length > 0 && !readOnly && (
              <Alert color="gray" variant="light" icon={<IconInfoCircle size={18} />} mb="md">
                Draft: add {missing.join(' and ')} so users can run it. You can save at any time.
              </Alert>
            )}
            <WorkflowEditor
              trigger={doc.trigger}
              onTriggerChange={(trigger) => set({ trigger })}
              fields={fields}
              onFieldsChange={setFields}
              steps={doc.steps}
              onChange={(steps) => set({ steps })}
            />
          </Tabs.Panel>

          <Tabs.Panel value="general">
            <Stack gap="md">
              <GeneralFields doc={doc} isNew={false} onChange={set} />
              <Switch
                label="Enabled"
                description="Disabled workflows are hidden from users"
                checked={doc.enabled}
                onChange={(e) => set({ enabled: e.currentTarget.checked })}
              />
            </Stack>
          </Tabs.Panel>
        </fieldset>

        {typeof value.version === 'number' && (
          <Tabs.Panel value="history">
            <ActionHistory identifier={doc.identifier} current={value.version} onRestored={onClose} />
          </Tabs.Panel>
        )}

        <CodePanels view={code} readOnly={readOnly} />
      </Tabs>

      <BuilderFooter problems={saver.problems} readOnly={readOnly} saving={saver.saving} saveLabel="Save" onSave={save} onClose={onClose} />
    </Stack>
  );
}
