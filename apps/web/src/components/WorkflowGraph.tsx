import { Box, Group, Loader, Paper, ScrollArea, Stack, Text, ThemeIcon, Tooltip, UnstyledButton } from '@mantine/core';
import { IconBolt, IconCheck, IconChevronRight, IconClock, IconCode, IconMinus, IconRobot, IconShieldCheck, IconX } from '@tabler/icons-react';
import type { StepStatus, WorkflowStepType } from '@asterius/shared';
import { STEP_STATUS_COLORS, STEP_STATUS_LABELS, STEP_TYPES, stagesOf } from '../lib/workflow';

/**
 * The workflow as columns of stages (left → right): steps of a column run in parallel, a column starts when what
 * its steps need is done. Used in the action builder (no status) and on run pages (live status).
 */

export interface GraphStep {
  id: string;
  name?: string;
  type: WorkflowStepType;
  needs?: string[];
  status?: StepStatus;
  /** `if` set: shown as conditional. */
  conditional?: boolean;
}

const TYPE_ICON = { invoke: IconBolt, approval: IconShieldCheck, agent: IconRobot, transform: IconCode } as const;

function StatusIcon({ status }: { status?: StepStatus }) {
  if (!status) return null;
  if (status === 'RUNNING') return <Loader size={14} color="blue" />;
  const Icon =
    status === 'SUCCESS'
      ? IconCheck
      : status === 'FAILURE'
        ? IconX
        : status === 'WAITING_APPROVAL'
          ? IconClock
          : status === 'SKIPPED' || status === 'CANCELLED'
            ? IconMinus
            : IconClock;
  return (
    <Tooltip label={STEP_STATUS_LABELS[status]}>
      <ThemeIcon size={20} radius="xl" color={STEP_STATUS_COLORS[status]} variant={status === 'SUCCESS' || status === 'FAILURE' ? 'filled' : 'light'}>
        <Icon size={13} />
      </ThemeIcon>
    </Tooltip>
  );
}

export function WorkflowGraph({ steps, selected, onSelect }: { steps: GraphStep[]; selected?: string | null; onSelect?: (id: string) => void }) {
  const stages = stagesOf(steps);
  return (
    <ScrollArea type="auto" offsetScrollbars>
      <Group gap={6} wrap="nowrap" align="center" py={4}>
        {stages.map((stage, i) => (
          <Group key={i} gap={6} wrap="nowrap" align="center">
            {i > 0 && <IconChevronRight size={18} color="var(--text-3)" style={{ flexShrink: 0 }} />}
            <Stack gap={6}>
              {stage.map((s) => {
                const Icon = TYPE_ICON[s.type];
                const active = selected === s.id;
                const dim = s.status === 'SKIPPED' || s.status === 'CANCELLED';
                return (
                  <UnstyledButton key={s.id} onClick={() => onSelect?.(s.id)} disabled={!onSelect} aria-pressed={active}>
                    <Paper
                      px="sm"
                      py={8}
                      radius="md"
                      shadow="none"
                      w={210}
                      style={{
                        border: `1px solid ${active ? 'var(--mantine-color-brand-6)' : 'var(--mantine-color-default-border)'}`,
                        background: active ? 'var(--surface)' : 'var(--mantine-color-body)',
                        opacity: dim ? 0.55 : 1,
                      }}
                    >
                      <Group gap={8} wrap="nowrap" justify="space-between">
                        <Group gap={8} wrap="nowrap" style={{ minWidth: 0 }}>
                          <ThemeIcon size={26} variant="light" color={STEP_TYPES[s.type].color}>
                            <Icon size={15} />
                          </ThemeIcon>
                          <Box style={{ minWidth: 0 }}>
                            <Text fz="sm" fw={500} truncate>
                              {s.name || s.id}
                            </Text>
                            <Text fz={11} c="dimmed" truncate>
                              {STEP_TYPES[s.type].label}
                              {s.conditional ? ' · if' : ''}
                            </Text>
                          </Box>
                        </Group>
                        <StatusIcon status={s.status} />
                      </Group>
                    </Paper>
                  </UnstyledButton>
                );
              })}
            </Stack>
          </Group>
        ))}
      </Group>
    </ScrollArea>
  );
}
