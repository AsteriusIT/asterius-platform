import { useState } from 'react';
import { ActionIcon, Badge, Button, Code, Group, Modal, NumberInput, Stack, Text, TextInput, Tooltip } from '@mantine/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import { IconHistory, IconKey, IconListDetails, IconPlugConnected, IconTrash } from '@tabler/icons-react';
import type { Agent, ApiToken, McpServer } from '@asterius/shared';
import { api, errorText } from '../../lib/api';
import { useAppMutation } from '../../lib/queryClient';
import { DataTable } from '../../components/DataTable';
import { ErrorAlert, Loading, TimeAgo } from '../../components/ui';
import { ResourceAdmin, strip } from './ResourceAdmin';
import { NewTokenAlert } from '../Profile';

/** Badges of an allow-list; an empty list allows nothing. */
export function AllowList({ items, none = 'none' }: { items: string[]; none?: string }) {
  if (!items.length)
    return (
      <Badge color="red" variant="light">
        {none}
      </Badge>
    );
  return (
    <Group gap="3xs">
      {items.slice(0, 4).map((i) => (
        <Badge key={i} color="gray" variant="light">
          {i === '*' ? 'all' : i}
        </Badge>
      ))}
      {items.length > 4 && <Text fz="xs" c="dimmed">{`+${items.length - 4}`}</Text>}
    </Group>
  );
}

/** Issue tokens bound to an agent (shown once) and revoke them. */
function AgentTokens({ agent, onClose }: { agent: Agent; onClose: () => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState(`${agent.title} token`);
  const [days, setDays] = useState<number | string>(90);
  const [created, setCreated] = useState<string | null>(null);
  const tokens = useQuery({ queryKey: ['agent-tokens', agent.identifier], queryFn: () => api.agentTokens(agent.identifier) });
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['agent-tokens', agent.identifier] });
    void qc.invalidateQueries({ queryKey: ['agents'] });
  };
  const create = useMutation({
    mutationFn: () => api.createAgentToken(agent.identifier, { name, expiresInDays: typeof days === 'number' ? days : null }),
    onSuccess: (r) => {
      setCreated(r.token);
      refresh();
    },
  });
  const revoke = useAppMutation({ mutationFn: (t: ApiToken) => api.deleteToken(t.id), onSuccess: refresh });
  return (
    <Modal opened onClose={onClose} title={`Tokens of ${agent.title}`} size="lg">
      <Stack>
        <Text fz="sm" c="dimmed">
          A token acts as you, narrowed to this agent&apos;s workflows and blueprints. Use it on the API or the MCP endpoint (
          <Code>Authorization: Bearer ast_…</Code>). It can never approve.
        </Text>
        <Group align="flex-end">
          <TextInput label="Name" value={name} onChange={(e) => setName(e.currentTarget.value)} flex={1} />
          <NumberInput label="Expires in (days)" min={1} max={730} value={days} onChange={setDays} w={160} />
          <Button disabled={!name.trim() || !agent.enabled} loading={create.isPending} onClick={() => create.mutate()}>
            Issue token
          </Button>
        </Group>
        {create.error && (
          <Text c="red" fz="sm">
            {errorText(create.error)}
          </Text>
        )}
        <NewTokenAlert token={created} onClose={() => setCreated(null)} />
        <DataTable
          rows={tokens.data}
          loading={tokens.isPending}
          error={tokens.error}
          rowKey={(t) => t.id}
          empty="No tokens for this agent"
          columns={[
            { key: 'n', label: 'Name', render: (t) => t.name },
            { key: 'p', label: 'Token', render: (t) => <Code>{t.prefix}…</Code> },
            { key: 'u', label: 'Acts as', render: (t) => t.userName },
            { key: 'e', label: 'Expires', render: (t) => (t.expiresAt ? <TimeAgo at={t.expiresAt} /> : <Badge color="gray">never</Badge>) },
            { key: 'l', label: 'Last used', render: (t) => <TimeAgo at={t.lastUsedAt} /> },
            {
              key: 'x',
              label: '',
              width: 60,
              render: (t) => (
                <ActionIcon variant="subtle" color="red" aria-label="Revoke" onClick={() => revoke.mutate(t)}>
                  <IconTrash size={16} />
                </ActionIcon>
              ),
            },
          ]}
        />
      </Stack>
    </Modal>
  );
}

const AGENT_HELP = (
  <Text fz="xs" c="dimmed">
    An agent authenticates with tokens bound to it (Tokens button), or as an OAuth MCP client whose client id is listed in <Code>oauthClients</Code>; a person
    can also act as an agent on the MCP endpoint with the <Code>X-Asterius-Agent</Code> header. Its rights are the user&apos;s, narrowed to{' '}
    <Code>workflows</Code> and <Code>blueprints</Code> (<Code>*</Code>: all); it never approves.
  </Text>
);

