import type { CallChannel } from '@asterius/shared';

/** How a call came in, as shown next to audit entries and runs. */
export const CHANNEL_LABELS: Record<CallChannel, string> = {
  ui: 'Web UI',
  api: 'API token',
  mcp: 'MCP',
  workflow: 'AI agent step',
};

export const channelLabel = (c: string | null | undefined) => (c ? (CHANNEL_LABELS[c as CallChannel] ?? c) : 'Platform');

export const CHANNEL_OPTIONS = Object.entries(CHANNEL_LABELS).map(([value, label]) => ({ value, label }));
