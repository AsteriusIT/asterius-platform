import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { config, paths } from './config.js';
import { entitySearchText } from './catalog/search.js';
import { CATALOG_MIGRATIONS } from './catalog/migrations.js';
import { AI_MIGRATIONS } from './ai/migrations.js';
import { componentLogger } from './logger.js';
import { dbSpan } from './tracing.js';

/**
 * Storage: Postgres in production (DATABASE_URL, any number of replicas) or SQLite for local development.
 * SQL is written once with `?` placeholders (rewritten to `$n` on Postgres). Timestamps are ISO-8601 strings
 * produced by the application and JSON documents are TEXT columns, so both dialects behave the same.
 */

export type SqlValue = string | number | null;

export interface Driver {
  readonly dialect: 'sqlite' | 'postgres';
  query<T>(sql: string, params?: SqlValue[]): Promise<{ rows: T[]; changes: number }>;
  exec(sql: string): Promise<void>;
  close(): Promise<void>;
}

export function sqliteDriver(file: string): Driver {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const d = new DatabaseSync(file);
  d.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  return {
    dialect: 'sqlite',
    async query<T>(sql: string, params: SqlValue[] = []) {
      const st = d.prepare(sql);
      if (/^\s*(select|with|pragma)\b/i.test(sql) || /\breturning\b/i.test(sql)) return { rows: st.all(...params) as T[], changes: 0 };
      return { rows: [], changes: Number(st.run(...params).changes) };
    },
    async exec(sql: string) {
      d.exec(sql);
    },
    async close() {
      d.close();
    },
  };
}

// count(*) / bigserial / numeric come back as strings by default
pg.types.setTypeParser(20, Number);
pg.types.setTypeParser(1700, Number);

const toPg = (sql: string) => {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
};

/** Every query becomes a `db.<OP>` span (no-op unless tracing is enabled). */
function traced(d: Driver): Driver {
  return {
    dialect: d.dialect,
    query: (sql, params) => dbSpan(d.dialect, sql, () => d.query(sql, params)),
    exec: (sql) => d.exec(sql),
    close: () => d.close(),
  };
}

export function postgresDriver(conn: pg.Pool | pg.PoolClient): Driver {
  return {
    dialect: 'postgres',
    async query<T>(sql: string, params: SqlValue[] = []) {
      const r = await conn.query(toPg(sql), params);
      return { rows: r.rows as T[], changes: r.rowCount ?? 0 };
    },
    async exec(sql: string) {
      await conn.query(sql);
    },
    async close() {
      if ('end' in conn) await conn.end();
    },
  };
}

// ---------- schema ----------
const ddl = (d: Driver, sql: string) => (d.dialect === 'postgres' ? sql.replace(/INTEGER PRIMARY KEY AUTOINCREMENT/g, 'BIGSERIAL PRIMARY KEY') : sql);

