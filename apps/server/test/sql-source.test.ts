import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { assertReadOnly } from '../src/lib/sql-guard.js';
import { keysetQuery, sqlSource } from '../src/integrations/sources/sql.js';
import type { SourceEnv } from '../src/integrations/types.js';

describe('read-only guard', () => {
  it('accepts SELECT and WITH', () => {
    expect(() => assertReadOnly('SELECT a, "update" FROM t WHERE x = \'delete from y\'; ')).not.toThrow();
    expect(() => assertReadOnly('WITH x AS (SELECT 1) SELECT * FROM x -- drop table t')).not.toThrow();
  });
  it('refuses writes, multiple statements and DDL', () => {
    for (const q of [
      'DELETE FROM t',
      'SELECT 1; DROP TABLE t',
      'INSERT INTO t VALUES (1)',
      'SELECT * INTO copy FROM t',
      'UPDATE t SET a = 1',
      'CALL p()',
      '',
    ]) {
      expect(() => assertReadOnly(q), q).toThrow();
    }
  });
  it('builds keyset queries per dialect and refuses unsafe column names', () => {
    expect(keysetQuery('postgres', 'SELECT * FROM t;', 'id', 10, true)).toBe('SELECT * FROM (SELECT * FROM t) q WHERE q.id > $1 ORDER BY q.id LIMIT 10');
    expect(keysetQuery('mssql', 'SELECT * FROM t', 'id', 10, false)).toBe('SELECT TOP (10) * FROM (SELECT * FROM t) q ORDER BY q.id');
    expect(() => keysetQuery('mysql', 'SELECT 1', 'id; DROP', 10, false)).toThrow();
  });
});

describe('sql source (sqlite driver)', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sqlsrc-')), 'cmdb.db');
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE apps (code TEXT PRIMARY KEY, name TEXT)');
  for (let i = 1; i <= 7; i++) db.prepare('INSERT INTO apps VALUES (?, ?)').run(`a${i}`, `App ${i}`);
  db.close();

  const env = (config: Record<string, unknown>): SourceEnv => ({
    config,
    log: () => undefined,
    startedAt: '',
    setState: () => undefined,
    incomplete: () => undefined,
  });
  const collect = async (config: Record<string, unknown>, kind = 'application') => {
    const out: Array<Record<string, unknown>> = [];
    for await (const page of sqlSource.list!(kind, env(config))) out.push(...(page as Array<Record<string, unknown>>));
    return out;
  };

  it('reads all rows, with and without keyset paging', async () => {
    const base = { driver: 'sqlite', url: file, queries: { application: 'SELECT code, name FROM apps' } };
    expect(await collect(base)).toHaveLength(7);
    const paged = await collect({ ...base, keyset: { column: 'code', pageSize: 3 } });
    expect(paged.map((r) => r.code)).toEqual(['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7']);
  });

  it('validates the configuration', () => {
    expect(() => sqlSource.validate({ driver: 'oracle', url: 'x', query: 'SELECT 1' })).toThrow(/driver/);
    expect(() => sqlSource.validate({ driver: 'sqlite', url: 'x', query: 'DELETE FROM t' })).toThrow(/only SELECT/);
    expect(() => sqlSource.validate({ driver: 'sqlite', url: 'x' })).toThrow(/queries/);
    expect(() => sqlSource.validate({ driver: 'sqlite', url: 'x', query: 'SELECT 1', keyset: { column: 'a b' } })).toThrow(/column/);
    expect(() => sqlSource.validate({ driver: 'sqlite', url: 'x', query: 'SELECT 1' })).not.toThrow();
  });

  it('cannot write even if a query slipped through (read-only connection)', async () => {
    await expect(collect({ driver: 'sqlite', url: file, queries: { application: 'DELETE FROM apps' } })).rejects.toThrow();
  });
});
