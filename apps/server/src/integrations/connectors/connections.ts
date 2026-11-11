import type { Connection, ConnectionTestResult, ConnectionUsage, ObjectSchema } from '@asterius/shared';
import { all, bool, json, now, one, run } from '../../db.js';
import { badRequest, conflict, errorMessage, forbidden, HttpError, managedError, notFound } from '../../lib/errors.js';
import { redact, render } from '../../lib/expr.js';
import { http, UpstreamError } from '../../lib/http.js';
import { resolveAuth } from '../../lib/auth.js';
import { validator } from '../../catalog/validation.js';
import { resolveRef } from '../../secrets.js';
import { connectionDef, CREDENTIAL_REF, type AuthDef, type ConnectionDef, type ConnectorDef } from '../../schemas.js';
import { orgId } from '../../orgs/context.js';
import { findConnectorDef } from './definitions.js';
import { authBlock, fieldsWithDefaults, placeholdersOf, secretKeysOf, testRequest, testVerdict, type Fields } from './request.js';
import { bindingFor, connectionRef, type ConnectionToken } from './bindings.js';

/**
 * Connections: configured instances of a connector definition, per organization (admin API or CONFIG_DIR). They hold
 * the field values and the auth block (references only). Sources, invokers and workflow steps resolve them when they
 * run: `resolveConnection` renders the auth block (secrets resolved) and applies the field defaults.
 */

// ---------- storage ----------
interface Row {
  identifier: string;
  title: string;
  description: string;
  connector: string;
  fields: string;
  auth: string | null;
  access: string;
  allowed: string;
  api: string | null;
  version: number;
  managed: number;
  created_at: string;
  updated_at: string;
}

const defOf = (r: Row): ConnectionDef => ({
  identifier: r.identifier,
  title: r.title,
  description: r.description,
  connector: r.connector,
  fields: json(r.fields, {}),
  auth: json(r.auth, null),
  access: r.access === 'read-write' ? 'read-write' : 'read',
  allowed: json(r.allowed, {}),
  ...(r.api ? { api: json(r.api, undefined) } : {}),
});

