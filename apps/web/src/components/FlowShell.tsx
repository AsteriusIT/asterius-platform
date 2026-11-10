import type { ReactNode } from 'react';
import { ActionIcon, Box, Group, Paper, Stack, Text, Tooltip } from '@mantine/core';
import { Link } from 'react-router';
import { IconArrowLeft } from '@tabler/icons-react';

/** Geometry of the floating chrome (px): distance of the bars from the canvas edge, and where notices start under them. */
const INSET = 12;
const BANNER_TOP = 84;

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
  /** Width (px) taken on the right by a docked side panel: the canvas and its bars shrink so nothing sits under it. */
  reserve?: number;
  children: ReactNode;
}) {
  return (
    <Box
      className="flow-shell"
      pos="relative"
      flex={1}
      miw={0}
      mih="calc(100dvh - var(--app-shell-header-height, 60px) - 14px)"
      style={{ '--flow-shell-reserve': `${props.reserve ?? 0}px` }}
    >
      <Box pos="absolute" inset={0}>
        {props.children}
      </Box>
      <Group className="flow-shell-top" pos="absolute" top={INSET} left={INSET} right={INSET} justify="space-between" align="flex-start" gap="sm">
        <Paper className="flow-shell-bar" px="sm" py="xs" radius="lg" shadow="sm" miw={0} maw="50%">
          <Group gap="sm" wrap="nowrap">
            <Tooltip label={props.back.label}>
              <ActionIcon component={Link} to={props.back.to} variant="subtle" color="gray" size="lg" aria-label={props.back.label}>
                <IconArrowLeft size={18} />
              </ActionIcon>
            </Tooltip>
            <Stack gap="4xs" miw={0}>
              <Text fw={700} fz="md" truncate>
                {props.title}
              </Text>
              {props.meta && (
                <Group gap="2xs" wrap="nowrap">
                  {props.meta}
                </Group>
              )}
            </Stack>
          </Group>
        </Paper>
        {props.actions && (
          <Paper className="flow-shell-bar" p="2xs" radius="lg" shadow="sm">
            <Group gap="2xs" wrap="wrap" justify="flex-end">
              {props.actions}
            </Group>
          </Paper>
        )}
      </Group>
      {props.banner && (
        <Stack className="flow-shell-center" pos="absolute" top={BANNER_TOP} left="50%" w="min(720px, calc(100% - 24px))" gap="xs">
          {props.banner}
        </Stack>
      )}
      {props.hint && (
        <Text
          className="flow-shell-center flow-shell-hint"
          pos="absolute"
          bottom={INSET}
          left="50%"
          fz="xs"
          c="dimmed"
          ta="center"
          w="min(720px, calc(100% - 200px))"
        >
          {props.hint}
        </Text>
      )}
    </Box>
  );
}
