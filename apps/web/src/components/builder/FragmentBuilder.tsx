import { useMemo, useState } from 'react';
import { Accordion, ActionIcon, Alert, Badge, Button, Group, Input, Menu, Stack, Text, Textarea } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useQuery } from '@tanstack/react-query';
import { IconForms, IconHistory, IconListDetails, IconPlus, IconPuzzle, IconTrash, IconWritingSign } from '@tabler/icons-react';
import type { ObjectSchema, WorkflowStep, WorkflowStepType } from '@asterius/shared';
import { api } from '../../lib/api';
import { STEP_TYPES } from '../../lib/workflow';
import { StepTypeItems } from '../WorkflowFlow';
import { FragmentHistory } from './ActionHistory';
import { KeyValueEditor } from './blocks';
import { FieldsEditor } from './FieldsEditor';
import { fieldProblems, fieldsToSchema, schemaToFields, type FieldDraft } from './fields';
import { FormBuilder, identityProblems, IdentityFields, type EditorProps, type FormContext } from './FormBuilder';
import { newStep, patchStep, StepSettings, stepProblems } from './WorkflowEditor';

/**
 * Form editor of a step fragment: parameters (a form schema), steps (edited with the workflow step forms) and
 * outputs (JSONata over the fragment's steps), with the JSON / YAML views of FormBuilder.
 */

export interface FragmentDoc {
  identifier: string;
  title: string;
  description: string;
  params: ObjectSchema;
  steps: WorkflowStep[];
  outputs: Record<string, string>;
  [k: string]: unknown;
}

export const toFragmentDoc = (v: Record<string, unknown>): FragmentDoc => ({
  ...v,
  identifier: String(v.identifier ?? ''),
  title: String(v.title ?? ''),
  description: String(v.description ?? ''),
  params: (v.params as ObjectSchema) ?? { properties: {} },
  steps: Array.isArray(v.steps) ? (v.steps as WorkflowStep[]) : [],
  outputs: (v.outputs as Record<string, string>) ?? {},
});

export const blankFragment: Record<string, unknown> = {
  identifier: 'notify-and-approve',
  title: 'Notify and wait for approval',
  description: '',
  params: { properties: { channel: { type: 'string', title: 'Slack channel' } }, required: ['channel'] },
  steps: [{ id: 'approve', name: 'Approval', type: 'approval', minApprovals: 1, message: 'Approval requested in {{ params.channel }}' }],
  outputs: { approved: 'steps.approve.output.approved' },
};

function ParamsTab({ doc, set }: FormContext<FragmentDoc>) {
  const [fields, setFields] = useState<FieldDraft[]>(() => schemaToFields(doc.params));
  return (
    <Stack gap="sm">
      <Text fz="sm" c="dimmed">
        What workflows pass to this fragment (<code>with</code>). Inside the fragment, read them as <code>{'{{ params.<name> }}'}</code>.
      </Text>
      <FieldsEditor
        fields={fields}
        onChange={(f) => {
          setFields(f);
          set({ params: fieldsToSchema(f) });
        }}
      />
    </Stack>
  );
}

function StepsTab({ doc, set }: FormContext<FragmentDoc>) {
  const meta = useQuery({ queryKey: ['meta'], queryFn: api.meta, staleTime: Infinity });
  const invokers = useMemo(() => meta.data?.invokers ?? [], [meta.data]);
  const [open, setOpen] = useState<string | null>(doc.steps[0]?.id ?? null);
  const add = (type: WorkflowStepType) => {
    const s = newStep(type, doc.steps, invokers);
    set({ steps: [...doc.steps, s] });
    setOpen(s.id);
  };
  return (
    <Stack gap="sm">
      <Accordion variant="contained" radius="lg" value={open} onChange={setOpen}>
        {doc.steps.map((s, i) => (
          <Accordion.Item key={i} value={s.id}>
            <Accordion.Control>
              <Group gap="xs" wrap="nowrap">
                <Badge color={STEP_TYPES[s.type].color}>{STEP_TYPES[s.type].label}</Badge>
                <Text fz="sm">{s.name || s.id}</Text>
              </Group>
            </Accordion.Control>
            <Accordion.Panel>
              <Stack gap="sm">
                <StepSettings
                  steps={doc.steps}
                  index={i}
                  invokers={invokers}
                  inputFields={[]}
                  blueprint={null}
                  onEntity={false}
                  warnings={[]}
                  update={(patch) => set({ steps: patchStep(doc.steps, i, patch) })}
                  params={Object.keys(doc.params.properties ?? {})}
                />
                <Group justify="flex-end">
                  <ActionIcon
                    variant="subtle"
                    color="red"
                    aria-label="Remove step"
                    onClick={() => set({ steps: doc.steps.filter((_, j) => j !== i).map((x) => ({ ...x, needs: x.needs?.filter((n) => n !== s.id) })) })}
                  >
                    <IconTrash size={16} />
                  </ActionIcon>
                </Group>
              </Stack>
            </Accordion.Panel>
          </Accordion.Item>
        ))}
      </Accordion>
      <Menu position="bottom-start" width={340}>
        <Menu.Target>
          <Button variant="light" leftSection={<IconPlus size={16} />} w="fit-content">
            Add a step
          </Button>
        </Menu.Target>
        <Menu.Dropdown>
          <StepTypeItems onPick={add} />
        </Menu.Dropdown>
      </Menu>
    </Stack>
  );
}

