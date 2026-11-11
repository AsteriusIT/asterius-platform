import { useSyncExternalStore } from 'react';
import type { AuthType, Connection, ConnectionTestResult, ConnectorAuthMethod, ConnectorCategory, ConnectorDefinition } from '@asterius/shared';
import { tabOrg } from './api';

/**
 * Client-side knowledge of connector definitions and connections (server: apps/server/src/integrations/connectors/).
 * Keep AUTH_FIELDS in sync with `authDef` (schemas.ts) and SECRET_AUTH_KEYS (connectors/request.ts).
 */

export const CATEGORY_LABELS: Record<ConnectorCategory, string> = {
  'source-control': 'Source control',
  'ci-cd': 'CI/CD & deployment',
  cloud: 'Cloud',
  incident: 'Incidents',
  observability: 'Observability',
  itsm: 'ITSM',
  'project-management': 'Project management',
  security: 'Security & quality',
  artifacts: 'Artifacts',
  identity: 'Identity',
  internal: 'Internal',
  other: 'Other',
};
export const categoryLabel = (c: string) => CATEGORY_LABELS[c as ConnectorCategory] ?? c;

const CATEGORY_ORDER = Object.keys(CATEGORY_LABELS);
/** The organization's own connectors first, then the built-ins by category (in CATEGORY_LABELS order) and title. */
export const pickerOrder = (defs: ConnectorDefinition[]) =>
  [...defs].sort(
    (a, b) =>
      Number(a.builtin) - Number(b.builtin) || CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category) || a.title.localeCompare(b.title),
  );

export const AUTH_LABELS: Record<AuthType, string> = {
  basic: 'Basic (user and password)',
  bearer: 'Bearer token',
  header: 'API key header',
  'oauth2-client-credentials': 'OAuth2 client credentials',
  'github-app': 'GitHub App',
  'azure-managed-identity': 'Azure managed identity',
  'azure-workload-identity': 'Azure workload identity',
  'gcp-service-account': 'GCP service account',
  'aws-sigv4': 'AWS SigV4',
  mtls: 'Client certificate (mTLS)',
};
export const methodLabel = (m: Pick<ConnectorAuthMethod, 'type' | 'title'>) => m.title || AUTH_LABELS[m.type] || m.type;

export interface AuthField {
  key: string;
  label: string;
  /** A credential: only a reference (`${secret:NAME}`…) is accepted. */
  secret?: boolean;
  required?: boolean;
  /** May be an empty string (Basic username of an Azure DevOps PAT). */
  allowEmpty?: boolean;
  placeholder?: string;
  options?: string[];
}

/** The inputs of each auth type (the keys of `authDef` but `type`). */
export const AUTH_FIELDS: Record<AuthType, AuthField[]> = {
  basic: [
    { key: 'username', label: 'Username', required: true, allowEmpty: true },
    { key: 'password', label: 'Password or token', secret: true, required: true },
  ],
  bearer: [{ key: 'token', label: 'Token', secret: true, required: true }],
  header: [],
  'oauth2-client-credentials': [
    { key: 'tokenUrl', label: 'Token URL', required: true, placeholder: 'https://login.example.com/oauth2/token' },
    { key: 'clientId', label: 'Client ID', required: true },
    { key: 'clientSecret', label: 'Client secret', secret: true, required: true },
    { key: 'scope', label: 'Scope' },
    { key: 'audience', label: 'Audience' },
    { key: 'authStyle', label: 'Send the client credentials', options: ['body', 'basic'] },
  ],
  'github-app': [
    { key: 'appId', label: 'App ID', required: true },
    { key: 'installationId', label: 'Installation ID', required: true },
    { key: 'privateKey', label: 'Private key', secret: true, required: true },
    { key: 'apiUrl', label: 'API URL', placeholder: 'https://api.github.com' },
  ],
  'azure-managed-identity': [
    { key: 'resource', label: 'Resource', required: true },
    { key: 'clientId', label: 'Client ID (user-assigned identity)' },
  ],
  'azure-workload-identity': [
    { key: 'scope', label: 'Scope', required: true },
    { key: 'clientId', label: 'Client ID', placeholder: 'AZURE_CLIENT_ID' },
    { key: 'tenantId', label: 'Tenant ID', placeholder: 'AZURE_TENANT_ID' },
  ],
  'gcp-service-account': [
    { key: 'scope', label: 'Scope', placeholder: 'https://www.googleapis.com/auth/cloud-platform' },
    { key: 'serviceAccountJson', label: 'Service account key', secret: true, placeholder: 'Empty: the identity of the workload' },
  ],
  'aws-sigv4': [
    { key: 'region', label: 'Region', required: true },
    { key: 'service', label: 'Service', required: true },
    { key: 'accessKeyId', label: 'Access key ID' },
    { key: 'secretAccessKey', label: 'Secret access key', secret: true },
    { key: 'sessionToken', label: 'Session token', secret: true },
  ],
  mtls: [
    { key: 'cert', label: 'Certificate (PEM)', required: true },
    { key: 'key', label: 'Private key', secret: true, required: true },
    { key: 'ca', label: 'CA bundle (PEM)' },
  ],
};

