import type { ObjectSchema } from '@asterius/shared';
import { badRequest } from '../../lib/errors.js';
import { evaluate, render, type RefResolver } from '../../lib/expr.js';
import { validator } from '../../catalog/validation.js';
import {
  authDef,
  type AuthDef,
  type AuthType,
  type ConnectorAuthMethod,
  type ConnectorDef,
  type ConnectorKindDef,
  type ConnectorOperationDef,
} from '../../schemas.js';

/**
 * The connector engine, as pure functions (no database, no network): what a definition's requests look like for a
 * connection's fields and an operation's inputs. Sources (ingestion) and workflow steps (operations) render their
 * requests here and send them with lib/http.ts, passing the connection's auth block as `auth`.
 *
 * Template syntax (one syntax everywhere): `{{ expression }}` (JSONata) over a context holding
 *   connection   the connection's field values (defaults applied): `{{ connection.organization }}`
 *   inputs       operations: the operation's inputs (defaults applied): `{{ inputs.name }}`
 *   output       poll requests: the operation's mapped output: `{{ output.runId }}`
 * In a path each `{{ }}` value is URL-encoded as one path segment (`a/b` → `a%2Fb`, `.` and `..` refused), and empty
 * segments collapse (`/{{ connection.project }}/_apis` with no project → `/_apis`). Query values that render empty are
 * left out. Definitions never contain `${secret:…}`: credentials come from the connection's auth block only.
 */

export type Fields = Record<string, unknown>;

/** A request ready for `http(url, { method, headers, body, auth })`. Never carries credentials. */
export interface RenderedRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: unknown;
}

/** What `render` needs of a request (kinds, operations, poll, test). */
export interface RequestSpec {
  method?: string;
  path: string;
  query?: Record<string, string>;
  headers?: Record<string, string>;
  body?: unknown;
}

const noRefs: RefResolver = async () => {
  throw badRequest('Secret references are not allowed in connector definitions (credentials come from the connection)');
};
const tpl = async (t: unknown, ctx: unknown) => (await render(t, ctx, noRefs, { noRefs: true })).value;

/** `{{ }}` value of a path: one URL-encoded segment. */
function segment(text: string, expr: string): string {
  if (text === '.' || text === '..') throw badRequest(`Path value "{{ ${expr} }}" cannot be "${text}"`);
  return encodeURIComponent(text);
}

/** The connection's field values with the definition's defaults applied. */
export function fieldsWithDefaults(def: Pick<ConnectorDef, 'fields'>, fields: Fields): Fields {
  const out: Fields = { ...fields };
  for (const [k, p] of Object.entries(def.fields.properties ?? {})) if (out[k] === undefined && p.default !== undefined) out[k] = p.default;
  return out;
}

/** Base URL of a connection: its `baseUrl` field (http or https). */
export function baseUrlOf(fields: Fields): URL {
  const raw = fields.baseUrl;
  if (typeof raw !== 'string' || !raw) throw badRequest('The connection has no baseUrl');
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw badRequest(`baseUrl "${raw}" is not a URL`);
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw badRequest('baseUrl must be an http(s) URL');
  if (u.search || u.hash || u.username || u.password) throw badRequest('baseUrl cannot carry a query string, fragment or credentials');
  return u;
}

/** Render one request of a definition against `ctx` (which must hold `connection`, the fields with defaults). */
export async function renderRequest(
  def: Pick<ConnectorDef, 'headers'>,
  spec: RequestSpec,
  ctx: { connection: Fields } & Record<string, unknown>,
): Promise<RenderedRequest> {
  const base = baseUrlOf(ctx.connection);
  const rendered = String((await render(spec.path, ctx, noRefs, { noRefs: true, wrap: segment })).value ?? '');
  let path = rendered.replace(/\/{2,}/g, '/');
  if (path.length > 1 && path.endsWith('/') && !spec.path.endsWith('/')) path = path.slice(0, -1);
  if (!path.startsWith('/')) path = `/${path}`;
  const basePath = base.pathname.replace(/\/$/, '');
  const url = new URL(`${base.origin}${basePath}${path}`);
  // Encoded values cannot change the origin or climb above the base path; checked anyway.
  if (url.origin !== base.origin || !url.pathname.startsWith(basePath)) throw badRequest('The request would leave the connection base URL');
  for (const [name, t] of Object.entries(spec.query ?? {})) {
    const v = await tpl(t, ctx);
    for (const x of Array.isArray(v) ? v : [v]) {
      if (x === undefined || x === null || x === '') continue;
      url.searchParams.append(name, typeof x === 'object' ? JSON.stringify(x) : String(x as string));
    }
  }
  const headers: Record<string, string> = {};
  for (const [name, t] of Object.entries({ ...def.headers, ...spec.headers })) {
    const v = await tpl(t, ctx);
    if (v === undefined || v === null || v === '') continue;
    const s = typeof v === 'object' ? JSON.stringify(v) : String(v as string);
    if (/[\r\n]/.test(s)) throw badRequest(`Header ${name}: line breaks are not allowed`);
    headers[name.toLowerCase()] = s;
  }
  const out: RenderedRequest = { method: (spec.method ?? 'GET').toUpperCase(), url: url.toString(), headers };
  if (spec.body !== undefined) out.body = await tpl(spec.body, ctx);
  return out;
}

