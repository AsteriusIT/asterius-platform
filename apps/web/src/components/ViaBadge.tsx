import { Badge, Group, Tooltip } from '@mantine/core';
import { IconRobot } from '@tabler/icons-react';
import { channelLabel, viaText } from '../lib/agents';

/** The channel of an audit entry or a run, and the AI agent that acted (highlighted). */
export function ViaBadge({ channel, agent }: { channel?: string | null; agent?: string | null }) {
  return (
    <Tooltip label={viaText({ channel, agent })}>
      <Group gap="3xs" wrap="nowrap">
        {agent ? (
          <Badge color="grape" variant="light" leftSection={<IconRobot size={12} />}>
            {agent}
          </Badge>
        ) : null}
        <Badge color="gray" variant="light">
          {channelLabel(channel)}
        </Badge>
      </Group>
    </Tooltip>
  );
}
