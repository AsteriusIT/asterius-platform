import type { ObjectSchema } from '@asterius/shared';
import { validator } from '../../catalog/validation.js';
import { badRequest, errorMessage, HttpError } from '../../lib/errors.js';
import { http, UpstreamError } from '../../lib/http.js';
import { redactDeep } from '../../lib/expr.js';
import {
  assertConnectionUse,
  assertRawCall,
  getConnection,
  resolveConnection,
  RESOLVED,
  type ResolvedConnection,
} from '../../integrations/connectors/connections.js';
import { findConnectorDef } from '../../integrations/connectors/definitions.js';
import {
  baseUrlOf,
  fieldsWithDefaults,
  getOperation,
  isReadOnlyOperation,
  operationOutput,
  operationRequest,
  pollOutcome,
  pollRequest,
  prepareInputs,
  renderRequest,
  type Fields,
  type RenderedRequest,
} from '../../integrations/connectors/request.js';
import type { ConnectorDef, ConnectorOperationDef } from '../../schemas.js';
import { str, type InvokeEnv, type Invoker } from '../types.js';

/**
 * Workflow steps that go through a connection (integrations/connectors/):
 *
 *   connector       { connection, operation, inputs }   an operation of the connection's connector definition: the
 *                   request is rendered from the definition, sent with the connection's credentials, its output mapped;
 *                   operations with `poll` stay IN_PROGRESS and are polled every `poll.intervalSeconds` until `done` /
 *                   `failed` or `poll.timeoutMinutes` (the state lives in the step row: worker restarts lose nothing).
 *   connector-api   { connection, method, path, query?, headers?, body? }   a raw call, allowed only by the connection's
 *                   `api` allow-list (methods and path prefixes). Output: { status, body, headers }.
 *
 * Access: a write (an operation that is not read-only, a raw call other than GET) needs a read-write connection, and the
 * connection's `allowed` workflows / teams must match the run. Inputs are templates rendered like any invoker config.
 * Logs show the method, the URL path and the status, never credentials, query strings or bodies.
 */

const HEADERS_KEPT = ['content-type', 'location', 'etag', 'link', 'retry-after', 'x-ms-continuationtoken', 'x-total-count'];
const RESERVED_HEADER = /^(authorization|proxy-authorization|cookie|host|content-length|transfer-encoding|connection)$/i;

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
/** Does a (unrendered) value contain a template or a reference? Those are only checked when the step runs. */
const dynamic = (v: unknown): boolean =>
  typeof v === 'string' ? v.includes('{{') || v.includes('${') : Array.isArray(v) ? v.some(dynamic) : isObject(v) && Object.values(v).some(dynamic);

function resolvedOf(config: Record<string, unknown>): ResolvedConnection {
  const c = config[RESOLVED] as ResolvedConnection | undefined;
  if (!c) throw new Error('The connection of this step was not resolved');
  return c;
}

/** The connection and its definition without resolving credentials (save-time checks, dry runs, previews). */
async function connectionInfo(id: string) {
  let conn;
  try {
    conn = await getConnection(id);
  } catch (err) {
    if (err instanceof HttpError && err.statusCode === 404) throw badRequest(`Unknown connection "${id}"`);
    throw err;
  }
  const def = await findConnectorDef(conn.connector);
  if (!def) throw badRequest(`Connection "${id}" uses an unknown connector "${conn.connector}"`);
  return { conn, def, fields: fieldsWithDefaults(def, conn.fields) };
}

/** Inputs given as literals must satisfy the operation's input schema (templated ones are checked when the step runs). */
export function checkLiteralInputs(op: ConnectorOperationDef, inputs: Record<string, unknown>) {
  const props = op.inputs.properties ?? {};
  const unknown = Object.keys(inputs).filter((k) => !(k in props));
  if (unknown.length) throw badRequest(`inputs: unknown ${unknown.join(', ')} (inputs: ${Object.keys(props).join(', ') || 'none'})`);
  const templated = Object.keys(inputs).filter((k) => dynamic(inputs[k]));
  const literal = Object.fromEntries(Object.entries(inputs).filter(([k]) => !templated.includes(k)));
  const schema = { ...op.inputs, required: (op.inputs.required ?? []).filter((k) => !templated.includes(k)) } as ObjectSchema;
  const check = validator(schema);
  if (!check(structuredClone(literal)))
    throw badRequest(`inputs: ${(check.errors ?? []).map((e) => `${e.instancePath.slice(1).replaceAll('/', '.') || 'inputs'} ${e.message}`).join('; ')}`);
}