const toConnection = (r: Row): Connection => ({
  ...(defOf(r) as Connection),
  version: Number(r.version),
  managed: bool(r.managed),
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export async function listConnections(): Promise<Connection[]> {
  return (await all<Row>('SELECT * FROM connections WHERE org_id = ? ORDER BY title', orgId())).map(toConnection);
}

async function row(id: string): Promise<Row> {
  const r = await one<Row>('SELECT * FROM connections WHERE org_id = ? AND identifier = ?', orgId(), id);
  if (!r) throw notFound(`Connection ${id}`);
  return r;
}

export async function getConnection(id: string): Promise<Connection> {
  return toConnection(await row(id));
}

// ---------- validation ----------
const hasCredentialRef = (v: unknown): boolean =>
  typeof v === 'string'
    ? /\$\{(secret|env|vault|awssm|azkv|gcpsm|k8s):/.test(v)
    : Array.isArray(v)
      ? v.some(hasCredentialRef)
      : !!v && typeof v === 'object' && Object.values(v).some(hasCredentialRef);

/** Check a connection against its definition; returns the definition and the unrendered auth block. */
export async function validateConnection(c: ConnectionDef, def?: ConnectorDef): Promise<{ def: ConnectorDef; auth?: AuthDef }> {
  def ??= await findConnectorDef(c.connector);
  if (!def) throw badRequest(`Unknown connector "${c.connector}"`);
  const props = def.fields.properties ?? {};
  for (const k of Object.keys(c.fields))
    if (!(k in props)) throw badRequest(`fields: "${k}" is not a field of ${def.identifier} (fields: ${Object.keys(props).join(', ')})`);
  if (hasCredentialRef(c.fields)) throw badRequest('fields: credentials do not belong in fields; put them in auth');
  const fields = fieldsWithDefaults(def, c.fields);
  const check = validator(def.fields as ObjectSchema);
  const copy = structuredClone(fields);
  if (!check(copy)) throw badRequest(`fields: ${(check.errors ?? []).map((e) => `${e.instancePath.slice(1) || 'fields'} ${e.message}`).join('; ')}`);
  if (!c.auth) {
    if (def.auth.length && !def.authOptional) throw badRequest(`auth: ${def.identifier} needs one of ${def.auth.map((m) => m.type).join(', ')}`);
    return { def };
  }
  const method = def.auth.find((m) => m.type === c.auth!.type);
  if (method)
    for (const k of secretKeysOf(method)) {
      const v = (c.auth as Record<string, unknown>)[k];
      if (v === undefined || k in method.set) continue;
      if (typeof v !== 'string' || !CREDENTIAL_REF.test(v.trim()))
        throw badRequest(`auth.${k}: credentials must be references (\${secret:NAME}, \${vault:…}, \${env:NAME}…), never values`);
    }
  if (method?.type === 'header') for (const n of placeholdersOf(method)) if (!(c.auth as Record<string, unknown>)[n]) throw badRequest(`auth: missing "${n}"`);
  return { def, auth: await authBlock(def, c.auth as Record<string, unknown> & { type: string }, fields) };
}

export async function upsertConnection(
  input: unknown,
  opts: { managed?: boolean; ifMatch?: number } = {},
): Promise<{ connection: Connection; created: boolean; changed: boolean }> {
  const parsed = connectionDef.safeParse(input);
  if (!parsed.success) throw badRequest(parsed.error.issues.map((i) => `${i.path.join('.') || 'connection'}: ${i.message}`).join('; '));
  const c = parsed.data;
  await validateConnection(c);
  const org = orgId();
  const existing = await one<Row>('SELECT * FROM connections WHERE org_id = ? AND identifier = ?', org, c.identifier);
  if (existing && bool(existing.managed) && !opts.managed) throw managedError('Connection', c.identifier);
  if (opts.ifMatch !== undefined && (existing ? Number(existing.version) : undefined) !== opts.ifMatch)
    throw new HttpError(412, `Connection ${c.identifier} is at version ${existing ? existing.version : 'none'}, not ${opts.ifMatch}; reload and retry`, {
      conflict: { currentVersion: existing ? Number(existing.version) : null, changedBy: null, changedAt: existing?.updated_at ?? null },
    });
  const vals = [
    c.title,
    c.description,
    c.connector,
    JSON.stringify(c.fields),
    c.auth ? JSON.stringify(c.auth) : null,
    c.access,
    JSON.stringify(c.allowed),
    c.api ? JSON.stringify(c.api) : null,
  ];
  const changed = !existing || JSON.stringify(defOf(existing)) !== JSON.stringify(defOf({ ...existing, ...rowOf(c) }));
  const t = now();
  if (existing) {
    // Compare-and-set on the version: two concurrent saves cannot both win.
    const { changes } = await run(
      'UPDATE connections SET title = ?, description = ?, connector = ?, fields = ?, auth = ?, access = ?, allowed = ?, api = ?, managed = ?, version = ?, updated_at = ? WHERE org_id = ? AND identifier = ? AND version = ?',
      ...vals,
      opts.managed ? 1 : 0,
      Number(existing.version) + (changed ? 1 : 0),
      changed ? t : existing.updated_at,
      org,
      c.identifier,
      Number(existing.version),
    );
    if (!changes) throw conflict('The connection was changed by someone else meanwhile; reload and try again');
  } else
    await run(
      'INSERT INTO connections (title, description, connector, fields, auth, access, allowed, api, managed, version, created_at, updated_at, org_id, identifier) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)',
      ...vals,
      opts.managed ? 1 : 0,
      t,
      t,
      org,
      c.identifier,
    );
  return { connection: await getConnection(c.identifier), created: !existing, changed };
}

const rowOf = (c: ConnectionDef): Partial<Row> => ({
  title: c.title,
  description: c.description,
  connector: c.connector,
  fields: JSON.stringify(c.fields),
  auth: c.auth ? JSON.stringify(c.auth) : null,
  access: c.access,
  allowed: JSON.stringify(c.allowed),
  api: c.api ? JSON.stringify(c.api) : null,
});

/** Refused (409, `usedBy`) while integrations or workflows reference it. */
export async function deleteConnection(id: string, opts: { managed?: boolean } = {}) {
  const r = await row(id);
  if (bool(r.managed) && !opts.managed) throw managedError('Connection', id);
  const usedBy = await connectionUsage(id);
  if (usedBy.integrations.length || usedBy.actions.length || usedBy.fragments.length) {
    const names = [
      ...usedBy.integrations.map((x) => `integration ${x}`),
      ...usedBy.actions.map((x) => `workflow ${x}`),
      ...usedBy.fragments.map((x) => `fragment ${x}`),
    ];
    throw new HttpError(409, `Connection "${id}" is used by ${names.join(', ')}: remove it from them first`, { usedBy });
  }
  await run('DELETE FROM connections WHERE org_id = ? AND identifier = ?', orgId(), id);
}

/** The connections of a definition must stay valid when the definition changes (400 naming the broken ones). */
export async function checkConnectionsOf(def: ConnectorDef) {
  const rows = await all<Row>('SELECT * FROM connections WHERE org_id = ? AND connector = ?', orgId(), def.identifier);
  const broken: string[] = [];
  for (const r of rows)
    await validateConnection(defOf(r), def).catch((err: unknown) => {
      broken.push(`${r.identifier} (${errorMessage(err)})`);
    });
  if (broken.length) throw badRequest(`This change breaks connection(s): ${broken.join('; ')}`);
}

// ---------- usage ----------
/** Does `value` contain an object whose `connection` property is `id` (any depth)? */
function references(value: unknown, id: string): boolean {
  if (Array.isArray(value)) return value.some((v) => references(v, id));
  if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    return o.connection === id || Object.values(o).some((v) => references(v, id));
  }
  return false;
}

/** Integrations, workflows (steps and legacy invoker) and fragments referencing the connection. */
export async function connectionUsage(id: string): Promise<ConnectionUsage> {
  const org = orgId();
  const like = `%"connection":"${id.replace(/[\\%_]/g, (c) => `\\${c}`)}"%`;
  const integrations = await all<{ identifier: string; config: string }>(
    "SELECT identifier, config FROM integrations WHERE org_id = ? AND config LIKE ? ESCAPE '\\' ORDER BY identifier",
    org,
    like,
  );
  const actions = await all<{ identifier: string; steps: string | null; invoker: string | null }>(
    "SELECT identifier, steps, invoker FROM actions WHERE org_id = ? AND (steps LIKE ? ESCAPE '\\' OR invoker LIKE ? ESCAPE '\\') ORDER BY identifier",
    org,
    like,
    like,
  );
  const fragments = await all<{ identifier: string; steps: string }>(
    "SELECT identifier, steps FROM fragments WHERE org_id = ? AND steps LIKE ? ESCAPE '\\' ORDER BY identifier",
    org,
    like,
  );
  return {
    integrations: integrations.filter((i) => json<Record<string, unknown>>(i.config, {}).connection === id).map((i) => i.identifier),
    actions: actions.filter((a) => references([json(a.steps, []), json(a.invoker, null)], id)).map((a) => a.identifier),
    fragments: fragments.filter((f) => references(json(f.steps, []), id)).map((f) => f.identifier),
  };
}

// ---------- resolution ----------
export interface ResolvedConnection {
  identifier: string;
  title: string;
  connector: ConnectorDef;
  /** Field values, defaults applied. */
  fields: Fields;
  /** The auth block with secrets resolved: pass it as `auth` to lib/http.ts. Undefined: no authentication. */
  auth?: AuthDef;
  /** Resolved credential values the connection supplied, by auth key (`token`, `password`…). */
  credentials: Record<string, string>;
  /** Every secret value involved (redact them from logs and outputs). */
  secrets: string[];
  access: 'read' | 'read-write';
  allowed: ConnectionDef['allowed'];
  api?: ConnectionDef['api'];
}

/** Load a connection and resolve its auth block (secret references are resolved in the current organization). */
export async function resolveConnection(id: string): Promise<ResolvedConnection> {
  const c = defOf(await row(id));
  const { def, auth } = await validateConnection(c);
  const fields = fieldsWithDefaults(def, c.fields);
  const secrets: string[] = [];
  let rendered: AuthDef | undefined;
  const credentials: Record<string, string> = {};
  if (auth) {
    const r = await render(auth, { connection: fields }, resolveRef);
    secrets.push(...r.secrets);
    rendered = r.value as AuthDef;
    const given = await render(c.auth, {}, resolveRef);
    for (const [k, v] of Object.entries(given.value as Record<string, unknown>)) if (k !== 'type' && typeof v === 'string') credentials[k] = v;
  }
  return {
    identifier: c.identifier,
    title: c.title,
    connector: def,
    fields,
    auth: rendered,
    credentials,
    secrets,
    access: c.access,
    allowed: c.allowed,
    api: c.api,
  };
}

// ---------- access ----------
/** Who wants to use a connection, from a workflow run. */
export interface ConnectionUse {
  /** The operation changes something (needs a read-write connection). */
  write: boolean;
  /** The workflow (action identifier) of the run. */
  workflow?: string;
  /** The run's team (owner team of the entity it acts on). */
  team?: string | null;
}

/**
 * May this use go through the connection? A write needs `access: read-write`; when `allowed` lists workflows or teams
 * the run must match one of them (workflow listed, or run team listed). Throws 403. Ingestion (integrations) is not
 * restricted by `allowed`: integrations and connections are managed by the same administrators.
 */
export function assertConnectionUse(conn: Pick<ResolvedConnection, 'identifier' | 'access' | 'allowed'>, use: ConnectionUse) {
  if (use.write && conn.access !== 'read-write') throw forbidden(`Connection "${conn.identifier}" is read-only: it cannot be used to change things`);
  const { workflows = [], teams = [] } = conn.allowed ?? {};
  if (!workflows.length && !teams.length) return;
  if (use.workflow && workflows.includes(use.workflow)) return;
  if (use.team && teams.includes(use.team)) return;
  throw forbidden(
    `Connection "${conn.identifier}" is not allowed for ${use.workflow ? `workflow "${use.workflow}"` : 'this use'}${use.team ? ` (team ${use.team})` : ''}`,
  );
}

/** Can the connection be used to change things? */
export const isWritable = (conn: Pick<ResolvedConnection, 'access'>) => conn.access === 'read-write';

/**
 * Raw API calls (for the operations agent): the connection must declare `api`, the method must be listed (and a
 * non-GET method needs read-write access), and the path (no query, no dot segments, no encoded slashes or dots) must
 * be under one of the prefixes, on a segment boundary.
 */
export function assertRawCall(conn: Pick<ResolvedConnection, 'identifier' | 'access' | 'api'>, method: string, path: string) {
  const m = method.toUpperCase();
  if (!conn.api) throw forbidden(`Connection "${conn.identifier}" does not allow raw API calls`);
  if (!(conn.api.methods as string[]).includes(m)) throw forbidden(`Connection "${conn.identifier}" does not allow ${m} calls`);
  if (m !== 'GET' && conn.access !== 'read-write') throw forbidden(`Connection "${conn.identifier}" is read-only`);
  if (!path.startsWith('/') || /[?#\s\\]/.test(path) || /%2e|%2f|%5c/i.test(path) || path.split('/').some((s) => s === '.' || s === '..'))
    throw forbidden(`Path "${path}" is not allowed`);
  const ok = conn.api.paths.some((p) => {
    const prefix = p.endsWith('/') ? p : `${p}/`;
    return path === p || path.startsWith(prefix);
  });
  if (!ok) throw forbidden(`Path "${path}" is outside the paths allowed by connection "${conn.identifier}"`);
}

// ---------- test ----------
export async function testConnection(id: string): Promise<ConnectionTestResult> {
  const checkedAt = now();
  let conn: ResolvedConnection;
  try {
    conn = await resolveConnection(id);
  } catch (err) {
    if (err instanceof HttpError && err.statusCode === 404) throw err;
    return { ok: false, status: null, latencyMs: null, error: errorMessage(err), checkedAt };
  }
  const clean = (s: string) => redact(s, conn.secrets).slice(0, 500);
  const req = await testRequest(conn.connector, conn.fields).catch((err: unknown) => {
    throw badRequest(errorMessage(err));
  });
  if (!req) return { ok: false, status: null, latencyMs: null, error: `${conn.connector.identifier} defines no test request`, checkedAt };
  const started = performance.now();
  let status: number;
  let body: unknown;
  try {
    const res = await http(req.url, {
      method: req.method,
      headers: req.headers,
      body: req.body,
      auth: conn.auth,
      retry: false,
      timeoutMs: 15_000,
      redirect: 'error',
    });
    status = res.status;
    body = res.data;
  } catch (err) {
    const latencyMs = Math.round(performance.now() - started);
    if (!(err instanceof UpstreamError) || !err.status) return { ok: false, status: null, latencyMs, error: clean(errorMessage(err)), checkedAt };
    status = err.status;
    try {
      body = JSON.parse(err.body ?? '');
    } catch {
      body = err.body;
    }
  }
  const latencyMs = Math.round(performance.now() - started);
  const why = await testVerdict(conn.connector, { status, body }).catch((err: unknown) => errorMessage(err));
  return why ? { ok: false, status, latencyMs, error: clean(why), checkedAt } : { ok: true, status, latencyMs, checkedAt };
}

// ---------- code integrations (bindings.ts) and connector-native sources ----------

/** Key under which a connector-native source finds its resolved connection in the rendered config. */
export const RESOLVED = '__connection';

/** The token of a connection for code integrations (see bindings.ts). */
export async function connectionToken(conn: ResolvedConnection): Promise<ConnectionToken> {
  const a = conn.auth;
  if (!a) throw new Error(`Connection "${conn.identifier}" has no credentials`);
  if (a.type === 'basic' && a.username === '') return { scheme: 'pat', token: a.password };
  if (a.type === 'bearer') return { scheme: 'bearer', token: a.token };
  if (a.type === 'header') {
    if (conn.credentials.token) return { scheme: 'token', token: conn.credentials.token };
    throw new Error(`Connection "${conn.identifier}": its header auth has no {token} credential`);
  }
  if (a.type === 'basic' || a.type === 'aws-sigv4' || a.type === 'mtls')
    throw new Error(`Connection "${conn.identifier}": auth "${a.type}" yields no token for this integration`);
  const { headers } = await resolveAuth(a, { url: String(conn.fields.baseUrl), method: 'GET' }, (u, init) => http(u, init));
  const m = /^Bearer (.+)$/.exec(headers.authorization ?? '');
  if (!m) throw new Error(`Connection "${conn.identifier}": auth "${a.type}" yields no bearer token`);
  conn.secrets.push(m[1]!);
  return { scheme: 'bearer', token: m[1]! };
}

/**
 * Resolve the `connection` of a rendered source or invoker config: connector-native sources get the resolved
 * connection under RESOLVED; code integrations get their keys filled by their binding. Returns the secrets to redact.
 */
export async function applyConnection(
  kind: 'source' | 'invoker',
  type: string,
  config: Record<string, unknown>,
  use: ConnectionUse,
  native = false,
): Promise<{ config: Record<string, unknown>; secrets: string[] }> {
  const id = connectionRef(config);
  if (!id) return { config, secrets: [] };
  const conn = await resolveConnection(id);
  assertConnectionUse(conn, use);
  if (native) return { config: { ...config, [RESOLVED]: conn }, secrets: conn.secrets };
  const binding = bindingFor(kind, type);
  if (!binding) throw new Error(`${type} does not accept a connection`);
  if (!binding.connectors.includes(conn.connector.identifier))
    throw new Error(`${type} cannot use connection "${id}" (a ${conn.connector.identifier} connection; expected ${binding.connectors.join(' or ')})`);
  const { connection: _c, ...rest } = config;
  void _c;
  const merged = await binding.apply(rest, { connector: conn.connector.identifier, fields: conn.fields }, () => connectionToken(conn));
  return { config: merged, secrets: conn.secrets };
}

/**
 * Save-time check of a config naming a connection: it exists, its connector suits the type, and (invokers) it may be
 * used by this workflow for writing. `kinds`: connector-native sources, the definition's kinds for the mappings.
 */
export async function checkConnectionRef(
  kind: 'source' | 'invoker',
  type: string,
  config: Record<string, unknown>,
  opts: { native?: string | true; workflow?: string } = {},
): Promise<ConnectorDef | undefined> {
  const id = connectionRef(config);
  if (!id) return undefined;
  const r = await one<Row>('SELECT * FROM connections WHERE org_id = ? AND identifier = ?', orgId(), id);
  if (!r) throw badRequest(`Unknown connection "${id}"`);
  const def = await findConnectorDef(r.connector);
  if (!def) throw badRequest(`Connection "${id}" uses an unknown connector "${r.connector}"`);
  if (typeof opts.native === 'string' && opts.native !== def.identifier)
    throw badRequest(`${type} integrations need a ${opts.native} connection ("${id}" is a ${def.identifier} connection)`);
  if (!opts.native) {
    const b = bindingFor(kind, type);
    if (!b) throw badRequest(`${type} does not accept a connection`);
    if (!b.connectors.includes(def.identifier)) throw badRequest(`${type} cannot use connection "${id}" (a ${def.identifier} connection)`);
    if (type === 'scaffolder' && config.provider && config.provider !== def.identifier)
      throw badRequest(`scaffolder: provider "${String(config.provider)}" cannot use a ${def.identifier} connection`);
  }
  if (kind === 'invoker') {
    try {
      assertConnectionUse(defOf(r), { write: true, workflow: opts.workflow, team: undefined });
    } catch (err) {
      // Team allow-lists are checked when the run starts (its team is not known yet).
      const { teams = [] } = defOf(r).allowed;
      if (!(err instanceof HttpError) || r.access !== 'read-write' || !teams.length) throw badRequest(errorMessage(err));
    }
  }
  return def;
}
