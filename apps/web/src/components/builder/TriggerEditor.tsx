import { Button, Group, NumberInput, SegmentedControl, Select, Stack, Switch, Text, Title } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { IconForms, IconTrash } from '@tabler/icons-react';
import type { FormTrigger } from '@asterius/shared';
import { api } from '../../lib/api';
import type { FieldDraft } from './fields';
import { FieldsEditor } from './FieldsEditor';
import { SubjectsEditor } from './blocks';

/**
 * The trigger of a workflow. Only one kind today: a form submitted by a user, offered on the self-service page
 * (create) or in the "⋯" menu of an entity (day-2 / delete). Its fields become `inputs.*` for every step.
 */

export const TRIGGER_TYPES = {
  form: { label: 'Form submission', hint: 'A user fills a form on the self-service page or on a catalog entity', icon: IconForms },
} as const;

export const newFormTrigger = (): FormTrigger => ({
  type: 'form',
  on: 'create',
  blueprint: null,
  inputs: { properties: {} },
  allowed: {},
  approval: { required: false },
});

/** "Self-service · database" / "On a database entity" */
export function triggerSummary(t: FormTrigger) {
  if (t.on === 'create') return `Self-service page${t.blueprint ? ` · ${t.blueprint}` : ''}`;
  return `${t.on === 'delete' ? 'Delete' : 'Action'} on ${t.blueprint ? `a ${t.blueprint}` : 'an entity'}`;
}

export function TriggerEditor({
  trigger,
  onChange,
  fields,
  onFieldsChange,
  onRemove,
}: {
  trigger: FormTrigger;
  onChange: (t: FormTrigger) => void;
  fields: FieldDraft[];
  onFieldsChange: (f: FieldDraft[]) => void;
  onRemove: () => void;
}) {
  const blueprints = useQuery({ queryKey: ['blueprints'], queryFn: api.blueprints, staleTime: 30_000 });
  const set = (patch: Partial<FormTrigger>) => onChange({ ...trigger, ...patch });
  const onEntity = trigger.on !== 'create';
  const approval = trigger.approval;

  return (
    <Stack gap="lg">
      <Stack gap="sm">
        <Title order={5}>Where the form is offered</Title>
        <SegmentedControl
          value={trigger.on}
          onChange={(on) => set({ on: on as FormTrigger['on'] })}
          data={[
            { value: 'create', label: 'Self-service page' },
            { value: 'day-2', label: 'On an entity' },
            { value: 'delete', label: 'On an entity (delete)' },
          ]}
        />
        <Select
          label="Blueprint"
          description={onEntity ? 'The kind of entity it runs on (its "⋯" menu)' : 'Optional: groups it on the self-service page and the catalog'}
          withAsterisk={onEntity}
          searchable
          clearable={!onEntity}
          placeholder={onEntity ? 'Choose a blueprint' : 'None (general)'}
          data={(blueprints.data ?? []).map((b) => ({ value: b.identifier, label: b.title }))}
          value={trigger.blueprint ?? null}
          onChange={(b) => set({ blueprint: b })}
          error={onEntity && !trigger.blueprint ? 'Required for forms on an entity' : undefined}
        />
      </Stack>

      <Stack gap="sm">
        <div>
          <Title order={5}>Form fields</Title>
          <Text fz="xs" c="dimmed">
            What the user fills in; steps read them as <code>{'{{ inputs.<name> }}'}</code>. A form may have no field (a button).
          </Text>
        </div>
        <FieldsEditor fields={fields} onChange={onFieldsChange} />
      </Stack>

      <Stack gap="sm">
        <Title order={5}>Who can submit it</Title>
        <SubjectsEditor value={trigger.allowed} onChange={(allowed) => set({ allowed })} allowOwnerTeam={onEntity} emptyMeans="every signed-in user" />
      </Stack>

      <Stack gap="sm">
        <Switch
          label={<Title order={5}>Require approval before the workflow starts</Title>}
          description="For an approval in the middle of the workflow (e.g. after an AI review), add an Approval step instead"
          checked={approval.required}
          onChange={(e) => set({ approval: { ...approval, required: e.currentTarget.checked } })}
        />
        {approval.required && (
          <>
            <SubjectsEditor
              value={approval.approvers}
              onChange={(approvers) => set({ approval: { ...approval, approvers } })}
              allowOwnerTeam={onEntity}
              emptyMeans="admins approve"
            />
            <Group align="flex-end">
              <NumberInput
                label="Approvals needed"
                min={1}
                max={10}
                w={180}
                value={approval.minApprovals ?? 1}
                onChange={(n) => set({ approval: { ...approval, minApprovals: Number(n) || 1 } })}
              />
              <Switch
                mb={8}
                label="Requesters may approve their own requests"
                checked={!!approval.allowSelfApproval}
                onChange={(e) => set({ approval: { ...approval, allowSelfApproval: e.currentTarget.checked } })}
              />
            </Group>
          </>
        )}
      </Stack>

      <Group justify="flex-end">
        <Button variant="subtle" color="red" leftSection={<IconTrash size={16} />} onClick={onRemove}>
          Remove trigger
        </Button>
      </Group>
    </Stack>
  );
}