/** `allowed` workflows (teams are only known when the run starts). */
function checkAllowedWorkflow(conn: { identifier: string; allowed: { workflows?: string[]; teams?: string[] } }, workflow: string) {
  const { workflows = [], teams = [] } = conn.allowed ?? {};
  if ((workflows.length || teams.length) && !workflows.includes(workflow) && !teams.length)
    throw badRequest(`Connection "${conn.identifier}" is not allowed for workflow "${workflow}"`);
}

const pathOf = (url: string) => new URL(url).pathname;

/** Send a rendered request with the connection's credentials; log method, path and status only. */
async function send(conn: ResolvedConnection, req: RenderedRequest, log: InvokeEnv['log']) {
  try {
    const res = await http(req.url, { method: req.method, headers: req.headers, body: req.body, auth: conn.auth });
    await log(`${req.method} ${pathOf(req.url)} → ${res.status}`);
    return res;
  } catch (err) {
    if (err instanceof UpstreamError && err.status) {
      await log(`${req.method} ${pathOf(req.url)} → ${err.status}`, 'error');
      throw new Error(`${req.method} ${pathOf(req.url)} failed with status ${err.status}${err.body ? `: ${err.body.slice(0, 300)}` : ''}`, {
        cause: err,
      });
    }
    throw err;
  }
}

const outputLink = (output: unknown) => {
  const o = isObject(output) ? output : {};
  const v = o.url ?? o.link ?? o.webUrl;
  return typeof v === 'string' && /^https?:\/\//.test(v) ? v : undefined;
};

/** The step output: the operation output (an object; anything else under `body`) and the HTTP status. */
const stepOutput = (output: unknown, httpStatus: number) => ({ ...(isObject(output) ? output : { body: output }), httpStatus });

// ---------- operations ----------

interface OperationState {
  kind: 'connector';
  operation: string;
  output: unknown;
  httpStatus: number;
  startedAt: string;
  deadline: string;
  polls: number;
}

function operationOf(def: ConnectorDef, config: Record<string, unknown>) {
  return getOperation(def, str(config.operation));
}

