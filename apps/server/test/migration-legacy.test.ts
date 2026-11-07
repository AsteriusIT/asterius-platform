import { describe, expect, it } from 'vitest';
import pg from 'pg';
import { randomBytes } from 'node:crypto';
import { MIGRATIONS, migrate, postgresDriver, sqliteDriver, type Driver } from '../src/db.js';
import { ORG_MIGRATIONS } from '../src/orgs/migrations.js';

/**
 * Upgrade of a database from the first multi-tenant build (its migrations 8 "organizations (tenants)" and 9 "sessions:
 * identity provider ID token" are ids the roadmap uses for other migrations) with data in two organizations.
 * Runs on SQLite and, when TEST_DATABASE_URL is set, on Postgres.
 */

const t = '2026-01-01T00:00:00.000Z';

/** Build the legacy state: schema 7, organization-scoped core tables, rows numbered 8 and 9. */
async function seedLegacy(d: Driver) {
  await migrate(
    d,
    MIGRATIONS.filter((m) => m.id <= 7),
  );
  const q = (sql: string, ...p: (string | number | null)[]) => d.query(sql, p);
  await q("INSERT INTO users (id, provider, email, name, role, created_at) VALUES ('u1', 'local', 'admin@x.test', 'Admin', 'admin', ?)", t);
  await q("INSERT INTO blueprints (identifier, title, schema, created_at, updated_at) VALUES ('service', 'Service', '{}', ?, ?)", t, t);
  await q("INSERT INTO entities (blueprint, identifier, title, source, created_at, updated_at) VALUES ('service', 'api', 'Billing API', 'ui', ?, ?)", t, t);
  await q(
    "INSERT INTO actions (identifier, title, trigger, inputs, invoker, approval, allowed, created_at, updated_at, steps) VALUES ('deploy', 'Deploy', 'create', '{}', 'null', '{}', '{}', ?, ?, '[]')",
    t,
    t,
  );
  await q(
    "INSERT INTO runs (id, action, action_title, inputs, status, invoker, approval, triggered_by, created_at, updated_at) VALUES ('r1', 'deploy', 'Deploy', '{}', 'SUCCESS', 'null', '{}', 'u1', ?, ?)",
    t,
    t,
  );
  // The first multi-tenant build's migration 8 scoped the core tables; the roadmap's org migration does the same.
  // (Indexes on columns a schema-7 database lacks are skipped: the legacy build did not have them either.)
  const lenient: Driver = {
    ...d,
    exec: async (sql) => {
      try {
        await d.exec(sql);
      } catch (err) {
        if (!/^\s*CREATE (UNIQUE )?INDEX/i.test(sql)) throw err;
      }
    },
  };
  const cols = async () =>
    (
      await d.query<{ t: string; c: string }>(
        d.dialect === 'sqlite'
          ? "SELECT m.name AS t, p.name AS c FROM sqlite_master m, pragma_table_info(m.name) p WHERE m.type = 'table'"
          : "SELECT table_name AS t, column_name AS c FROM information_schema.columns WHERE table_schema = current_schema() AND is_generated = 'NEVER'",
      )
    ).rows;
  const v7 = new Set((await cols()).map((r) => `${r.t}.${r.c}`));
  if (d.dialect === 'sqlite') await d.exec('PRAGMA foreign_keys = OFF');
  await ORG_MIGRATIONS[0]!.up(lenient);
  if (d.dialect === 'sqlite') await d.exec('PRAGMA foreign_keys = ON');
  // The rebuild used the roadmap's final table shapes; the legacy build only had the columns of schema 7 (+ org_id).
  const v7Tables = new Set([...v7].map((k) => k.split('.')[0]));
  // …and none of the roadmap's later indexes.
  const loose = (
    await d.query<{ n: string }>(
      d.dialect === 'sqlite'
        ? "SELECT name AS n FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL"
        : 'SELECT indexname AS n FROM pg_indexes WHERE schemaname = current_schema() AND indexname NOT IN (SELECT conname FROM pg_constraint)',
    )
  ).rows;
  for (const { n } of loose) if (n !== 'memberships_user') await d.exec(`DROP INDEX ${n}`);
  for (const { t: table, c } of await cols()) {
    if (!v7Tables.has(table!) || v7.has(`${table}.${c}`) || ['org_id', 'superadmin', 'last_org_id', 'org', 'extra_roles'].includes(c!)) continue;
    await d.exec(`ALTER TABLE ${table} DROP COLUMN ${c}`).catch(() => undefined);
  }
  if (d.dialect === 'postgres') {
    // That build had no Postgres search columns yet.
    await d.exec('DROP INDEX IF EXISTS entities_search_tsv');
    await d.exec('DROP INDEX IF EXISTS entities_properties_gin');
    await d.exec('DROP INDEX IF EXISTS entities_search_trgm');
    await d.exec('ALTER TABLE entities DROP COLUMN IF EXISTS search_tsv');
  }
  await d.exec('ALTER TABLE sessions ADD COLUMN id_token TEXT');
  await q("INSERT INTO schema_migrations (id, name, applied_at) VALUES (8, 'organizations (tenants): memberships, org-scoped keys', ?)", t);
  await q("INSERT INTO schema_migrations (id, name, applied_at) VALUES (9, 'sessions: identity provider ID token (single sign-out)', ?)", t);
  // A second organization with the same identifiers but other content.
  await q("INSERT INTO organizations (id, slug, name, created_at, updated_at) VALUES ('o2', 'acme', 'Acme', ?, ?)", t, t);
  await q("INSERT INTO blueprints (org_id, identifier, title, schema, created_at, updated_at) VALUES ('o2', 'service', 'Acme service', '{}', ?, ?)", t, t);
  await q(
    "INSERT INTO entities (org_id, blueprint, identifier, title, source, search, created_at, updated_at) VALUES ('o2', 'service', 'api', 'Payroll gateway', 'ui', 'api payroll gateway', ?, ?)",
    t,
    t,
  );
  await q("UPDATE entities SET search = 'api billing api' WHERE org_id = 'default'");
}