export function AgentsAdmin() {
  const navigate = useNavigate();
  const [tokensOf, setTokensOf] = useState<Agent | null>(null);
  return (
    <ResourceAdmin<Agent>
      title="Agents"
      description="AI agents as principals: who owns them, which workflows they may start and which blueprints they may read. Their calls are audited separately."
      queryKey="agents"
      list={api.agents}
      columns={[
        { key: 'o', label: 'Owner team', render: (a) => <Badge color="gray">{a.ownerTeam}</Badge> },
        { key: 'w', label: 'Workflows', render: (a) => <AllowList items={a.workflows} /> },
        { key: 'b', label: 'Blueprints', render: (a) => <AllowList items={a.blueprints} /> },
        { key: 't', label: 'Tokens', render: (a) => a.tokens ?? 0 },
        { key: 'e', label: 'Enabled', render: (a) => (a.enabled ? 'yes' : <Badge color="gray">disabled</Badge>) },
      ]}
      rowActions={(a) => (
        <>
          <Tooltip label="Tokens">
            <ActionIcon variant="subtle" aria-label="Tokens" onClick={() => setTokensOf(a)}>
              <IconKey size={16} />
            </ActionIcon>
          </Tooltip>
          <Tooltip label="Audit log of this agent">
            <ActionIcon variant="subtle" aria-label="Audit log" onClick={() => void navigate(`/admin/audit?agent=${encodeURIComponent(a.identifier)}`)}>
              <IconHistory size={16} />
            </ActionIcon>
          </Tooltip>
          <Tooltip label="Runs started by this agent">
            <ActionIcon variant="subtle" aria-label="Runs" onClick={() => void navigate(`/runs?scope=all&agent=${encodeURIComponent(a.identifier)}`)}>
              <IconListDetails size={16} />
            </ActionIcon>
          </Tooltip>
        </>
      )}
      templates={[
        {
          label: 'Agent',
          value: {
            identifier: 'release-bot',
            title: 'Release bot',
            description: 'Prepares releases from the chat',
            ownerTeam: '',
            workflows: [],
            blueprints: ['*'],
            oauthClients: [],
            enabled: true,
          },
        },
      ]}
      toEditable={(a) => strip(a, ['managed', 'version', 'tokens', 'createdAt', 'updatedAt'])}
      save={api.saveAgent}
      remove={(a) => api.deleteAgent(a.identifier)}
      removeWarning={() => 'Its tokens are revoked: anything using them stops working immediately.'}
      help={AGENT_HELP}
    >
      {tokensOf && <AgentTokens agent={tokensOf} onClose={() => setTokensOf(null)} />}
    </ResourceAdmin>
  );
}

/** Connects to the server and shows its tools against the allow-list. */
function McpServerTest({ server, onClose }: { server: McpServer; onClose: () => void }) {
  const q = useQuery({ queryKey: ['mcp-server-test', server.identifier], queryFn: () => api.testMcpServer(server.identifier), gcTime: 0 });
  return (
    <Modal opened onClose={onClose} title={`Test ${server.title}`} size="lg">
      {q.isPending ? (
        <Loading />
      ) : q.error ? (
        <ErrorAlert error={q.error} />
      ) : (
        <Stack>
          <Text fz="sm" c={q.data.ok ? undefined : 'red'}>
            {q.data.message}
          </Text>
          {q.data.missing.length > 0 && (
            <Text fz="sm" c="orange">
              Allowed but not offered by the server: {q.data.missing.join(', ')}
            </Text>
          )}
          <DataTable
            rows={q.data.tools}
            rowKey={(t) => t.name}
            empty="The server offers no tools"
            columns={[
              { key: 'n', label: 'Tool', render: (t) => <Code>{t.name}</Code> },
              { key: 'd', label: 'Description', render: (t) => <Text fz="sm">{t.description ?? ''}</Text> },
              { key: 'a', label: 'Agent steps', render: (t) => (t.allowed ? <Badge color="green">allowed</Badge> : <Badge color="gray">not allowed</Badge>) },
            ]}
          />
        </Stack>
      )}
    </Modal>
  );
}

const MCP_HELP = (
  <Text fz="xs" c="dimmed">
    The platform calls the server (Streamable HTTP) through its SSRF guard. Credentials are references only (<Code>{'${secret:NAME}'}</Code>). An AI agent step
    uses a tool when it lists <Code>mcp</Code> in <Code>tools</Code> and <Code>server/tool</Code> in <Code>guardrails.mcpTools</Code>, and the tool is in{' '}
    <Code>tools</Code> here; each call counts as a write.
  </Text>
);

export function McpServersAdmin() {
  const [testing, setTesting] = useState<McpServer | null>(null);
  return (
    <ResourceAdmin<McpServer>
      title="MCP servers"
      description="External MCP servers whose allow-listed tools AI agent steps may call."
      queryKey="mcp-servers"
      list={api.mcpServers}
      columns={[
        {
          key: 'u',
          label: 'URL',
          render: (s) => (
            <Text fz="sm" truncate maw={280}>
              {s.url}
            </Text>
          ),
        },
        { key: 't', label: 'Allowed tools', render: (s) => <AllowList items={s.tools} /> },
        { key: 'a', label: 'Auth', render: (s) => s.auth?.type ?? '—' },
        { key: 'e', label: 'Enabled', render: (s) => (s.enabled ? 'yes' : <Badge color="gray">disabled</Badge>) },
      ]}
      rowActions={(s) => (
        <Tooltip label="Test: list the server's tools">
          <ActionIcon variant="subtle" aria-label="Test" onClick={() => setTesting(s)}>
            <IconPlugConnected size={16} />
          </ActionIcon>
        </Tooltip>
      )}
      templates={[
        {
          label: 'MCP server',
          value: {
            identifier: 'tickets',
            title: 'Ticketing',
            description: '',
            url: 'https://mcp.example.com/mcp',
            auth: { type: 'bearer', token: '${secret:tickets-mcp-token}' },
            tools: ['search_issues'],
            timeoutSeconds: 30,
            enabled: true,
          },
        },
      ]}
      toEditable={(s) => strip(s, ['managed', 'version', 'createdAt', 'updatedAt'])}
      save={api.saveMcpServer}
      remove={(s) => api.deleteMcpServer(s.identifier)}
      help={MCP_HELP}
    >
      {testing && <McpServerTest server={testing} onClose={() => setTesting(null)} />}
    </ResourceAdmin>
  );
}
