import { z } from 'zod';
import type { Principal } from '../auth/users.js';
import { canTrigger, forViewer, getAction, isRunnable, listActions } from '../actions/actions.js';
import { getRun, listRuns, triggerRun } from '../actions/runs.js';
import { runCatalogTool } from './tools.js';
import { truncate } from './model.js';
import { errorMessage } from '../lib/errors.js';

/**
 * The platform as a Model Context Protocol server (Streamable HTTP transport, stateless JSON responses).
 * Callers authenticate with an API token and act with that user's permissions: the catalog is readable,
 * actions are started (and runs read) exactly as through the API.
 */

const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, unknown>;
  run: (input: Record<string, unknown>, p: Principal) => Promise<unknown>;
}

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });

const TOOLS: ToolDef[] = [
  {
    name: 'list_blueprints',
    description: 'List the kinds of entities in the software catalog (blueprints) with their properties and relations.',
    inputSchema: obj({}),
    annotations: { readOnlyHint: true },
    run: (i) => runCatalogTool('list_blueprints', i),
  },
  {
    name: 'search_catalog',
    description: 'Search catalog entities by name or identifier, optionally within one blueprint (up to 10 results).',
    inputSchema: obj({ query: { type: 'string' }, blueprint: { type: 'string' } }, ['query']),
    annotations: { readOnlyHint: true },
    run: (i) => runCatalogTool('search_catalog', i),
  },
  {
    name: 'get_entity',
    description: 'Get one catalog entity by blueprint and identifier.',
    inputSchema: obj({ blueprint: { type: 'string' }, identifier: { type: 'string' } }, ['blueprint', 'identifier']),
    annotations: { readOnlyHint: true },
    run: (i) => runCatalogTool('get_entity', i),
  },
  {
    name: 'list_actions',
    description: 'List the self-service actions you may start, with the inputs each one expects.',
    inputSchema: obj({ blueprint: { type: 'string', description: 'Only actions on this blueprint' } }),
    annotations: { readOnlyHint: true },
    run: async (i, p) =>
      (await listActions())
        .filter((a) => isRunnable(a) && canTrigger(a, p, null) && (typeof i.blueprint !== 'string' || a.trigger?.blueprint === i.blueprint))
        .map((a) => {
          const v = forViewer(a, p);
          return {
            identifier: v.identifier,
            title: v.title,
            description: v.description,
            blueprint: v.trigger?.blueprint ?? null,
            on: (v.trigger as { on?: string } | null)?.on ?? null,
            inputs: (v.trigger as { inputs?: unknown } | null)?.inputs ?? null,
          };
        }),
  },
  {
    name: 'trigger_action',
    description: 'Start a self-service action with your permissions. It may wait for approvals; read the run with get_run.',
    inputSchema: obj(
      { action: { type: 'string' }, entity: { type: 'string', description: 'Target entity identifier for day-2 actions' }, inputs: { type: 'object' } },
      ['action'],
    ),
    run: async (i, p) => {
      const a = z.object({ action: z.string().min(1), entity: z.string().nullish(), inputs: z.record(z.string(), z.unknown()).default({}) }).parse(i);
      await getAction(a.action); // 404 for unknown actions
      const r = await triggerRun(p, a.action, { entity: a.entity ?? null, inputs: a.inputs });
      return { runId: r.id, status: r.status, url: `/runs/${r.id}` };
    },
  },
  {
    name: 'list_runs',
    description: 'List recent runs (yours by default).',
    inputSchema: obj({ action: { type: 'string' }, mine: { type: 'boolean' }, limit: { type: 'number' } }),
    annotations: { readOnlyHint: true },
    run: async (i, p) => {
      const page = await listRuns({
        limit: Math.min(Math.max(Number(i.limit) || 10, 1), 50),
        offset: 0,
        action: typeof i.action === 'string' ? i.action : undefined,
        mine: i.mine === false ? undefined : p.id,
      });
      return page.items.map((r) => ({ id: r.id, action: r.action, status: r.status, statusLabel: r.statusLabel, createdAt: r.createdAt }));
    },
  },
  {
    name: 'get_run',
    description: 'Get a run with its steps, outputs and logs.',
    inputSchema: obj({ id: { type: 'string' } }, ['id']),
    annotations: { readOnlyHint: true },
    run: async (i, p) => {
      const r = await getRun(String(i.id ?? ''), p);
      return { ...r, logs: (r.logs ?? []).slice(-100) };
    },
  },
];

export const MCP_TOOL_NAMES = TOOLS.map((t) => t.name);

type Id = string | number | null;
interface Rpc {
  jsonrpc: '2.0';
  id?: Id;
  method: string;
  params?: Record<string, unknown>;
}
type RpcResult = { jsonrpc: '2.0'; id: Id; result: unknown } | { jsonrpc: '2.0'; id: Id; error: { code: number; message: string } };

const rpcSchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.union([z.string(), z.number(), z.null()]).optional(),
  method: z.string(),
  params: z.record(z.string(), z.unknown()).optional(),
});

const err = (id: Id, code: number, message: string): RpcResult => ({ jsonrpc: '2.0', id, error: { code, message } });

async function handleOne(raw: unknown, p: Principal): Promise<RpcResult | undefined> {
  const parsed = rpcSchema.safeParse(raw);
  if (!parsed.success) return err(null, -32600, 'Invalid request');
  const m = parsed.data as Rpc;
  const id = m.id ?? null;
  const notification = m.id === undefined;
  switch (m.method) {
    case 'initialize': {
      const asked = typeof m.params?.protocolVersion === 'string' ? m.params.protocolVersion : '';
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'asterius-platform', version: '1' },
          instructions: 'Search the software catalog, list and start self-service actions, and follow runs. Calls use your permissions.',
        },
      };
    }
    case 'ping':
      return { jsonrpc: '2.0', id, result: {} };
    case 'tools/list':
      return { jsonrpc: '2.0', id, result: { tools: TOOLS.map(({ run: _run, ...t }) => t) } };
    case 'tools/call': {
      const name = typeof m.params?.name === 'string' ? m.params.name : '';
      const tool = TOOLS.find((t) => t.name === name);
      if (!tool) return err(id, -32602, `Unknown tool "${name}"`);
      const args = (m.params?.arguments ?? {}) as Record<string, unknown>;
      try {
        const out = await tool.run(typeof args === 'object' && args ? args : {}, p);
        const text = typeof out === 'string' ? out : JSON.stringify(out);
        return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: truncate(text) }] } };
      } catch (e) {
        // Tool failures are results the model can read, not protocol errors.
        return { jsonrpc: '2.0', id, result: { isError: true, content: [{ type: 'text', text: errorMessage(e) }] } };
      }
    }
    default:
      return notification || m.method.startsWith('notifications/') ? undefined : err(id, -32601, `Method not found: ${m.method}`);
  }
}

/** Handle a JSON-RPC request or batch; undefined when there is nothing to answer (notifications). */
export async function handleMcp(body: unknown, p: Principal): Promise<RpcResult | RpcResult[] | undefined> {
  if (Array.isArray(body)) {
    if (!body.length || body.length > 20) return err(null, -32600, 'Invalid batch');
    const out = (await Promise.all(body.map((b) => handleOne(b, p)))).filter((r): r is RpcResult => !!r);
    return out.length ? out : undefined;
  }
  return handleOne(body, p);
}
