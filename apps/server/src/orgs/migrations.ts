import type { Driver, Migration } from '../db.js';

/**
 * Organizations (tenants) schema. Every named resource gets `org_id` in its primary key, records keyed by an id get
 * an `org_id` column, singletons become one row per organization. Existing data moves into the `default`
 * organization.
 *
 * Databases reach this point in different shapes, so every step detects what is already there:
 *  - fresh installs and installs of the roadmap branch: migrations 1-34, then everything below;
 *  - installs of the first multi-tenant build: its migrations 8-9 (organizations, session ID token) are renumbered
 *    by `renumberLegacyOrgMigrations` so the roadmap migrations 8-9 run, and the core tables are already scoped;
 *  - databases that ran both (the roadmap migrations 10-34 on top of the first multi-tenant build).
 */

const DEFAULT = 'default';

/** Names of the stored (non-generated) columns of a table; empty when the table does not exist. */
export async function columns(d: Driver, table: string): Promise<string[]> {
  const rows =
    d.dialect === 'sqlite'
      ? (await d.query<{ name: string }>('SELECT name FROM pragma_table_info(?)', [table])).rows
      : (
          await d.query<{ name: string }>(
            "SELECT column_name AS name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = ? AND is_generated = 'NEVER' ORDER BY ordinal_position",
            [table],
          )
        ).rows;
  return rows.map((r) => r.name);
}