export const connectorInvoker: Invoker = {
  info: {
    type: 'connector',
    title: 'Connection operation',
    description:
      "Run an operation of a connection's connector (create a repository, run a pipeline, open an issue…). Output: the operation's output and httpStatus.",
    fields: [
      { key: 'connection', label: 'Connection', kind: 'text', required: true },
      { key: 'operation', label: 'Operation', kind: 'text', required: true },
      { key: 'inputs', label: 'Inputs', kind: 'json' },
    ],
    example: {
      type: 'connector',
      connection: 'azure-devops',
      operation: 'create-repository',
      inputs: { name: '{{ inputs.name }}' },
    },
  },
  validate(c) {
    if (!c.connection || typeof c.connection !== 'string') throw new Error('connector invoker: missing connection');
    if (!c.operation || typeof c.operation !== 'string') throw new Error('connector invoker: missing operation');
    if (c.inputs !== undefined && !isObject(c.inputs) && !dynamic(c.inputs)) throw new Error('connector invoker: inputs must be an object');
  },
  connection: {
    async resolve(config, use) {
      const conn = await resolveConnection(str(config.connection));
      const op = operationOf(conn.connector, config);
      assertConnectionUse(conn, { write: !isReadOnlyOperation(op), workflow: use.workflow, team: use.team });
      return { config: { ...config, [RESOLVED]: conn }, secrets: conn.secrets };
    },
    async check(config, { workflow }) {
      const { conn, def } = await connectionInfo(str(config.connection));
      const op = operationOf(def, config);
      if (!isReadOnlyOperation(op) && conn.access !== 'read-write')
        throw badRequest(`Connection "${conn.identifier}" is read-only: operation "${str(config.operation)}" changes things and needs a read-write connection`);
      checkAllowedWorkflow(conn, workflow);
      if (isObject(config.inputs)) checkLiteralInputs(op, config.inputs);
    },
  },
  async simulate(config) {
    const { conn, def, fields } = await connectionInfo(str(config.connection));
    const op = operationOf(def, config);
    if (!isReadOnlyOperation(op) && conn.access !== 'read-write') throw new Error(`Connection "${conn.identifier}" is read-only`);
    const { request, inputs } = await operationRequest(def, str(config.operation), fields, (config.inputs as Record<string, unknown>) ?? {});
    const sample = Object.fromEntries(Object.keys(op.output ?? {}).map((k) => [k, `<${k}>`]));
    return {
      rendered: { connection: conn.identifier, operation: str(config.operation), title: op.title, request, inputs, ...(op.poll ? { polls: true } : {}) },
      output: { ...sample, httpStatus: 200 },
    };
  },
  async start({ config, log }) {
    const conn = resolvedOf(config);
    const name = str(config.operation);
    const { request, inputs, operation: op } = await operationRequest(conn.connector, name, conn.fields, (config.inputs as Record<string, unknown>) ?? {});
    await log(`${op.title} (${conn.connector.identifier} operation "${name}") through connection ${conn.identifier}`);
    const res = await send(conn, request, log);
    const output = await operationOutput(op, { connection: conn.fields, inputs, status: res.status, body: res.data });
    const link = outputLink(output);
    if (!op.poll) return { status: 'SUCCESS', result: stepOutput(output, res.status), link, statusLabel: `${op.title} · ${res.status}` };
    const now = Date.now();
    const state: OperationState = {
      kind: 'connector',
      operation: name,
      output: redactDeep(output, conn.secrets),
      httpStatus: res.status,
      startedAt: new Date(now).toISOString(),
      deadline: new Date(now + op.poll.timeoutMinutes * 60_000).toISOString(),
      polls: 0,
    };
    return {
      status: 'IN_PROGRESS',
      state: state as unknown as Record<string, unknown>,
      link,
      statusLabel: `${op.title} · started`,
      pollAfterSeconds: op.poll.intervalSeconds,
    };
  },
  async poll({ config, log }, raw) {
    const state = raw as unknown as OperationState;
    const conn = resolvedOf(config);
    const op = operationOf(conn.connector, config);
    if (!op.poll) return { status: 'SUCCESS', result: stepOutput(state.output, state.httpStatus) };
    const link = outputLink(state.output);
    if (Date.now() > Date.parse(state.deadline)) {
      await log(`${op.title}: not finished after ${op.poll.timeoutMinutes} minute(s)`, 'error');
      return { status: 'FAILURE', result: stepOutput(state.output, state.httpStatus), link, statusLabel: `${op.title} · timed out` };
    }
    // Inputs are rendered again from the step's templates (they are not kept in the state).
    const inputs = prepareInputs(op, (config.inputs as Record<string, unknown>) ?? {});
    const request = await pollRequest(conn.connector, op, conn.fields, { inputs, output: state.output });
    const res = await send(conn, request, log);
    const outcome = await pollOutcome(op, {
      connection: conn.fields,
      inputs,
      status: res.status,
      body: res.data,
      output: isObject(state.output) ? state.output : undefined,
    });
    if (outcome.status === 'running')
      return {
        status: 'IN_PROGRESS',
        state: { ...state, polls: state.polls + 1 } as unknown as Record<string, unknown>,
        link,
        statusLabel: `${op.title} · running`,
        pollAfterSeconds: op.poll.intervalSeconds,
      };
    await log(`${op.title}: ${outcome.status === 'success' ? 'finished' : 'failed'}`, outcome.status === 'success' ? 'info' : 'error');
    return {
      status: outcome.status === 'success' ? 'SUCCESS' : 'FAILURE',
      result: stepOutput(outcome.output, state.httpStatus),
      link: outputLink(outcome.output) ?? link,
      statusLabel: `${op.title} · ${outcome.status === 'success' ? 'done' : 'failed'}`,
    };
  },
};

// ---------- raw API calls ----------

/** The request of a raw call (the path must be allowed by the connection's `api`). Never carries credentials. */
export async function rawRequest(
  conn: Pick<ResolvedConnection, 'identifier' | 'access' | 'api' | 'connector'> & { fields: Fields },
  c: Record<string, unknown>,
): Promise<RenderedRequest> {
  const method = str(c.method || 'GET').toUpperCase();
  const path = str(c.path);
  assertRawCall(conn, method, path);
  const base = baseUrlOf(conn.fields);
  const basePath = base.pathname.replace(/\/$/, '');
  const url = new URL(`${base.origin}${basePath}${path}`);
  if (url.origin !== base.origin || !url.pathname.startsWith(basePath)) throw badRequest('The request would leave the connection base URL');
  for (const [k, v] of Object.entries(isObject(c.query) ? c.query : {}))
    for (const x of Array.isArray(v) ? v : [v]) {
      if (x === undefined || x === null || x === '') continue;
      url.searchParams.append(k, typeof x === 'object' ? JSON.stringify(x) : String(x as string));
    }
  // The definition's own headers (Accept, API version…), then the step's.
  const { headers } = await renderRequest(conn.connector, { path: '/' }, { connection: conn.fields });
  for (const [k, v] of Object.entries(isObject(c.headers) ? c.headers : {})) {
    if (RESERVED_HEADER.test(k)) throw badRequest(`Header ${k} cannot be set (credentials come from the connection)`);
    const s = typeof v === 'string' ? v : JSON.stringify(v);
    if (/[\r\n]/.test(s)) throw badRequest(`Header ${k}: line breaks are not allowed`);
    headers[k.toLowerCase()] = s;
  }
  return { method, url: url.toString(), headers, ...(c.body !== undefined && method !== 'GET' && method !== 'HEAD' ? { body: c.body } : {}) };
}

