import { z } from 'zod';
import path from 'node:path';

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
  METRICS_TOKEN: z.string().optional(),
  /** Serve the built web UI from the API process (production image). */
  WEB_DIST_DIR: z.string().optional(),
  LOG_LEVEL: z.string().default('info'),

  // ---- sign-in ----
  AUTH_PROVIDERS: z
    .string()
    .optional()
    .transform((v) => (v || 'local').split(',').map((x) => x.trim()))
    .pipe(z.array(z.enum(['local', 'entra'])).min(1)),
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
  KUBE_JOB_SERVICE_ACCOUNTS: list,
  KUBE_JOB_CONTEXTS: list,
  KUBECONFIG_PATH: z.string().optional(),

  // ---- AI agent steps (Claude) ----
  /** Default credential of agent steps (a step may reference another key with `apiKey: ${secret:…}`). */
  ANTHROPIC_API_KEY: z.string().optional(),
  /** Agent steps without `model`. */
  AGENT_DEFAULT_MODEL: z.string().default('claude-opus-5-5'),
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
