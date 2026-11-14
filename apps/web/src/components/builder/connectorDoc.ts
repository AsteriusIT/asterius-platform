import type { AuthType, ConnectorCategory, ConnectorPagination, HttpMethod, ObjectSchema } from '@asterius/shared';
import { AUTH_FIELDS, CATEGORY_LABELS, placeholdersOf } from '../../lib/connectors';
import { identityProblems, type Doc } from './FormBuilder';
import { FIELD_NAME, fieldProblems, fieldsToSchema, newId, schemaToFields, type FieldDraft } from './fields';

/**
 * A connector definition as edited by ConnectorBuilder, and its mapping to/from the document of the API
 * (`connectorDef` in apps/server/src/schemas.ts). Maps (kinds, operations) become ordered lists with their key,
 * JSON Schemas (connection fields, operation inputs) become field drafts; keys the form does not know are kept.
 * `connectorProblems` mirrors the schema and `validateDefinition` (integrations/connectors/definitions.ts).
 */

export const CATEGORIES = Object.keys(CATEGORY_LABELS) as ConnectorCategory[];
export const METHODS: HttpMethod[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
export const PAGINATION_TYPES: ConnectorPagination['type'][] = ['none', 'link', 'next', 'offset', 'page', 'cursor'];
/** Auth keys holding credentials (server: SECRET_AUTH_KEYS in connectors/request.ts). */
const SECRET_KEYS = Object.fromEntries(Object.entries(AUTH_FIELDS).map(([t, fs]) => [t, fs.filter((f) => f.secret).map((f) => f.key)])) as Record<
  AuthType,
  string[]
>;

type Extra = Record<string, unknown>;

export interface RequestDraft {
  method: HttpMethod;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  body?: unknown;
}

export interface AuthDraft {
  id: string;
  type: AuthType;
  title: string;
  description: string;
  set: Record<string, unknown>;
  /** `header` methods: header name → format with {credential} placeholders. */
  headers: Record<string, string>;
  secrets: string[];
  extra: Extra;
}

export interface KindDraft extends RequestDraft {
  id: string;
  key: string;
  /** The key follows the title until edited (new kinds). */
  autoKey?: boolean;
  title: string;
  description: string;
  itemsPath: string;
  pagination: ConnectorPagination | null;
  /** Incremental syncs: the query parameter of `since`. */
  since: string;
  requires: string[];
  extra: Extra;
}

export interface PollDraft extends RequestDraft {
  intervalSeconds: number;
  timeoutMinutes: number;
  done: string;
  failed: string;
  output: Record<string, string>;
  extra: Extra;
}

export interface OperationDraft extends RequestDraft {
  id: string;
  key: string;
  autoKey?: boolean;
  title: string;
  description: string;
  kind: string;
  readOnly: boolean | undefined;
  inputs: FieldDraft[];
  output: Record<string, string>;
  poll: PollDraft | null;
  extra: Extra;
}

export interface TestDraft extends RequestDraft {
  status: number[];
  condition: string;
  extra: Extra;
}

export interface ConnectorDoc extends Doc {
  description: string;
  icon: string | null;
  category: ConnectorCategory;
  /** The connection form, `baseUrl` included. */
  fields: FieldDraft[];
  auth: AuthDraft[];
  authOptional: boolean;
  headers: Record<string, string>;
  test: TestDraft | null;
  kinds: KindDraft[];
  operations: OperationDraft[];
}

// ---------- API document → form ----------

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const str = (v: unknown) => (typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v));
const strMap = (v: unknown): Record<string, string> =>
  Object.fromEntries(Object.entries(obj(v)).map(([k, x]) => [k, typeof x === 'string' ? x : JSON.stringify(x)]));
const strings = (v: unknown) => (Array.isArray(v) ? v.map(String) : []);
const method = (v: unknown): HttpMethod => (METHODS.includes(v as HttpMethod) ? (v as HttpMethod) : 'GET');

function toRequest(r: Record<string, unknown>): RequestDraft {
  return { method: method(r.method), path: str(r.path), query: strMap(r.query), headers: strMap(r.headers), body: r.body };
}

