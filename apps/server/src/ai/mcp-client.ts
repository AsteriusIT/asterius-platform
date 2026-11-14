import { http } from '../lib/http.js';

/**
 * A minimal MCP client (Streamable HTTP transport, protocol 2025-06-18) for the `mcp` tool of AI agent steps
 * (ai/mcp-tools.ts): it talks to the MCP gateway or server a connection points at. Requests go through lib/http.ts: SSRF
 * guard on every connection, a timeout, no redirects, no retries (tool calls may have effects). Responses may be JSON or
 * a server-sent event stream; the session id the server returns at initialization is sent back on every later request.
 */

/** Where to connect: the endpoint and the auth block of a resolved connection (secrets already resolved). */
export interface McpEndpoint {
  url: string;
  /** Passed as `auth` to lib/http.ts. */
  auth?: unknown;
  /** Extra headers (the connector definition's). */
  headers?: Record<string, string>;
  timeoutMs: number;
}

export const MCP_CLIENT_PROTOCOL = '2025-06-18';

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface McpSession {
  info: { name?: string; version?: string; protocolVersion?: string };
  listTools(): Promise<McpTool[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }>;
}

interface RpcMessage {
  jsonrpc?: string;
  id?: string | number | null;
  result?: Record<string, unknown>;
  error?: { code?: number; message?: string };
}

/** The JSON-RPC answer to request `id`, from a JSON body or a server-sent event stream. */
export function rpcAnswer(data: unknown, text: string, contentType: string, id: number): RpcMessage {
  const pick = (m: unknown): RpcMessage | undefined => {
    if (Array.isArray(m)) return m.map(pick).find(Boolean);
    const msg = m as RpcMessage | null;
    return msg && typeof msg === 'object' && msg.id === id && (msg.result !== undefined || msg.error !== undefined) ? msg : undefined;
  };
  if (contentType.includes('text/event-stream')) {
    for (const event of text.split(/\r?\n\r?\n/)) {
      const payload = event
        .split(/\r?\n/)
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).trimStart())
        .join('\n');
      if (!payload) continue;
      try {
        const hit = pick(JSON.parse(payload));
        if (hit) return hit;
      } catch {
        // not JSON: skip
      }
    }
    throw new Error('The MCP server answered with an event stream without the response');
  }
  const hit = pick(typeof data === 'string' ? safeJson(data) : data);
  if (!hit) throw new Error(`The MCP server returned no JSON-RPC response (${text.slice(0, 200)})`);
  return hit;
}

const safeJson = (t: string): unknown => {
  try {
    return JSON.parse(t);
  } catch {
    return undefined;
  }
};

const MAX_TOOL_PAGES = 10;

/** Text of a tool result: text parts as they are, other parts (images, resources, structured content) as JSON. */
export function resultText(result: Record<string, unknown>): string {
  const content = Array.isArray(result.content) ? (result.content as { type?: string; text?: string }[]) : [];
  const parts = content.map((c) => (c.type === 'text' && typeof c.text === 'string' ? c.text : JSON.stringify(c)));
  if (!parts.length && result.structuredContent !== undefined) parts.push(JSON.stringify(result.structuredContent));
  return parts.join('\n');
}

/** Open a session with a server: initialize, then the `initialized` notification. */
export async function connectMcp(def: McpEndpoint): Promise<McpSession> {
  /** Session id returned at initialization, sent back on every later request. */
  const session: { id?: string } = {};
  let protocol = MCP_CLIENT_PROTOCOL;
  let seq = 0;
  const post = async (method: string, params: Record<string, unknown> | undefined, notification = false) => {
    const id = ++seq;
    const res = await http<unknown>(def.url, {
      method: 'POST',
      headers: {
        ...def.headers,
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
        'mcp-protocol-version': protocol,
        ...(session.id ? { 'mcp-session-id': session.id } : {}),
      },
      body: JSON.stringify({ jsonrpc: '2.0', ...(notification ? {} : { id }), method, ...(params ? { params } : {}) }),
      auth: def.auth,
      timeoutMs: def.timeoutMs,
      redirect: 'error',
      retry: false,
    });
    if (notification) return undefined;
    const msg = rpcAnswer(res.data, res.text, res.headers.get('content-type') ?? '', id);
    if (msg.error) throw new Error(`MCP ${method} failed: ${msg.error.message ?? 'error'}${msg.error.code !== undefined ? ` (${msg.error.code})` : ''}`);
    return { result: msg.result ?? {}, headers: res.headers };
  };

  const init = (await post('initialize', {
    protocolVersion: MCP_CLIENT_PROTOCOL,
    capabilities: {},
    clientInfo: { name: 'asterius-platform', version: '1' },
  }))!;
  session.id = init.headers.get('mcp-session-id') ?? undefined;
  if (typeof init.result.protocolVersion === 'string') protocol = init.result.protocolVersion;
  await post('notifications/initialized', undefined, true);
  const serverInfo = (init.result.serverInfo ?? {}) as { name?: string; version?: string };

  return {
    info: { name: serverInfo.name, version: serverInfo.version, protocolVersion: protocol },
    async listTools() {
      const out: McpTool[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < MAX_TOOL_PAGES; page++) {
        const { result } = (await post('tools/list', cursor ? { cursor } : {}))!;
        for (const t of (Array.isArray(result.tools) ? result.tools : []) as McpTool[])
          if (t && typeof t.name === 'string') out.push({ name: t.name, description: t.description, inputSchema: t.inputSchema });
        cursor = typeof result.nextCursor === 'string' && result.nextCursor ? result.nextCursor : undefined;
        if (!cursor) break;
      }
      return out;
    },
    async callTool(name, args) {
      const { result } = (await post('tools/call', { name, arguments: args }))!;
      return { text: resultText(result), isError: result.isError === true };
    },
  };
}
