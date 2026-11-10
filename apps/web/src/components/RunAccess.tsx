import { Button, List, Popover, Stack, Text } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { IconLock } from '@tabler/icons-react';
import type { Action } from '@asterius/shared';
import { api } from '../lib/api';
import { runAccess } from '../lib/permissions';

/** Team identifier -> title, from the (cached) team list; falls back to the identifier. */
export function useTeamTitle() {
  const teams = useQuery({ queryKey: ['teams'], queryFn: api.teams, staleTime: 60_000 });
  return (id: string) => teams.data?.find((t) => t.identifier === id)?.title ?? id;
}

/** In place of "Start" for an action the user may not run: who can run it and whom to ask. */
export function RunAccessButton({ action, entity }: { action: Action; entity?: { team: string | null } | null }) {
  const teamTitle = useTeamTitle();
  const { who, ask } = runAccess(action, teamTitle, entity);
  return (
    <Popover position="bottom-end" withArrow width={300}>
      <Popover.Target>
        <Button size="xs" variant="default" leftSection={<IconLock size={14} />} aria-label={`How to get access to ${action.title}`}>
          Get access
        </Button>
      </Popover.Target>
      <Popover.Dropdown>
        <Stack gap="xs">
          <Text fz="sm" fw={500}>
            You cannot run this action
          </Text>
          {who.length > 0 && (
            <>
              <Text fz="xs" c="dimmed">
                Who can run it
              </Text>
              <List size="sm" spacing="4xs">
                {who.map((w) => (
                  <List.Item key={w}>{w}</List.Item>
                ))}
              </List>
            </>
          )}
          <Text fz="sm">{ask}</Text>
        </Stack>
      </Popover.Dropdown>
    </Popover>
  );
}
