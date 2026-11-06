import type { Driver } from '../db.js';

/**
 * Catalog governance migrations (scorecards, history, computed values, tombstones…). Numbered from 20 so they
 * never collide with the core schema migrations in db.ts; every step is additive.
 */
export interface CatalogMigration {
  id: number;
  name: string;
  up: (d: Driver) => Promise<void>;
}

const ddl = (d: Driver, sql: string) => (d.dialect === 'postgres' ? sql.replace(/INTEGER PRIMARY KEY AUTOINCREMENT/g, 'BIGSERIAL PRIMARY KEY') : sql);

export const CATALOG_MIGRATIONS: CatalogMigration[] = [
  {
    id: 20,
    name: 'scorecards',
    up: (d) =>
      d.exec(
        ddl(
          d,
          `
        CREATE TABLE scorecards (
          identifier TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          description TEXT NOT NULL DEFAULT '',
          blueprint TEXT NOT NULL,
          levels TEXT NOT NULL,
          rules TEXT NOT NULL,
          managed INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX scorecards_blueprint ON scorecards(blueprint);
        CREATE TABLE scorecard_results (
          scorecard TEXT NOT NULL REFERENCES scorecards(identifier) ON DELETE CASCADE,
          blueprint TEXT NOT NULL,
          entity TEXT NOT NULL,
          level TEXT,
          passed INTEGER NOT NULL,
          total INTEGER NOT NULL,
          rules TEXT NOT NULL,
          evaluated_at TEXT NOT NULL,
          PRIMARY KEY (scorecard, blueprint, entity)
        );
        CREATE INDEX scorecard_results_entity ON scorecard_results(blueprint, entity);
        CREATE TABLE scorecard_history (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          scorecard TEXT NOT NULL REFERENCES scorecards(identifier) ON DELETE CASCADE,
          blueprint TEXT NOT NULL,
          entity TEXT NOT NULL,
          level TEXT,
          passed INTEGER NOT NULL,
          total INTEGER NOT NULL,
          at TEXT NOT NULL
        );
        CREATE INDEX scorecard_history_entity ON scorecard_history(scorecard, blueprint, entity, at);
        CREATE INDEX scorecard_history_at ON scorecard_history(scorecard, at);
      `,
        ),
      ),
  },
];