async function checkLegacyUpgrade(d: Driver) {
  await seedLegacy(d);
  const all = async (sql: string) => (await d.query<Record<string, unknown>>(sql)).rows;
  await migrate(d);

  const applied = (await all('SELECT id FROM schema_migrations ORDER BY id')).map((r) => Number(r.id));
  expect(new Set(applied).size).toBe(applied.length);
  for (const m of MIGRATIONS) expect(applied, `migration ${m.id}`).toContain(m.id);
  expect(applied).toContain(1008); // the legacy "organizations (tenants)" row, moved out of the way
  expect((await all('SELECT name FROM schema_migrations WHERE id = 36'))[0]!.name).toMatch(/^sessions/);

  expect(await all('SELECT org_id, title FROM entities ORDER BY org_id')).toEqual([
    { org_id: 'default', title: 'Billing API' },
    { org_id: 'o2', title: 'Payroll gateway' },
  ]);
  // The roadmap's search backfill must not leak one organization's text into the other's same-named entity.
  expect(await all('SELECT org_id, search FROM entities ORDER BY org_id')).toEqual([
    { org_id: 'default', search: expect.stringContaining('billing') },
    { org_id: 'o2', search: expect.stringContaining('payroll') },
  ]);
  expect(await all('SELECT org_id, id FROM runs')).toEqual([{ org_id: 'default', id: 'r1' }]);
  expect(await all('SELECT org_id, identifier FROM actions')).toEqual([{ org_id: 'default', identifier: 'deploy' }]);
  expect(await all('SELECT id FROM organizations ORDER BY id')).toEqual([{ id: 'default' }, { id: 'o2' }]);

  if (d.dialect === 'postgres') {
    const idx = (await all("SELECT indexname FROM pg_indexes WHERE schemaname = current_schema() AND tablename = 'entities'")).map((r) => r.indexname);
    expect(idx).toContain('entities_search_tsv');
    expect(idx).toContain('entities_properties_gin');
    expect(idx).toContain('entities_search_trgm');
    expect(await all("SELECT org_id FROM entities WHERE search_tsv @@ to_tsquery('simple', 'payroll')")).toEqual([{ org_id: 'o2' }]);
    expect(await all("SELECT org_id FROM entities WHERE search ILIKE '%billing%'")).toEqual([{ org_id: 'default' }]);
  }

  // Idempotent: nothing left to apply, nothing changes.
  const before = JSON.stringify(await all('SELECT id, name, applied_at FROM schema_migrations ORDER BY id'));
  await migrate(d);
  expect(JSON.stringify(await all('SELECT id, name, applied_at FROM schema_migrations ORDER BY id'))).toBe(before);
}

describe('upgrade from the first multi-tenant build', () => {
  it('SQLite', async () => {
    const d = sqliteDriver(':memory:');
    await checkLegacyUpgrade(d);
    await d.close();
  });

  it.skipIf(!process.env.TEST_DATABASE_URL)('Postgres', async () => {
    const schema = `l_${randomBytes(5).toString('hex')}`;
    const admin = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${schema}`);
    const c = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path=${schema}` });
    await c.connect();
    try {
      await checkLegacyUpgrade(postgresDriver(c as unknown as pg.PoolClient));
    } finally {
      await c.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  });
});
