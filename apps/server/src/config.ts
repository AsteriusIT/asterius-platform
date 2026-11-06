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
  ALLOW_REGISTRATION: bool(true),
  /** Users with these emails are admins (bootstrap). The first local user is admin too when no admin exists. */
  ADMIN_EMAILS: list.transform((v) => v.map((x) => x.toLowerCase())),
  SESSION_DAYS: z.coerce.number().default(7),
  ENTRA_TENANT_ID: z.string().optional(),
  ENTRA_CLIENT_ID: z.string().optional(),
  ENTRA_CLIENT_SECRET: z.string().optional(),
  ENTRA_REDIRECT_URI: z.string().optional(),
  /** Entra group object ids whose members are admins. */
  ENTRA_ADMIN_GROUPS: list,

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
  /** Keep entity history (versions, diffs) for N days; the latest version of every entity is always kept. */
  HISTORY_RETENTION_DAYS: z.coerce.number().int().min(1).default(365),
  KUBECONFIG_PATH: z.string().optional(),

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