export function FragmentBuilder(props: EditorProps) {
  const meta = useQuery({ queryKey: ['meta'], queryFn: api.meta, staleTime: Infinity });
  const problems = (d: FragmentDoc) => [
    ...identityProblems(d),
    ...(d.steps.length ? [] : ['Add at least one step']),
    ...fieldProblems(schemaToFields(d.params), 'Parameter'),
    ...stepProblems(d.steps, meta.data?.invokers ?? []),
  ];
  return (
    <FormBuilder<FragmentDoc>
      {...props}
      size="xl"
      noun="fragment"
      toDoc={toFragmentDoc}
      versioned={{
        reload: async (id) => {
          const { managed: _m, updatedAt: _u, ...rest } = await api.fragment(id);
          return rest;
        },
        diff: api.fragmentDiff,
      }}
      problems={problems}
      header={
        <Alert variant="light" color="gray" icon={<IconPuzzle size={16} />} p="xs">
          Workflows include this fragment with a Fragment step; its steps are inlined when a run starts (ids prefixed with the step id). Changes apply to new
          runs only.
        </Alert>
      }
      tabs={[
        {
          value: 'general',
          label: 'General',
          icon: <IconWritingSign size={16} />,
          render: (ctx) => (
            <Stack gap="md">
              <IdentityFields {...ctx} placeholder="Notify and wait for approval" />
              <Textarea
                label="Description"
                autosize
                minRows={2}
                value={ctx.doc.description}
                onChange={(e) => ctx.set({ description: e.currentTarget.value })}
              />
            </Stack>
          ),
        },
        {
          value: 'params',
          label: 'Parameters',
          icon: <IconForms size={16} />,
          count: (d) => Object.keys(d.params.properties ?? {}).length,
          render: (ctx) => <ParamsTab {...ctx} />,
        },
        { value: 'steps', label: 'Steps', icon: <IconListDetails size={16} />, count: (d) => d.steps.length, render: (ctx) => <StepsTab {...ctx} /> },
        {
          value: 'outputs',
          label: 'Outputs',
          icon: <IconPuzzle size={16} />,
          count: (d) => Object.keys(d.outputs).length,
          render: (ctx) => (
            <Input.Wrapper
              label="Outputs"
              description="Name → JSONata over the fragment's steps (steps.<id>.output…); callers read steps.<fragment step id>.output.<name>"
            >
              <KeyValueEditor
                value={ctx.doc.outputs}
                onChange={(o) => ctx.set({ outputs: o as Record<string, string> })}
                keyPlaceholder="name"
                valuePlaceholder="steps.approve.output.approved"
              />
            </Input.Wrapper>
          ),
        },
        ...(props.isNew
          ? []
          : [
              {
                value: 'history',
                label: 'History',
                icon: <IconHistory size={16} />,
                render: (ctx: FormContext<FragmentDoc>) => (
                  <FragmentHistory
                    identifier={ctx.doc.identifier}
                    readOnly={ctx.readOnly}
                    onRestored={() => {
                      notifications.show({ color: 'green', message: `${ctx.doc.identifier} restored` });
                      props.onClose();
                    }}
                  />
                ),
              },
            ]),
      ]}
    />
  );
}
