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
  /**
   * Proxies whose X-Forwarded-For is believed (client IPs for rate limiting and lockout): `true`, `false`, a number of
   * hops, or a comma-separated list of addresses / CIDRs / names (`loopback`, `linklocal`, `uniquelocal`). The default
   * trusts private ranges only, i.e. an in-cluster ingress controller; set the ingress CIDR to be strict.
   */
  TRUST_PROXY: z.string().default('loopback,linklocal,uniquelocal'),
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
  /** Serve /metrics (and probes) on this separate port only, so the ingress cannot reach it. Unset: /metrics on PORT. */
  METRICS_PORT: z.coerce.number().int().optional(),
  /** Serve the built web UI from the API process (production image). */
  WEB_DIST_DIR: z.string().optional(),
  LOG_LEVEL: z.string().default('info'),
  /** json (default, one object per line) | pretty (human readable, local development; needs pino-pretty). */
  LOG_FORMAT: z.enum(['json', 'pretty']).default('json'),

  // ---- branding ----
  /** Product name shown in the sidebar, the sign-in page and the browser tab. */
  BRAND_NAME: z.string().min(1).max(60).default('Asterius Platform'),
  /** Logo (sidebar, sign-in, favicon): an https:// or same-origin (/…) image URL, or a data:image/… URI. Default: the built-in logo. */
  BRAND_LOGO: z
    .string()
    .regex(/^(https:\/\/|\/|data:image\/(png|jpeg|gif|webp|svg\+xml);base64,)/, 'BRAND_LOGO must be an https:// or /path image URL, or a data:image/… URI')
    .optional(),

  // ---- sign-in ----
  AUTH_PROVIDERS: z
    .string()
    .optional()
    .transform((v) => (v || 'local').split(',').map((x) => x.trim()))
    .pipe(z.array(z.enum(['local', 'entra', 'oidc', 'github', 'saml', 'keycloak'])).min(1)),
  /** Open self-registration. Default: on for a local PUBLIC_URL (development), off once a real public URL is set. */
  ALLOW_REGISTRATION: z.string().optional(),
  /**
   * One-time bootstrap secret: the first account registered with it (`bootstrapToken` field) becomes admin while no
   * admin exists. Without it (and without ADMIN_EMAILS), the first-registrant-is-admin fallback only applies to a local
   * PUBLIC_URL.
   */
  BOOTSTRAP_TOKEN: z.string().optional(),
  /** Users with these emails are admins (bootstrap). The first local user is admin too when no admin exists. */
  ADMIN_EMAILS: list.transform((v) => v.map((x) => x.toLowerCase())),
  SESSION_DAYS: z.coerce.number().default(7),
  /**
   * Browser sessions in an httpOnly cookie instead of a token kept by the web app (not readable by scripts, so an XSS
   * cannot steal it). State-changing requests then need the CSRF token (X-CSRF-Token) and a same-origin Origin.
   * API tokens and Authorization headers keep working unchanged.
   */
  SESSION_COOKIE: bool(false),
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
  /**
   * Minutes between re-synchronisations of the roles and teams of Entra users with an active session (0: sign-in only).
   * Also needs the app registration to hold the Microsoft Graph application permission GroupMember.Read.All (admin
   * consent), which is how group overage (more than 200 groups) is resolved at sign-in too.
   */
  ENTRA_RESYNC_MINUTES: z.coerce.number().int().min(0).default(60),

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
  // ---- Keycloak (registration, login, per-organization SSO) ----
  /**
   * Base URL of Keycloak as browsers reach it (https://id.example.com). With AUTH_PROVIDERS containing `keycloak`, sign-in
   * and registration happen there, and each platform organization maps to a Keycloak Organization (same alias) whose
   * identity providers (Entra, Okta, Google, any OIDC / SAML) organization admins connect from the platform.
   */
  KEYCLOAK_URL: z.string().optional(),
  /** Back-channel URL (token, JWKS, admin API) when it differs from KEYCLOAK_URL, e.g. the in-cluster service. */
  KEYCLOAK_INTERNAL_URL: z.string().optional(),
  KEYCLOAK_REALM: z.string().default('asterius'),
  /** Confidential OIDC client, with a service account holding realm-management: manage-users, manage-identity-providers, manage-realm. */
  KEYCLOAK_CLIENT_ID: z.string().default('asterius-platform'),
  KEYCLOAK_CLIENT_SECRET: z.string().optional(),

  // ---- organizations ----
  /** Who may create organizations: everyone signed in (self-service sign-up) or platform super-admins only. */
  ORG_CREATION: z.enum(['everyone', 'superadmin']).default('everyone'),
  /**
   * Single-tenant installs: new accounts join the default organization (the bootstrap super-admin as its admin). Off by
   * default: a new account belongs to no organization until it creates one, is invited, or signs in through an
   * organization's SSO.
   */
  AUTO_JOIN_DEFAULT_ORG: z
    .string()
    .optional()
    .transform((v) => v === 'true' || v === '1'),

  // ---- workers ----
  /** Concurrent action runs per worker process. */
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).default(8),
  /** Milliseconds between checks of steps waiting for child runs (sub-workflows, fan-out). */
  WORKFLOW_VISIT_MS: z.coerce.number().int().min(100).default(2000),
  /** Seconds between status polls of running pipelines / jobs. */
  RUN_POLL_SECONDS: z.coerce.number().int().min(2).default(15),
  /** A run still IN_PROGRESS this many hours after it started is failed (extended by the timeouts of its approval steps). */
  RUN_TIMEOUT_HOURS: z.coerce.number().default(24),
  /** Default timeout of one step (non-approval) when the step sets no `timeoutMinutes`. */
  STEP_TIMEOUT_MINUTES: z.coerce.number().int().min(1).default(1440),
  /** Longest sleep of an idle worker loop; it wakes sooner on new work (in-process, or Postgres NOTIFY). */
  WORKER_IDLE_MAX_MS: z.coerce.number().int().min(100).default(5000),
  /** Max log lines kept per run; further lines are dropped (a notice is added once). */
  RUN_LOG_MAX_LINES: z.coerce.number().int().min(100).default(5000),
  /** Apply schema migrations at startup. Set false when a pre-upgrade job runs them (`npm run migrate`). */
  MIGRATE_ON_START: bool(true),
  /** Outbound HTTP timeout for invokers, sources and webhooks. */
  HTTP_TIMEOUT_SECONDS: z.coerce.number().default(30),
  /** `database` shares API rate-limit counters between replicas (one upsert per request); `memory` is per pod. */
  RATE_LIMIT_STORE: z.enum(['memory', 'database']).default('memory'),
  /** Directory of plugin modules (*.mjs / *.js, or sub-directories with an index) loaded at startup. */
  PLUGIN_DIR: z.string().optional(),
  /** Comma separated plugin packages or paths loaded at startup (installed in the image). */
  PLUGINS: z.string().default(''),
  /** Retries of outbound requests on 429 / 5xx / network errors (0 disables), with jittered exponential backoff. */
  HTTP_RETRIES: z.coerce.number().int().min(0).max(10).default(3),
  HTTP_RETRY_BASE_MS: z.coerce.number().int().min(1).default(500),
  /** Longest single wait between attempts, including waits requested by Retry-After / X-RateLimit-Reset. */
  HTTP_RETRY_MAX_DELAY_SECONDS: z.coerce.number().min(0).default(60),
  /** Concurrent outbound requests per upstream host and process (0: unlimited). */
  HTTP_MAX_CONCURRENCY_PER_HOST: z.coerce.number().int().min(0).default(8),
  /** Consecutive failures that open the circuit of an integration, and how long it stays open (0 threshold: off). */
  HTTP_CIRCUIT_THRESHOLD: z.coerce.number().int().min(0).default(5),
  HTTP_CIRCUIT_COOLDOWN_SECONDS: z.coerce.number().min(1).default(60),
  /** Keep run logs, sync runs, deliveries and audit entries for N days. */
  RETENTION_DAYS: z.coerce.number().int().min(1).default(90),
  /**
   * SSRF guard for outbound HTTP. Private, loopback and link-local destinations (incl. cloud metadata) are blocked;
   * OUTBOUND_ALLOW lists hostnames, `*.suffix`, IPs or CIDRs that may be reached anyway (e.g. `*.internal,10.20.0.0/16`),
   * OUTBOUND_DENY lists destinations that are never reachable (it wins over the allow list).
   */
  OUTBOUND_ALLOW: list,
  OUTBOUND_DENY: list,
  /**
   * Kubernetes Job invoker allow-lists (empty: no restriction on namespaces / service accounts; the platform's RBAC still
   * applies). Other kubeconfig contexts than the default one are refused unless listed in KUBE_JOB_CONTEXTS.
   */
  KUBE_JOB_NAMESPACES: list,
  /**
   * Organizations (slugs) allowed to use the platform's own workload identity: external secret manager references
   * (`${vault:…}`, `${awssm:…}`, `${azkv:…}`, `${gcpsm:…}`, `${k8s:…}`) and `auth` blocks without credentials (Azure
   * managed / workload identity, the GCP metadata server, AWS IRSA). Other organizations bring their own credentials.
   * Default: the default organization only.
   */
  PLATFORM_IDENTITY_ORGS: z
    .string()
    .optional()
    .transform((v) =>
      (v ?? 'default')
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean),
    ),
  /**
   * Organizations (slugs) allowed to use the platform's own Kubernetes access: the Kubernetes source and the Job invoker
   * run with the platform's service account / kubeconfig, which tenants must not borrow. Default: the default organization.
   */
  KUBERNETES_ORGS: z
    .string()
    .optional()
    .transform((v) =>
      (v ?? 'default')
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean),
    ),
  KUBE_JOB_SERVICE_ACCOUNTS: list,
  KUBE_JOB_CONTEXTS: list,
  /** Keep entity history (versions, diffs) for N days; the latest version of every entity is always kept. */
  HISTORY_RETENTION_DAYS: z.coerce.number().int().min(1).default(365),
  /** Deleted entities stay restorable for N days (tombstones). 0: delete for good immediately. */
  TOMBSTONE_DAYS: z.coerce.number().int().min(0).default(30),

  // ---- guard rails ----
  /** A JSONata expression running longer than this (milliseconds) is stopped and fails with a clear message. */
  EXPR_TIMEOUT_MS: z.coerce.number().int().min(50).default(2000),
  /** Maximum nesting depth of a JSONata evaluation (non-terminating recursion). */
  EXPR_MAX_DEPTH: z.coerce.number().int().min(10).default(500),
  /** A step whose output is larger (JSON bytes) fails instead of bloating the database. */
  STEP_OUTPUT_MAX_BYTES: z.coerce.number().int().min(1024).default(262_144),

  // ---- notifications ----
  /** smtp://user:pass@host:587 (or smtps://…): email notifications and the email invoker. Admin → Notifications can override it. */
  SMTP_URL: z.string().optional(),
  SMTP_FROM: z.string().optional(),
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
  /** Model for assistant features (catalog questions, run explanations, authoring help, reviews); cheaper by default. */
  AI_ASSISTANT_MODEL: z.string().default('claude-sonnet-5-5'),
  /** JSON `{ "<model>": { "input": $/MTok, "output": $/MTok, "cacheWrite"?: $/MTok, "cacheRead"?: $/MTok } }` overriding the built-in price table. */
  AI_PRICES: z.string().optional(),
  /** Where agent steps call Claude: anthropic (default), bedrock (AWS) or vertex (Google Cloud). A step may override it. */
  AI_PROVIDER: z.enum(['anthropic', 'bedrock', 'vertex']).default('anthropic'),
  /** Bedrock / Vertex region and Vertex project (credentials come from the standard AWS / Google environment). */
  AI_REGION: z.string().optional(),
  AI_VERTEX_PROJECT: z.string().optional(),
  /** Scheduled catalog quality review every N hours (0: disabled). */
  AI_REVIEW_INTERVAL_HOURS: z.coerce.number().min(0).default(0),
  /** Entities untouched for this many days are reported as stale by the quality review. */
  AI_REVIEW_STALE_DAYS: z.coerce.number().int().min(1).default(180),
});

const parsed = schema.parse(process.env);
export const isLocalUrl = (u: string) => /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(u);
export const config = {
  ...parsed,
  PUBLIC_URL: parsed.PUBLIC_URL.replace(/\/$/, ''),
  ALLOW_REGISTRATION: parsed.ALLOW_REGISTRATION ? parsed.ALLOW_REGISTRATION === 'true' || parsed.ALLOW_REGISTRATION === '1' : isLocalUrl(parsed.PUBLIC_URL),
};
export type Config = typeof config;

export const paths = {
  db: path.join(config.DATA_DIR, 'platform.db'),
  secretsKey: path.join(config.DATA_DIR, 'secrets.key'),
};

export const isWorker = config.PLATFORM_ROLE !== 'api';
export const isApi = config.PLATFORM_ROLE !== 'worker';
