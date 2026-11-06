import type { Migration } from '../db.js';

/** Additive schema of the AI features (ids 400+ so they never collide with other migration series). */
export const AI_MIGRATIONS: Migration[] = [
  {
    id: 400,
    name: 'ai: usage, prices, budgets, catalog reviews',
    up: (d) =>
      d.exec(`
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
          error TEXT
        );
        CREATE INDEX llm_usage_at ON llm_usage(at);
        CREATE INDEX llm_usage_run ON llm_usage(run_id, step_id);
        CREATE INDEX llm_usage_action ON llm_usage(action, at);
        CREATE INDEX llm_usage_team ON llm_usage(team, at);

        CREATE TABLE ai_prices (
          model TEXT PRIMARY KEY,
          input DOUBLE PRECISION NOT NULL,
          output DOUBLE PRECISION NOT NULL,
          cache_write DOUBLE PRECISION NOT NULL,
          cache_read DOUBLE PRECISION NOT NULL
        );

        CREATE TABLE ai_budgets (
          id TEXT PRIMARY KEY,
          scope TEXT NOT NULL,             -- global | action | team | run
          key TEXT NOT NULL,
          soft_usd DOUBLE PRECISION,
          hard_usd DOUBLE PRECISION,
          UNIQUE (scope, key)
        );

        CREATE TABLE ai_reviews (
          id TEXT PRIMARY KEY,
          at TEXT NOT NULL,
          trigger TEXT NOT NULL,           -- schedule | manual
          status TEXT NOT NULL,            -- success | failure
          findings TEXT NOT NULL DEFAULT '[]',
          summary TEXT NOT NULL DEFAULT '',
          cost_usd DOUBLE PRECISION,
          error TEXT
        );
        CREATE INDEX ai_reviews_at ON ai_reviews(at);

        CREATE TABLE ai_leases (
          name TEXT PRIMARY KEY,
          locked_until TEXT NOT NULL,
          last_run_at TEXT
        );
      `),
  },
];