const SCHEMA_V1 = `
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,              -- local | entra | service
  external_id TEXT,                    -- entra: <tenant id>:<object id>
  email TEXT NOT NULL,
  name TEXT NOT NULL,
  password_hash TEXT,
  role TEXT NOT NULL DEFAULT 'member', -- admin | member
  active INTEGER NOT NULL DEFAULT 1,
  groups TEXT NOT NULL DEFAULT '[]',   -- Entra group object ids at last sign-in
  last_login_at TEXT,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX users_email_provider ON users(provider, email);
CREATE UNIQUE INDEX users_external ON users(provider, external_id) WHERE external_id IS NOT NULL;

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL
);
CREATE INDEX sessions_user ON sessions(user_id);

CREATE TABLE oauth_states (
  state TEXT PRIMARY KEY,
  nonce TEXT NOT NULL,
  code_verifier TEXT NOT NULL,
  return_to TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE api_tokens (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  prefix TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_by TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT,
  last_used_at TEXT
);

CREATE TABLE teams (
  identifier TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  entra_group_id TEXT,
  managed INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE TABLE team_members (
  team TEXT NOT NULL REFERENCES teams(identifier) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  via TEXT NOT NULL DEFAULT 'manual', -- manual | entra
  PRIMARY KEY (team, user_id)
);
CREATE INDEX team_members_user ON team_members(user_id);

CREATE TABLE blueprints (
  identifier TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  icon TEXT,
  schema TEXT NOT NULL,
  relations TEXT NOT NULL DEFAULT '{}',
  managed INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE entities (
  blueprint TEXT NOT NULL REFERENCES blueprints(identifier),
  identifier TEXT NOT NULL,
  title TEXT NOT NULL,
  team TEXT,
  properties TEXT NOT NULL DEFAULT '{}',
  relations TEXT NOT NULL DEFAULT '{}',
  source TEXT NOT NULL,
  search TEXT NOT NULL DEFAULT '',     -- lower-cased identifier + title for LIKE search
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (blueprint, identifier)
);
CREATE INDEX entities_title ON entities(blueprint, title);
CREATE INDEX entities_source ON entities(source, blueprint);
CREATE INDEX entities_team ON entities(team);
CREATE INDEX entities_updated ON entities(updated_at);

CREATE TABLE entity_relations (
  blueprint TEXT NOT NULL,
  identifier TEXT NOT NULL,
  relation TEXT NOT NULL,
  target_blueprint TEXT NOT NULL,
  target_identifier TEXT NOT NULL,
  PRIMARY KEY (blueprint, identifier, relation, target_identifier),
  FOREIGN KEY (blueprint, identifier) REFERENCES entities(blueprint, identifier) ON DELETE CASCADE
);
CREATE INDEX entity_relations_target ON entity_relations(target_blueprint, target_identifier);

CREATE TABLE actions (
  identifier TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  icon TEXT,
  blueprint TEXT,
  trigger TEXT NOT NULL,
  inputs TEXT NOT NULL,
  invoker TEXT NOT NULL,
  approval TEXT NOT NULL,
  allowed TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  managed INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  action TEXT NOT NULL,
  action_title TEXT NOT NULL,
  blueprint TEXT,
  entity TEXT,
  inputs TEXT NOT NULL,
  status TEXT NOT NULL,
  status_label TEXT,
  link TEXT,
  result TEXT,
  invoker TEXT NOT NULL,               -- snapshot of the action's invoker at trigger time
  approval TEXT NOT NULL,              -- snapshot of the approval policy
  state TEXT,                          -- invoker state (external ids) for polling
  triggered_by TEXT NOT NULL REFERENCES users(id),
  team TEXT,                           -- team owning the target entity at trigger time
  worker TEXT,
  locked_until TEXT,
  next_poll_at TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  ended_at TEXT,
  updated_at TEXT NOT NULL
);
CREATE INDEX runs_status ON runs(status, next_poll_at);
CREATE INDEX runs_user ON runs(triggered_by, created_at);
CREATE INDEX runs_entity ON runs(blueprint, entity, created_at);
CREATE INDEX runs_created ON runs(created_at);

CREATE TABLE run_approvals (
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id),
  decision TEXT NOT NULL,
  comment TEXT NOT NULL DEFAULT '',
  at TEXT NOT NULL,
  PRIMARY KEY (run_id, user_id)
);

CREATE TABLE run_logs (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  at TEXT NOT NULL,
  level TEXT NOT NULL,
  message TEXT NOT NULL
);
CREATE INDEX run_logs_run ON run_logs(run_id, seq);

CREATE TABLE integrations (
  identifier TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  type TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  config TEXT NOT NULL,
  mappings TEXT NOT NULL,
  interval_minutes INTEGER NOT NULL DEFAULT 60,
  delete_missing INTEGER NOT NULL DEFAULT 0,
  managed INTEGER NOT NULL DEFAULT 0,
  next_sync_at TEXT,
  locked_until TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE sync_runs (
  id TEXT PRIMARY KEY,
  integration TEXT NOT NULL REFERENCES integrations(identifier) ON DELETE CASCADE,
  trigger TEXT NOT NULL,
  status TEXT NOT NULL,
  stats TEXT NOT NULL DEFAULT '{}',
  logs TEXT NOT NULL DEFAULT '[]',
  started_at TEXT NOT NULL,
  ended_at TEXT
);
CREATE INDEX sync_runs_integration ON sync_runs(integration, started_at);

CREATE TABLE webhooks (
  identifier TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  events TEXT NOT NULL,
  blueprints TEXT NOT NULL DEFAULT '[]',
  secret TEXT,                          -- reference: \${secret:NAME} / \${env:NAME}
  enabled INTEGER NOT NULL DEFAULT 1,
  managed INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE deliveries (
  id TEXT PRIMARY KEY,
  webhook TEXT NOT NULL REFERENCES webhooks(identifier) ON DELETE CASCADE,
  event TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL,                -- pending | success | failed
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  locked_until TEXT,
  response_status INTEGER,
  last_error TEXT,
  created_at TEXT NOT NULL,
  delivered_at TEXT
);
CREATE INDEX deliveries_due ON deliveries(status, next_attempt_at);
CREATE INDEX deliveries_webhook ON deliveries(webhook, created_at);

CREATE TABLE secrets (
  name TEXT PRIMARY KEY,
  value_enc TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  updated_by TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE audit_log (
  id TEXT PRIMARY KEY,
  at TEXT NOT NULL,
  action TEXT NOT NULL,
  actor_id TEXT,
  actor_email TEXT,
  target TEXT,
  detail TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX audit_at ON audit_log(at);
`;