// ---------- ingestion ----------

/** The first request of a kind's listing, and the kind (pagination, itemsPath, since). */
export async function kindRequest(def: ConnectorDef, kindName: string, fields: Fields): Promise<{ request: RenderedRequest; kind: ConnectorKindDef }> {
  const kind = def.kinds[kindName];
  if (!kind) throw badRequest(`${def.identifier}: unknown kind "${kindName}" (available: ${Object.keys(def.kinds).join(', ') || 'none'})`);
  const missing = (kind.requires ?? []).filter((f) => fields[f] === undefined || fields[f] === null || fields[f] === '');
  if (missing.length) throw badRequest(`${def.identifier}: listing "${kindName}" needs the connection field(s) ${missing.join(', ')}`);
  return { request: await renderRequest(def, kind, { connection: fields }), kind };
}

// ---------- operations ----------

export function getOperation(def: ConnectorDef, name: string): ConnectorOperationDef {
  const op = def.operations[name];
  if (!op) throw badRequest(`${def.identifier}: unknown operation "${name}" (available: ${Object.keys(def.operations).join(', ') || 'none'})`);
  return op;
}

/** Does the operation change nothing? Explicit `readOnly`, else GET only. A read-only connection only runs these. */
export const isReadOnlyOperation = (op: Pick<ConnectorOperationDef, 'readOnly' | 'method'>) => op.readOnly ?? op.method === 'GET';

/** Inputs validated against the operation's schema, defaults applied (400 listing the problems). */
export function prepareInputs(op: Pick<ConnectorOperationDef, 'inputs'>, inputs: Record<string, unknown> = {}): Record<string, unknown> {
  const copy = structuredClone(inputs ?? {});
  const check = validator(op.inputs as ObjectSchema);
  if (!check(copy)) {
    const problems = (check.errors ?? []).map((e) => `${e.instancePath.slice(1).replaceAll('/', '.') || 'inputs'} ${e.message}`);
    throw badRequest(`Invalid inputs: ${problems.join('; ')}`);
  }
  return copy;
}

/**
 * The request of an operation for a connection's fields and the given inputs (validated, defaults applied).
 * The caller sends it with the connection's auth: `http(r.url, { method, headers, body, auth: connection.auth })`.
 */
export async function operationRequest(
  def: ConnectorDef,
  operation: string,
  fields: Fields,
  inputs: Record<string, unknown> = {},
): Promise<{ request: RenderedRequest; inputs: Record<string, unknown>; operation: ConnectorOperationDef }> {
  const op = getOperation(def, operation);
  const prepared = prepareInputs(op, inputs);
  return { request: await renderRequest(def, op, { connection: fields, inputs: prepared }), inputs: prepared, operation: op };
}

/** Context of output expressions: the response of the operation (or of the last poll). */
export interface ResponseContext {
  connection: Fields;
  inputs: Record<string, unknown>;
  status: number;
  body: unknown;
  /** Poll: the output mapped from the operation's own response. */
  output?: Record<string, unknown>;
}

async function mapOutput(map: Record<string, string>, ctx: ResponseContext): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const [k, expr] of Object.entries(map)) {
    const v = await evaluate(expr, ctx);
    if (v !== undefined) out[k] = v;
  }
  return out;
}

/** The output of an operation from its response: the `output` mapping, or the body itself. */
export async function operationOutput(op: Pick<ConnectorOperationDef, 'output'>, ctx: ResponseContext): Promise<unknown> {
  return op.output ? mapOutput(op.output, ctx) : ctx.body;
}

