import type { McpServer, McpServerTestResult } from '@asterius/shared';
import { all, bool, json, now, one, run } from '../db.js';
import { badRequest, conflict, errorMessage, HttpError, managedError, notFound } from '../lib/errors.js';
import { assertUrlAllowed } from '../lib/netguard.js';
import { CREDENTIAL_REF, mcpServerDef, type McpServerDef } from '../schemas.js';
import { orgId } from '../orgs/context.js';
import { connectMcp } from './mcp-client.js';

/**
 * External MCP servers (admin API or CONFIG_DIR `mcpServers:`): Streamable HTTP servers whose tools AI agent steps may
 * call. The platform is the MCP client (agents/mcp-client.ts): every call goes through lib/http.ts (SSRF guard, timeouts)
 * with the server's auth rendered from secret references. Two allow-lists apply, both fail closed: the server's `tools`
 * and the step's `guardrails.mcpTools`; a tool missing from either is never offered to the model.
 */

interface Row {
  identifier: string;
  title: string;
  description: string;
  url: string;
  auth: string | null;
  tools: string;
  timeout_seconds: number;
  enabled: number;
  version: number;
  managed: number;
  created_at: string;
  updated_at: string;
}

const defOf = (r: Row): McpServerDef => ({
  identifier: r.identifier,
  title: r.title,
  description: r.description,
  url: r.url,
  auth: json(r.auth, null),
  tools: json(r.tools, []),
  timeoutSeconds: Number(r.timeout_seconds),
  enabled: bool(r.enabled),
});

const toServer = (r: Row): McpServer => ({
  ...(defOf(r) as McpServer),
  version: Number(r.version),
  managed: bool(r.managed),
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export async function listMcpServers(): Promise<McpServer[]> {
  return (await all<Row>('SELECT * FROM mcp_servers WHERE org_id = ? ORDER BY title', orgId())).map(toServer);
}

const findRow = (id: string) => one<Row>('SELECT * FROM mcp_servers WHERE org_id = ? AND identifier = ?', orgId(), id);

export async function getMcpServer(id: string): Promise<McpServer> {
  const r = await findRow(id);
  if (!r) throw notFound(`MCP server ${id}`);
  return toServer(r);
}

/** The definition of a server, or undefined (agent steps check existence and `enabled` themselves). */
export async function findMcpServerDef(id: string): Promise<McpServerDef | undefined> {
  const r = await findRow(id);
  return r ? defOf(r) : undefined;
}

const ref = (v: unknown) => typeof v === 'string' && CREDENTIAL_REF.test(v.trim());

/** Credentials are references, never values. */
function checkAuth(a: McpServerDef['auth']) {
  if (!a) return;
  const fail = (k: string) => {
    throw badRequest(`auth.${k}: credentials must be references (\${secret:NAME}, \${vault:…}, \${env:NAME}…), never values`);
  };
  if (a.type === 'bearer' && !ref(a.token)) fail('token');
  if (a.type === 'basic' && !ref(a.password)) fail('password');
  if (a.type === 'oauth2-client-credentials' && !ref(a.clientSecret)) fail('clientSecret');
  if (a.type === 'header') for (const [k, v] of Object.entries(a.headers)) if (!ref(v)) fail(`headers.${k}`);
}

export async function upsertMcpServer(
  input: unknown,
  opts: { managed?: boolean; ifMatch?: number } = {},
): Promise<{ server: McpServer; created: boolean; changed: boolean }> {
  const parsed = mcpServerDef.safeParse(input);
  if (!parsed.success) throw badRequest(parsed.error.issues.map((i) => `${i.path.join('.') || 'server'}: ${i.message}`).join('; '));
  const s = parsed.data;
  checkAuth(s.auth);
  try {
    assertUrlAllowed(s.url);
  } catch (err) {
    throw badRequest(`url: ${errorMessage(err)}`);
  }
  const org = orgId();
  const existing = await findRow(s.identifier);
  if (existing && bool(existing.managed) && !opts.managed) throw managedError('MCP server', s.identifier);
  if (opts.ifMatch !== undefined && (existing ? Number(existing.version) : undefined) !== opts.ifMatch)
    throw new HttpError(412, `MCP server ${s.identifier} is at version ${existing ? existing.version : 'none'}, not ${opts.ifMatch}; reload and retry`, {
      conflict: { currentVersion: existing ? Number(existing.version) : null, changedBy: null, changedAt: existing?.updated_at ?? null },
    });
  const vals = [
    s.title,
    s.description,
    s.url,
    s.auth ? JSON.stringify(s.auth) : null,
    JSON.stringify([...new Set(s.tools)]),
    s.timeoutSeconds,
    s.enabled ? 1 : 0,
    opts.managed ? 1 : 0,
  ];
  const changed = !existing || JSON.stringify(defOf(existing)) !== JSON.stringify({ ...s, auth: s.auth ?? null, tools: [...new Set(s.tools)] });
  const t = now();
  if (existing) {
    const { changes } = await run(
      'UPDATE mcp_servers SET title = ?, description = ?, url = ?, auth = ?, tools = ?, timeout_seconds = ?, enabled = ?, managed = ?, version = ?, updated_at = ? WHERE org_id = ? AND identifier = ? AND version = ?',
      ...vals,
      Number(existing.version) + (changed ? 1 : 0),
      changed ? t : existing.updated_at,
      org,
      s.identifier,
      Number(existing.version),
    );
    if (!changes) throw conflict('The MCP server was changed by someone else meanwhile; reload and try again');
  } else
    await run(
      'INSERT INTO mcp_servers (title, description, url, auth, tools, timeout_seconds, enabled, managed, version, created_at, updated_at, org_id, identifier) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)',
      ...vals,
      t,
      t,
      org,
      s.identifier,
    );
  return { server: await getMcpServer(s.identifier), created: !existing, changed };
}

export async function deleteMcpServer(id: string, opts: { managed?: boolean } = {}) {
  const r = await findRow(id);
  if (!r) throw notFound(`MCP server ${id}`);
  if (bool(r.managed) && !opts.managed) throw managedError('MCP server', id);
  await run('DELETE FROM mcp_servers WHERE org_id = ? AND identifier = ?', orgId(), id);
}

/** Connect, list the server's tools and compare them with the allow-list (Admin > MCP servers > Test). */
export async function testMcpServer(id: string): Promise<McpServerTestResult> {
  const def = defOf((await findRow(id)) ?? (await Promise.reject(notFound(`MCP server ${id}`))));
  try {
    const session = await connectMcp(def);
    const tools = await session.listTools();
    const names = new Set(tools.map((t) => t.name));
    return {
      ok: true,
      message: `Connected: ${tools.length} tool(s), ${tools.filter((t) => def.tools.includes(t.name)).length} allowed`,
      server: session.info,
      tools: tools.map((t) => ({ name: t.name, description: t.description, allowed: def.tools.includes(t.name) })),
      missing: def.tools.filter((t) => !names.has(t)),
    };
  } catch (err) {
    return { ok: false, message: errorMessage(err), tools: [], missing: [] };
  }
}