export interface Migration {
  id: number;
  name: string;
  up: (d: Driver) => Promise<void>;
}

export const MIGRATIONS: Migration[] = [
  { id: 1, name: 'developer portal schema', up: (d) => d.exec(ddl(d, SCHEMA_V1)) },
  { id: 2, name: 'onboarding tour', up: (d) => d.exec('ALTER TABLE users ADD COLUMN tour_completed_at TEXT') },
  {
    id: 3,
    name: 'workflows: steps, step approvals, step logs',
    up: (d) =>
      d.exec(`
        ALTER TABLE actions ADD COLUMN steps TEXT;
        ALTER TABLE runs ADD COLUMN steps TEXT;
        ALTER TABLE run_logs ADD COLUMN step_id TEXT;
        CREATE TABLE run_steps (
          run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
          step_id TEXT NOT NULL,
          position INTEGER NOT NULL,
          name TEXT NOT NULL,
          type TEXT NOT NULL,
          status TEXT NOT NULL,   -- PENDING QUEUED RUNNING WAITING_APPROVAL SUCCESS FAILURE SKIPPED CANCELLED
          status_label TEXT,
          attempt INTEGER NOT NULL DEFAULT 0,
          output TEXT,
          state TEXT,             -- invoker state (external ids), approval message
          link TEXT,
          worker TEXT,
          locked_until TEXT,      -- lease while a worker executes the step
          next_at TEXT,           -- QUEUED: not before (retry backoff) · RUNNING: next status poll
          deadline_at TEXT,       -- timeout
          started_at TEXT,
          ended_at TEXT,
          PRIMARY KEY (run_id, step_id)
        );
        CREATE INDEX run_steps_due ON run_steps(status, next_at);
        CREATE TABLE step_approvals (
          run_id TEXT NOT NULL,
          step_id TEXT NOT NULL,
          user_id TEXT NOT NULL REFERENCES users(id),
          decision TEXT NOT NULL,
          comment TEXT NOT NULL DEFAULT '',
          at TEXT NOT NULL,
          PRIMARY KEY (run_id, step_id, user_id),
          FOREIGN KEY (run_id, step_id) REFERENCES run_steps(run_id, step_id) ON DELETE CASCADE
        );
      `),
  },
  {
    id: 4,
    name: 'users: local role override (Entra roles follow group claims unless an admin set the role by hand)',
    up: (d) => d.exec('ALTER TABLE users ADD COLUMN role_override INTEGER NOT NULL DEFAULT 0'),
  },
  {
    id: 5,
    name: 'inbound webhook delivery ids (replay protection)',
    up: (d) =>
      d.exec(`
        CREATE TABLE ingest_deliveries (
          integration TEXT NOT NULL,
          delivery_id TEXT NOT NULL,
          received_at TEXT NOT NULL,
          PRIMARY KEY (integration, delivery_id)
        );
        CREATE INDEX ingest_deliveries_at ON ingest_deliveries(received_at);
      `),
  },
  {
    id: 6,
    name: 'login failure counters shared by all replicas',
    up: (d) =>
      d.exec(`
        CREATE TABLE login_failures (
          key TEXT PRIMARY KEY,
          count INTEGER NOT NULL DEFAULT 0,
          locked_until TEXT,
          updated_at TEXT NOT NULL
        );
      `),
  },
  {
    id: 7,
    name: 'outbound webhooks: secondary signing secret for rotation',
    up: (d) => d.exec('ALTER TABLE webhooks ADD COLUMN secondary_secret TEXT'),
  },
  {
    id: 8,
    name: 'engine hardening: run deadline, cancel request, idempotency keys, lease owner, partial indexes',
    up: (d) =>
      d.exec(`
        ALTER TABLE runs ADD COLUMN deadline_at TEXT;
        ALTER TABLE runs ADD COLUMN cancel_requested INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE runs ADD COLUMN idempotency_key TEXT;
        CREATE UNIQUE INDEX runs_idempotency ON runs(triggered_by, action, idempotency_key);
        CREATE INDEX runs_deadline ON runs(deadline_at) WHERE status = 'IN_PROGRESS';
        ALTER TABLE integrations ADD COLUMN lock_owner TEXT;
        CREATE INDEX run_steps_lease ON run_steps(locked_until) WHERE status = 'RUNNING' AND locked_until IS NOT NULL;
        CREATE INDEX run_steps_deadline ON run_steps(deadline_at) WHERE deadline_at IS NOT NULL AND status IN ('QUEUED', 'RUNNING', 'WAITING_APPROVAL', 'WAITING');
      `),
  },
  {
    id: 9,
    name: 'catalog performance: entity version, search backfill, indexes, trigram and full-text on Postgres',
    up: async (d) => {
      await d.exec(`
        ALTER TABLE entities ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
        CREATE INDEX entities_blueprint_updated ON entities(blueprint, updated_at);
        CREATE INDEX entities_title_key ON entities(title, blueprint, identifier);
        CREATE INDEX entities_updated_key ON entities(updated_at, blueprint, identifier);
        CREATE INDEX runs_action_created ON runs(action, created_at);
        CREATE INDEX runs_status_started ON runs(status, started_at);
        CREATE INDEX deliveries_status_created ON deliveries(status, created_at);
        CREATE INDEX step_approvals_user ON step_approvals(user_id);
        CREATE INDEX run_approvals_user ON run_approvals(user_id);
        CREATE INDEX actions_blueprint ON actions(blueprint);
      `);
      // `search` now also holds string property values: rebuild it for existing rows, in chunks.
      let after: [string, string] | undefined;
      for (;;) {
        const rows = (
          await d.query<{ blueprint: string; identifier: string; title: string; properties: string }>(
            `SELECT blueprint, identifier, title, properties FROM entities ${after ? 'WHERE (blueprint, identifier) > (?, ?)' : ''} ORDER BY blueprint, identifier LIMIT 500`,
            after,
          )
        ).rows;
        if (!rows.length) break;
        for (const r of rows)
          await d.query('UPDATE entities SET search = ? WHERE blueprint = ? AND identifier = ?', [
            entitySearchText(r.identifier, r.title, json(r.properties, {})),
            r.blueprint,
            r.identifier,
          ]);
        const last = rows[rows.length - 1]!;
        after = [last.blueprint, last.identifier];
      }
      if (d.dialect !== 'postgres') return;
      await d.exec("ALTER TABLE entities ADD COLUMN search_tsv tsvector GENERATED ALWAYS AS (to_tsvector('simple', search)) STORED");
      await d.exec('CREATE INDEX entities_search_tsv ON entities USING gin (search_tsv)');
      await d.exec('CREATE INDEX entities_properties_gin ON entities USING gin ((properties::jsonb) jsonb_path_ops)');
      try {
        await d.exec('CREATE EXTENSION IF NOT EXISTS pg_trgm');
        const ns = (
          await d.query<{ nspname: string }>("SELECT n.nspname FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace WHERE e.extname = 'pg_trgm'")
        ).rows[0];
        if (ns) await d.exec(`CREATE INDEX entities_search_trgm ON entities USING gin (search "${ns.nspname}".gin_trgm_ops)`);
      } catch (err) {
        console.warn(`[db] pg_trgm unavailable, search falls back to substring matching: ${(err as Error).message}`);
      }
    },
  },
  {
    id: 10,
    name: 'approvals scan index, blueprint stats',
    up: (d) =>
      d.exec(`
        CREATE INDEX runs_status_created ON runs(status, created_at);
        ALTER TABLE runs ADD COLUMN log_count INTEGER NOT NULL DEFAULT 0;
        CREATE TABLE rate_limits (key TEXT PRIMARY KEY, count INTEGER NOT NULL, window_start BIGINT NOT NULL);
        CREATE TABLE config_version (id INTEGER PRIMARY KEY, version INTEGER NOT NULL);
        INSERT INTO config_version (id, version) VALUES (1, 0);
        CREATE TABLE blueprint_stats (
          blueprint TEXT PRIMARY KEY,
          entity_count INTEGER NOT NULL DEFAULT 0,
          updated_at TEXT NOT NULL
        );
      `),
  },
  ...CATALOG_MIGRATIONS,
  // Workflow features (epic ap-35y)
  {
    id: 17,
    name: 'workflow triggers: schedule, event, webhook, api',
    up: (d) =>
      d.exec(`
        ALTER TABLE actions ADD COLUMN trigger_config TEXT;  -- full trigger document for non-form triggers
        ALTER TABLE actions ADD COLUMN next_fire_at TEXT;    -- schedule triggers: next tick (claimed with a conditional UPDATE)
        ALTER TABLE runs ADD COLUMN trigger_type TEXT;
        ALTER TABLE runs ADD COLUMN trigger_info TEXT;
        CREATE INDEX actions_next_fire ON actions(next_fire_at);
      `),
  },
  {
    id: 18,
    name: 'workflows: sub-workflows, approval choices and values',
    up: (d) =>
      d.exec(`
        ALTER TABLE runs ADD COLUMN parent_run_id TEXT;
        ALTER TABLE runs ADD COLUMN parent_step_id TEXT;
        CREATE INDEX runs_parent ON runs(parent_run_id);
        ALTER TABLE step_approvals ADD COLUMN choice TEXT;
        ALTER TABLE step_approvals ADD COLUMN form_values TEXT;
      `),
  },
  {
    id: 19,
    name: 'action versions',
    up: (d) =>
      d.exec(`
        ALTER TABLE actions ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
        ALTER TABLE runs ADD COLUMN action_version INTEGER;
        CREATE TABLE action_versions (
          action TEXT NOT NULL,       -- no foreign key: the history outlives a deleted action
          version INTEGER NOT NULL,
          definition TEXT NOT NULL,
          actor_id TEXT,
          actor_email TEXT,
          note TEXT,
          created_at TEXT NOT NULL,
          PRIMARY KEY (action, version)
        );
      `),
  },
  {
    id: 20,
    name: 'notification settings and user preferences',
    up: (d) =>
      d.exec(`
        CREATE TABLE notification_settings (id INTEGER PRIMARY KEY, config TEXT NOT NULL, updated_at TEXT NOT NULL);
        ALTER TABLE users ADD COLUMN notification_prefs TEXT;
      `),
  },
  {
    id: 21,
    name: 'per-action secret allow-list',
    up: (d) =>
      d.exec(`
        ALTER TABLE actions ADD COLUMN allowed_secrets TEXT;  -- JSON list; NULL: unrestricted
        ALTER TABLE runs ADD COLUMN allowed_secrets TEXT;     -- snapshot at trigger time
      `),
  },
  // Identity & access epic (ap-m49)
  {
    id: 22,
    name: 'fine-grained RBAC: blueprint permissions, delegated roles',
    up: (d) => d.exec('ALTER TABLE blueprints ADD COLUMN permissions TEXT; ALTER TABLE users ADD COLUMN extra_roles TEXT'),
  },
  {
    id: 23,
    name: 'API token scopes and IP allow-list, session metadata',
    up: (d) =>
      d.exec(`
        ALTER TABLE api_tokens ADD COLUMN scopes TEXT;
        ALTER TABLE api_tokens ADD COLUMN blueprints TEXT;
        ALTER TABLE api_tokens ADD COLUMN ip_allow TEXT;
        ALTER TABLE sessions ADD COLUMN created_at TEXT;
        ALTER TABLE sessions ADD COLUMN last_seen_at TEXT;
        ALTER TABLE sessions ADD COLUMN ip TEXT;
        ALTER TABLE sessions ADD COLUMN user_agent TEXT;
      `),
  },
  {
    id: 24,
    name: 'audit log: SIEM streaming marker and hash chain',
    up: (d) =>
      d.exec(`
        ALTER TABLE audit_log ADD COLUMN streamed_at TEXT;
        ALTER TABLE audit_log ADD COLUMN chain_seq INTEGER;
        ALTER TABLE audit_log ADD COLUMN prev_hash TEXT;
        ALTER TABLE audit_log ADD COLUMN hash TEXT;
        CREATE INDEX audit_unstreamed ON audit_log(at) WHERE streamed_at IS NULL;
        CREATE UNIQUE INDEX audit_chain_seq ON audit_log(chain_seq) WHERE chain_seq IS NOT NULL;
        CREATE INDEX audit_action ON audit_log(action);
        CREATE INDEX audit_actor ON audit_log(actor_email);
      `),
  },
  // Integrations epic (ap-8s5)
  {
    id: 25,
    name: 'integrations: incremental sync state, deletion guards',
    up: (d) =>
      d.exec(`
        ALTER TABLE integrations ADD COLUMN sync_state TEXT;
        ALTER TABLE integrations ADD COLUMN delete_max_percent INTEGER NOT NULL DEFAULT 20;
        ALTER TABLE integrations ADD COLUMN delete_dry_run INTEGER NOT NULL DEFAULT 0;
      `),
  },
  {
    id: 26,
    name: 'integrations: cron schedule, single-kind sync requests, per-item sync errors',
    up: (d) =>
      d.exec(`
        ALTER TABLE integrations ADD COLUMN schedule TEXT;
        ALTER TABLE integrations ADD COLUMN requested_kind TEXT;
        ALTER TABLE sync_runs ADD COLUMN errors TEXT NOT NULL DEFAULT '[]';
      `),
  },
  {
    id: 27,
    name: 'integrations: ownership priority',
    up: (d) => d.exec('ALTER TABLE integrations ADD COLUMN priority INTEGER NOT NULL DEFAULT 0'),
  },
  {
    id: 28,
    name: 'webhooks: custom headers, filter, transform',
    up: (d) =>
      d.exec(`
        ALTER TABLE webhooks ADD COLUMN headers TEXT NOT NULL DEFAULT '{}';
        ALTER TABLE webhooks ADD COLUMN filter TEXT;
        ALTER TABLE webhooks ADD COLUMN transform TEXT;
      `),
  },
  {
    id: 29,
    name: 'configuration as code: applied status',
    up: (d) =>
      d.exec(`
        CREATE TABLE config_status (
          id INTEGER PRIMARY KEY,
          hash TEXT NOT NULL,
          files TEXT NOT NULL DEFAULT '[]',
          errors TEXT NOT NULL DEFAULT '[]',
          applied_at TEXT NOT NULL,
          applied_by TEXT
        );
      `),
  },
  {
    id: 30,
    name: 'inbound webhooks: persisted events processed by workers',
    up: (d) =>
      d.exec(`
        CREATE TABLE inbound_events (
          id TEXT PRIMARY KEY,
          integration TEXT NOT NULL REFERENCES integrations(identifier) ON DELETE CASCADE,
          headers TEXT NOT NULL,
          content_type TEXT NOT NULL,
          payload TEXT NOT NULL,
          status TEXT NOT NULL,        -- pending done failed
          attempts INTEGER NOT NULL DEFAULT 0,
          error TEXT,
          next_attempt_at TEXT NOT NULL,
          locked_until TEXT,
          received_at TEXT NOT NULL,
          processed_at TEXT
        );
        CREATE INDEX inbound_events_due ON inbound_events(status, next_attempt_at);
      `),
  },
  {
    id: 31,
    name: 'ownership: field owners, primary blueprints',
    up: (d) =>
      d.exec(`
        ALTER TABLE entities ADD COLUMN field_owners TEXT;
        ALTER TABLE integrations ADD COLUMN primary_for TEXT NOT NULL DEFAULT '[]';
      `),
  },
  {
    id: 32,
    name: 'integrations: scoped sync requests (push fast path)',
    up: (d) => d.exec('ALTER TABLE integrations ADD COLUMN requested_scope TEXT'),
  },
  ...AI_MIGRATIONS,
  {
    id: 34,
    name: 'in-app notifications inbox',
    up: (d) =>
      d.exec(`
        CREATE TABLE notifications (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          kind TEXT NOT NULL,
          title TEXT NOT NULL,
          body TEXT NOT NULL DEFAULT '',
          link TEXT,
          dedupe TEXT NOT NULL,
          created_at TEXT NOT NULL,
          read_at TEXT
        );
        CREATE UNIQUE INDEX notifications_dedupe ON notifications(user_id, dedupe);
        CREATE INDEX notifications_user ON notifications(user_id, created_at);
        CREATE TABLE notification_prefs (
          user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
          email INTEGER NOT NULL DEFAULT 0,
          slack INTEGER NOT NULL DEFAULT 0
        );
      `),
  },
];

