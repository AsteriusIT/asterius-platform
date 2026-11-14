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

/** Agent filter of the audit log and the runs list: `*` any agent, `-` people and the platform, or one agent. */
export function agentFilterOptions(agents: string[]) {
  return [
    { value: '*', label: 'Any AI agent' },
    { value: '-', label: 'People and platform only' },
    ...agents.filter((a) => a !== '*' && a !== '-').map((a) => ({ value: a, label: a })),
  ];
}

/** One-line description of who acted through which channel: "MCP · agent release-bot". */
export function viaText(e: { channel?: string | null; agent?: string | null }) {
  return [channelLabel(e.channel), e.agent ? `agent ${e.agent}` : null].filter(Boolean).join(' · ');
}
