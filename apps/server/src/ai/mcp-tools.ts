import { createHash } from 'node:crypto';
import type Anthropic from '@anthropic-ai/sdk';
import { badRequest, errorMessage, HttpError } from '../lib/errors.js';
import { redact } from '../lib/expr.js';
import { assertConnectionUse, getConnection, resolveConnection, type ResolvedConnection } from '../integrations/connectors/connections.js';
import { baseUrlOf } from '../integrations/connectors/request.js';
import { StepError, truncate } from './model.js';
import { connectMcp, type McpSession, type McpTool } from './mcp-client.js';

/**
 * The `mcp` tool of AI agent steps: tools of an external MCP gateway or server, reached through a connection.
 *
 *   tools: [mcp]
 *   mcp: { connection: mcp-gateway }          # a connection of the built-in `mcp` connector
 *   guardrails: { mcpTools: [search_issues] } # the only tools offered to the model
 *
 * The connection holds the endpoint and the credentials (secret references) and says who may use it: MCP tools can
 * change things, so it must be `access: read-write` and its `allowed` workflows / teams must match the run. Fail closed:
 * a connection the workflow may not use, or an allow-listed tool the server does not offer, fails the step before the
 * model is called; the model can call nothing outside `guardrails.mcpTools`.
 */

/** The connector definition MCP connections are made of (apps/server/connectors/mcp.yaml). */
export const MCP_CONNECTOR = 'mcp';

export interface McpBinding {
  defs: Anthropic.Beta.BetaTool[];
  /** `connection/tool` behind a model-facing tool name (undefined: not an MCP tool of this step). */
  target(name: string): string | undefined;
  call(name: string, input: Record<string, unknown>): Promise<string>;
}

const MAX_NAME = 64;

/** Model-facing name: `mcp_<tool>`, restricted to [A-Za-z0-9_-] and 64 characters. */
export function mcpToolName(tool: string): string {
  const raw = `mcp_${tool}`.replace(/[^A-Za-z0-9_-]/g, '_');
  if (raw.length <= MAX_NAME) return raw;
  const h = createHash('sha256').update(tool).digest('hex').slice(0, 8);
  return `${raw.slice(0, MAX_NAME - 9)}_${h}`;
}

/** Save-time check of an agent step using `mcp`: the connection exists, is an MCP one, is read-write and allows the workflow. */
export async function checkMcpConnection(id: string, workflow: string) {
  const conn = await getConnection(id).catch((err: unknown) => {
    throw err instanceof HttpError && err.statusCode === 404 ? badRequest(`mcp: unknown connection "${id}"`) : err;
  });
  if (conn.connector !== MCP_CONNECTOR)
    throw badRequest(`mcp: "${id}" is a ${conn.connector} connection; use a connection of the "${MCP_CONNECTOR}" connector`);
  try {
    assertConnectionUse(conn, { write: true, workflow });
  } catch (err) {
    // Team allow-lists are checked when the run starts (its team is not known yet).
    if (conn.access !== 'read-write' || !conn.allowed.teams?.length) throw badRequest(`mcp: ${errorMessage(err)}`);
  }
}

/** Resolve the step's connection and its allow-listed tools; nothing is called yet. */
export async function mcpBinding(connection: string, tools: string[], use: { workflow: string; team: string | null }): Promise<McpBinding> {
  let conn: ResolvedConnection;
  try {
    conn = await resolveConnection(connection);
    if (conn.connector.identifier !== MCP_CONNECTOR) throw new Error(`"${connection}" is not a connection of the "${MCP_CONNECTOR}" connector`);
    assertConnectionUse(conn, { write: true, ...use });
  } catch (err) {
    throw new StepError(`MCP connection "${connection}": ${errorMessage(err)}`, false);
  }
  const clean = (text: string) => redact(text, conn.secrets);
  let session: McpSession;
  let listed: McpTool[];
  try {
    session = await connectMcp({
      url: baseUrlOf(conn.fields).href,
      auth: conn.auth,
      headers: conn.connector.headers,
      timeoutMs: (Number(conn.fields.timeoutSeconds) || 30) * 1000,
    });
    listed = await session.listTools();
  } catch (err) {
    throw new StepError(`MCP connection "${connection}": ${clean(errorMessage(err))}`, true);
  }
  const defs: McpBinding['defs'] = [];
  const bound = new Map<string, string>();
  for (const tool of new Set(tools)) {
    const t = listed.find((x) => x.name === tool);
    if (!t) throw new StepError(`MCP connection "${connection}" does not offer the tool "${tool}" (guardrails.mcpTools)`, false);
    const name = mcpToolName(tool);
    bound.set(name, tool);
    const schema = t.inputSchema && t.inputSchema.type === 'object' ? t.inputSchema : { type: 'object', properties: {} };
    defs.push({
      name,
      description: `[${conn.title}] ${t.description ?? tool}`.slice(0, 1024),
      input_schema: schema as Anthropic.Beta.BetaTool['input_schema'],
    });
  }
  return {
    defs,
    target: (name) => (bound.has(name) ? `${connection}/${bound.get(name)}` : undefined),
    async call(name, input) {
      const tool = bound.get(name);
      if (!tool) throw new Error(`Unknown tool ${name}`);
      const r = await session.callTool(tool, input).catch((err: unknown) => {
        throw new Error(clean(errorMessage(err)));
      });
      if (r.isError) throw new Error(truncate(clean(r.text) || `${tool} failed`));
      return truncate(clean(r.text));
    },
  };
}