/**
 * Apply pending numbered migrations (idempotent; serialized across replicas by an advisory lock on Postgres).
 * Each migration and its bookkeeping row commit atomically (DDL is transactional on both Postgres and SQLite), so a
 * failure half way never leaves a partly applied migration behind.
 */
export async function migrate(d: Driver, migrations = MIGRATIONS) {
  await d.exec('CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)');
  const done = new Set((await d.query<{ id: number }>('SELECT id FROM schema_migrations')).rows.map((r) => Number(r.id)));
  for (const m of migrations) {
    if (done.has(m.id)) continue;
    await d.exec('BEGIN');
    try {
      await m.up(d);
      await d.query('INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)', [m.id, m.name, new Date().toISOString()]);
      await d.exec('COMMIT');
    } catch (err) {
      await d.exec('ROLLBACK').catch(() => undefined);
      throw err;
    }
  }
}

/** Wait (bounded) for the migration job to bring the schema to this build's version, then fail so the pod restarts. */
async function assertMigrated(d: Driver) {
  for (let attempt = 1; ; attempt++) {
    const done = new Set<number>();
    try {
      for (const r of (await d.query<{ id: number }>('SELECT id FROM schema_migrations')).rows) done.add(Number(r.id));
    } catch {
      // table missing: nothing applied yet
    }
    const missing = MIGRATIONS.filter((m) => !done.has(m.id));
    if (!missing.length) return;
    if (attempt >= 100) throw new Error(`Database schema is behind: pending migrations ${missing.map((m) => m.id).join(', ')} (run the migration job)`);
    if (attempt === 1) console.warn(`[db] waiting for the migration job (pending: ${missing.map((m) => m.id).join(', ')})`);
    await new Promise((r) => setTimeout(r, 3000));
  }
}