/** The next status request of a long-running operation (`output`: what operationOutput returned). */
export async function pollRequest(
  def: ConnectorDef,
  op: ConnectorOperationDef,
  fields: Fields,
  ctx: { inputs: Record<string, unknown>; output: unknown },
): Promise<RenderedRequest> {
  if (!op.poll) throw badRequest('This operation does not poll');
  return renderRequest(def, op.poll, { connection: fields, inputs: ctx.inputs, output: ctx.output });
}

/**
 * Interpret a poll response: `failed` is checked first, then `done`. The output is the operation's output with the
 * poll's `output` fields merged over it (when finished).
 */
export async function pollOutcome(op: ConnectorOperationDef, ctx: ResponseContext): Promise<{ status: 'running' | 'success' | 'failure'; output: unknown }> {
  if (!op.poll) throw badRequest('This operation does not poll');
  const failed = op.poll.failed ? !!(await evaluate(op.poll.failed, ctx)) : false;
  const done = failed || !!(await evaluate(op.poll.done, ctx));
  if (!done) return { status: 'running', output: ctx.output };
  const extra = op.poll.output ? await mapOutput(op.poll.output, ctx) : {};
  const base = ctx.output && typeof ctx.output === 'object' && !Array.isArray(ctx.output) ? ctx.output : {};
  return { status: failed ? 'failure' : 'success', output: { ...base, ...extra } };
}

// ---------- test connection ----------

export async function testRequest(def: ConnectorDef, fields: Fields): Promise<RenderedRequest | undefined> {
  return def.test ? renderRequest(def, def.test, { connection: fields }) : undefined;
}

/** Did the test response meet the definition's expectations? Returns the reason when not. */
export async function testVerdict(def: ConnectorDef, res: { status: number; body: unknown }): Promise<string | undefined> {
  const expect = def.test?.expect ?? {};
  const okStatus = expect.status?.length ? expect.status.includes(res.status) : res.status >= 200 && res.status < 300;
  if (!okStatus) return `Unexpected status ${res.status}${expect.status?.length ? ` (expected ${expect.status.join(', ')})` : ''}`;
  if (expect.condition && !(await evaluate(expect.condition, res))) return `The response does not satisfy the test condition (${expect.condition})`;
  return undefined;
}

// ---------- authentication ----------

/** Fields of an auth block that hold credentials, per type: a connection may only set them as references. */
export const SECRET_AUTH_KEYS: Record<AuthType, string[]> = {
  basic: ['password'],
  bearer: ['token'],
  header: [],
  'oauth2-client-credentials': ['clientSecret'],
  'github-app': ['privateKey'],
  'azure-managed-identity': [],
  'azure-workload-identity': [],
  'gcp-service-account': ['serviceAccountJson'],
  'aws-sigv4': ['secretAccessKey', 'sessionToken'],
  mtls: ['key'],
};

const PLACEHOLDER = /\{([A-Za-z_][A-Za-z0-9_]{0,63})\}/g;

/** `header` methods: the credentials their formats name (`Token token={token}` → token). */
export function placeholdersOf(method: Pick<ConnectorAuthMethod, 'headers'>): string[] {
  const out = new Set<string>();
  for (const v of Object.values(method.headers ?? {})) for (const m of v.matchAll(PLACEHOLDER)) out.add(m[1]!);
  return [...out];
}

/** Keys an auth block of `type` accepts. */
export function authKeys(type: AuthType): string[] {
  const opt = authDef.options.find((o) => o.shape.type.value === type);
  return opt ? Object.keys(opt.shape).filter((k) => k !== 'type') : [];
}

/** Credential keys of a method: the type's secret fields, the method's extra `secrets` and the header placeholders. */
export const secretKeysOf = (method: ConnectorAuthMethod) => [...SECRET_AUTH_KEYS[method.type], ...(method.secrets ?? []), ...placeholdersOf(method)];

const issues = (e: { issues: Array<{ path: PropertyKey[]; message: string }> }) =>
  e.issues.map((i) => `${i.path.map(String).join('.') || 'type'} ${i.message}`).join('; ');

/**
 * The auth block (lib/auth.ts `authDef`) of a connection: the definition's method (its fixed `set` values, rendered
 * against the fields) merged with what the connection supplies. Values stay unrendered: `${secret:…}` references are
 * resolved when the block is used. Throws 400 on an unsupported method, unknown or fixed keys, or an invalid block.
 */
