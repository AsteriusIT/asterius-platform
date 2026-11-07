import type { ReactNode } from 'react';
import { ActionIcon, Box, Group, Paper, Stack, Text, Tooltip } from '@mantine/core';
import { Link } from 'react-router';
import { IconArrowLeft } from '@tabler/icons-react';

/**
 * Frame of the flow views (workflow editor, run): the graph fills the whole content panel (the sidebar and top bar
 * stay), with the title on the top left, the actions on the top right and notices under them, floating over it.
 */
export function FlowShell(props: {
  back: { to: string; label: string };
  title: ReactNode;
  /** Under the title: badges (status, read-only, unsaved…). */
  meta?: ReactNode;
  actions?: ReactNode;
  /** Notices floating under the bars (problems, test result…). */
  banner?: ReactNode;
  /** Small help at the bottom. */
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Box pos="relative" w="100%" style={{ flex: 1, minHeight: 'calc(100dvh - var(--app-shell-header-height, 60px) - 14px)' }}>
      <Box pos="absolute" inset={0}>
        {props.children}
      </Box>
      <Group pos="absolute" top={12} left={12} right={12} justify="space-between" align="flex-start" gap="sm" style={{ pointerEvents: 'none' }}>
        <Paper className="flow-shell-bar" px="sm" py={8} radius="lg" shadow="sm" style={{ pointerEvents: 'auto', minWidth: 0, maxWidth: '50%' }}>
          <Group gap="sm" wrap="nowrap">
            <Tooltip label={props.back.label}>
              <ActionIcon component={Link} to={props.back.to} variant="subtle" color="gray" size="lg" aria-label={props.back.label}>
                <IconArrowLeft size={18} />
              </ActionIcon>
            </Tooltip>
            <Stack gap={2} style={{ minWidth: 0 }}>
              <Text fw={700} fz="md" truncate>
                {props.title}
              </Text>
              {props.meta && (
                <Group gap={6} wrap="nowrap">
                  {props.meta}
                </Group>
              )}
            </Stack>
          </Group>
        </Paper>
        {props.actions && (
          <Paper className="flow-shell-bar" p={6} radius="lg" shadow="sm" style={{ pointerEvents: 'auto' }}>
            <Group gap={6} wrap="wrap" justify="flex-end">
              {props.actions}
            </Group>
          </Paper>
        )}
      </Group>
      {props.banner && (
        <Stack pos="absolute" top={84} left="50%" w="min(720px, calc(100% - 24px))" gap="xs" style={{ transform: 'translateX(-50%)' }}>
          {props.banner}
        </Stack>
      )}
      {props.hint && (
        <Text
          pos="absolute"
          bottom={12}
          left="50%"
          fz="xs"
          c="dimmed"
          ta="center"
          w="min(720px, calc(100% - 200px))"
          style={{ transform: 'translateX(-50%)', pointerEvents: 'none' }}
        >
          {props.hint}
        </Text>
      )}
    </Box>
  );
}
