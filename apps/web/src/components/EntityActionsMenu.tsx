import { ActionIcon, Menu, Text } from '@mantine/core';
import { IconDots, IconShieldCheck } from '@tabler/icons-react';
import type { Action, Entity, PublicUser } from '@asterius/shared';
import { canRunOn, formOf, runAccess } from '../lib/permissions';
import { useTeamTitle } from './RunAccess';
import { EntityIcon } from './icons';
import { ICON } from './iconScale';

/**
 * "⋯" menu of the actions that run on one entity (day-2 first, delete actions last in red).
 * Actions the user may not run stay visible but disabled, so people know they exist, with who can run them.
 */
export function EntityActionsMenu({
  entity,
  actions,
  user,
  onRun,
}: {
  entity: Entity;
  actions: Action[];
  user: PublicUser | null;
  onRun: (a: Action) => void;
}) {
  const day2 = actions.filter((a) => formOf(a)?.on === 'day-2');
  const deletes = actions.filter((a) => formOf(a)?.on === 'delete');
  const teamTitle = useTeamTitle();
  if (!day2.length && !deletes.length) return null;

  const item = (a: Action) => {
    const allowed = canRunOn(a, user, entity.team);
    const access = allowed ? null : runAccess(a, teamTitle, entity);
    return (
      <Menu.Item
        key={a.identifier}
        color={formOf(a)?.on === 'delete' ? 'red' : undefined}
        leftSection={<EntityIcon name={a.icon} size={16} />}
        rightSection={
          formOf(a)?.approval.required ? <IconShieldCheck size={ICON.sm} color="var(--mantine-color-yellow-6)" aria-label="Requires approval" /> : undefined
        }
        disabled={!allowed}
        title={access ? `You cannot run this action. ${[access.who.join(' · '), access.ask].filter(Boolean).join('. ')}` : a.description}
        onClick={() => onRun(a)}
      >
        {a.title}
        {access && (
          <Text fz="xs" c="dimmed">
            {access.who.length ? `Who can run it: ${access.who.join(' · ')}` : access.ask}
          </Text>
        )}
      </Menu.Item>
    );
  };

  return (
    // Rows are clickable: keep clicks on the menu from opening the entity.
    <div onClick={(e) => e.stopPropagation()}>
      <Menu position="bottom-end" width={240} withinPortal>
        <Menu.Target>
          <ActionIcon variant="subtle" color="gray" aria-label={`Actions on ${entity.title}`} title="Actions">
            <IconDots size={ICON.lg} />
          </ActionIcon>
        </Menu.Target>
        <Menu.Dropdown>
          <Menu.Label>
            <Text fz="xs" c="dimmed" truncate>
              {entity.title}
            </Text>
          </Menu.Label>
          {day2.map(item)}
          {day2.length > 0 && deletes.length > 0 && <Menu.Divider />}
          {deletes.map(item)}
        </Menu.Dropdown>
      </Menu>
    </div>
  );
}