export async function authBlock(def: ConnectorDef, auth: Record<string, unknown> & { type: string }, fields: Fields): Promise<AuthDef> {
  const method = def.auth.find((m) => m.type === auth.type);
  if (!method) throw badRequest(`auth: ${def.identifier} does not support "${auth.type}" (supported: ${def.auth.map((m) => m.type).join(', ') || 'none'})`);
  const { type, ...given } = auth;
  const placeholders = placeholdersOf(method);
  const allowed = new Set([...authKeys(method.type), ...placeholders]);
  for (const k of Object.keys(given)) {
    if (!allowed.has(k) || (method.type === 'header' && k === 'headers'))
      throw badRequest(
        `auth: unknown field "${k}" for ${type} (expected: ${[...allowed].filter((x) => x !== 'headers' || method.type !== 'header').join(', ')})`,
      );
    if (k in method.set && JSON.stringify(method.set[k]) !== JSON.stringify(given[k])) throw badRequest(`auth: "${k}" is set by the connector definition`);
  }
  const set = (await tpl(method.set, { connection: fields })) as Record<string, unknown>;
  const block: Record<string, unknown> = { ...Object.fromEntries(Object.entries(given).filter(([k]) => !placeholders.includes(k))), ...set, type };
  if (method.type === 'header') {
    const headers: Record<string, string> = {};
    for (const [name, format] of Object.entries(method.headers ?? {}))
      headers[name] = format.replace(PLACEHOLDER, (_m, n: string) => {
        const v = given[n];
        if (typeof v !== 'string' || !v) throw badRequest(`auth: missing "${n}"`);
        return v;
      });
    block.headers = headers;
  }
  const parsed = authDef.safeParse(block);
  if (!parsed.success) throw badRequest(`auth: ${issues(parsed.error)}`);
  return parsed.data;
}

/**
 * Inline (legacy) integration configs of the built-in connectors that used to be presets: `token`, `email`,
 * `user` / `password`, `apiKey`… at the top level of the config. Picks the first auth method whose credentials are
 * present; `config.auth` (an explicit auth block) wins. Undefined: no credentials (the API is called anonymously).
 */
export async function inlineAuth(def: ConnectorDef, config: Record<string, unknown>, fields: Fields): Promise<AuthDef | undefined> {
  if (config.auth) {
    const parsed = authDef.safeParse(config.auth);
    if (!parsed.success) throw new Error(`auth: ${issues(parsed.error)}`);
    return parsed.data;
  }
  const found = inlineCredentials(def, config);
  return found ? authBlock(def, { type: found.method.type, ...found.given }, fields) : undefined;
}

/** The first auth method of `def` whose credentials an inline config carries, and those credentials. */
export function inlineCredentials(
  def: ConnectorDef,
  config: Record<string, unknown>,
): { method: ConnectorAuthMethod; given: Record<string, unknown> } | undefined {
  const s = (k: string) => (typeof config[k] === 'string' && config[k] !== '' ? (config[k] as string) : undefined);
  for (const m of def.auth) {
    let given: Record<string, unknown> | undefined;
    if (m.type === 'bearer' && s('token')) given = { token: s('token') };
    else if (m.type === 'header') {
      const names = placeholdersOf(m);
      if (names.every((n) => s(n))) given = Object.fromEntries(names.map((n) => [n, s(n)]));
    } else if (m.type === 'basic') {
      const username = 'username' in m.set ? undefined : (s('username') ?? s('user') ?? s('email') ?? ('password' in m.set ? s('token') : undefined));
      const password = 'password' in m.set ? undefined : (s('password') ?? s('token'));
      if (('username' in m.set || username) && ('password' in m.set || password))
        given = { ...(username !== undefined ? { username } : {}), ...(password !== undefined ? { password } : {}) };
    }
    if (given) return { method: m, given };
  }
  return undefined;
}

/** The credential names an inline config of this definition is expected to carry (first method), for errors. */
export function inlineCredentialNames(def: ConnectorDef): string[] {
  const m = def.auth[0];
  if (!m) return [];
  if (m.type === 'bearer') return ['token'];
  if (m.type === 'header') return placeholdersOf(m);
  if (m.type === 'basic') return 'password' in m.set || 'username' in m.set ? ['token'] : ['user (or email)', 'password (or token)'];
  return [];
}
