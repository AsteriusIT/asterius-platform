import type { Driver } from './db.js';

/**
 * Baseline schema (migration 1): the final shape of every table and index, written once for SQLite and Postgres.
 * Flattened on 2026-11-07, before the first production release; later schema changes are appended as migrations
 * 2, 3… in db.ts and this file is not edited once a release has shipped it.
 *
 * Multi-tenancy: named resources carry `org_id` in their primary key; records keyed by an id (runs, tokens, audit,
 * usage…) have a nullable `org_id` column; singletons are one row per organization.
 */

const ddl = (d: Driver, sql: string) => (d.dialect === 'postgres' ? sql.replace(/INTEGER PRIMARY KEY AUTOINCREMENT/g, 'BIGSERIAL PRIMARY KEY') : sql);

const SCHEMA = `
-- ===== identity & tenancy =====
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
  created_at TEXT NOT NULL,
  tour_completed_at TEXT,
  role_override INTEGER NOT NULL DEFAULT 0,
  notification_prefs TEXT,
  extra_roles TEXT,
  superadmin INTEGER NOT NULL DEFAULT 0,
  last_org_id TEXT
);
CREATE UNIQUE INDEX users_email_provider ON users(provider, email);
CREATE UNIQUE INDEX users_external ON users(provider, external_id) WHERE external_id IS NOT NULL;

CREATE TABLE memberships (
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'member',    -- admin | member (within the organization)
  role_override INTEGER NOT NULL DEFAULT 0,
  via TEXT NOT NULL DEFAULT 'manual',     -- manual | sso | config
  created_at TEXT NOT NULL,
  extra_roles TEXT,
  PRIMARY KEY (org_id, user_id)
);
CREATE INDEX memberships_user ON memberships(user_id);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT,
  last_seen_at TEXT,
  ip TEXT,
  user_agent TEXT,
  id_token TEXT
);
CREATE INDEX sessions_user ON sessions(user_id);

CREATE TABLE oauth_states (
  state TEXT PRIMARY KEY,
  nonce TEXT NOT NULL,
  code_verifier TEXT NOT NULL,
  return_to TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  org TEXT
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
  last_used_at TEXT,
  scopes TEXT,
  blueprints TEXT,
  ip_allow TEXT,
  org_id TEXT
);

CREATE TABLE login_failures (
  key TEXT PRIMARY KEY,
  count INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE teams (
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  identifier TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  entra_group_id TEXT,
  managed INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  PRIMARY KEY (org_id, identifier)
);
CREATE TABLE team_members (
  org_id TEXT NOT NULL,
  team TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  via TEXT NOT NULL DEFAULT 'manual', -- manual | entra
  PRIMARY KEY (org_id, team, user_id),
  FOREIGN KEY (org_id, team) REFERENCES teams(org_id, identifier) ON DELETE CASCADE
);
CREATE INDEX team_members_user ON team_members(user_id);

CREATE TABLE secrets (
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  value_enc TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  updated_by TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (org_id, name)
);

-- ===== catalog =====
CREATE TABLE blueprints (
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
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
  ttl_property TEXT,
  PRIMARY KEY (org_id, identifier)
);

CREATE TABLE entities (
  org_id TEXT NOT NULL,
  blueprint TEXT NOT NULL,
  identifier TEXT NOT NULL,
  title TEXT NOT NULL,
  team TEXT,
  properties TEXT NOT NULL DEFAULT '{}',
  relations TEXT NOT NULL DEFAULT '{}',
  source TEXT NOT NULL,
  search TEXT NOT NULL DEFAULT '',     -- lower-cased identifier, title and string property values
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  computed TEXT NOT NULL DEFAULT '{}',
  field_owners TEXT,
  PRIMARY KEY (org_id, blueprint, identifier),
  FOREIGN KEY (org_id, blueprint) REFERENCES blueprints(org_id, identifier)
);
CREATE INDEX entities_title ON entities(org_id, blueprint, title);
CREATE INDEX entities_source ON entities(org_id, source, blueprint);
CREATE INDEX entities_team ON entities(org_id, team);
CREATE INDEX entities_updated ON entities(org_id, updated_at);
CREATE INDEX entities_blueprint_updated ON entities(org_id, blueprint, updated_at);
CREATE INDEX entities_title_key ON entities(org_id, title, blueprint, identifier);
CREATE INDEX entities_updated_key ON entities(org_id, updated_at, blueprint, identifier);

CREATE TABLE entity_relations (
  org_id TEXT NOT NULL,
  blueprint TEXT NOT NULL,
  identifier TEXT NOT NULL,
  relation TEXT NOT NULL,
  target_blueprint TEXT NOT NULL,
  target_identifier TEXT NOT NULL,
  PRIMARY KEY (org_id, blueprint, identifier, relation, target_identifier),
  FOREIGN KEY (org_id, blueprint, identifier) REFERENCES entities(org_id, blueprint, identifier) ON DELETE CASCADE
);
CREATE INDEX entity_relations_target ON entity_relations(org_id, target_blueprint, target_identifier);

CREATE TABLE entity_expiry (
  org_id TEXT NOT NULL,
  blueprint TEXT NOT NULL,
  identifier TEXT NOT NULL,
  expires TEXT NOT NULL,
  emitted_at TEXT NOT NULL,
  PRIMARY KEY (org_id, blueprint, identifier),
  FOREIGN KEY (org_id, blueprint, identifier) REFERENCES entities(org_id, blueprint, identifier) ON DELETE CASCADE
);

CREATE TABLE entity_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  blueprint TEXT NOT NULL,
  entity TEXT NOT NULL,
  version INTEGER NOT NULL,
  op TEXT NOT NULL,              -- create | update | delete | revert
  actor_id TEXT,
  actor_email TEXT,
  source TEXT NOT NULL,
  snapshot TEXT NOT NULL,        -- the entity after the change (before it, for a delete)
  diff TEXT NOT NULL,            -- [{ path, before, after }]
  at TEXT NOT NULL,
  org_id TEXT
);
CREATE UNIQUE INDEX entity_versions_entity ON entity_versions(org_id, blueprint, entity, version);
CREATE INDEX entity_versions_at ON entity_versions(at);
CREATE INDEX entity_versions_org ON entity_versions(org_id, blueprint, entity);

CREATE TABLE entity_tombstones (
  org_id TEXT NOT NULL,
  blueprint TEXT NOT NULL,
  identifier TEXT NOT NULL,
  snapshot TEXT NOT NULL,        -- title, team, properties, relations and source at deletion
  deleted_by TEXT,
  deleted_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  PRIMARY KEY (org_id, blueprint, identifier)
);
CREATE INDEX entity_tombstones_expires ON entity_tombstones(expires_at);

CREATE TABLE blueprint_stats (
  org_id TEXT NOT NULL,
  blueprint TEXT NOT NULL,
  entity_count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (org_id, blueprint)
);

CREATE TABLE blueprint_validation (
  org_id TEXT NOT NULL,
  blueprint TEXT NOT NULL,
  status TEXT NOT NULL,          -- running | done
  total INTEGER NOT NULL DEFAULT 0,
  invalid INTEGER NOT NULL DEFAULT 0,
  samples TEXT NOT NULL DEFAULT '[]',
  started_at TEXT NOT NULL,
  finished_at TEXT,
  PRIMARY KEY (org_id, blueprint)
);

CREATE TABLE dashboards (
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
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
  PRIMARY KEY (org_id, identifier)
);
CREATE INDEX dashboards_blueprint ON dashboards(org_id, blueprint);

CREATE TABLE scorecards (
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  identifier TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  blueprint TEXT NOT NULL,
  levels TEXT NOT NULL,
  rules TEXT NOT NULL,
  managed INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (org_id, identifier)
);
CREATE INDEX scorecards_blueprint ON scorecards(org_id, blueprint);
CREATE TABLE scorecard_results (
  org_id TEXT NOT NULL,
  scorecard TEXT NOT NULL,
  blueprint TEXT NOT NULL,
  entity TEXT NOT NULL,
  level TEXT,
  passed INTEGER NOT NULL,
  total INTEGER NOT NULL,
  rules TEXT NOT NULL,
  evaluated_at TEXT NOT NULL,
  PRIMARY KEY (org_id, scorecard, blueprint, entity),
  FOREIGN KEY (org_id, scorecard) REFERENCES scorecards(org_id, identifier) ON DELETE CASCADE
);
CREATE INDEX scorecard_results_entity ON scorecard_results(org_id, blueprint, entity);
CREATE TABLE scorecard_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id TEXT NOT NULL,
  scorecard TEXT NOT NULL,
  blueprint TEXT NOT NULL,
  entity TEXT NOT NULL,
  level TEXT,
  passed INTEGER NOT NULL,
  total INTEGER NOT NULL,
  at TEXT NOT NULL,
  FOREIGN KEY (org_id, scorecard) REFERENCES scorecards(org_id, identifier) ON DELETE CASCADE
);
CREATE INDEX scorecard_history_entity ON scorecard_history(org_id, scorecard, blueprint, entity, at);
CREATE INDEX scorecard_history_at ON scorecard_history(org_id, scorecard, at);

CREATE TABLE policies (
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  identifier TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1,
  target TEXT NOT NULL,
  filters TEXT NOT NULL DEFAULT '{}',
  expression TEXT NOT NULL,
  message TEXT NOT NULL DEFAULT '',
  managed INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (org_id, identifier)
);

-- ===== actions & runs =====
CREATE TABLE actions (
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
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
  trigger_config TEXT,                 -- full trigger document for non-form triggers
  next_fire_at TEXT,                   -- schedule triggers: next tick (claimed with a conditional UPDATE)
  version INTEGER NOT NULL DEFAULT 1,
  allowed_secrets TEXT,                -- JSON list; NULL: unrestricted
  PRIMARY KEY (org_id, identifier)
);
CREATE INDEX actions_blueprint ON actions(org_id, blueprint);
CREATE INDEX actions_next_fire ON actions(next_fire_at);

CREATE TABLE action_versions (
  org_id TEXT NOT NULL,
  action TEXT NOT NULL,                -- no foreign key: the history outlives a deleted action
  version INTEGER NOT NULL,
  definition TEXT NOT NULL,
  actor_id TEXT,
  actor_email TEXT,
  note TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (org_id, action, version)
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
  updated_at TEXT NOT NULL,
  steps TEXT,
  deadline_at TEXT,
  cancel_requested INTEGER NOT NULL DEFAULT 0,
  idempotency_key TEXT,
  log_count INTEGER NOT NULL DEFAULT 0,
  trigger_type TEXT,
  trigger_info TEXT,
  parent_run_id TEXT,
  parent_step_id TEXT,
  action_version INTEGER,
  allowed_secrets TEXT,                -- snapshot at trigger time
  org_id TEXT
);
CREATE INDEX runs_status ON runs(status, next_poll_at);
CREATE INDEX runs_user ON runs(triggered_by, created_at);
CREATE INDEX runs_entity ON runs(blueprint, entity, created_at);
CREATE INDEX runs_created ON runs(created_at);
CREATE INDEX runs_org ON runs(org_id, created_at);
CREATE UNIQUE INDEX runs_idempotency ON runs(org_id, triggered_by, action, idempotency_key);
CREATE INDEX runs_deadline ON runs(deadline_at) WHERE status = 'IN_PROGRESS';
CREATE INDEX runs_action_created ON runs(action, created_at);
CREATE INDEX runs_status_started ON runs(status, started_at);
CREATE INDEX runs_status_created ON runs(status, created_at);
CREATE INDEX runs_parent ON runs(parent_run_id);

CREATE TABLE run_approvals (
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id),
  decision TEXT NOT NULL,
  comment TEXT NOT NULL DEFAULT '',
  at TEXT NOT NULL,
  PRIMARY KEY (run_id, user_id)
);
CREATE INDEX run_approvals_user ON run_approvals(user_id);

CREATE TABLE run_logs (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  at TEXT NOT NULL,
  level TEXT NOT NULL,
  message TEXT NOT NULL,
  step_id TEXT
);
CREATE INDEX run_logs_run ON run_logs(run_id, seq);

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
CREATE INDEX run_steps_lease ON run_steps(locked_until) WHERE status = 'RUNNING' AND locked_until IS NOT NULL;
CREATE INDEX run_steps_deadline ON run_steps(deadline_at) WHERE deadline_at IS NOT NULL AND status IN ('QUEUED', 'RUNNING', 'WAITING_APPROVAL', 'WAITING');

CREATE TABLE step_approvals (
  run_id TEXT NOT NULL,
  step_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  decision TEXT NOT NULL,
  comment TEXT NOT NULL DEFAULT '',
  at TEXT NOT NULL,
  choice TEXT,
  form_values TEXT,
  PRIMARY KEY (run_id, step_id, user_id),
  FOREIGN KEY (run_id, step_id) REFERENCES run_steps(run_id, step_id) ON DELETE CASCADE
);
CREATE INDEX step_approvals_user ON step_approvals(user_id);

-- ===== integrations & webhooks =====
CREATE TABLE integrations (
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
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
  PRIMARY KEY (org_id, identifier)
);
CREATE INDEX integrations_due ON integrations(next_sync_at);

CREATE TABLE sync_runs (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  integration TEXT NOT NULL,
  trigger TEXT NOT NULL,
  status TEXT NOT NULL,
  stats TEXT NOT NULL DEFAULT '{}',
  logs TEXT NOT NULL DEFAULT '[]',
  started_at TEXT NOT NULL,
  ended_at TEXT,
  errors TEXT NOT NULL DEFAULT '[]',
  FOREIGN KEY (org_id, integration) REFERENCES integrations(org_id, identifier) ON DELETE CASCADE
);
CREATE INDEX sync_runs_integration ON sync_runs(org_id, integration, started_at);

CREATE TABLE inbound_events (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  integration TEXT NOT NULL,
  headers TEXT NOT NULL,
  content_type TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL,        -- pending done failed
  attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  next_attempt_at TEXT NOT NULL,
  locked_until TEXT,
  received_at TEXT NOT NULL,
  processed_at TEXT,
  FOREIGN KEY (org_id, integration) REFERENCES integrations(org_id, identifier) ON DELETE CASCADE
);
CREATE INDEX inbound_events_due ON inbound_events(status, next_attempt_at);

CREATE TABLE ingest_deliveries (
  org_id TEXT NOT NULL,
  integration TEXT NOT NULL,
  delivery_id TEXT NOT NULL,
  received_at TEXT NOT NULL,
  PRIMARY KEY (org_id, integration, delivery_id)
);
CREATE INDEX ingest_deliveries_at ON ingest_deliveries(received_at);

CREATE TABLE webhooks (
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  identifier TEXT NOT NULL,
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  events TEXT NOT NULL,
  blueprints TEXT NOT NULL DEFAULT '[]',
  secret TEXT,                          -- reference: \${secret:NAME} / \${env:NAME}
  enabled INTEGER NOT NULL DEFAULT 1,
  managed INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  secondary_secret TEXT,
  headers TEXT NOT NULL DEFAULT '{}',
  filter TEXT,
  transform TEXT,
  PRIMARY KEY (org_id, identifier)
);

CREATE TABLE deliveries (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  webhook TEXT NOT NULL,
  event TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL,                -- pending | success | failed
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  locked_until TEXT,
  response_status INTEGER,
  last_error TEXT,
  created_at TEXT NOT NULL,
  delivered_at TEXT,
  FOREIGN KEY (org_id, webhook) REFERENCES webhooks(org_id, identifier) ON DELETE CASCADE
);
CREATE INDEX deliveries_due ON deliveries(status, next_attempt_at);
CREATE INDEX deliveries_webhook ON deliveries(org_id, webhook, created_at);
CREATE INDEX deliveries_status_created ON deliveries(status, created_at);

-- ===== notifications =====
CREATE TABLE notification_settings (
  org_id TEXT PRIMARY KEY,
  config TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  link TEXT,
  dedupe TEXT NOT NULL,
  created_at TEXT NOT NULL,
  read_at TEXT,
  org_id TEXT
);
CREATE UNIQUE INDEX notifications_dedupe ON notifications(user_id, dedupe);
CREATE INDEX notifications_user ON notifications(user_id, created_at);
CREATE INDEX notifications_org ON notifications(user_id, org_id, created_at);

CREATE TABLE notification_prefs (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  email INTEGER NOT NULL DEFAULT 0,
  slack INTEGER NOT NULL DEFAULT 0
);

-- ===== audit =====
CREATE TABLE audit_log (
  id TEXT PRIMARY KEY,
  at TEXT NOT NULL,
  action TEXT NOT NULL,
  actor_id TEXT,
  actor_email TEXT,
  target TEXT,
  detail TEXT NOT NULL DEFAULT '{}',
  streamed_at TEXT,                    -- SIEM streaming marker
  chain_seq INTEGER,                   -- hash chain
  prev_hash TEXT,
  hash TEXT,
  org_id TEXT,
  chain_version INTEGER NOT NULL DEFAULT 1  -- 2: the hash covers org_id
);
CREATE INDEX audit_at ON audit_log(at);
CREATE INDEX audit_unstreamed ON audit_log(at) WHERE streamed_at IS NULL;
CREATE UNIQUE INDEX audit_chain_seq ON audit_log(chain_seq) WHERE chain_seq IS NOT NULL;
CREATE INDEX audit_action ON audit_log(action);
CREATE INDEX audit_actor ON audit_log(actor_email);
CREATE INDEX audit_org ON audit_log(org_id, at);

-- ===== AI =====
CREATE TABLE llm_usage (
  id TEXT PRIMARY KEY,
  at TEXT NOT NULL,
  kind TEXT NOT NULL,              -- agent | assist | authoring | review
  run_id TEXT,
  step_id TEXT,
  action TEXT,
  team TEXT,
  user_id TEXT,
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd DOUBLE PRECISION,       -- null: unknown price
  outcome TEXT NOT NULL,           -- success | error | refused | truncated | budget
  error TEXT,
  org_id TEXT
);
CREATE INDEX llm_usage_at ON llm_usage(at);
CREATE INDEX llm_usage_run ON llm_usage(run_id, step_id);
CREATE INDEX llm_usage_action ON llm_usage(action, at);
CREATE INDEX llm_usage_team ON llm_usage(team, at);
CREATE INDEX llm_usage_org ON llm_usage(org_id, at);

CREATE TABLE ai_prices (
  model TEXT PRIMARY KEY,
  input DOUBLE PRECISION NOT NULL,
  output DOUBLE PRECISION NOT NULL,
  cache_write DOUBLE PRECISION NOT NULL,
  cache_read DOUBLE PRECISION NOT NULL
);

CREATE TABLE ai_budgets (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  scope TEXT NOT NULL,             -- global | action | team | run
  key TEXT NOT NULL,
  soft_usd DOUBLE PRECISION,
  hard_usd DOUBLE PRECISION,
  UNIQUE (org_id, scope, key)
);

CREATE TABLE ai_reviews (
  id TEXT PRIMARY KEY,
  at TEXT NOT NULL,
  trigger TEXT NOT NULL,           -- schedule | manual
  status TEXT NOT NULL,            -- success | failure
  findings TEXT NOT NULL DEFAULT '[]',
  summary TEXT NOT NULL DEFAULT '',
  cost_usd DOUBLE PRECISION,
  error TEXT,
  org_id TEXT
);
CREATE INDEX ai_reviews_at ON ai_reviews(at);
CREATE INDEX ai_reviews_org ON ai_reviews(org_id, at);

CREATE TABLE ai_leases (
  name TEXT PRIMARY KEY,
  locked_until TEXT NOT NULL,
  last_run_at TEXT
);

-- ===== platform =====
CREATE TABLE rate_limits (key TEXT PRIMARY KEY, count INTEGER NOT NULL, window_start BIGINT NOT NULL);
CREATE TABLE config_version (id INTEGER PRIMARY KEY, version INTEGER NOT NULL);
CREATE TABLE config_status (
  org_id TEXT PRIMARY KEY,
  hash TEXT NOT NULL,
  files TEXT NOT NULL DEFAULT '[]',
  errors TEXT NOT NULL DEFAULT '[]',
  applied_at TEXT NOT NULL,
  applied_by TEXT
);
`;