const log = componentLogger('db');
let pool: pg.Pool | undefined;

async function open(): Promise<Driver> {
  if (!config.DATABASE_URL?.startsWith('postgres')) {
    const d = sqliteDriver(paths.db);
    await migrate(d); // SQLite is single-process: always migrate on open
    return d;
  }
  pool = new pg.Pool({ connectionString: config.DATABASE_URL, max: config.DATABASE_POOL_SIZE });
  pool.on('error', (err) => log.error({ err }, 'idle client error')); // never crash on a dropped idle connection
  // The database may start after the pods (fresh install, failover): wait instead of crash-looping.
  let client: pg.PoolClient | undefined;
  for (let attempt = 1; !client; attempt++) {
    try {
      client = await pool.connect();
    } catch (err) {
      if (attempt >= 30) throw err;
      log.warn({ attempt, err: (err as Error).message }, 'waiting for PostgreSQL');
      await new Promise((r) => setTimeout(r, Math.min(1000 * attempt, 5000)));
    }
  }
  try {
    // MIGRATE_ON_START=false: a pre-upgrade job (`npm run migrate`) owns the schema, pods only verify nothing is pending.
    if (config.MIGRATE_ON_START) {
      await client.query('SELECT pg_advisory_lock(726201)');
      await migrate(postgresDriver(client));
    } else await assertMigrated(postgresDriver(client)); // no lock held while waiting
  } finally {
    await client.query('SELECT pg_advisory_unlock(726201)').catch(() => undefined);
    client.release();
  }
  return postgresDriver(pool);
}

