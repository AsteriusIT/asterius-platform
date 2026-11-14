import type { Driver } from '../db.js';

/**
 * Migration 11: scorecard initiatives.
 *  - initiatives: a scorecard target (level and/or rules) with start and deadline dates, per organization. `status` is
 *    the last status announced (`initiative.*` events fire on a change, claimed by a conditional UPDATE on its current
 *    value), `snapshot_day` the last day a progress snapshot was written and `remind_at` when the next reminder is due;
 *    both are claimed the same way, so only one replica writes a snapshot or sends a reminder.
 *  - initiative_snapshots: daily progress, overall (`team` = '') and per owner team (`team` = '-' for unowned entities).
 *  - initiative_exemptions: an entity (rule '') or one rule of it left out until `expires_at`, with who granted it.
 */
export async function initiativesMigration(d: Driver) {
  await d.exec(`
    CREATE TABLE initiatives (
      org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      identifier TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      scorecard TEXT NOT NULL,
      target_level TEXT,
      rules TEXT NOT NULL DEFAULT '[]',
      start_date TEXT NOT NULL,
      deadline TEXT NOT NULL,
      teams TEXT NOT NULL DEFAULT '[]',
      owner TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      reminder_days INTEGER NOT NULL DEFAULT 7,
      status TEXT,
      snapshot_day TEXT,
      remind_at TEXT,
      managed INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (org_id, identifier)
    );
    CREATE INDEX initiatives_scorecard ON initiatives(org_id, scorecard);
    CREATE TABLE initiative_snapshots (
      org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      initiative TEXT NOT NULL,
      day TEXT NOT NULL,
      team TEXT NOT NULL,
      passing INTEGER NOT NULL,
      total INTEGER NOT NULL,
      PRIMARY KEY (org_id, initiative, day, team)
    );
    CREATE TABLE initiative_exemptions (
      id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      initiative TEXT NOT NULL,
      entity TEXT NOT NULL,
      rule TEXT NOT NULL DEFAULT '',
      reason TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      granted_by_id TEXT,
      granted_by_email TEXT,
      created_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX initiative_exemptions_key ON initiative_exemptions(org_id, initiative, entity, rule);
  `);
}
