import { Badge } from '@mantine/core';
import { channelLabel } from '../lib/channels';

/** The channel an audit entry or a run came through: web UI, API token, MCP or an AI agent step. */
export function ViaBadge({ channel }: { channel?: string | null }) {
  return (
    <Badge color="gray" variant="light">
      {channelLabel(channel)}
    </Badge>
  );
}