const PLACEHOLDER = /\{([A-Za-z_][A-Za-z0-9_]{0,63})\}/g;

/** `header` methods: the credentials their formats name (`Token token={token}` → token). */
export function placeholdersOf(method: Pick<ConnectorAuthMethod, 'headers'>): string[] {
  const out = new Set<string>();
  for (const v of Object.values(method.headers ?? {})) for (const m of v.matchAll(PLACEHOLDER)) out.add(m[1]!);
  return [...out];
}

/** What a connection supplies for a method: the type's inputs minus the values the definition fixes, plus its credentials. */
export function authInputs(method: ConnectorAuthMethod): AuthField[] {
  const set = method.set ?? {};
  const own = AUTH_FIELDS[method.type].filter((f) => !(f.key in set));
  const extra = [...(method.secrets ?? []), ...placeholdersOf(method)]
    .filter((k) => !own.some((f) => f.key === k) && !(k in set))
    .map((k): AuthField => ({ key: k, label: k, secret: true, required: true }));
  return [...own, ...extra];
}

/** A credential reference: `${secret:NAME}`, `${env:NAME}` or an external secret manager. The only accepted credential value. */
export const CREDENTIAL_REF = /^\$\{(secret|env|vault|awssm|azkv|gcpsm|k8s):[^}\s]+\}$/;
export const CREDENTIAL_HELP = 'Credentials are references, never values: ${secret:NAME} (Admin → Secrets), ${env:NAME}, ${vault:…}';

/** Problems of the auth block of a connection (the server checks again). */
export function authProblems(method: ConnectorAuthMethod | undefined, auth: Record<string, unknown> | null): Record<string, string> {
  if (!method || !auth) return {};
  const out: Record<string, string> = {};
  for (const f of authInputs(method)) {
    const v = auth[f.key];
    const empty = v === undefined || v === null || (v === '' && !f.allowEmpty);
    if (f.required && empty) out[f.key] = 'Required';
    else if (f.secret && typeof v === 'string' && v !== '' && !CREDENTIAL_REF.test(v.trim()))
      out[f.key] = 'Must be a reference such as ${secret:NAME}: the value itself is never stored';
  }
  return out;
}

/** Code integration types that optionally take a connection: what it fills in (hidden when one is used). */
export const CONNECTION_PROVIDES: Record<string, string[]> = {
  github: ['org', 'apiUrl', 'token'],
  gitlab: ['group', 'baseUrl', 'token'],
  'azure-devops': ['organization', 'project', 'token'],
};

/**
 * Integration types that always go through a connection, and of which connector (`true`: any): `connector`, and the
 * built-in definitions that are integration types of their own (pagerduty, jira…), but not the code sources.
 */
export function connectionTypeOf(type: string, connectors: ConnectorDefinition[]): string | true | undefined {
  if (type === 'connector') return true;
  if (type in CONNECTION_PROVIDES) return undefined;
  return connectors.some((d) => d.builtin && d.identifier === type) ? type : undefined;
}

// ---------- last test results (per browser, per organization) ----------
const STORE_KEY = 'asterius.connection-tests';
type Results = Record<string, Record<string, ConnectionTestResult>>;
const listeners = new Set<() => void>();
let cache: Results | null = null;

function load(): Results {
  if (cache) return cache;
  try {
    cache = JSON.parse(localStorage.getItem(STORE_KEY) ?? '{}') as Results;
  } catch {
    cache = {};
  }
  return cache;
}

/** Remember the result of "Test connection" (the server keeps it in the audit log only). */
export function rememberTest(id: string, result: ConnectionTestResult) {
  const org = tabOrg() ?? '';
  const all = load();
  cache = { ...all, [org]: { ...all[org], [id]: result } };
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(cache));
  } catch {
    // Private mode or storage full: kept for this page only.
  }
  for (const l of listeners) l();
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export function useLastTest(id: string | undefined): ConnectionTestResult | undefined {
  const all = useSyncExternalStore(subscribe, load);
  return id ? all[tabOrg() ?? '']?.[id] : undefined;
}

/** The blueprints the integrations of a connection write to. */
export function blueprintsFed(integrationIds: string[], integrations: { identifier: string; mappings: { entity: { blueprint: string } }[] }[]): string[] {
  const out = new Set<string>();
  for (const i of integrations) if (integrationIds.includes(i.identifier)) for (const m of i.mappings) if (m.entity?.blueprint) out.add(m.entity.blueprint);
  return [...out].sort();
}

export const connectorOf = (c: Pick<Connection, 'connector'>, connectors: ConnectorDefinition[] | undefined) =>
  connectors?.find((d) => d.identifier === c.connector);