/** Migration 1: create the whole schema and seed the rows a fresh install needs. */
export async function baseline(d: Driver) {
  await d.exec(ddl(d, SCHEMA));
  const now = new Date().toISOString();
  await d.query("INSERT INTO organizations (id, slug, name, created_at, updated_at) VALUES ('default', 'default', 'Default', ?, ?)", [now, now]);
  await d.exec('INSERT INTO config_version (id, version) VALUES (1, 0)');
  if (d.dialect !== 'postgres') return;
  // Full-text and trigram search on entities.search
  await d.exec("ALTER TABLE entities ADD COLUMN search_tsv tsvector GENERATED ALWAYS AS (to_tsvector('simple', search)) STORED");
  await d.exec('CREATE INDEX entities_search_tsv ON entities USING gin (search_tsv)');
  await d.exec('CREATE INDEX entities_properties_gin ON entities USING gin ((properties::jsonb) jsonb_path_ops)');
  // Extensions are per database while the other migration locks are per schema: serialize this statement
  // database-wide (one-key lock space, released at COMMIT) so concurrent schemas do not race on pg_extension.
  await d.exec('SELECT pg_advisory_xact_lock(726209)');
  // The extension may be unavailable or not creatable by this role: a savepoint keeps the transaction alive and
  // search falls back to substring matching.
  await d.exec('SAVEPOINT pg_trgm');
  try {
    await d.exec('CREATE EXTENSION IF NOT EXISTS pg_trgm');
    await d.exec('RELEASE SAVEPOINT pg_trgm');
  } catch (err) {
    await d.exec('ROLLBACK TO SAVEPOINT pg_trgm');
    console.warn(`[db] pg_trgm unavailable, search falls back to substring matching: ${(err as Error).message}`);
    return;
  }
  const ns = (
    await d.query<{ nspname: string }>("SELECT n.nspname FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace WHERE e.extname = 'pg_trgm'")
  ).rows[0];
  if (ns) await d.exec(`CREATE INDEX entities_search_trgm ON entities USING gin (search "${ns.nspname}".gin_trgm_ops)`);
}
