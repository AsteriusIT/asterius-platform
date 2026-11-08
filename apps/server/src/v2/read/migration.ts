import type { Driver } from '../../db.js';

/**
 * Migration 2: cached run timelines (V2.md §9 "caches the timeline on the run record once the run is terminal").
 * One row per run, removed with the run (retention, organization deletion). Same SQL on SQLite and Postgres.
 */
export async function runTimelinesMigration(d: Driver) {
  await d.exec(`
CREATE TABLE run_timelines (
  run_id TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
  org_id TEXT NOT NULL,
  events TEXT NOT NULL,     -- [{ time, step, status, symbol, message, source, traceId }]
  sources TEXT NOT NULL,    -- [{ name, status, count, error }]
  entity TEXT,              -- { blueprint, identifier, lifecycle } the run was correlated with
  cached_at TEXT NOT NULL
);
CREATE INDEX run_timelines_org ON run_timelines(org_id);
`);
}