async function addColumn(d: Driver, table: string, column: string, definition: string) {
  if (!(await columns(d, table)).includes(column)) await d.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

const autoId = (d: Driver, sql: string) => (d.dialect === 'postgres' ? sql.replace(/INTEGER PRIMARY KEY AUTOINCREMENT/g, 'BIGSERIAL PRIMARY KEY') : sql);

interface ScopedTable {
  name: string;
  /** Full definition with `org_id` (CREATE TABLE body). */
  ddl: string;
  /** Source columns not copied (e.g. an AUTOINCREMENT id, a singleton id). */
  skip?: string[];
  /** Row filter / order of the copy. */
  where?: string;
  order?: string;
}

/**
 * Tables rebuilt with `org_id` in their key, parents before children. Columns are those of the roadmap schema
 * (migration 34); the copy takes the columns both versions have, so older shapes migrate too.
 */
const SCOPED: ScopedTable[] = [
  {
    name: 'teams',
    ddl: `org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      identifier TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      entra_group_id TEXT,
      managed INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      PRIMARY KEY (org_id, identifier)`,
  },
  {
    name: 'team_members',
    ddl: `org_id TEXT NOT NULL,
      team TEXT NOT NULL,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      via TEXT NOT NULL DEFAULT 'manual',
      PRIMARY KEY (org_id, team, user_id),
      FOREIGN KEY (org_id, team) REFERENCES teams(org_id, identifier) ON DELETE CASCADE`,
  },
  {
    name: 'blueprints',
    ddl: `org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      identifier TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      icon TEXT,
      schema TEXT NOT NULL,
      relations TEXT NOT NULL DEFAULT '{}',
      managed INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      computed TEXT NOT NULL DEFAULT '{}',
      permissions TEXT,
      PRIMARY KEY (org_id, identifier)`,
  },
  {
    name: 'entities',
    ddl: `org_id TEXT NOT NULL,
      blueprint TEXT NOT NULL,
      identifier TEXT NOT NULL,
      title TEXT NOT NULL,
      team TEXT,
      properties TEXT NOT NULL DEFAULT '{}',
      relations TEXT NOT NULL DEFAULT '{}',
      source TEXT NOT NULL,
      search TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1,
      computed TEXT NOT NULL DEFAULT '{}',
      field_owners TEXT,
      PRIMARY KEY (org_id, blueprint, identifier),
      FOREIGN KEY (org_id, blueprint) REFERENCES blueprints(org_id, identifier)`,
  },
  {
    name: 'entity_relations',
    ddl: `org_id TEXT NOT NULL,
      blueprint TEXT NOT NULL,
      identifier TEXT NOT NULL,
      relation TEXT NOT NULL,
      target_blueprint TEXT NOT NULL,
      target_identifier TEXT NOT NULL,
      PRIMARY KEY (org_id, blueprint, identifier, relation, target_identifier),
      FOREIGN KEY (org_id, blueprint, identifier) REFERENCES entities(org_id, blueprint, identifier) ON DELETE CASCADE`,
  },
  {
    name: 'actions',
    ddl: `org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      identifier TEXT NOT NULL,
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
      updated_at TEXT NOT NULL,
      steps TEXT,
      trigger_config TEXT,
      next_fire_at TEXT,
      version INTEGER NOT NULL DEFAULT 1,
      allowed_secrets TEXT,
      PRIMARY KEY (org_id, identifier)`,
  },
  {
    name: 'integrations',
    ddl: `org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      identifier TEXT NOT NULL,
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
      updated_at TEXT NOT NULL,
      lock_owner TEXT,
      sync_state TEXT,
      delete_max_percent INTEGER NOT NULL DEFAULT 20,
      delete_dry_run INTEGER NOT NULL DEFAULT 0,
      schedule TEXT,
      requested_kind TEXT,
      priority INTEGER NOT NULL DEFAULT 0,
      primary_for TEXT NOT NULL DEFAULT '[]',
      requested_scope TEXT,
      PRIMARY KEY (org_id, identifier)`,
  },
  {
    name: 'sync_runs',
    ddl: `id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL,
      integration TEXT NOT NULL,
      trigger TEXT NOT NULL,
      status TEXT NOT NULL,
      stats TEXT NOT NULL DEFAULT '{}',
      logs TEXT NOT NULL DEFAULT '[]',
      started_at TEXT NOT NULL,
      ended_at TEXT,
      errors TEXT NOT NULL DEFAULT '[]',
      FOREIGN KEY (org_id, integration) REFERENCES integrations(org_id, identifier) ON DELETE CASCADE`,
  },
  {
    name: 'inbound_events',
    ddl: `id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL,
      integration TEXT NOT NULL,
      headers TEXT NOT NULL,
      content_type TEXT NOT NULL,
      payload TEXT NOT NULL,
      status TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      next_attempt_at TEXT NOT NULL,
      locked_until TEXT,
      received_at TEXT NOT NULL,
      processed_at TEXT,
      FOREIGN KEY (org_id, integration) REFERENCES integrations(org_id, identifier) ON DELETE CASCADE`,
  },
  {
    name: 'webhooks',
    ddl: `org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      identifier TEXT NOT NULL,
      title TEXT NOT NULL,
      url TEXT NOT NULL,
      events TEXT NOT NULL,
      blueprints TEXT NOT NULL DEFAULT '[]',
      secret TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      managed INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      secondary_secret TEXT,
      headers TEXT NOT NULL DEFAULT '{}',
      filter TEXT,
      transform TEXT,
      PRIMARY KEY (org_id, identifier)`,
  },
  {
    name: 'deliveries',
    ddl: `id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL,
      webhook TEXT NOT NULL,
      event TEXT NOT NULL,
      payload TEXT NOT NULL,
      status TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at TEXT NOT NULL,
      locked_until TEXT,
      response_status INTEGER,
      last_error TEXT,
      created_at TEXT NOT NULL,
      delivered_at TEXT,
      FOREIGN KEY (org_id, webhook) REFERENCES webhooks(org_id, identifier) ON DELETE CASCADE`,
  },
  {
    name: 'secrets',
    ddl: `org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      value_enc TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      updated_by TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (org_id, name)`,
  },
  {
    name: 'ingest_deliveries',
    ddl: `org_id TEXT NOT NULL,
      integration TEXT NOT NULL,
      delivery_id TEXT NOT NULL,
      received_at TEXT NOT NULL,
      PRIMARY KEY (org_id, integration, delivery_id)`,
  },
  // ---- roadmap features ----
  {
    name: 'action_versions',
    ddl: `org_id TEXT NOT NULL,
      action TEXT NOT NULL,
      version INTEGER NOT NULL,
      definition TEXT NOT NULL,
      actor_id TEXT,
      actor_email TEXT,
      note TEXT,
      created_at TEXT NOT NULL,
      PRIMARY KEY (org_id, action, version)`,
  },
  {
    name: 'blueprint_stats',
    ddl: `org_id TEXT NOT NULL,
      blueprint TEXT NOT NULL,
      entity_count INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (org_id, blueprint)`,
  },
  {
    name: 'blueprint_validation',
    ddl: `org_id TEXT NOT NULL,
      blueprint TEXT NOT NULL,
      status TEXT NOT NULL,
      total INTEGER NOT NULL DEFAULT 0,
      invalid INTEGER NOT NULL DEFAULT 0,
      samples TEXT NOT NULL DEFAULT '[]',
      started_at TEXT NOT NULL,
      finished_at TEXT,
      PRIMARY KEY (org_id, blueprint)`,
  },
  {
    name: 'entity_tombstones',
    ddl: `org_id TEXT NOT NULL,
      blueprint TEXT NOT NULL,
      identifier TEXT NOT NULL,
      snapshot TEXT NOT NULL,
      deleted_by TEXT,
      deleted_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      PRIMARY KEY (org_id, blueprint, identifier)`,
  },
  {
    name: 'dashboards',
    ddl: `org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      identifier TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      team TEXT,
      blueprint TEXT,
      is_default INTEGER NOT NULL DEFAULT 0,
      widgets TEXT NOT NULL,
      managed INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (org_id, identifier)`,
  },
  {
    name: 'scorecards',
    ddl: `org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      identifier TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      blueprint TEXT NOT NULL,
      levels TEXT NOT NULL,
      rules TEXT NOT NULL,
      managed INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (org_id, identifier)`,
  },
  {
    name: 'scorecard_results',
    ddl: `org_id TEXT NOT NULL,
      scorecard TEXT NOT NULL,
      blueprint TEXT NOT NULL,
      entity TEXT NOT NULL,
      level TEXT,
      passed INTEGER NOT NULL,
      total INTEGER NOT NULL,
      rules TEXT NOT NULL,
      evaluated_at TEXT NOT NULL,
      PRIMARY KEY (org_id, scorecard, blueprint, entity),
      FOREIGN KEY (org_id, scorecard) REFERENCES scorecards(org_id, identifier) ON DELETE CASCADE`,
  },
  {
    name: 'scorecard_history',
    ddl: `id INTEGER PRIMARY KEY AUTOINCREMENT,
      org_id TEXT NOT NULL,
      scorecard TEXT NOT NULL,
      blueprint TEXT NOT NULL,
      entity TEXT NOT NULL,
      level TEXT,
      passed INTEGER NOT NULL,
      total INTEGER NOT NULL,
      at TEXT NOT NULL,
      FOREIGN KEY (org_id, scorecard) REFERENCES scorecards(org_id, identifier) ON DELETE CASCADE`,
    // New ids (BIGSERIAL on Postgres): nothing references them, the order is kept.
    skip: ['id'],
    order: 'id',
  },
  {
    name: 'ai_budgets',
    ddl: `id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL,
      scope TEXT NOT NULL,
      key TEXT NOT NULL,
      soft_usd DOUBLE PRECISION,
      hard_usd DOUBLE PRECISION,
      UNIQUE (org_id, scope, key)`,
  },
  // Singletons become one row per organization.
  {
    name: 'config_status',
    ddl: `org_id TEXT PRIMARY KEY,
      hash TEXT NOT NULL,
      files TEXT NOT NULL DEFAULT '[]',
      errors TEXT NOT NULL DEFAULT '[]',
      applied_at TEXT NOT NULL,
      applied_by TEXT`,
    skip: ['id'],
    where: 'id = 1',
  },
  {
    name: 'notification_settings',
    ddl: `org_id TEXT PRIMARY KEY,
      config TEXT NOT NULL,
      updated_at TEXT NOT NULL`,
    skip: ['id'],
    where: 'id = 1',
  },
];

/** Records keyed by an id: an `org_id` column (existing rows: the default organization). */
const WITH_ORG_COLUMN = ['runs', 'api_tokens', 'audit_log', 'entity_versions', 'llm_usage', 'ai_reviews', 'notifications'];

/** Indexes over the scoped keys (created after the rebuilds; replaces the single-tenant ones of the same name). */
const INDEXES: [table: string, name: string, definition: string][] = [
  ['team_members', 'team_members_user', '(user_id)'],
  ['entities', 'entities_title', '(org_id, blueprint, title)'],
  ['entities', 'entities_source', '(org_id, source, blueprint)'],
  ['entities', 'entities_team', '(org_id, team)'],
  ['entities', 'entities_updated', '(org_id, updated_at)'],
  ['entities', 'entities_blueprint_updated', '(org_id, blueprint, updated_at)'],
  ['entities', 'entities_title_key', '(org_id, title, blueprint, identifier)'],
  ['entities', 'entities_updated_key', '(org_id, updated_at, blueprint, identifier)'],
  ['entity_relations', 'entity_relations_target', '(org_id, target_blueprint, target_identifier)'],
  ['actions', 'actions_blueprint', '(org_id, blueprint)'],
  ['actions', 'actions_next_fire', '(next_fire_at)'],
  ['integrations', 'integrations_due', '(next_sync_at)'],
  ['sync_runs', 'sync_runs_integration', '(org_id, integration, started_at)'],
  ['inbound_events', 'inbound_events_due', '(status, next_attempt_at)'],
  ['deliveries', 'deliveries_due', '(status, next_attempt_at)'],
  ['deliveries', 'deliveries_webhook', '(org_id, webhook, created_at)'],
  ['deliveries', 'deliveries_status_created', '(status, created_at)'],
  ['ingest_deliveries', 'ingest_deliveries_at', '(received_at)'],
  ['entity_tombstones', 'entity_tombstones_expires', '(expires_at)'],
  ['dashboards', 'dashboards_blueprint', '(org_id, blueprint)'],
  ['scorecards', 'scorecards_blueprint', '(org_id, blueprint)'],
  ['scorecard_results', 'scorecard_results_entity', '(org_id, blueprint, entity)'],
  ['scorecard_history', 'scorecard_history_entity', '(org_id, scorecard, blueprint, entity, at)'],
  ['scorecard_history', 'scorecard_history_at', '(org_id, scorecard, at)'],
  ['runs', 'runs_org', '(org_id, created_at)'],
  ['audit_log', 'audit_org', '(org_id, at)'],
  ['entity_versions', 'entity_versions_org', '(org_id, blueprint, entity)'],
  ['llm_usage', 'llm_usage_org', '(org_id, at)'],
  ['ai_reviews', 'ai_reviews_org', '(org_id, at)'],
  ['notifications', 'notifications_org', '(user_id, org_id, created_at)'],
];

const UNIQUE_INDEXES: [table: string, name: string, definition: string][] = [
  ['runs', 'runs_idempotency', '(org_id, triggered_by, action, idempotency_key)'],
  ['entity_versions', 'entity_versions_entity', '(org_id, blueprint, entity, version)'],
];

async function rebuild(d: Driver, t: ScopedTable) {
  const src = await columns(d, t.name);
  if (!src.length || src.includes('org_id')) return; // missing (older schema) or already scoped
  const tmp = `${t.name}__org`;
  await d.exec(`CREATE TABLE ${tmp} (${autoId(d, t.ddl)})`);
  const dst = await columns(d, tmp);
  const copy = dst.filter((c) => c !== 'org_id' && src.includes(c) && !t.skip?.includes(c));
  const list = copy.join(', ');
  await d.exec(
    `INSERT INTO ${tmp} (org_id${list ? `, ${list}` : ''}) SELECT '${DEFAULT}'${list ? `, ${list}` : ''} FROM ${t.name}` +
      (t.where ? ` WHERE ${t.where}` : '') +
      (t.order ? ` ORDER BY ${t.order}` : ''),
  );
  await d.exec(`DROP TABLE ${t.name}${d.dialect === 'postgres' ? ' CASCADE' : ''}`);
  await d.exec(`ALTER TABLE ${tmp} RENAME TO ${t.name}`);
}

/** Core tenancy tables (first multi-tenant build: they already exist). */
async function core(d: Driver) {
  const t = new Date().toISOString();
  const fresh = !(await columns(d, 'organizations')).length;
  if (fresh) {
    await d.exec(`
      CREATE TABLE organizations (
        id TEXT PRIMARY KEY,
        slug TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        domains TEXT NOT NULL DEFAULT '[]',     -- email domains (SSO routing, auto-join)
        settings TEXT NOT NULL DEFAULT '{}',    -- config-as-code source, SSO (Keycloak organization id)…
        managed INTEGER NOT NULL DEFAULT 0,     -- declared in the platform configuration files
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE memberships (
        org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        role TEXT NOT NULL DEFAULT 'member',    -- admin | member (within the organization)
        role_override INTEGER NOT NULL DEFAULT 0,
        via TEXT NOT NULL DEFAULT 'manual',     -- manual | sso | config
        created_at TEXT NOT NULL,
        PRIMARY KEY (org_id, user_id)
      );
      CREATE INDEX memberships_user ON memberships(user_id);
    `);
    await d.query("INSERT INTO organizations (id, slug, name, created_at, updated_at) VALUES (?, ?, 'Default', ?, ?)", [DEFAULT, DEFAULT, t, t]);
  }
  await addColumn(d, 'users', 'superadmin', 'INTEGER NOT NULL DEFAULT 0');
  await addColumn(d, 'users', 'last_org_id', 'TEXT');
  await addColumn(d, 'oauth_states', 'org', 'TEXT');
  // Delegated roles are granted in an organization.
  await addColumn(d, 'memberships', 'extra_roles', 'TEXT');
  if (fresh) {
    // Everyone keeps their access in the default organization; admins of the single-tenant install run the platform.
    await d.query(
      `INSERT INTO memberships (org_id, user_id, role, role_override, extra_roles, created_at)
       SELECT ?, id, role, role_override, ${(await columns(d, 'users')).includes('extra_roles') ? 'extra_roles' : 'NULL'}, ? FROM users`,
      [DEFAULT, t],
    );
    await d.exec("UPDATE users SET superadmin = 1 WHERE role = 'admin' AND provider != 'service'");
  } else if ((await columns(d, 'users')).includes('extra_roles')) {
    await d.query(
      'UPDATE memberships SET extra_roles = (SELECT extra_roles FROM users WHERE users.id = memberships.user_id) WHERE org_id = ? AND extra_roles IS NULL',
      [DEFAULT],
    );
  }
}

async function indexes(d: Driver) {
  for (const [unique, list] of [
    [false, INDEXES],
    [true, UNIQUE_INDEXES],
  ] as const) {
    for (const [table, name, def] of list) {
      if (!(await columns(d, table)).length) continue;
      await d.exec(`DROP INDEX IF EXISTS ${name}`);
      await d.exec(`CREATE ${unique ? 'UNIQUE ' : ''}INDEX ${name} ON ${table}${def}`);
    }
  }
  if (d.dialect !== 'postgres') return;
  // Full-text and trigram search (roadmap migration 9) live on entities, which may have been rebuilt.
  const hasTsv = (
    await d.query("SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'entities' AND column_name = 'search_tsv'")
  ).rows.length;
  if (!hasTsv) await d.exec("ALTER TABLE entities ADD COLUMN search_tsv tsvector GENERATED ALWAYS AS (to_tsvector('simple', search)) STORED");
  await d.exec('CREATE INDEX IF NOT EXISTS entities_search_tsv ON entities USING gin (search_tsv)');
  await d.exec('CREATE INDEX IF NOT EXISTS entities_properties_gin ON entities USING gin ((properties::jsonb) jsonb_path_ops)');
  const ns = (
    await d.query<{ nspname: string }>("SELECT n.nspname FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace WHERE e.extname = 'pg_trgm'")
  ).rows[0];
  if (ns) await d.exec(`CREATE INDEX IF NOT EXISTS entities_search_trgm ON entities USING gin (search "${ns.nspname}".gin_trgm_ops)`);
}

export const ORG_MIGRATIONS: Migration[] = [
  {
    id: 35,
    name: 'organizations (tenants): memberships, org-scoped keys on every resource',
    sqliteForeignKeysOff: true,
    up: async (d) => {
      await core(d);
      for (const t of WITH_ORG_COLUMN) {
        if (!(await columns(d, t)).length) continue;
        await addColumn(d, t, 'org_id', 'TEXT');
        await d.query(`UPDATE ${t} SET org_id = ? WHERE org_id IS NULL`, [DEFAULT]);
      }
      for (const t of SCOPED) await rebuild(d, t);
      await indexes(d);
    },
  },
  {
    id: 36,
    name: 'sessions: identity provider ID token (single sign-out)',
    up: (d) => addColumn(d, 'sessions', 'id_token', 'TEXT'),
  },
  {
    id: 37,
    name: 'entity expiry: blueprint ttl_property, emitted expiry per entity',
    up: async (d) => {
      await addColumn(d, 'blueprints', 'ttl_property', 'TEXT');
      await d.exec(`CREATE TABLE IF NOT EXISTS entity_expiry (
        org_id TEXT NOT NULL,
        blueprint TEXT NOT NULL,
        identifier TEXT NOT NULL,
        expires TEXT NOT NULL,
        emitted_at TEXT NOT NULL,
        PRIMARY KEY (org_id, blueprint, identifier),
        FOREIGN KEY (org_id, blueprint, identifier) REFERENCES entities(org_id, blueprint, identifier) ON DELETE CASCADE
      )`);
    },
  },
];

/**
 * The first multi-tenant build numbered its migrations 8 (organizations) and 9 (session ID token), ids the roadmap
 * uses for other migrations. Move those rows out of the way so the roadmap migrations 8 and 9 run; 35 then finds
 * the core tables already scoped and only scopes the newer ones.
 */
export async function renumberLegacyOrgMigrations(d: Driver) {
  const rows = (await d.query<{ id: number; name: string }>('SELECT id, name FROM schema_migrations WHERE id IN (8, 9, 36)')).rows;
  const named = (id: number, prefix: string) => rows.some((r) => Number(r.id) === id && r.name.startsWith(prefix));
  if (named(8, 'organizations (tenants)')) await d.query('UPDATE schema_migrations SET id = 1008 WHERE id = 8');
  if (named(9, 'sessions: identity provider ID token') && !rows.some((r) => Number(r.id) === 36))
    await d.query('UPDATE schema_migrations SET id = 36 WHERE id = 9');
}
