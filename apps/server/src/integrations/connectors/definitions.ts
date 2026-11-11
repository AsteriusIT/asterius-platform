import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import type { ConnectorDefinition, ConnectorVersion, ObjectSchema } from '@asterius/shared';
import { all, bool, json, now, one, run } from '../../db.js';
import { badRequest, conflict, errorMessage, HttpError, managedError, notFound } from '../../lib/errors.js';
import { staleVersion } from '../../lib/conflict.js';
import { checkExpression, checkTemplate, hasRefs } from '../../lib/expr.js';
import { validator } from '../../catalog/validation.js';
import { CREDENTIAL_REF, connectorDef, type ConnectorDef } from '../../schemas.js';
import { orgId } from '../../orgs/context.js';
import { SYSTEM, type Actor } from '../../audit.js';
import { placeholdersOf, SECRET_AUTH_KEYS } from './request.js';

/**
 * Connector definitions: built-in ones (YAML files in apps/server/connectors, shipped with the platform, read-only,
 * identical in every organization) and the organization's own (`connectors` table, created by admins or CONFIG_DIR,
 * versioned in `connector_versions`). Built-in identifiers cannot be overridden: copy a definition under another
 * identifier to change it, so integrations and connections relying on a built-in behave the same everywhere.
 */

// ---------- validation ----------
const CONNECTION_REF = /(?<![\w.$])connection\.([A-Za-z_][A-Za-z0-9_]*)/g;
const INPUT_REF = /(?<![\w.$])inputs\.([A-Za-z_][A-Za-z0-9_]*)/g;

const fail = (where: string, err: unknown): never => {
  throw badRequest(`${where}: ${errorMessage(err)}`);
};
const check = (where: string, fn: () => void) => {
  try {
    fn();
  } catch (err) {
    fail(where, err);
  }
};

/** Every reference to `connection.<x>` / `inputs.<x>` in `value` must be declared. */
function checkRefs(where: string, value: unknown, re: RegExp, declared: Set<string>, what: string) {
  for (const m of JSON.stringify(value ?? null).matchAll(re)) if (!declared.has(m[1]!)) throw badRequest(`${where}: ${what}.${m[1]} is used but not declared`);
}

