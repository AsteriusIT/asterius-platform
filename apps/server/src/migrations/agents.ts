import type { Driver } from '../db.js';

/**
 * Migration 10: AI agent governance (agents/).
 *  - agents: the registry of AI agents per organization (owner team, workflow and blueprint allow-lists, OAuth clients).
 *  - mcp_servers: external MCP servers whose allow-listed tools AI agent steps may call; `auth` holds references only.
 *  - api_tokens.agent: the agent a token is bound to (NULL: a person's or service account's token).
 *  - audit_log / runs: `channel` (ui, api, mcp, workflow) and `agent` (agent identifier) of the call, so agent-originated
 *    entries and runs can be filtered. Audit entries chained with version 3 cover both columns.
 */
export async function agentsMigration(d: Driver) {
  for (const sql of [
    `CREATE TABLE agents (
       org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
       identifier TEXT NOT NULL,
       title TEXT NOT NULL,
       description TEXT NOT NULL DEFAULT '',
       owner_team TEXT NOT NULL,
       workflows TEXT NOT NULL DEFAULT '[]',
       blueprints TEXT NOT NULL DEFAULT '[]',
       oauth_clients TEXT NOT NULL DEFAULT '[]',
       enabled INTEGER NOT NULL DEFAULT 1,
       version INTEGER NOT NULL DEFAULT 1,
       managed INTEGER NOT NULL DEFAULT 0,
       created_at TEXT NOT NULL,
       updated_at TEXT NOT NULL,
       PRIMARY KEY (org_id, identifier)
     )`,
    `CREATE TABLE mcp_servers (
       org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
       identifier TEXT NOT NULL,
       title TEXT NOT NULL,
       description TEXT NOT NULL DEFAULT '',
       url TEXT NOT NULL,
       auth TEXT,
       tools TEXT NOT NULL DEFAULT '[]',
       timeout_seconds INTEGER NOT NULL DEFAULT 30,
       enabled INTEGER NOT NULL DEFAULT 1,
       version INTEGER NOT NULL DEFAULT 1,
       managed INTEGER NOT NULL DEFAULT 0,
       created_at TEXT NOT NULL,
       updated_at TEXT NOT NULL,
       PRIMARY KEY (org_id, identifier)
     )`,
    'ALTER TABLE api_tokens ADD COLUMN agent TEXT',
    'CREATE INDEX api_tokens_agent ON api_tokens(org_id, agent) WHERE agent IS NOT NULL',
    'ALTER TABLE audit_log ADD COLUMN channel TEXT',
    'ALTER TABLE audit_log ADD COLUMN agent TEXT',
    'CREATE INDEX audit_agent ON audit_log(org_id, agent, at) WHERE agent IS NOT NULL',
    'ALTER TABLE runs ADD COLUMN channel TEXT',
    'ALTER TABLE runs ADD COLUMN agent TEXT',
    'CREATE INDEX runs_agent ON runs(org_id, agent, created_at) WHERE agent IS NOT NULL',
  ])
    await d.exec(sql);
}
