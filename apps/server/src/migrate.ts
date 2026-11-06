/**
 * One-shot schema migration (`npm run migrate`, Helm pre-upgrade Job). Applies pending migrations under the
 * advisory lock and exits; pods then run with MIGRATE_ON_START=false.
 */
process.env.MIGRATE_ON_START = 'true';
const { closeDb, driver } = await import('./db.js');
const { rows } = await driver.query<{ n: number }>('SELECT count(*) AS n FROM schema_migrations');
console.log(`[migrate] schema up to date (${Number(rows[0]?.n ?? 0)} migrations applied)`);
await closeDb();
