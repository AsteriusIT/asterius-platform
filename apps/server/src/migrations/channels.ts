import type { Driver } from '../db.js';

/**
 * Migration 10: workflow-restricted API tokens and call channels.
 *  - api_tokens.workflows: JSON array of the workflows (action identifiers) the token may see and start (NULL: no
 *    restriction). This is how an AI agent is scoped: a service account with a workflow-restricted token.
 *  - audit_log / runs: `channel` (ui, api, mcp, workflow) of the call. Audit entries chained with version 3 cover it.
 */
export async function channelsMigration(d: Driver) {
  for (const sql of [
    'ALTER TABLE api_tokens ADD COLUMN workflows TEXT',
    'ALTER TABLE audit_log ADD COLUMN channel TEXT',
    'CREATE INDEX audit_channel ON audit_log(org_id, channel, at)',
    'ALTER TABLE runs ADD COLUMN channel TEXT',
    'CREATE INDEX runs_channel ON runs(org_id, channel, created_at)',
  ])
    await d.exec(sql);
}
