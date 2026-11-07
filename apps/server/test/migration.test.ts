import { describe, expect, it } from 'vitest';
import pg from 'pg';
import { randomBytes } from 'node:crypto';
import { MIGRATIONS, migrate, postgresDriver, sqliteDriver, type Driver } from '../src/db.js';

/** Upgrade of a populated single-tenant database (schema 7) to organizations (8+), on SQLite and, when set, Postgres. */

const t = '2026-01-01T00:00:00.000Z';

async function seedV7(d: Driver) {
  await migrate(
    d,
    MIGRATIONS.filter((m) => m.id <= 7),
  );
  const q = (sql: string, ...p: (string | number | null)[]) => d.query(sql, p);
  await q("INSERT INTO users (id, provider, email, name, role, created_at) VALUES ('u1', 'local', 'admin@x.test', 'Admin', 'admin', ?)", t);
  await q("INSERT INTO users (id, provider, email, name, role, created_at) VALUES ('u2', 'local', 'dev@x.test', 'Dev', 'member', ?)", t);
  await q("INSERT INTO users (id, provider, email, name, role, created_at) VALUES ('sa', 'service', 'ci@service.local', 'CI', 'member', ?)", t);
  await q("INSERT INTO teams (identifier, title, created_at) VALUES ('platform', 'Platform', ?)", t);
  await q("INSERT INTO team_members (team, user_id) VALUES ('platform', 'u2')");
  await q("INSERT INTO blueprints (identifier, title, schema, created_at, updated_at) VALUES ('service', 'Service', '{}', ?, ?)", t, t);
  await q(
    "INSERT INTO entities (blueprint, identifier, title, team, source, created_at, updated_at) VALUES ('service', 'api', 'API', 'platform', 'ui', ?, ?)",
    t,
    t,
  );
  await q("INSERT INTO entities (blueprint, identifier, title, source, created_at, updated_at) VALUES ('service', 'db', 'DB', 'ui', ?, ?)", t, t);
  await q(
    "INSERT INTO entity_relations (blueprint, identifier, relation, target_blueprint, target_identifier) VALUES ('service', 'api', 'dependsOn', 'service', 'db')",
  );
  await q(
    "INSERT INTO actions (identifier, title, trigger, inputs, invoker, approval, allowed, created_at, updated_at, steps) VALUES ('deploy', 'Deploy', 'create', '{}', 'null', '{}', '{}', ?, ?, '[]')",
    t,
    t,
  );
  await q(
    "INSERT INTO runs (id, action, action_title, inputs, status, invoker, approval, triggered_by, created_at, updated_at) VALUES ('r1', 'deploy', 'Deploy', '{}', 'SUCCESS', 'null', '{}', 'u2', ?, ?)",
    t,
    t,
  );
  await q(
    "INSERT INTO integrations (identifier, title, type, config, mappings, created_at, updated_at) VALUES ('gh', 'GitHub', 'github', '{}', '[]', ?, ?)",
    t,
    t,
  );
  await q("INSERT INTO sync_runs (id, integration, trigger, status, started_at) VALUES ('s1', 'gh', 'manual', 'success', ?)", t);
  await q("INSERT INTO webhooks (identifier, title, url, events, created_at, updated_at) VALUES ('w', 'W', 'https://x.test', '[]', ?, ?)", t, t);
  await q(
    "INSERT INTO deliveries (id, webhook, event, payload, status, next_attempt_at, created_at) VALUES ('d1', 'w', 'entity.created', '{}', 'success', ?, ?)",
    t,
    t,
  );
  await q("INSERT INTO secrets (name, value_enc, updated_at) VALUES ('TOKEN', 'v1:x', ?)", t);
  await q("INSERT INTO api_tokens (id, name, token_hash, prefix, user_id, created_at) VALUES ('t1', 'ci', 'h', 'ast_', 'sa', ?)", t);
  await q("INSERT INTO audit_log (id, at, action) VALUES ('a1', ?, 'run.triggered')", t);
}

async function checkUpgrade(d: Driver) {
  await seedV7(d);
  await migrate(d); // 8, 9…
  const one = async (sql: string) => (await d.query<Record<string, unknown>>(sql)).rows[0];
  const all = async (sql: string) => (await d.query<Record<string, unknown>>(sql)).rows;

  expect(await one("SELECT slug, name FROM organizations WHERE id = 'default'")).toEqual({ slug: 'default', name: 'Default' });
  expect(await all('SELECT user_id, role FROM memberships ORDER BY user_id')).toEqual([
    { user_id: 'sa', role: 'member' },
    { user_id: 'u1', role: 'admin' },
    { user_id: 'u2', role: 'member' },
  ]);
  expect(Number((await one("SELECT superadmin FROM users WHERE id = 'u1'"))!.superadmin)).toBe(1);
  expect(Number((await one("SELECT superadmin FROM users WHERE id = 'u2'"))!.superadmin)).toBe(0);
  for (const table of [
    'teams',
    'team_members',
    'blueprints',
    'entities',
    'entity_relations',
    'actions',
    'runs',
    'integrations',
    'sync_runs',
    'webhooks',
    'deliveries',
    'secrets',
    'api_tokens',
  ])
    expect(await all(`SELECT DISTINCT org_id FROM ${table}`), table).toEqual([{ org_id: 'default' }]);
  expect(await one("SELECT title, team FROM entities WHERE identifier = 'api'")).toEqual({ title: 'API', team: 'platform' });
  expect(await one('SELECT target_identifier FROM entity_relations')).toEqual({ target_identifier: 'db' });
  expect(await one("SELECT steps FROM actions WHERE identifier = 'deploy'")).toEqual({ steps: '[]' });

  // Keys are per organization now: the same identifiers can exist in another one.
  await d.query("INSERT INTO organizations (id, slug, name, created_at, updated_at) VALUES ('o2', 'acme', 'Acme', ?, ?)", [t, t]);
  await d.query("INSERT INTO blueprints (org_id, identifier, title, schema, created_at, updated_at) VALUES ('o2', 'service', 'Acme service', '{}', ?, ?)", [
    t,
    t,
  ]);
  await d.query("INSERT INTO secrets (org_id, name, value_enc, updated_at) VALUES ('o2', 'TOKEN', 'v1:y', ?)", [t]);
  expect(await all("SELECT org_id FROM blueprints WHERE identifier = 'service' ORDER BY org_id")).toEqual([{ org_id: 'default' }, { org_id: 'o2' }]);
  // Foreign keys still hold: an entity needs its organization's blueprint.
  await expect(
    d.query("INSERT INTO entities (org_id, blueprint, identifier, title, source, created_at, updated_at) VALUES ('o2', 'missing', 'x', 'x', 'ui', ?, ?)", [
      t,
      t,
    ]),
  ).rejects.toThrow();
  // Deleting a relation's entity cascades through the composite key.
  await d.query("DELETE FROM entities WHERE org_id = 'default' AND identifier = 'api'");
  expect(await all('SELECT * FROM entity_relations')).toEqual([]);
}

describe('migration to organizations', () => {
  it('moves a populated SQLite database into the default organization', async () => {
    const d = sqliteDriver(':memory:');
    await checkUpgrade(d);
    await d.close();
  });

  it.skipIf(!process.env.TEST_DATABASE_URL)('moves a populated Postgres database into the default organization', async () => {
    const schema = `m_${randomBytes(5).toString('hex')}`;
    const admin = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${schema}`);
    const c = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path=${schema}` });
    await c.connect();
    try {
      await checkUpgrade(postgresDriver(c as unknown as pg.PoolClient)); // a plain client is enough: no transactions
    } finally {
      await c.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  });
});
