import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { config, paths } from './config.js';
import { entitySearchText } from './catalog/search.js';

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
    id: 100,
    name: 'catalog performance: entity version, search backfill, indexes, trigram and full-text on Postgres',
    up: async (d) => {
      await d.exec(`
        ALTER TABLE entities ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
        CREATE INDEX entities_blueprint_updated ON entities(blueprint, updated_at);
        CREATE INDEX entities_title_key ON entities(title, blueprint, identifier);
        CREATE INDEX entities_updated_key ON entities(updated_at, blueprint, identifier);
        CREATE INDEX runs_action_created ON runs(action, created_at);
        CREATE INDEX runs_status_started ON runs(status, started_at);
        CREATE INDEX run_steps_deadline ON run_steps(status, deadline_at);
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
    id: 101,
    name: 'approvals scan index, blueprint stats',
    up: (d) =>
      d.exec(`
        CREATE INDEX runs_status_created ON runs(status, created_at);
        ALTER TABLE runs ADD COLUMN log_count INTEGER NOT NULL DEFAULT 0;
        CREATE TABLE rate_limits (key TEXT PRIMARY KEY, count INTEGER NOT NULL, window_start BIGINT NOT NULL);
        CREATE TABLE login_failures (email TEXT PRIMARY KEY, count INTEGER NOT NULL DEFAULT 0, locked_until BIGINT NOT NULL DEFAULT 0);
        CREATE TABLE config_version (id INTEGER PRIMARY KEY, version INTEGER NOT NULL);
        INSERT INTO config_version (id, version) VALUES (1, 0);
        CREATE TABLE blueprint_stats (
          blueprint TEXT PRIMARY KEY,
          entity_count INTEGER NOT NULL DEFAULT 0,
          updated_at TEXT NOT NULL
        );
      `),
  },
];

/** Apply pending numbered migrations (idempotent; serialized across replicas by an advisory lock on Postgres). */
export async function migrate(d: Driver, migrations = MIGRATIONS) {
  await d.exec('CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)');
  const done = new Set((await d.query<{ id: number }>('SELECT id FROM schema_migrations')).rows.map((r) => Number(r.id)));
  for (const m of migrations) {
    if (done.has(m.id)) continue;
    await m.up(d);
    await d.query('INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)', [m.id, m.name, new Date().toISOString()]);
  }
}

let pool: pg.Pool | undefined;

async function open(): Promise<Driver> {
  if (!config.DATABASE_URL?.startsWith('postgres')) {
    const d = sqliteDriver(paths.db);
    await migrate(d);
    return d;
  }
  pool = new pg.Pool({ connectionString: config.DATABASE_URL, max: config.DATABASE_POOL_SIZE });
  pool.on('error', (err) => console.error('[db] idle client error', err.message)); // never crash on a dropped idle connection
  // The database may start after the pods (fresh install, failover): wait instead of crash-looping.
  let client: pg.PoolClient | undefined;
  for (let attempt = 1; !client; attempt++) {
    try {
      client = await pool.connect();
    } catch (err) {
      if (attempt >= 30) throw err;
      console.warn(`[db] waiting for PostgreSQL (attempt ${attempt}/30): ${(err as Error).message}`);
      await new Promise((r) => setTimeout(r, Math.min(1000 * attempt, 5000)));
    }
  }
  try {
    await client.query('SELECT pg_advisory_lock(726201)');
    await migrate(postgresDriver(client));
  } finally {
    await client.query('SELECT pg_advisory_unlock(726201)').catch(() => undefined);
    client.release();
  }
  return postgresDriver(pool);
}

export const driver = await open();
export const dialect = driver.dialect;

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
    const r = await fn(postgresDriver(client));
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
