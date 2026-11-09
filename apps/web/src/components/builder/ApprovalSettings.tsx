import { ActionIcon, Button, Card, Group, NumberInput, Select, Stack, Switch, Text, TextInput, Title } from '@mantine/core';
import { IconPlus, IconTrash } from '@tabler/icons-react';
import type { ApprovalExpiry, ApprovalTier, ApprovalTimers } from '@asterius/shared';
import { SubjectsEditor } from './blocks';

/**
 * Reminders, escalation, expiry outcome and sequential tiers of an approval: shared by the approval step (workflow
 * editor), the pre-start approval (trigger editor) and, for reminders only, the input step.
 */

const DELAY = /^[1-9]\d{0,5}[smhd]$/;
const delayError = (v: string | undefined) => (v && !DELAY.test(v) ? 'e.g. 30m, 4h, 1d' : undefined);

export const EXPIRY_OPTIONS: { value: ApprovalExpiry; label: string }[] = [
  { value: 'fail', label: 'Fail (default)' },
  { value: 'reject', label: 'Reject' },
  { value: 'approve', label: 'Approve' },
  { value: 'skip', label: 'Skip the approval' },
];

export function RemindersEditor({ value, onChange }: { value: ApprovalTimers; onChange: (p: Partial<ApprovalTimers>) => void }) {
  return (
    <Group align="flex-start">
      <TextInput
        label="Remind every"
        description="Re-notify who has not decided yet"
        placeholder="never (e.g. 1d)"
        w={200}
        value={value.remindEvery ?? ''}
        error={delayError(value.remindEvery)}
        onChange={(e) => onChange({ remindEvery: e.currentTarget.value || undefined })}
      />
      <NumberInput
        label="At most"
        description="reminders"
        min={1}
        max={20}
        w={120}
        placeholder="3"
        disabled={!value.remindEvery}
        value={value.maxReminders ?? ''}
        onChange={(n) => onChange({ maxReminders: n === '' ? undefined : Number(n) })}
      />
    </Group>
  );
}

/** Reminders, escalation and what happens when nobody decides in time. */
export function ApprovalTimersEditor({
  value,
  onChange,
  onEntity,
  expiryHint,
}: {
  value: ApprovalTimers;
  onChange: (p: Partial<ApprovalTimers>) => void;
  onEntity: boolean;
  expiryHint: string;
}) {
  const esc = value.escalate;
  return (
    <Stack gap="sm">
      <Title order={6}>Reminders, escalation and expiry</Title>
      <RemindersEditor value={value} onChange={onChange} />
      <Switch
        label="Escalate when nobody decides in time"
        checked={!!esc}
        onChange={(e) => onChange({ escalate: e.currentTarget.checked ? { after: '2d', approvers: { roles: ['admin'] } } : undefined })}
      />
      {esc && (
        <Card withBorder p="sm">
          <Stack gap="xs">
            <TextInput
              label="After"
              w={200}
              value={esc.after}
              error={delayError(esc.after)}
              onChange={(e) => onChange({ escalate: { ...esc, after: e.currentTarget.value } })}
            />
            <Text fz="sm" fw={500}>
              These people may approve too, and are notified
            </Text>
            <SubjectsEditor
              value={esc.approvers}
              onChange={(approvers) => onChange({ escalate: { ...esc, approvers } })}
              allowOwnerTeam={onEntity}
              emptyMeans="name someone"
            />
          </Stack>
        </Card>
      )}
      <Select
        label="When the approval expires"
        description={expiryHint}
        w={260}
        data={EXPIRY_OPTIONS}
        value={value.onExpiry ?? 'fail'}
        onChange={(v) => onChange({ onExpiry: v && v !== 'fail' ? (v as ApprovalExpiry) : undefined })}
      />
    </Stack>
  );
}

/** Sequential tiers: decided in order, each opening once the previous one has its approvals. */
export function TiersEditor({ tiers, onChange, onEntity }: { tiers: ApprovalTier[]; onChange: (t: ApprovalTier[]) => void; onEntity: boolean }) {
  const set = (i: number, patch: Partial<ApprovalTier>) => onChange(tiers.map((t, j) => (j === i ? { ...t, ...patch } : t)));
  return (
    <Stack gap="sm">
      {tiers.map((t, i) => (
        <Card key={i} withBorder p="sm">
          <Stack gap="xs">
            <Group align="flex-end">
              <Text fw={600} fz="sm">
                {i + 1}.
              </Text>
              <TextInput label="Tier" value={t.name} onChange={(e) => set(i, { name: e.currentTarget.value })} style={{ flex: 1 }} />
              <NumberInput
                label="Approvals needed"
                min={1}
                max={10}
                w={160}
                value={t.minApprovals ?? 1}
                onChange={(n) => set(i, { minApprovals: Number(n) || 1 })}
              />
              <ActionIcon variant="subtle" color="red" mb={4} aria-label="Remove tier" onClick={() => onChange(tiers.filter((_, j) => j !== i))}>
                <IconTrash size={16} />
              </ActionIcon>
            </Group>
            <SubjectsEditor value={t.approvers} onChange={(approvers) => set(i, { approvers })} allowOwnerTeam={onEntity} emptyMeans="admins approve" />
          </Stack>
        </Card>
      ))}
      <Group>
        <Button
          size="xs"
          variant="light"
          leftSection={<IconPlus size={14} />}
          onClick={() => onChange([...tiers, { name: `Tier ${tiers.length + 1}`, approvers: {}, minApprovals: 1 }])}
        >
          Add tier
        </Button>
      </Group>
    </Stack>
  );
}
