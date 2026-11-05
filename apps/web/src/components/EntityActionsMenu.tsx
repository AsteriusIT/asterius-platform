import { ActionIcon, Menu, Text } from '@mantine/core';
import { IconDots, IconShieldCheck } from '@tabler/icons-react';
import type { Action, Entity, PublicUser } from '@asterius/shared';
import { canRunOn } from '../lib/permissions';
import { EntityIcon } from './icons';

/**
 * "⋯" menu of the actions that run on one entity (day-2 first, delete actions last in red).
 * Actions the user may not run stay visible but disabled, so people know they exist.
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
  const day2 = actions.filter((a) => a.trigger?.on === 'day-2');
  const deletes = actions.filter((a) => a.trigger?.on === 'delete');
  if (!day2.length && !deletes.length) return null;

  const item = (a: Action) => {
    const allowed = canRunOn(a, user, entity.team);
    return (
      <Menu.Item
        key={a.identifier}
        color={a.trigger?.on === 'delete' ? 'red' : undefined}
        leftSection={<EntityIcon name={a.icon} size={16} />}
        rightSection={
          a.trigger?.approval.required ? <IconShieldCheck size={14} color="var(--mantine-color-yellow-6)" aria-label="Requires approval" /> : undefined
        }
        disabled={!allowed}
        title={allowed ? a.description : 'You are not allowed to run this action'}
        onClick={() => onRun(a)}
      >
        {a.title}
      </Menu.Item>
    );
  };

  return (
    // Rows are clickable: keep clicks on the menu from opening the entity.
    <div onClick={(e) => e.stopPropagation()}>
      <Menu position="bottom-end" width={240} withinPortal>
        <Menu.Target>
          <ActionIcon variant="subtle" color="gray" aria-label={`Actions on ${entity.title}`} title="Actions">
            <IconDots size={18} />
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