const without = (r: Record<string, unknown>, keys: string[]) => Object.fromEntries(Object.entries(r).filter(([k]) => !keys.includes(k)));
const REQUEST_KEYS = ['method', 'path', 'query', 'headers', 'body'];

export function toAuthDraft(v: unknown): AuthDraft {
  const m = obj(v);
  return {
    id: newId(),
    type: (m.type as AuthType) ?? 'bearer',
    title: str(m.title),
    description: str(m.description),
    set: { ...obj(m.set) },
    headers: strMap(m.headers),
    secrets: strings(m.secrets),
    extra: without(m, ['type', 'title', 'description', 'set', 'headers', 'secrets']),
  };
}

export function toKindDraft(key: string, v: unknown): KindDraft {
  const k = obj(v);
  return {
    id: newId(),
    key,
    title: str(k.title),
    description: str(k.description),
    ...toRequest(k),
    itemsPath: str(k.itemsPath),
    pagination: k.pagination ? ({ type: 'none', ...obj(k.pagination) } as ConnectorPagination) : null,
    since: str(obj(k.since).param),
    requires: strings(k.requires),
    extra: without(k, [...REQUEST_KEYS, 'title', 'description', 'itemsPath', 'pagination', 'since', 'requires']),
  };
}

export function toPollDraft(v: unknown): PollDraft {
  const p = obj(v);
  return {
    ...toRequest(p),
    intervalSeconds: typeof p.intervalSeconds === 'number' ? p.intervalSeconds : 15,
    timeoutMinutes: typeof p.timeoutMinutes === 'number' ? p.timeoutMinutes : 60,
    done: str(p.done),
    failed: str(p.failed),
    output: strMap(p.output),
    extra: without(p, [...REQUEST_KEYS, 'intervalSeconds', 'timeoutMinutes', 'done', 'failed', 'output']),
  };
}

export function toOperationDraft(key: string, v: unknown): OperationDraft {
  const o = obj(v);
  return {
    id: newId(),
    key,
    title: str(o.title),
    description: str(o.description),
    kind: str(o.kind),
    readOnly: typeof o.readOnly === 'boolean' ? o.readOnly : undefined,
    inputs: schemaToFields(obj(o.inputs) as unknown as ObjectSchema),
    ...toRequest(o),
    output: strMap(o.output),
    poll: o.poll ? toPollDraft(o.poll) : null,
    extra: without(o, [...REQUEST_KEYS, 'title', 'description', 'kind', 'readOnly', 'inputs', 'output', 'poll']),
  };
}

export function toTestDraft(v: unknown): TestDraft {
  const t = obj(v);
  const expect = obj(t.expect);
  return {
    ...toRequest(t),
    status: Array.isArray(expect.status) ? expect.status.map(Number) : [],
    condition: str(expect.condition),
    extra: without(t, [...REQUEST_KEYS, 'expect']),
  };
}

export const toConnectorDoc = (v: Record<string, unknown>): ConnectorDoc => ({
  ...v,
  identifier: str(v.identifier),
  title: str(v.title),
  description: str(v.description),
  icon: typeof v.icon === 'string' && v.icon ? v.icon : null,
  category: CATEGORIES.includes(v.category as ConnectorCategory) ? (v.category as ConnectorCategory) : 'other',
  fields: schemaToFields(obj(v.fields) as unknown as ObjectSchema),
  auth: Array.isArray(v.auth) ? v.auth.map(toAuthDraft) : [],
  authOptional: v.authOptional === true,
  headers: strMap(v.headers),
  test: v.test ? toTestDraft(v.test) : null,
  kinds: Object.entries(obj(v.kinds)).map(([k, x]) => toKindDraft(k, x)),
  operations: Object.entries(obj(v.operations)).map(([k, x]) => toOperationDraft(k, x)),
});

// ---------- form → API document ----------

/** Only non-empty optional values: the server fills the defaults. */
function compact(o: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(o).filter(
      ([, v]) =>
        v !== undefined &&
        v !== null &&
        v !== '' &&
        !(Array.isArray(v) && !v.length) &&
        !(typeof v === 'object' && !Array.isArray(v) && !Object.keys(v).length),
    ),
  );
}

