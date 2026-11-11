/**
 * Code sources and invokers that accept `connection: <id>` instead of an inline URL and token. A binding says which
 * connector definitions it accepts and how the connection fills the config (inline keys still win, except the
 * credential: `token` and `connection` together are refused). Pure: the connection is resolved by connections.ts.
 *
 * Credentials: these integrations send a token themselves, so the connection's auth must yield one: a PAT
 * (`basic` with an empty username: Azure DevOps), a `bearer` token, a `header` method with a `{token}` credential, or a
 * method that obtains an access token (OAuth2 client credentials, GitHub App, Entra workload / managed identity).
 */

/** The token of a connection, in the shape the code integration expects. */
export interface ConnectionToken {
  /** pat: a personal access token (Azure DevOps: Basic); bearer: an OAuth / Entra access token; token: a raw token header. */
  scheme: 'pat' | 'bearer' | 'token';
  token: string;
}

/** What a binding sees of a resolved connection. */
export interface BoundConnection {
  connector: string;
  fields: Record<string, unknown>;
}

export interface ConnectionBinding {
  /** Connector definitions it accepts. */
  connectors: string[];
  /** Values standing in for what the connection provides, to validate a config before the connection is resolved. */
  placeholders: (config: Record<string, unknown>) => Record<string, unknown>;
  /** Merge the connection into the config (inline values win). */
  apply: (config: Record<string, unknown>, conn: BoundConnection, token: () => Promise<ConnectionToken>) => Promise<Record<string, unknown>>;
}

const PLACEHOLDER_TOKEN = '${secret:CONNECTION}';
const trim = (v: unknown) => String(v ?? '').replace(/\/$/, '');
const fill = (config: Record<string, unknown>, values: Record<string, unknown>) => {
  const out = { ...config };
  for (const [k, v] of Object.entries(values)) if ((out[k] === undefined || out[k] === '') && v !== undefined && v !== '') out[k] = v;
  return out;
};

// Azure DevOps: the code integrations take `organization` as the full URL (https://dev.azure.com/<org>).
const adoOrganization = (f: Record<string, unknown>) => `${trim(f.baseUrl || 'https://dev.azure.com')}/${encodeURIComponent(String(f.organization ?? ''))}`;
const adoToken = (t: ConnectionToken) => (t.scheme === 'bearer' ? `Bearer ${t.token}` : t.token);

const azureDevOps: ConnectionBinding = {
  connectors: ['azure-devops'],
  placeholders: () => ({ organization: 'https://dev.azure.com/connection', project: 'connection', token: PLACEHOLDER_TOKEN }),
  apply: async (c, conn, token) => fill(c, { organization: adoOrganization(conn.fields), project: conn.fields.project, token: adoToken(await token()) }),
};

const githubSource: ConnectionBinding = {
  connectors: ['github'],
  placeholders: () => ({ org: 'connection', token: PLACEHOLDER_TOKEN }),
  apply: async (c, conn, token) => fill(c, { org: conn.fields.organization, apiUrl: conn.fields.baseUrl, token: (await token()).token }),
};
const githubWorkflow: ConnectionBinding = {
  connectors: ['github'],
  placeholders: () => ({ owner: 'connection', token: PLACEHOLDER_TOKEN }),
  apply: async (c, conn, token) => fill(c, { owner: conn.fields.organization, apiUrl: conn.fields.baseUrl, token: (await token()).token }),
};
const gitlabSource: ConnectionBinding = {
  connectors: ['gitlab'],
  placeholders: () => ({ group: 'connection', token: PLACEHOLDER_TOKEN }),
  apply: async (c, conn, token) => fill(c, { group: conn.fields.group, baseUrl: conn.fields.baseUrl, token: (await token()).token }),
};
const gitlabPipeline: ConnectionBinding = {
  connectors: ['gitlab'],
  placeholders: () => ({ token: PLACEHOLDER_TOKEN }),
  apply: async (c, conn, token) => fill(c, { baseUrl: conn.fields.baseUrl, token: (await token()).token }),
};

/** The scaffolder's `provider` names the connector (github, gitlab, azure-devops). */
const scaffolder: ConnectionBinding = {
  connectors: ['github', 'gitlab', 'azure-devops'],
  placeholders: (c) => (c.provider === 'azure-devops' ? azureDevOps.placeholders(c) : { token: PLACEHOLDER_TOKEN }),
  apply: async (c, conn, token) => {
    const provider = c.provider ?? conn.connector;
    if (provider !== conn.connector) throw new Error(`scaffolder: provider "${String(provider)}" cannot use a ${conn.connector} connection`);
    if (provider === 'azure-devops') return azureDevOps.apply({ ...c, provider }, conn, token);
    const t = (await token()).token;
    return fill({ ...c, provider }, provider === 'github' ? { apiUrl: conn.fields.baseUrl, token: t } : { baseUrl: conn.fields.baseUrl, token: t });
  },
};

export const SOURCE_BINDINGS: Record<string, ConnectionBinding> = {
  'azure-devops': azureDevOps,
  github: githubSource,
  gitlab: gitlabSource,
};

export const INVOKER_BINDINGS: Record<string, ConnectionBinding> = {
  'azure-pipeline': azureDevOps,
  'github-workflow': githubWorkflow,
  'gitlab-pipeline': gitlabPipeline,
  scaffolder,
};

export const bindingFor = (kind: 'source' | 'invoker', type: string): ConnectionBinding | undefined =>
  (kind === 'source' ? SOURCE_BINDINGS : INVOKER_BINDINGS)[type];

/** A `connection` key holding an identifier (not yet resolved). */
export const connectionRef = (config: Record<string, unknown>): string | undefined =>
  typeof config.connection === 'string' && config.connection ? config.connection : undefined;

const SLUG = /^[a-z][a-z0-9_-]{0,63}$/;

/**
 * The config to validate (save time, dry runs): a config naming a connection gets placeholders for what the connection
 * provides. Throws when the type does not accept connections (and is not connector-native).
 */
export function configForValidation(kind: 'source' | 'invoker', type: string, config: Record<string, unknown>, native = false): Record<string, unknown> {
  const id = connectionRef(config);
  if (config.connection === undefined || config.connection === null) return config;
  if (!id || !SLUG.test(id)) throw new Error(`${type}: "connection" must be the identifier of a connection`);
  if (native) return config;
  const b = bindingFor(kind, type);
  if (!b) throw new Error(`${type}: this ${kind === 'source' ? 'integration type' : 'invoker'} does not accept a connection`);
  if (config.token !== undefined && config.token !== '') throw new Error(`${type}: the token comes from the connection; remove "token" or "connection"`);
  return fill(config, b.placeholders(config));
}
