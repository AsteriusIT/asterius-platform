import type { Driver } from '../db.js';

/**
 * Migration 3: approval reminders, escalation, pre-start expiry, delegation and tiers.
 *  - runs / run_steps: `remind_at` (next reminder due) with the `reminders` sent so far, `escalate_at` (escalation due)
 *    and `escalated_at`; runs also get `approval_expires_at` (pre-start approval expiry). Each due time is claimed by a
 *    conditional UPDATE on its current value, so only one replica sends a reminder or escalates.
 *  - run_approvals / step_approvals: `on_behalf_of` (the delegator when a delegate decided); step_approvals: `tier`.
 *  - delegations: one per (organization, user), optionally limited to a date range.
 */
export async function approvalsMigration(d: Driver) {
  const statements = [
    ...['runs', 'run_steps'].flatMap((t) => [
      `ALTER TABLE ${t} ADD COLUMN remind_at TEXT`,
      `ALTER TABLE ${t} ADD COLUMN reminders INTEGER NOT NULL DEFAULT 0`,
      `ALTER TABLE ${t} ADD COLUMN escalate_at TEXT`,
      `ALTER TABLE ${t} ADD COLUMN escalated_at TEXT`,
      `CREATE INDEX ${t}_remind ON ${t}(remind_at) WHERE remind_at IS NOT NULL`,
      `CREATE INDEX ${t}_escalate ON ${t}(escalate_at) WHERE escalate_at IS NOT NULL`,
    ]),
    'ALTER TABLE runs ADD COLUMN approval_expires_at TEXT',
    'CREATE INDEX runs_approval_expiry ON runs(approval_expires_at) WHERE approval_expires_at IS NOT NULL',
    'ALTER TABLE run_approvals ADD COLUMN on_behalf_of TEXT',
    'ALTER TABLE step_approvals ADD COLUMN on_behalf_of TEXT',
    'ALTER TABLE step_approvals ADD COLUMN tier INTEGER',
    `CREATE TABLE delegations (
      org_id TEXT NOT NULL,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      delegate_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      starts_at TEXT,
      ends_at TEXT,
      created_at TEXT NOT NULL,
      PRIMARY KEY (org_id, user_id)
    )`,
    'CREATE INDEX delegations_delegate ON delegations(org_id, delegate_id)',
  ];
  for (const sql of statements) await d.exec(sql);
}