const requestBody = (r: RequestDraft) => ({
  method: r.method,
  path: r.path,
  ...compact({ query: r.query, headers: r.headers }),
  ...(r.body !== undefined ? { body: r.body } : {}),
});

export function paginationBody(p: ConnectorPagination): ConnectorPagination {
  return compact({ ...p }) as unknown as ConnectorPagination;
}

export function authBody(m: AuthDraft): Record<string, unknown> {
  return {
    ...m.extra,
    type: m.type,
    ...compact({ title: m.title.trim(), description: m.description.trim(), headers: m.type === 'header' ? m.headers : undefined, secrets: m.secrets }),
    set: m.set,
  };
}

export function kindBody(k: KindDraft): Record<string, unknown> {
  return {
    ...k.extra,
    ...compact({ title: k.title.trim(), description: k.description.trim() }),
    ...requestBody(k),
    ...compact({
      itemsPath: k.itemsPath.trim(),
      pagination: k.pagination && k.pagination.type !== 'none' ? paginationBody(k.pagination) : undefined,
      since: k.since.trim() ? { param: k.since.trim() } : undefined,
      requires: k.requires,
    }),
  };
}

export function pollBody(p: PollDraft): Record<string, unknown> {
  return {
    ...p.extra,
    ...requestBody(p),
    intervalSeconds: p.intervalSeconds,
    timeoutMinutes: p.timeoutMinutes,
    done: p.done,
    ...compact({ failed: p.failed.trim(), output: p.output }),
  };
}

export function operationBody(o: OperationDraft): Record<string, unknown> {
  return {
    ...o.extra,
    title: o.title,
    description: o.description,
    ...compact({ kind: o.kind }),
    inputs: fieldsToSchema(o.inputs),
    ...requestBody(o),
    ...compact({ output: o.output, poll: o.poll ? pollBody(o.poll) : undefined }),
    ...(o.readOnly !== undefined ? { readOnly: o.readOnly } : {}),
  };
}

export function testBody(t: TestDraft): Record<string, unknown> {
  return { ...t.extra, ...requestBody(t), expect: compact({ status: t.status, condition: t.condition.trim() }) };
}

/** The document sent to the API (what the JSON / YAML tabs show). */
export function connectorBody(d: ConnectorDoc): Record<string, unknown> {
  const out: Record<string, unknown> = {
    ...d,
    description: d.description,
    icon: d.icon,
    category: d.category,
    fields: fieldsToSchema(d.fields),
    auth: d.auth.map(authBody),
    authOptional: d.authOptional,
    headers: d.headers,
    kinds: Object.fromEntries(d.kinds.map((k) => [k.key, kindBody(k)])),
    operations: Object.fromEntries(d.operations.map((o) => [o.key, operationBody(o)])),
  };
  if (d.test) out.test = testBody(d.test);
  else delete out.test;
  if (!d.icon) delete out.icon;
  return out;
}

// ---------- new items ----------

export const BASE_URL = 'baseUrl';

export const newAuth = (type: AuthType = 'bearer'): AuthDraft => ({
  id: newId(),
  type,
  title: '',
  description: '',
  set: {},
  headers: type === 'header' ? { 'X-API-Key': '{apiKey}' } : {},
  secrets: [],
  extra: {},
});
export const newKind = (): KindDraft => ({ ...toKindDraft('', { path: '/' }), autoKey: true });
export const newOperation = (): OperationDraft => ({ ...toOperationDraft('', { title: '', method: 'POST', path: '/' }), autoKey: true });
export const newPoll = (): PollDraft => toPollDraft({ path: '/', done: '' });
export const newTest = (): TestDraft => toTestDraft({ path: '/' });

// ---------- validation ----------

