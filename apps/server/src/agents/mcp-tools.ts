import { createHash } from 'node:crypto';
import type Anthropic from '@anthropic-ai/sdk';
import { errorMessage } from '../lib/errors.js';
import { StepError, truncate, type Logger } from '../ai/model.js';
import { findMcpServerDef } from './mcp-servers.js';
import { connectMcp, type McpSession } from './mcp-client.js';

/**
 * Tools of registered MCP servers offered to an AI agent step (`tools: [mcp]`, `guardrails.mcpTools: [server/tool]`).
 * Fail closed: an unknown or disabled server, or a tool the server's allow-list does not name, fails the step before the
 * model is called; a tool the server does not offer is left out. Only the tools resolved here can be called.
 */

export interface McpBinding {
  defs: Anthropic.Beta.BetaTool[];
  /** `server/tool` behind a model-facing tool name (undefined: not an MCP tool of this step). */
  target(name: string): string | undefined;
  call(name: string, input: Record<string, unknown>): Promise<string>;
}

const MAX_NAME = 64;

/** Model-facing name: `mcp_<server>_<tool>`, restricted to [A-Za-z0-9_-] and 64 characters. */
export function mcpToolName(server: string, tool: string): string {
  const raw = `mcp_${server}_${tool}`.replace(/[^A-Za-z0-9_-]/g, '_');
  if (raw.length <= MAX_NAME) return raw;
  const h = createHash('sha256').update(`${server}/${tool}`).digest('hex').slice(0, 8);
  return `${raw.slice(0, MAX_NAME - 9)}_${h}`;
}

export async function mcpBinding(refs: string[], log: Logger): Promise<McpBinding> {
  const byServer = new Map<string, string[]>();
  for (const r of refs) {
    const i = r.indexOf('/');
    const server = r.slice(0, i);
    byServer.set(server, [...(byServer.get(server) ?? []), r.slice(i + 1)]);
  }
  const defs: McpBinding['defs'] = [];
  const bound = new Map<string, { session: McpSession; server: string; tool: string }>();
  for (const [server, tools] of byServer) {
    const def = await findMcpServerDef(server);
    if (!def) throw new StepError(`MCP server "${server}" is not registered (Admin > MCP servers)`, false);
    if (!def.enabled) throw new StepError(`MCP server "${server}" is disabled`, false);
    const refused = tools.filter((t) => !def.tools.includes(t));
    if (refused.length)
      throw new StepError(`MCP server "${server}" does not allow ${refused.map((t) => `"${t}"`).join(', ')} (allowed: ${def.tools.join(', ')})`, false);
    let session: McpSession;
    let listed: Awaited<ReturnType<McpSession['listTools']>>;
    try {
      session = await connectMcp(def);
      listed = await session.listTools();
    } catch (err) {
      throw new StepError(`MCP server "${server}": ${errorMessage(err)}`, true);
    }
    for (const tool of new Set(tools)) {
      const t = listed.find((x) => x.name === tool);
      if (!t) {
        await log(`MCP server "${server}" does not offer the tool "${tool}": left out`, 'warn');
        continue;
      }
      const name = mcpToolName(server, tool);
      if (bound.has(name)) continue;
      bound.set(name, { session, server, tool });
      const schema = t.inputSchema && t.inputSchema.type === 'object' ? t.inputSchema : { type: 'object', properties: {} };
      defs.push({
        name,
        description: `[${def.title}] ${t.description ?? tool}`.slice(0, 1024),
        input_schema: schema as Anthropic.Beta.BetaTool['input_schema'],
      });
    }
  }
  return {
    defs,
    target: (name) => {
      const b = bound.get(name);
      return b ? `${b.server}/${b.tool}` : undefined;
    },
    async call(name, input) {
      const b = bound.get(name);
      if (!b) throw new Error(`Unknown tool ${name}`);
      const r = await b.session.callTool(b.tool, input);
      if (r.isError) throw new Error(truncate(r.text || `${b.server}/${b.tool} failed`));
      return truncate(r.text);
    },
  };
}
