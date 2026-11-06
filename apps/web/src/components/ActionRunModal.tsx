import { useState } from 'react';
import { Alert, Button, Group, Modal, Stack, Text } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import { IconShieldCheck } from '@tabler/icons-react';
import type { Action, ApprovalPolicy, ObjectSchema } from '@asterius/shared';
import { api, errorText } from '../lib/api';
import { formOf } from '../lib/permissions';
import { initialValues, SchemaForm, validateValues, type FormValues } from './SchemaForm';
import { Markdown } from './ui';

function approvalText(approval: ApprovalPolicy) {
  const ap = approval.approvers ?? {};
  const who = [
    ...(ap.teams ?? []).map((t) => `team ${t}`),
    ...(ap.roles ?? []).map((r) => `${r}s`),
    ...(ap.users ?? []),
    ...(ap.ownerTeam ? ['the owning team'] : []),
  ];
  const n = approval.minApprovals ?? 1;
  return `Needs ${n} approval${n > 1 ? 's' : ''} from ${who.length ? who.join(', ') : 'an admin'} before it runs.`;
}

const NO_INPUTS: ObjectSchema = { properties: {} };
const NO_APPROVAL: ApprovalPolicy = { required: false };

/** Fill the workflow's form (its trigger) and start a run. */
export function ActionRunModal({
  action,
  entity,
  onClose,
}: {
  action: Action | null;
  entity?: { blueprint: string; identifier: string; title: string } | null;
  onClose: () => void;
}) {
  return (
    <Modal opened={!!action} onClose={onClose} title={<Text fw={600}>{action?.title}</Text>} size="lg">
      {action && <RunForm key={action.identifier} action={action} entity={entity ?? null} onClose={onClose} />}
    </Modal>
  );
}

function RunForm({
  action,
  entity,
  onClose,
}: {
  action: Action;
  entity: { blueprint: string; identifier: string; title: string } | null;
  onClose: () => void;
}) {
  const inputs = formOf(action)?.inputs ?? NO_INPUTS;
  const approval = formOf(action)?.approval ?? NO_APPROVAL;
  const [values, setValues] = useState<FormValues>(() => initialValues(inputs));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const navigate = useNavigate();
  const qc = useQueryClient();
  const run = useMutation({
    mutationFn: () => api.trigger(action.identifier, { entity: entity?.identifier ?? null, inputs: values }),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ['runs'] });
      notifications.show({
        color: r.status === 'PENDING_APPROVAL' ? 'yellow' : 'green',
        title: action.title,
        message: r.status === 'PENDING_APPROVAL' ? 'Submitted for approval' : 'Started',
      });
      onClose();
      navigate(`/runs/${r.id}`);
    },
  });

  const submit = () => {
    const e = validateValues(inputs, values);
    setErrors(e);
    if (!Object.keys(e).length) run.mutate();
  };

  return (
    <Stack>
      {action.description && <Markdown>{action.description}</Markdown>}
      {entity && (
        <Text fz="sm" c="dimmed">
          On <b>{entity.title}</b> ({entity.blueprint}/{entity.identifier})
        </Text>
      )}
      {approval.required && (
        <Alert color="yellow" variant="light" icon={<IconShieldCheck size={18} />}>
          {approvalText(approval)}
        </Alert>
      )}
      {Object.keys(inputs.properties ?? {}).length > 0 && <SchemaForm schema={inputs} values={values} onChange={setValues} errors={errors} />}
      {run.error && (
        <Alert color="red" variant="light">
          {errorText(run.error)}
        </Alert>
      )}
      <Group justify="flex-end">
        <Button variant="default" onClick={onClose}>
          Cancel
        </Button>
        <Button onClick={submit} loading={run.isPending} color={formOf(action)?.on === 'delete' ? 'red' : undefined}>
          {approval.required ? 'Request' : 'Run'}
        </Button>
      </Group>
    </Stack>
  );
}
