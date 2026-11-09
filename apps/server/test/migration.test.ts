import { describe, expect, it } from 'vitest';
import pg from 'pg';
import { randomBytes } from 'node:crypto';
import { MIGRATIONS, migrate, postgresDriver, sqliteDriver, type Driver } from '../src/db.js';

/** Fresh install of the baseline schema (migration 1), on SQLite and, when set, Postgres. */

const t = '2026-01-01T00:00:00.000Z';

async function checkFresh(d: Driver) {
  await migrate(d);
  const all = async (sql: string) => (await d.query<Record<string, unknown>>(sql)).rows;

  expect(MIGRATIONS.map((m) => m.id)).toEqual([1, 6]);
  expect((await all('SELECT id, name FROM schema_migrations')).map((r) => Number(r.id))).toEqual(MIGRATIONS.map((m) => m.id));
  expect(await all("SELECT slug, name FROM organizations WHERE id = 'default'")).toEqual([{ slug: 'default', name: 'Default' }]);
  expect((await all('SELECT version FROM config_version WHERE id = 1')).map((r) => Number(r.version))).toEqual([0]);

  // A second run is a no-op.
  await migrate(d);
  expect((await all('SELECT id FROM schema_migrations')).length).toBe(MIGRATIONS.length);
  expect((await all('SELECT id FROM organizations')).length).toBe(1);

  // Keys are per organization: the same identifiers can exist in two of them.
  await d.query("INSERT INTO organizations (id, slug, name, created_at, updated_at) VALUES ('o2', 'acme', 'Acme', ?, ?)", [t, t]);
  for (const org of ['default', 'o2'])
    await d.query("INSERT INTO blueprints (org_id, identifier, title, schema, created_at, updated_at) VALUES (?, 'service', 'Service', '{}', ?, ?)", [
      org,
      t,
      t,
    ]);
  // Foreign keys hold: an entity needs its organization's blueprint.
  await expect(
    d.query("INSERT INTO entities (org_id, blueprint, identifier, title, source, created_at, updated_at) VALUES ('o2', 'missing', 'x', 'x', 'ui', ?, ?)", [
      t,
      t,
    ]),
  ).rejects.toThrow();
  // Deleting an entity cascades through the composite key.
  await d.query(
    "INSERT INTO entities (org_id, blueprint, identifier, title, source, created_at, updated_at) VALUES ('default', 'service', 'api', 'API', 'ui', ?, ?)",
    [t, t],
  );
  await d.query(
    "INSERT INTO entity_relations (org_id, blueprint, identifier, relation, target_blueprint, target_identifier) VALUES ('default', 'service', 'api', 'r', 'service', 'db')",
  );
  await d.query("DELETE FROM entities WHERE org_id = 'default' AND identifier = 'api'");
  expect(await all('SELECT * FROM entity_relations')).toEqual([]);
}

describe('baseline migration', () => {
  it('creates the schema on a fresh SQLite database', async () => {
    const d = sqliteDriver(':memory:');
    await checkFresh(d);
    await d.close();
  });

  it.skipIf(!process.env.TEST_DATABASE_URL)('creates the schema on a fresh Postgres schema', async () => {
    const schema = `m_${randomBytes(5).toString('hex')}`;
    const admin = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${schema}`);
    const c = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path=${schema}` });
    await c.connect();
    try {
      await checkFresh(postgresDriver(c as unknown as pg.PoolClient));
    } finally {
      await c.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  });
});