/** Connection pool occupancy (Postgres only), for the metrics endpoint. */
export const poolStats = () => (pool ? { total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount } : undefined);

export const driver = traced(await open());
export const dialect = driver.dialect;
/** Row lock suffix for `SELECT … FOR UPDATE` inside `tx` (SQLite serializes transactions in-process instead). */
export const forUpdate = dialect === 'postgres' ? ' FOR UPDATE' : '';

let sqliteChain: Promise<unknown> = Promise.resolve();

/**
 * Run `fn` in a transaction. Postgres: a dedicated pooled connection. SQLite (dev only): transactions are
 * serialized in-process; `fn` must use the driver it receives.
 */
export async function tx<T>(fn: (d: Driver) => Promise<T>): Promise<T> {
  if (!pool) {
    const p = sqliteChain.then(async () => {
      await driver.exec('BEGIN');
      try {
        const r = await fn(driver);
        await driver.exec('COMMIT');
        return r;
      } catch (err) {
        await driver.exec('ROLLBACK');
        throw err;
      }
    });
    sqliteChain = p.catch(() => undefined);
    return p;
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await fn(traced(postgresDriver(client)));
    await client.query('COMMIT');
    return r;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** Serialize `fn` across replicas (Postgres session advisory lock); in-process only on SQLite. */
export async function withAdvisoryLock<T>(key: number, fn: () => Promise<T>): Promise<T> {
  if (!pool) return fn();
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [key]);
    return await fn();
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [key]).catch(() => undefined);
    client.release();
  }
}