const rawWrite = (c: Record<string, unknown>) => str(c.method || 'GET').toUpperCase() !== 'GET';

export const connectorApiInvoker: Invoker = {
  info: {
    type: 'connector-api',
    title: 'Connection API call',
    description:
      "A raw call to a connection's API, limited to the methods and path prefixes the connection allows (admins only). Output: { status, body, headers }.",
    fields: [
      { key: 'connection', label: 'Connection', kind: 'text', required: true },
      { key: 'method', label: 'Method', kind: 'select', options: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'], required: true },
      { key: 'path', label: 'Path', kind: 'text', required: true, placeholder: '/my-org/_apis/projects' },
      { key: 'query', label: 'Query', kind: 'keyvalue' },
      { key: 'headers', label: 'Headers', kind: 'keyvalue', advanced: true },
      { key: 'body', label: 'Body', kind: 'json' },
    ],
    example: {
      type: 'connector-api',
      connection: 'azure-devops',
      method: 'GET',
      path: '/my-org/_apis/projects',
      query: { 'api-version': '7.1' },
    },
  },
  validate(c) {
    if (!c.connection || typeof c.connection !== 'string') throw new Error('connector-api invoker: missing connection');
    if (!c.path || typeof c.path !== 'string') throw new Error('connector-api invoker: missing path');
    if (!dynamic(c.path) && !c.path.startsWith('/')) throw new Error('connector-api invoker: the path starts with /');
    if (c.method !== undefined && !/^(GET|POST|PUT|PATCH|DELETE|HEAD)$/i.test(str(c.method)) && !dynamic(c.method))
      throw new Error(`connector-api invoker: unsupported method "${str(c.method)}"`);
  },
  connection: {
    async resolve(config, use) {
      const conn = await resolveConnection(str(config.connection));
      assertConnectionUse(conn, { write: rawWrite(config), workflow: use.workflow, team: use.team });
      assertRawCall(conn, str(config.method || 'GET'), str(config.path));
      return { config: { ...config, [RESOLVED]: conn }, secrets: conn.secrets };
    },
    async check(config, { workflow }) {
      const { conn } = await connectionInfo(str(config.connection));
      if (!conn.api) throw badRequest(`Connection "${conn.identifier}" does not allow raw API calls (no "api" allow-list)`);
      checkAllowedWorkflow(conn, workflow);
      // Literal method and path are checked now; templated ones when the step runs.
      if (!dynamic(config.method) && !dynamic(config.path))
        try {
          assertRawCall(conn, str(config.method || 'GET'), str(config.path));
        } catch (err) {
          throw badRequest(errorMessage(err));
        }
    },
  },
  async simulate(config) {
    const { conn, def, fields } = await connectionInfo(str(config.connection));
    if (rawWrite(config) && conn.access !== 'read-write') throw new Error(`Connection "${conn.identifier}" is read-only`);
    const request = await rawRequest({ identifier: conn.identifier, access: conn.access, api: conn.api, connector: def, fields }, config);
    return { rendered: { connection: conn.identifier, request }, output: { status: 200, body: null, headers: {} } };
  },
  async start({ config, log }) {
    const conn = resolvedOf(config);
    const request = await rawRequest(conn, config);
    await log(`API call through connection ${conn.identifier}`);
    const res = await send(conn, request, log);
    const headers = Object.fromEntries(HEADERS_KEPT.flatMap((h) => (res.headers.get(h) ? [[h, res.headers.get(h)!]] : [])));
    return {
      status: 'SUCCESS',
      result: { status: res.status, body: res.data, headers },
      statusLabel: `${request.method} ${pathOf(request.url)} · ${res.status}`,
    };
  },
};

/** The invoker types that go through a connection without a binding. */
export const CONNECTOR_INVOKERS = ['connector', 'connector-api'];
