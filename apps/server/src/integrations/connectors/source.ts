import { validateAuth } from '../../lib/auth.js';
import type { AuthDef, ConnectorDef } from '../../schemas.js';
import type { Source, SourceEnv } from '../types.js';
import { httpSource } from '../sources/http.js';
import { builtinConnectors } from './definitions.js';
import { fieldsWithDefaults, inlineAuth, inlineCredentialNames, inlineCredentials, kindRequest, type Fields } from './request.js';
import { RESOLVED, type ResolvedConnection } from './connections.js';

/**
 * Ingestion through connector definitions:
 *  - `type: connector`, `config: { connection: <id> }`: any definition (built-in or the organization's), mappings by
 *    the definition's kinds;
 *  - `type: <built-in id>` (pagerduty, jira…, the former presets): the same, with either `connection: <id>` or the
 *    legacy inline keys (`baseUrl`, `token`, `email`, `user` / `password`, `apiKey`…, `auth`, `headers`).
 * The listing itself is the `http` source (pagination, incremental `since`, ETag, formats).
 */

interface Listing {
  def: ConnectorDef;
  fields: Fields;
  auth?: AuthDef;
  /** Legacy inline configs: extra request headers. */
  headers?: Record<string, string>;
}

async function* listKind(l: Listing, kind: string, env: SourceEnv): AsyncGenerator<unknown[]> {
  const { request, kind: k } = await kindRequest(l.def, kind, l.fields);
  yield* httpSource.list!(kind, {
    ...env,
    config: {
      url: request.url,
      method: request.method,
      headers: { ...request.headers, ...(l.headers ?? {}) },
      body: request.body,
      itemsPath: k.itemsPath,
      pagination: k.pagination,
      auth: l.auth,
      ...(k.since ? { incremental: { sinceParam: k.since.param } } : {}),
    },
  });
}

const resolvedOf = (config: Record<string, unknown>): ResolvedConnection | undefined => config[RESOLVED] as ResolvedConnection | undefined;

export const connectorSource: Source = {
  info: {
    type: 'connector',
    title: 'Connector',
    description: 'Ingest the kinds of a connector definition (built-in or your own) through a connection.',
    kinds: [],
    fields: [{ key: 'connection', label: 'Connection', kind: 'text', required: true, help: 'Identifier of a connection (Admin → Connections)' }],
    example: {
      type: 'connector',
      config: { connection: 'pagerduty' },
      mappings: [{ kind: 'service', entity: { blueprint: 'service', identifier: '$lowercase(name)', properties: { status: 'status' } } }],
    },
  },
  incremental: true,
  validate(c) {
    if (typeof c.connection !== 'string' || !c.connection) throw new Error('connector: "connection" (a connection identifier) is required');
  },
  async *list(kind, env) {
    const conn = resolvedOf(env.config);
    if (!conn) throw new Error('connector: the connection was not resolved');
    yield* listKind({ def: conn.connector, fields: conn.fields, auth: conn.auth }, kind, env);
  },
};

const RESERVED = new Set([
  'connection',
  'auth',
  'headers',
  'token',
  'email',
  'user',
  'username',
  'password',
  'apiKey',
  'appKey',
  'fullReconcileHours',
  'pushSecret',
  'pushPreset',
  'pushSignatureHeader',
]);

/** Legacy inline config → fields (every non-credential key) with the definition's defaults. */
const inlineFields = (def: ConnectorDef, c: Record<string, unknown>) =>
  fieldsWithDefaults(def, Object.fromEntries(Object.entries(c).filter(([k, v]) => !RESERVED.has(k) && k !== RESOLVED && v !== '' && v !== undefined)));

/** A built-in definition as an integration type of its own (the former presets). */
export function definitionSource(def: ConnectorDef): Source {
  return {
    info: {
      type: def.identifier,
      title: def.title,
      description: def.description,
      kinds: Object.keys(def.kinds),
      fields: [{ key: 'connection', label: 'Connection', kind: 'text', help: `A ${def.title} connection (or the inline keys of older configurations)` }],
      example: { type: def.identifier, config: { connection: def.identifier }, mappings: def.example?.mappings ?? [] },
    },
    incremental: Object.values(def.kinds).some((k) => k.since),
    validate(c) {
      if (c.connection !== undefined) {
        if (typeof c.connection !== 'string' || !c.connection) throw new Error(`${def.identifier}: "connection" must be a connection identifier`);
        return;
      }
      const fields = inlineFields(def, c);
      const missing = (def.fields.required ?? []).filter((f) => fields[f] === undefined || fields[f] === '');
      if (!fields.baseUrl && !missing.includes('baseUrl')) missing.unshift('baseUrl');
      if (def.auth.length && !c.auth && !def.authOptional && !inlineCredentials(def, c)) missing.push(...inlineCredentialNames(def));
      if (missing.length) throw new Error(`${def.identifier}: missing ${[...new Set(missing)].join(', ')}`);
      validateAuth(c.auth);
    },
    async *list(kind, env) {
      const conn = resolvedOf(env.config);
      if (conn) {
        yield* listKind({ def: conn.connector, fields: conn.fields, auth: conn.auth }, kind, env);
        return;
      }
      const fields = inlineFields(def, env.config);
      const auth = await inlineAuth(def, env.config, fields);
      yield* listKind({ def, fields, auth, headers: (env.config.headers as Record<string, string>) ?? undefined }, kind, env);
    },
  };
}

/** Integration types of the built-in definitions that have kinds (types already taken by code sources are skipped). */
export const definitionSources = (taken: (type: string) => boolean): Source[] =>
  [...builtinConnectors().values()].filter((d) => Object.keys(d.kinds).length && !taken(d.identifier)).map(definitionSource);

/** Does this source take a connection natively (connector or built-in definition types)? The connector it needs, if one. */
export function nativeConnector(type: string): string | true | undefined {
  if (type === 'connector') return true;
  return builtinConnectors().has(type) && !NON_NATIVE.has(type) ? type : undefined;
}
/** Built-in definitions whose identifier is a code source (bindings.ts applies to them instead). */
const NON_NATIVE = new Set(['azure-devops', 'github', 'gitlab']);