/**
 * Run `fn` when this replica wins a Postgres session advisory lock, skip (return undefined) when another replica holds
 * it. Use for periodic jobs where one replica per period is enough. In-process guard on SQLite.
 */
const localLocks = new Set<number>();
export async function tryAdvisoryLock<T>(key: number, fn: () => Promise<T>): Promise<T | undefined> {
  if (!pool) {
    if (localLocks.has(key)) return undefined;
    localLocks.add(key);
    try {
      return await fn();
    } finally {
      localLocks.delete(key);
    }
  }
  const client = await pool.connect();
  try {
    const { rows } = await client.query<{ ok: boolean }>('SELECT pg_try_advisory_lock($1) AS ok', [key]);
    if (!rows[0]?.ok) return undefined;
    try {
      return await fn();
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [key]).catch(() => undefined);
    }
  } finally {
    client.release();
  }
}

/** Wake sleeping workers on other replicas (Postgres LISTEN/NOTIFY); no-op on SQLite, where everything is in-process. */
export async function notify(channel: string) {
  if (pool) await pool.query('SELECT pg_notify($1, $2)', [channel, '']).catch(() => undefined);
}

/** LISTEN on a dedicated connection, reconnecting after failures. Returns a stop function. */
export function listen(channel: string, onMessage: () => void): () => Promise<void> {
  if (!pool || !config.DATABASE_URL) return async () => undefined;
  let stopped = false;
  let client: pg.Client | undefined;
  const connect = async () => {
    if (stopped) return;
    const c = new pg.Client({ connectionString: config.DATABASE_URL });
    c.on('notification', (m) => m.channel === channel && onMessage());
    const retry = () => {
      if (client === c) client = undefined;
      c.removeAllListeners();
      c.end().catch(() => undefined);
      if (!stopped) setTimeout(() => void connect(), 5000).unref();
    };
    c.on('error', retry);
    c.on('end', retry);
    try {
      await c.connect();
      await c.query(`LISTEN ${channel}`);
      client = c;
    } catch {
      retry();
    }
  };
  void connect();
  return async () => {
    stopped = true;
    const c = client;
    client = undefined;
    c?.removeAllListeners();
    await c?.end().catch(() => undefined);
  };
}

export const newId = () => randomUUID();
export const now = () => new Date().toISOString();
export const later = (ms: number) => new Date(Date.now() + ms).toISOString();

export async function one<T>(sql: string, ...params: SqlValue[]): Promise<T | undefined> {
  return (await driver.query<T>(sql, params)).rows[0];
}
export async function all<T>(sql: string, ...params: SqlValue[]): Promise<T[]> {
  return (await driver.query<T>(sql, params)).rows;
}
export async function run(sql: string, ...params: SqlValue[]): Promise<{ changes: number }> {
  return { changes: (await driver.query(sql, params)).changes };
}

export const json = <T>(v: string | null | undefined, fallback: T): T => {
  if (v == null || v === '') return fallback;
  try {
    return JSON.parse(v) as T;
  } catch {
    return fallback;
  }
};
export const bool = (v: unknown) => v === 1 || v === true || v === '1';

/** Escape LIKE wildcards; use with `ESCAPE '\\'`. */
export const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

export async function closeDb() {
  await driver.close();
}
