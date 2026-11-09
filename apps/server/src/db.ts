import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { config, paths } from './config.js';
import { baseline } from './schema.js';
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

export interface Migration {
  id: number;
  name: string;
  up: (d: Driver) => Promise<void>;
  /**
   * SQLite: run with foreign keys off (table rebuilds; a DROP TABLE would otherwise cascade to the children) and
   * check them before committing. The pragma is a no-op inside a transaction, so it is set around it.
   */
  sqliteForeignKeysOff?: boolean;
}

/**
 * Baseline policy: the migration history was flattened into migration 1 (schema.ts) on 2026-11-07, before the first
 * production release. From now on append migrations (id 2, 3…) and never edit the baseline once it has shipped.
 */
export const MIGRATIONS: Migration[] = [
  { id: 1, name: 'baseline schema', up: baseline },
  {
    id: 5,
    name: 'trigger blackouts and deferred starts',
    async up(d) {
      // actions.blackouts: JSON { mode, windows } (NULL: none).
      await d.exec('ALTER TABLE actions ADD COLUMN blackouts TEXT');
      // Automated starts held during a blackout (blackoutMode: defer), started once due_at passes. Claimed by moving
      // due_at forward (a lease), deleted once started; dedupe_key is the idempotency key of the run.
      await d.exec(`CREATE TABLE deferred_starts (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        action TEXT NOT NULL,
        dedupe_key TEXT NOT NULL,
        payload TEXT NOT NULL,
        due_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      )`);
      await d.exec('CREATE UNIQUE INDEX deferred_starts_key ON deferred_starts(org_id, action, dedupe_key)');
      await d.exec('CREATE INDEX deferred_starts_due ON deferred_starts(due_at)');
    },
  },
  {
    id: 7,
    name: 'run and step SLAs, run artifacts, workflow tests',
    async up(d) {
      // SLA: `sla_due_at` is set when the clock starts and cleared (claimed) by housekeeping once due, so only due rows
      // are ever visited; `sla_breached_at` records the breach (shown on the run page).
      await d.exec(`
        ALTER TABLE runs ADD COLUMN sla_due_at TEXT;
        ALTER TABLE runs ADD COLUMN sla_breached_at TEXT;
        ALTER TABLE run_steps ADD COLUMN sla_due_at TEXT;
        ALTER TABLE run_steps ADD COLUMN sla_breached_at TEXT;
        ALTER TABLE actions ADD COLUMN sla_minutes INTEGER;
        ALTER TABLE actions ADD COLUMN tests TEXT;
        CREATE INDEX runs_sla_due ON runs(sla_due_at) WHERE sla_due_at IS NOT NULL;
        CREATE INDEX run_steps_sla_due ON run_steps(sla_due_at) WHERE sla_due_at IS NOT NULL;
        CREATE TABLE run_artifacts (
          id TEXT PRIMARY KEY,
          org_id TEXT,
          run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
          step_id TEXT,
          name TEXT NOT NULL,
          content_type TEXT NOT NULL,
          size INTEGER NOT NULL,
          sha256 TEXT NOT NULL,
          content ${d.dialect === 'postgres' ? 'BYTEA' : 'BLOB'} NOT NULL,
          created_at TEXT NOT NULL,
          created_by TEXT
        );
        CREATE INDEX run_artifacts_run ON run_artifacts(run_id, created_at);
      `);
    },
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
    const fkOff = !!m.sqliteForeignKeysOff && d.dialect === 'sqlite';
    if (fkOff) await d.exec('PRAGMA foreign_keys = OFF');
    await d.exec('BEGIN');
    try {
      await m.up(d);
      if (fkOff) {
        const broken = (await d.query('PRAGMA foreign_key_check')).rows;
        if (broken.length) throw new Error(`migration ${m.id}: foreign key check failed: ${JSON.stringify(broken.slice(0, 3))}`);
      }
      await d.query('INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)', [m.id, m.name, new Date().toISOString()]);
      await d.exec('COMMIT');
    } catch (err) {
      await d.exec('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      if (fkOff) await d.exec('PRAGMA foreign_keys = ON');
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
      await client.query(`SELECT pg_advisory_lock(${SCHEMA_KEY}, 726201)`);
      await migrate(postgresDriver(client));
    } else await assertMigrated(postgresDriver(client)); // no lock held while waiting
  } finally {
    await client.query(`SELECT pg_advisory_unlock(${SCHEMA_KEY}, 726201)`).catch(() => undefined);
    client.release();
  }
  return postgresDriver(pool);
}

/**
 * Postgres advisory locks are per database, not per schema: the first key is the current schema, so two installations
 * (or test files) in different schemas of one database never wait on each other. Replicas of one installation share
 * the schema, hence the lock.
 */
export const SCHEMA_KEY = 'hashtext(current_schema())';

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
    await client.query(`SELECT pg_advisory_lock(${SCHEMA_KEY}, $1)`, [key]);
    return await fn();
  } finally {
    await client.query(`SELECT pg_advisory_unlock(${SCHEMA_KEY}, $1)`, [key]).catch(() => undefined);
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
    const { rows } = await client.query<{ ok: boolean }>(`SELECT pg_try_advisory_lock(${SCHEMA_KEY}, $1) AS ok`, [key]);
    if (!rows[0]?.ok) return undefined;
    try {
      return await fn();
    } finally {
      await client.query(`SELECT pg_advisory_unlock(${SCHEMA_KEY}, $1)`, [key]).catch(() => undefined);
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
