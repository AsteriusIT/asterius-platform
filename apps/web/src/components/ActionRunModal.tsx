import { useEffect, useState } from 'react';
import { Alert, Button, Group, Modal, NumberInput, Stack, Switch, Text } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import { IconCalendarOff, IconShieldCheck } from '@tabler/icons-react';
import type { Action, ApprovalPolicy, ObjectSchema } from '@asterius/shared';
import { api, errorText } from '../lib/api';
import { formOf } from '../lib/permissions';
import { useAuth } from '../lib/auth';
import { clearDraft, loadDraft, saveDraft } from '../lib/drafts';
import { usePreferences } from '../lib/preferences';
import { initialValues, SchemaForm, validateValues, type FormValues } from './SchemaForm';
import { Markdown } from './ui';
import { DialogFocus } from './dialogFocus';

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

const when = (iso: string) => new Date(iso).toLocaleString();

/** The blackout in effect (submissions refused) or the next one, from the action's read-only status. */
export function BlackoutNotice({ action }: { action: Action }) {
  const b = action.blackout;
  if (b?.active)
    return (
      <Alert color="red" variant="light" icon={<IconCalendarOff size={18} />} title={`Blackout: ${b.active.name}`}>
        Runs cannot start until {when(b.active.until)}.
      </Alert>
    );
  if (b?.next)
    return (
      <Text fz="xs" c="dimmed">
        Next blackout ({b.next.name}): {when(b.next.from)} to {when(b.next.until)}
      </Text>
    );
  return null;
}

const NO_INPUTS: ObjectSchema = { properties: {} };
const NO_APPROVAL: ApprovalPolicy = { required: false };

/** Fill the workflow's form (its trigger) and start a run. */
export function ActionRunModal({
  action,
  entity,
  prefill,
  onClose,
}: {
  action: Action | null;
  entity?: { blueprint: string; identifier: string; title: string } | null;
  /** Initial input values (e.g. from `?inputs=`); they win over a saved draft. */
  prefill?: Record<string, unknown> | null;
  onClose: () => void;
}) {
  return (
    <Modal opened={!!action} onClose={onClose} title={<Text fw={600}>{action?.title}</Text>} size="lg">
      {action && (
        <DialogFocus>
          <RunForm key={action.identifier} action={action} entity={entity ?? null} prefill={prefill ?? null} onClose={onClose} />
        </DialogFocus>
      )}
    </Modal>
  );
}

function RunForm({
  action,
  entity,
  prefill,
  onClose,
}: {
  action: Action;
  entity: { blueprint: string; identifier: string; title: string } | null;
  prefill: Record<string, unknown> | null;
  onClose: () => void;
}) {
  const inputs = formOf(action)?.inputs ?? NO_INPUTS;
  const approval = formOf(action)?.approval ?? NO_APPROVAL;
  const [values, setValues] = useState<FormValues>(() =>
    initialValues(inputs, (prefill ?? loadDraft(action.identifier, entity?.identifier ?? null) ?? {}) as FormValues),
  );
  const entityId = entity?.identifier ?? null;
  // Keep a draft so closing the dialog does not lose what was typed.
  useEffect(() => {
    const t = setTimeout(() => saveDraft(action.identifier, entityId, values), 400);
    return () => clearTimeout(t);
  }, [action.identifier, entityId, values]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { isAdmin } = useAuth();
  const { pushRecent } = usePreferences();
  const inBlackout = !!action.blackout?.active;
  const [override, setOverride] = useState(false);
  // Admins: claim order of this run among queued ones (empty: the workflow's priority).
  const [priority, setPriority] = useState<number | null>(null);
  const run = useMutation({
    mutationFn: () =>
      api.trigger(action.identifier, {
        entity: entity?.identifier ?? null,
        inputs: values,
        ...(inBlackout && override ? { overrideBlackout: true } : {}),
        ...(isAdmin && priority !== null ? { priority } : {}),
      }),
    onSuccess: (r) => {
      clearDraft(action.identifier, entityId);
      pushRecent(action.identifier);
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
      <BlackoutNotice action={action} />
      {inBlackout && isAdmin && (
        <Switch label="Run anyway (admin override, audited)" checked={override} onChange={(e) => setOverride(e.currentTarget.checked)} />
      )}
      {approval.required && (
        <Alert color="yellow" variant="light" icon={<IconShieldCheck size={18} />}>
          {approvalText(approval)}
        </Alert>
      )}
      {Object.keys(inputs.properties ?? {}).length > 0 && <SchemaForm schema={inputs} values={values} onChange={setValues} errors={errors} />}
      {isAdmin && (
        <NumberInput
          label="Priority (admins)"
          description={`Queued runs start by priority, higher first, then age. Leave empty for the workflow's priority (${action.priority ?? 0}).`}
          placeholder={String(action.priority ?? 0)}
          min={-100}
          max={100}
          allowDecimal={false}
          clampBehavior="strict"
          value={priority ?? ''}
          onChange={(v) => setPriority(typeof v === 'number' ? v : v === '' ? null : Number(v))}
          w={{ base: '100%', sm: 240 }}
        />
      )}
      {run.error && (
        <Alert color="red" variant="light">
          {errorText(run.error)}
        </Alert>
      )}
      <Group justify="flex-end">
        <Button variant="default" onClick={onClose}>
          Cancel
        </Button>
        <Button onClick={submit} loading={run.isPending} disabled={inBlackout && !override} color={formOf(action)?.on === 'delete' ? 'red' : undefined}>
          {approval.required ? 'Request' : 'Run'}
        </Button>
      </Group>
    </Stack>
  );
}
