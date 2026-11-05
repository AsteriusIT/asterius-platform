import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import pg from 'pg';

// Each test file gets a throwaway DATA_DIR (SQLite) and an empty CONFIG_DIR…
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'asterius-test-'));
process.env.CONFIG_DIR = path.join(process.env.DATA_DIR, 'config');
fs.mkdirSync(process.env.CONFIG_DIR);

// …or, with TEST_DATABASE_URL=postgres://…, its own Postgres schema.
const pgUrl = process.env.TEST_DATABASE_URL;
if (pgUrl) {
  const schema = `t_${randomBytes(6).toString('hex')}`;
  const c = new pg.Client({ connectionString: pgUrl });
  await c.connect();
  await c.query(`CREATE SCHEMA ${schema}`);
  await c.end();
  const url = new URL(pgUrl);
  url.searchParams.set('options', `-c search_path=${schema}`);
  process.env.DATABASE_URL = url.toString();
  process.env.SECRETS_KEY = randomBytes(32).toString('hex');
}