/** Checks beyond the schema: templates and expressions parse, references are declared, no credentials. */
export function validateDefinition(def: ConnectorDef) {
  // The example (documentation) shows references; everything that is sent is checked.
  if (hasRefs({ ...def, example: undefined }))
    throw badRequest('A connector definition cannot contain ${secret:…} / ${env:…} references: credentials belong to connections');
  const props = def.fields.properties ?? {};
  if (!props.baseUrl || (props.baseUrl as { type?: string }).type !== 'string')
    throw badRequest('fields: a connector must declare a string field "baseUrl" (with a default for SaaS endpoints)');
  check('fields', () => validator(def.fields as ObjectSchema));
  const fields = new Set(Object.keys(props));
  const types = new Set<string>();
  def.auth.forEach((m, i) => {
    const where = `auth[${i}] (${m.type})`;
    if (types.has(m.type)) throw badRequest(`${where}: declared twice`);
    types.add(m.type);
    if (m.type === 'header' && !placeholdersOf(m).length)
      throw badRequest(`${where}: header methods need "headers" with at least one {credential} placeholder`);
    if (m.type !== 'header' && m.headers) throw badRequest(`${where}: "headers" only applies to the header method`);
    for (const v of Object.values(m.headers ?? {})) if (/\{\{|\$\{/.test(v)) throw badRequest(`${where}: header formats only use {credential} placeholders`);
    for (const k of [...SECRET_AUTH_KEYS[m.type], ...(m.secrets ?? [])]) {
      const v = m.set[k];
      if (typeof v === 'string' && v !== '' && !CREDENTIAL_REF.test(v))
        throw badRequest(`${where}: "${k}" is a credential and cannot be fixed by the definition`);
    }
    check(where, () => checkTemplate(m.set));
    checkRefs(where, m.set, CONNECTION_REF, fields, 'connection');
  });
  const request = (where: string, r: { path: string; query?: unknown; headers?: unknown; body?: unknown }, inputs?: Set<string>, extra?: string[]) => {
    check(where, () => checkTemplate([r.path, r.query, r.headers, r.body]));
    checkRefs(where, [r.path, r.query, r.headers, r.body], CONNECTION_REF, fields, 'connection');
    if (inputs) checkRefs(where, [r.path, r.query, r.headers, r.body], INPUT_REF, inputs, 'inputs');
    void extra;
  };
  check('headers', () => checkTemplate(def.headers));
  checkRefs('headers', def.headers, CONNECTION_REF, fields, 'connection');
  if (def.test) {
    request('test', def.test);
    if (def.test.expect.condition) check('test.expect.condition', () => checkExpression(def.test!.expect.condition!));
  }
  for (const [name, k] of Object.entries(def.kinds)) {
    const where = `kinds.${name}`;
    request(where, k);
    for (const e of [k.itemsPath, k.pagination?.nextUrl, k.pagination?.totalPath, k.pagination?.cursorPath]) if (e) check(where, () => checkExpression(e));
    for (const f of k.requires ?? []) if (!fields.has(f)) throw badRequest(`${where}: requires unknown field "${f}"`);
  }
  for (const [name, op] of Object.entries(def.operations)) {
    const where = `operations.${name}`;
    check(where, () => validator(op.inputs as ObjectSchema));
    const inputs = new Set(Object.keys(op.inputs.properties ?? {}));
    request(where, op, inputs);
    if (op.kind && !def.kinds[op.kind]) throw badRequest(`${where}: kind "${op.kind}" is not one of the definition's kinds`);
    for (const [k, e] of Object.entries(op.output ?? {})) check(`${where}.output.${k}`, () => checkExpression(e));
    checkRefs(`${where}.output`, op.output, INPUT_REF, inputs, 'inputs');
    if (op.poll) {
      request(`${where}.poll`, op.poll, inputs);
      for (const e of [op.poll.done, op.poll.failed, ...Object.values(op.poll.output ?? {})]) if (e) check(`${where}.poll`, () => checkExpression(e));
      checkRefs(`${where}.poll`, [op.poll.done, op.poll.failed, op.poll.output], INPUT_REF, inputs, 'inputs');
    }
  }
}

/** Parse and validate a definition document (400 with readable messages). */
export function parseDefinition(input: unknown): ConnectorDef {
  const r = connectorDef.safeParse(input);
  if (!r.success) throw badRequest(r.error.issues.map((i) => `${i.path.join('.') || 'definition'}: ${i.message}`).join('; '));
  validateDefinition(r.data);
  return r.data;
}

// ---------- built-in definitions ----------
const here = path.dirname(fileURLToPath(import.meta.url));
/** apps/server/connectors, from src/integrations/connectors (tsx, tests) and dist/integrations/connectors (build). */
export const BUILTIN_DIR = process.env.CONNECTORS_DIR ?? path.resolve(here, '../../../connectors');

let builtins: Map<string, ConnectorDef> | undefined;

/** Load the built-in definitions once (immutable for the life of the process). A broken file fails loudly. */
export function builtinConnectors(): Map<string, ConnectorDef> {
  if (builtins) return builtins;
  const out = new Map<string, ConnectorDef>();
  const files = fs.existsSync(BUILTIN_DIR)
    ? fs
        .readdirSync(BUILTIN_DIR)
        .filter((f) => /\.ya?ml$/.test(f))
        .sort()
    : [];
  for (const f of files) {
    let def: ConnectorDef;
    try {
      def = parseDefinition(parseYaml(fs.readFileSync(path.join(BUILTIN_DIR, f), 'utf8')));
    } catch (err) {
      throw new Error(`built-in connector ${f}: ${errorMessage(err)}`, { cause: err });
    }
    if (out.has(def.identifier)) throw new Error(`built-in connector ${def.identifier} is declared twice`);
    out.set(def.identifier, def);
  }
  builtins = out;
  return out;
}

// ---------- storage ----------
interface Row {
  identifier: string;
  title: string;
  definition: string;
  version: number;
  managed: number;
  updated_at: string;
}

const builtinView = (d: ConnectorDef): ConnectorDefinition => ({
  ...(d as unknown as ConnectorDefinition),
  builtin: true,
  managed: true,
  version: 0,
  updatedAt: null,
});
const toView = (r: Row): ConnectorDefinition => ({
  ...json<ConnectorDefinition>(r.definition, {} as ConnectorDefinition),
  builtin: false,
  managed: bool(r.managed),
  version: Number(r.version),
  updatedAt: r.updated_at,
});

/** Built-in definitions first, then the organization's, by title. */
export async function listConnectors(): Promise<ConnectorDefinition[]> {
  const own = (await all<Row>('SELECT * FROM connectors WHERE org_id = ? ORDER BY title', orgId())).map(toView);
  return [...[...builtinConnectors().values()].sort((a, b) => a.title.localeCompare(b.title)).map(builtinView), ...own];
}

export async function getConnector(id: string): Promise<ConnectorDefinition> {
  const b = builtinConnectors().get(id);
  if (b) return builtinView(b);
  const r = await one<Row>('SELECT * FROM connectors WHERE org_id = ? AND identifier = ?', orgId(), id);
  if (!r) throw notFound(`Connector ${id}`);
  return toView(r);
}

/** The definition a connection refers to (built-in or the organization's), or undefined. */
export async function findConnectorDef(id: string): Promise<ConnectorDef | undefined> {
  const b = builtinConnectors().get(id);
  if (b) return b;
  const r = await one<{ definition: string }>('SELECT definition FROM connectors WHERE org_id = ? AND identifier = ?', orgId(), id);
  return r ? connectorDef.parse(JSON.parse(r.definition)) : undefined;
}

async function staleConnector(id: string, expected: number) {
  const cur = await one<{ version: number }>('SELECT version FROM connectors WHERE org_id = ? AND identifier = ?', orgId(), id);
  const current = cur ? Number(cur.version) : null;
  const last =
    current === null
      ? undefined
      : await one<{ actor_id: string | null; actor_email: string | null; at: string }>(
          'SELECT actor_id, actor_email, created_at AS at FROM connector_versions WHERE org_id = ? AND connector = ? AND version = ?',
          orgId(),
          id,
          current,
        );
  return staleVersion(`Connector ${id} is at version ${current ?? 'none'}, not ${expected}; reload and retry`, current, last);
}

/**
 * Create or update an organization definition. `checkConnections` re-validates the connections using it (they must
 * stay valid: an auth method or a field they use cannot disappear).
 */
export async function upsertConnector(
  input: unknown,
  opts: { managed?: boolean; actor?: Actor; ifMatch?: number; checkConnections?: (def: ConnectorDef) => Promise<void> } = {},
): Promise<{ connector: ConnectorDefinition; created: boolean; changed: boolean }> {
  const def = parseDefinition(input);
  if (builtinConnectors().has(def.identifier)) throw conflict(`"${def.identifier}" is a built-in connector: copy it under another identifier to change it`);
  const org = orgId();
  const existing = await one<Row>('SELECT * FROM connectors WHERE org_id = ? AND identifier = ?', org, def.identifier);
  if (existing && bool(existing.managed) && !opts.managed) throw managedError('Connector', def.identifier);
  if (opts.ifMatch !== undefined && (existing ? Number(existing.version) : undefined) !== opts.ifMatch)
    throw await staleConnector(def.identifier, opts.ifMatch);
  const doc = JSON.stringify(def);
  const changed = !existing || existing.definition !== doc;
  if (existing && changed) await opts.checkConnections?.(def);
  let version = existing ? Number(existing.version) : 0;
  if (changed) {
    if (existing) version += 1;
    else {
      // History outlives a deleted definition: a re-created one continues the numbering.
      const max = await one<{ v: number | null }>('SELECT max(version) AS v FROM connector_versions WHERE org_id = ? AND connector = ?', org, def.identifier);
      version = Number(max?.v ?? 0) + 1;
    }
    const actor = opts.actor ?? SYSTEM;
    try {
      await run(
        'INSERT INTO connector_versions (org_id, connector, version, definition, actor_id, actor_email, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        org,
        def.identifier,
        version,
        doc,
        actor.id,
        actor.email,
        now(),
      );
    } catch {
      if (opts.ifMatch !== undefined) throw await staleConnector(def.identifier, opts.ifMatch);
      throw conflict('The connector was changed by someone else meanwhile; reload and try again');
    }
  }
  const t = now();
  if (existing)
    await run(
      'UPDATE connectors SET title = ?, definition = ?, version = ?, managed = ?, updated_at = ? WHERE org_id = ? AND identifier = ?',
      def.title,
      doc,
      version,
      opts.managed ? 1 : 0,
      changed ? t : existing.updated_at,
      org,
      def.identifier,
    );
  else
    await run(
      'INSERT INTO connectors (org_id, identifier, title, definition, version, managed, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      org,
      def.identifier,
      def.title,
      doc,
      version,
      opts.managed ? 1 : 0,
      t,
      t,
    );
  return { connector: await getConnector(def.identifier), created: !existing, changed };
}

/** Refused (409, `usedBy`) while connections use it. */
export async function deleteConnector(id: string, opts: { managed?: boolean } = {}) {
  if (builtinConnectors().has(id)) throw conflict(`"${id}" is a built-in connector and cannot be deleted`);
  const c = await getConnector(id);
  if (c.managed && !opts.managed) throw managedError('Connector', id);
  const used = await all<{ identifier: string }>('SELECT identifier FROM connections WHERE org_id = ? AND connector = ? ORDER BY identifier', orgId(), id);
  if (used.length)
    throw new HttpError(409, `Connector "${id}" is used by connection(s) ${used.map((u) => u.identifier).join(', ')}: delete them first`, {
      usedBy: { connections: used.map((u) => u.identifier) },
    });
  await run('DELETE FROM connectors WHERE org_id = ? AND identifier = ?', orgId(), id);
}

export async function listConnectorVersions(id: string): Promise<ConnectorVersion[]> {
  const rows = await all<{ version: number; actor_email: string | null; created_at: string; definition: string }>(
    'SELECT version, actor_email, created_at, definition FROM connector_versions WHERE org_id = ? AND connector = ? ORDER BY version DESC LIMIT 200',
    orgId(),
    id,
  );
  return rows.map((r) => ({ version: Number(r.version), actor: r.actor_email, at: r.created_at, definition: json(r.definition, {}) }));
}

export async function getConnectorVersion(id: string, version: number): Promise<ConnectorVersion> {
  const r = await one<{ version: number; actor_email: string | null; created_at: string; definition: string }>(
    'SELECT version, actor_email, created_at, definition FROM connector_versions WHERE org_id = ? AND connector = ? AND version = ?',
    orgId(),
    id,
    version,
  );
  if (!r) throw notFound(`Version ${version} of connector ${id}`);
  return { version: Number(r.version), actor: r.actor_email, at: r.created_at, definition: json(r.definition, {}) };
}