export const KEY = /^[a-z][a-z0-9_-]{0,63}$/;
export const HEADER_NAME = /^[A-Za-z0-9-]{1,100}$/;
const SECRET_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const CREDENTIAL_REF = /^\$\{(secret|env|vault|awssm|azkv|gcpsm|k8s):[^}\s]+\}$/;
const ANY_REF = /\$\{(secret|env|vault|awssm|azkv|gcpsm|k8s):/;
const CONNECTION_REF = /(?<![\w.$])connection\.([A-Za-z_][A-Za-z0-9_]*)/g;
const INPUT_REF = /(?<![\w.$])inputs\.([A-Za-z_][A-Za-z0-9_]*)/g;

/** Same rule as the server's `pathTemplate`: starts with /, no query string, no spaces (outside {{ }}). */
export function pathProblem(path: string): string | undefined {
  if (!path) return 'Path is required';
  if (path.length > 2000) return 'Path is too long';
  if (!/^\/[^?#\s]*$/.test(path.replace(/\{\{(?:(?!\}\})[\s\S])*\}\}/g, 'x'))) return 'Starts with / and has no query string (use Query) and no spaces';
  return undefined;
}

const undeclared = (value: unknown, re: RegExp, declared: Set<string>) => {
  const out = new Set<string>();
  for (const m of JSON.stringify(value ?? null).matchAll(re)) if (!declared.has(m[1]!)) out.add(m[1]!);
  return [...out];
};

function requestProblems(where: string, r: RequestDraft, fields: Set<string>, inputs?: Set<string>): string[] {
  const out: string[] = [];
  const p = pathProblem(r.path);
  if (p) out.push(`${where}: ${p}`);
  for (const h of Object.keys(r.headers)) if (!HEADER_NAME.test(h)) out.push(`${where}: header "${h}": letters, digits and - only`);
  const parts = [r.path, r.query, r.headers, r.body];
  for (const f of undeclared(parts, CONNECTION_REF, fields)) out.push(`${where}: connection.${f} is used but is not a connection field`);
  if (inputs) for (const f of undeclared(parts, INPUT_REF, inputs)) out.push(`${where}: inputs.${f} is used but is not an input`);
  return out;
}

const STRING_TYPES = new Set(['text', 'textarea', 'url', 'email', 'docs', 'date', 'datetime', 'choice', 'team', 'user', 'entity']);

export function connectorProblems(d: ConnectorDoc): string[] {
  const out = identityProblems(d);
  if (d.description.length > 4000) out.push('Description: at most 4000 characters');

  // Connection form.
  out.push(...fieldProblems(d.fields, 'Connection field'));
  const base = d.fields.find((f) => f.name === BASE_URL);
  if (!base) out.push('Connection form: the "baseUrl" field is required (the API URL every request is relative to)');
  else if (!STRING_TYPES.has(base.type)) out.push('Connection form: "baseUrl" must be a text or URL field');
  const fields = new Set(d.fields.map((f) => f.name).filter(Boolean));

  // Authentication.
  if (d.auth.length > 10) out.push('Authentication: at most 10 methods');
  const types = new Set<string>();
  d.auth.forEach((m, i) => {
    const where = `Authentication ${i + 1} (${m.type})`;
    if (types.has(m.type)) out.push(`${where}: this type is listed twice`);
    types.add(m.type);
    if (m.type === 'header') {
      if (!Object.keys(m.headers).length || !placeholdersOf(m).length) out.push(`${where}: add a header whose format has a {credential} placeholder`);
      for (const [h, v] of Object.entries(m.headers)) {
        if (!HEADER_NAME.test(h)) out.push(`${where}: header "${h}": letters, digits and - only`);
        if (!v.trim()) out.push(`${where}: header "${h}" needs a format`);
        if (/\{\{|\$\{/.test(v)) out.push(`${where}: header formats only use {credential} placeholders`);
      }
    }
    for (const s of m.secrets) if (!SECRET_NAME.test(s)) out.push(`${where}: credential "${s}": letters, digits and _, starting with a letter`);
    for (const k of [...SECRET_KEYS[m.type], ...m.secrets]) {
      const v = m.set[k];
      if (typeof v === 'string' && v !== '' && !CREDENTIAL_REF.test(v)) out.push(`${where}: "${k}" is a credential and cannot be fixed by the definition`);
    }
    for (const f of undeclared(m.set, CONNECTION_REF, fields)) out.push(`${where}: connection.${f} is used but is not a connection field`);
  });

  // Headers and test.
  for (const h of Object.keys(d.headers)) if (!HEADER_NAME.test(h)) out.push(`Headers: "${h}": letters, digits and - only`);
  for (const f of undeclared(d.headers, CONNECTION_REF, fields)) out.push(`Headers: connection.${f} is used but is not a connection field`);
  if (d.test) {
    out.push(...requestProblems('Test request', d.test, fields));
    for (const s of d.test.status) if (!Number.isInteger(s) || s < 100 || s > 599) out.push(`Test request: "${s}" is not an HTTP status`);
  }

  // Kinds.
  const kindKeys = new Set<string>();
  d.kinds.forEach((k, i) => {
    const where = `Kind ${k.key || i + 1}`;
    if (!KEY.test(k.key)) out.push(`${where}: the key must be lowercase letters, digits, - and _, starting with a letter`);
    else if (kindKeys.has(k.key)) out.push(`${where}: the key is used twice`);
    kindKeys.add(k.key);
    out.push(...requestProblems(where, k, fields));
    const p = k.pagination;
    if (p) {
      if (['offset', 'page', 'cursor'].includes(p.type) && !p.param?.trim()) out.push(`${where}: ${p.type} pagination needs a parameter`);
      if (p.type === 'next' && !p.nextUrl?.trim()) out.push(`${where}: next pagination needs the next URL expression`);
      if (p.type === 'cursor' && !p.cursorPath?.trim() && !p.cursorHeader?.trim()) out.push(`${where}: cursor pagination needs a cursor path or header`);
      if (p.cursorHeader && !HEADER_NAME.test(p.cursorHeader)) out.push(`${where}: cursor header: letters, digits and - only`);
    }
    for (const f of k.requires) if (!fields.has(f)) out.push(`${where}: requires unknown field "${f}"`);
  });

  // Operations.
  const opKeys = new Set<string>();
  d.operations.forEach((o, i) => {
    const where = `Operation ${o.key || i + 1}`;
    if (!KEY.test(o.key)) out.push(`${where}: the key must be lowercase letters, digits, - and _, starting with a letter`);
    else if (opKeys.has(o.key)) out.push(`${where}: the key is used twice`);
    opKeys.add(o.key);
    if (!o.title.trim()) out.push(`${where}: title is required`);
    if (o.kind && !kindKeys.has(o.kind)) out.push(`${where}: kind "${o.kind}" is not one of the kinds`);
    out.push(...fieldProblems(o.inputs, `${where}, input`));
    const inputs = new Set(o.inputs.map((f) => f.name).filter(Boolean));
    out.push(...requestProblems(where, o, fields, inputs));
    for (const [k, e] of Object.entries(o.output)) {
      if (!FIELD_NAME.test(k)) out.push(`${where}: output "${k}": letters, digits and _, starting with a letter`);
      if (!e.trim()) out.push(`${where}: output "${k}" needs an expression`);
    }
    for (const f of undeclared(o.output, INPUT_REF, inputs)) out.push(`${where}: output uses inputs.${f}, which is not an input`);
    if (o.poll) {
      const pw = `${where}, polling`;
      out.push(...requestProblems(pw, o.poll, fields, inputs));
      if (!o.poll.done.trim()) out.push(`${pw}: the "done" condition is required`);
      if (!Number.isInteger(o.poll.intervalSeconds) || o.poll.intervalSeconds < 2 || o.poll.intervalSeconds > 3600)
        out.push(`${pw}: interval between 2 and 3600 seconds`);
      if (!Number.isInteger(o.poll.timeoutMinutes) || o.poll.timeoutMinutes < 1 || o.poll.timeoutMinutes > 10080)
        out.push(`${pw}: timeout between 1 and 10080 minutes`);
      for (const k of Object.keys(o.poll.output)) if (!FIELD_NAME.test(k)) out.push(`${pw}: output "${k}": letters, digits and _, starting with a letter`);
    }
  });

  // Credentials never belong to a definition (the example documents references and is not sent).
  const { example: _e, ...sent } = connectorBody(d);
  if (ANY_REF.test(JSON.stringify(sent))) out.push('A definition cannot contain ${secret:…} / ${env:…} references: credentials belong to connections');
  return out;
}
