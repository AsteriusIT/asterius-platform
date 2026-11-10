import { Badge, Tooltip, type MantineSize } from '@mantine/core';
import { roleDescription, roleLabel } from '../lib/access';

/** Delegated and custom roles of the user in the current organization, readable, with what each grants on hover. */
export function RoleBadges({ roles, size }: Readonly<{ roles: string[] | undefined; size?: MantineSize }>) {
  return (roles ?? []).map((r) => (
    <Tooltip key={r} label={roleDescription(r)} multiline w={240} withinPortal>
      <Badge size={size} color="teal" variant="light" aria-label={`Role: ${roleLabel(r)}`}>
        {roleLabel(r)}
      </Badge>
    </Tooltip>
  ));
}
