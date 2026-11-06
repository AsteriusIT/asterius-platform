import { z } from 'zod';
import path from 'node:path';

const bool = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? def : v === 'true' || v === '1'));

const list = z
  .string()
  .default('')
  .transform((v) =>
    v
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean),
  );

const schema = z.object({
  PORT: z.coerce.number().default(8080),
  /** all: API + background workers (default, single pod) | api: HTTP only | worker: runs, syncs and deliveries only. */
  PLATFORM_ROLE: z.enum(['all', 'api', 'worker']).default('all'),
  /** SQLite file location when DATABASE_URL is empty (local development, single instance). */
  DATA_DIR: z.string().default(path.resolve(process.cwd(), '../../data')),
  PUBLIC_URL: z.string().default('http://localhost:5173'),
  /** postgres://… (required for several replicas). Empty: SQLite under DATA_DIR. */
  DATABASE_URL: z.string().optional(),
  DATABASE_POOL_SIZE: z.coerce.number().default(10),
  /** Configuration as code: directory of YAML/JSON files (blueprints, actions, integrations, webhooks, teams). */
  CONFIG_DIR: z.string().default(path.resolve(process.cwd(), '../../config')),
  /** 32-byte key (base64 or hex) encrypting secrets stored in the database. Required with Postgres. */
  SECRETS_KEY: z.string().optional(),
  /**
   * Key ring for rotation: `id:key,id:key` (32 bytes, base64 or hex). The first key encrypts, all keys decrypt.
   * Takes precedence over SECRETS_KEY, which stays a decryption key (id `legacy`) for values written before rotation.
   */
  SECRETS_KEYS: z.string().optional(),
  /**
   * Independent key ring signing run callback tokens, same `id:key,…` syntax (the first key signs, all verify).
   * The id `derived` stands for the historical key derived from SECRETS_KEY (keeps in-flight callbacks valid).
   * Unset: only the derived key.
   */
  CALLBACK_KEYS: z.string().optional(),
  METRICS_TOKEN: z.string().optional(),
  /** Serve the built web UI from the API process (production image). */
  WEB_DIST_DIR: z.string().optional(),
  LOG_LEVEL: z.string().default('info'),

  // ---- sign-in ----
  AUTH_PROVIDERS: z
    .string()
    .optional()
    .transform((v) => (v || 'local').split(',').map((x) => x.trim()))
    .pipe(z.array(z.enum(['local', 'entra', 'oidc', 'github', 'saml'])).min(1)),
  ALLOW_REGISTRATION: bool(true),
  /** Users with these emails are admins (bootstrap). The first local user is admin too when no admin exists. */
  ADMIN_EMAILS: list.transform((v) => v.map((x) => x.toLowerCase())),
  SESSION_DAYS: z.coerce.number().default(7),
  /** Sign out sessions idle for this many minutes (0: only SESSION_DAYS applies). */
  SESSION_IDLE_MINUTES: z.coerce.number().int().min(0).default(0),
  /** Cap on API token lifetime in days; when set every token needs an expiry within it (0: no policy). */
  API_TOKEN_MAX_DAYS: z.coerce.number().int().min(0).default(0),
  ENTRA_TENANT_ID: z.string().optional(),
  ENTRA_CLIENT_ID: z.string().optional(),
  ENTRA_CLIENT_SECRET: z.string().optional(),
  ENTRA_REDIRECT_URI: z.string().optional(),
  /** Entra group object ids whose members are admins. */
  ENTRA_ADMIN_GROUPS: list,

  // ---- generic OpenID Connect (Okta, Keycloak, Google, Auth0, …): AUTH_PROVIDERS includes oidc ----
  OIDC_ISSUER: z.string().optional(),
  OIDC_CLIENT_ID: z.string().optional(),
  OIDC_CLIENT_SECRET: z.string().optional(),
  OIDC_REDIRECT_URI: z.string().optional(),
  OIDC_SCOPES: z.string().default('openid profile email'),
  /** Label of the sign-in button. */
  OIDC_TITLE: z.string().default('SSO'),
  /** Claim holding the group list (an array of strings); some providers use `roles` or a namespaced claim. */
  OIDC_GROUPS_CLAIM: z.string().default('groups'),
  OIDC_EMAIL_CLAIM: z.string().default('email'),
  OIDC_NAME_CLAIM: z.string().default('name'),
  /** Members of these groups are admins. */
  OIDC_ADMIN_GROUPS: list,
  /** Restrict sign-in to these email domains (empty: any). */
  OIDC_ALLOWED_DOMAINS: list.transform((v) => v.map((x) => x.toLowerCase())),

  // ---- SAML 2.0: AUTH_PROVIDERS includes saml ----
  SAML_ENTRY_POINT: z.string().optional(),
  /** IdP signing certificate (PEM; `\n` sequences allowed). */
  SAML_IDP_CERT: z.string().optional(),
  SAML_IDP_ISSUER: z.string().optional(),
  /** SP entity id (default: the metadata URL). */
  SAML_ISSUER: z.string().optional(),
  SAML_AUDIENCE: z.string().optional(),
  SAML_CALLBACK_URL: z.string().optional(),
  SAML_TITLE: z.string().default('SAML SSO'),
  SAML_EMAIL_ATTR: z.string().default('email'),
  SAML_NAME_ATTR: z.string().default('displayName'),
  SAML_GROUPS_ATTR: z.string().default('groups'),
  SAML_ADMIN_GROUPS: list,
  SAML_ALLOWED_DOMAINS: list.transform((v) => v.map((x) => x.toLowerCase())),
  SAML_WANT_ASSERTIONS_SIGNED: bool(true),
  SAML_WANT_RESPONSE_SIGNED: bool(false),

  // ---- GitHub OAuth: AUTH_PROVIDERS includes github ----
  GITHUB_CLIENT_ID: z.string().optional(),
  GITHUB_CLIENT_SECRET: z.string().optional(),
  GITHUB_REDIRECT_URI: z.string().optional(),
  /** Only members of these organizations may sign in (required: GitHub accounts are open to everyone). */
  GITHUB_ALLOWED_ORGS: list,
  /** `org` or `org/team-slug` entries, matched by team `entraGroupId`; members of GITHUB_ADMIN_TEAMS are admins. */
  GITHUB_ADMIN_TEAMS: list,
  GITHUB_API_URL: z.string().default('https://api.github.com'),
  GITHUB_URL: z.string().default('https://github.com'),

  // ---- workers ----
  /** Concurrent action runs per worker process. */
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).default(8),
  /** Seconds between status polls of running pipelines / jobs. */
  RUN_POLL_SECONDS: z.coerce.number().int().min(2).default(15),
  /** Runs still IN_PROGRESS after this many hours are failed. */
  RUN_TIMEOUT_HOURS: z.coerce.number().default(24),
  /** Outbound HTTP timeout for invokers, sources and webhooks. */
  HTTP_TIMEOUT_SECONDS: z.coerce.number().default(30),
  /** Keep run logs, sync runs, deliveries and audit entries for N days. */
  RETENTION_DAYS: z.coerce.number().int().min(1).default(90),
  /** Audit entries are kept longer than operational data. */
  AUDIT_RETENTION_DAYS: z.coerce.number().int().min(1).default(365),
  /** Link audit entries in a hash chain (tamper evidence). With AUDIT_CHAIN_KEY the hashes are HMACs only the platform can produce. */
  AUDIT_HASH_CHAIN: bool(false),
  AUDIT_CHAIN_KEY: z.string().optional(),
  /** Maximum rows of one audit export. */
  AUDIT_EXPORT_MAX: z.coerce.number().int().min(1).default(100_000),
  /** Stream audit entries to a SIEM: HTTPS endpoint and/or syslog (udp:// or tcp://). */
  AUDIT_STREAM_URL: z.string().optional(),
  AUDIT_STREAM_TOKEN: z.string().optional(),
  AUDIT_STREAM_SECRET: z.string().optional(),
  AUDIT_SYSLOG_URL: z.string().optional(),
  AUDIT_STREAM_INTERVAL_SECONDS: z.coerce.number().int().min(1).default(10),
  KUBECONFIG_PATH: z.string().optional(),

  // ---- external secret managers (references ${vault:…} ${awssm:…} ${azkv:…} ${gcpsm:…} ${k8s:…}) ----
  /** Seconds a resolved external secret is cached in memory (0: no cache). */
  SECRET_CACHE_SECONDS: z.coerce.number().int().min(0).max(3600).default(30),
  VAULT_ADDR: z.string().optional(),
  VAULT_TOKEN: z.string().optional(),
  VAULT_NAMESPACE: z.string().optional(),
  /** Vault Kubernetes auth: role bound to the platform's service account (no static token needed). */
  VAULT_K8S_ROLE: z.string().optional(),
  VAULT_K8S_MOUNT: z.string().default('kubernetes'),
  VAULT_K8S_JWT_PATH: z.string().optional(),
  AWS_REGION: z.string().optional(),
  AWS_ACCESS_KEY_ID: z.string().optional(),
  AWS_SECRET_ACCESS_KEY: z.string().optional(),
  AWS_SESSION_TOKEN: z.string().optional(),
  /** IRSA / web identity (set by EKS): exchanged for temporary credentials. */
  AWS_ROLE_ARN: z.string().optional(),
  AWS_WEB_IDENTITY_TOKEN_FILE: z.string().optional(),
  AWS_STS_ENDPOINT: z.string().optional(),
  AWS_SECRETSMANAGER_ENDPOINT: z.string().optional(),
  /** Azure Key Vault: enable explicitly; auth is workload identity (AZURE_* set by the webhook) or managed identity. */
  AZURE_KEYVAULT_ENABLED: bool(false),
  AZURE_KEYVAULT_URL_TEMPLATE: z.string().default('https://{vault}.vault.azure.net'),
  AZURE_TENANT_ID: z.string().optional(),
  AZURE_CLIENT_ID: z.string().optional(),
  AZURE_FEDERATED_TOKEN_FILE: z.string().optional(),
  AZURE_AUTHORITY_HOST: z.string().optional(),
  AZURE_IMDS_ENDPOINT: z.string().optional(),
  /** GCP Secret Manager: enable explicitly; auth is the metadata server's service account (GKE workload identity). */
  GCP_SECRETMANAGER_ENABLED: bool(false),
  GCP_SECRETMANAGER_URL: z.string().default('https://secretmanager.googleapis.com'),
  GCP_METADATA_URL: z.string().default('http://metadata.google.internal'),
  /** Namespaces whose Kubernetes Secrets can be referenced (default: the platform's own namespace). */
  K8S_SECRET_NAMESPACES: list,

  // ---- AI agent steps (Claude) ----
  /** Default credential of agent steps (a step may reference another key with `apiKey: ${secret:…}`). */
  ANTHROPIC_API_KEY: z.string().optional(),
  /** Agent steps without `model`. */
  AGENT_DEFAULT_MODEL: z.string().default('claude-opus-5-5'),
});

const parsed = schema.parse(process.env);
export const config = { ...parsed, PUBLIC_URL: parsed.PUBLIC_URL.replace(/\/$/, '') };
export type Config = typeof config;

export const paths = {
  db: path.join(config.DATA_DIR, 'platform.db'),
  secretsKey: path.join(config.DATA_DIR, 'secrets.key'),
};

export const isWorker = config.PLATFORM_ROLE !== 'api';
export const isApi = config.PLATFORM_ROLE !== 'worker';
