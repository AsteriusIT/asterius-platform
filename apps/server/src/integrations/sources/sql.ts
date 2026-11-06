import { DatabaseSync } from 'node:sqlite';
import { requireFields, str } from '../../actions/types.js';
import { MAX_PAGES, type Source } from '../types.js';
import { assertReadOnly, validateIdent } from '../../lib/sql-guard.js';
import { assertHostAllowed } from '../../lib/netguard.js';

/**
 * Ingest rows of a read-only SQL query (a CMDB, a licence database…). One query per kind (`queries`), the connection
 * string comes from a secret. Rows are the items mappings run on.
 *   driver     postgres | mysql | mssql | sqlite   (mysql2 / mssql are optional dependencies; sqlite reads a file)
 *   url        connection string (`${secret:CMDB_URL}`); for sqlite the file path
 *   queries    { <kind>: "SELECT …" }   or a single `query` used for the kind `row`
 *   keyset     { column: "id", pageSize: 1000 }: page with `WHERE column > last ORDER BY column` instead of one big read
 *   timeoutSeconds   statement timeout (default 30)
 */

type Row = Record<string, unknown>;
interface Conn {
  query(sql: string, params: unknown[]): Promise<Row[]>;
  close(): Promise<void>;
}
export type Driver = 'postgres' | 'mysql' | 'mssql' | 'sqlite';
const DRIVERS: Driver[] = ['postgres', 'mysql', 'mssql', 'sqlite'];
const MAX_ROWS = 200_000;

// Optional drivers are loaded on demand; their typings are not a dependency.
type Loose = { default?: Loose } & Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const optional = async (name: string): Promise<Loose> => {
  try {
    return await import(/* @vite-ignore */ name);
  } catch (err) {
    throw new Error(`sql: driver package "${name}" is not installed (npm install ${name})`, { cause: err });
  }
};

/** Host of a connection string: `scheme://user:pw@host:port/db`, or the `Server=host,port;…` form of SQL Server. */
function hostOf(url: string): string | undefined {
  try {
    return new URL(url).hostname || undefined;
  } catch {
    return /(?:server|data source|host)\s*=\s*(?:tcp:)?([^,;:\s]+)/i.exec(url)?.[1];
  }
}

async function connect(driver: Driver, url: string, timeoutMs: number): Promise<Conn> {
  // The SSRF guard covers database hosts too: a source must not be a way to reach internal systems.
  const host = driver === 'sqlite' ? undefined : hostOf(url);
  if (host) await assertHostAllowed(host);
  switch (driver) {
    case 'postgres': {
      const pg = await import('pg');
      const client = new pg.default.Client({
        connectionString: url,
        statement_timeout: timeoutMs,
        query_timeout: timeoutMs + 1000,
        connectionTimeoutMillis: 10_000,
      });
      await client.connect();
      await client.query('BEGIN READ ONLY');
      return {
        query: async (sql, params) => (await client.query(sql, params)).rows as Row[],
        close: async () => {
          await client.query('ROLLBACK').catch(() => undefined);
          await client.end();
        },
      };
    }
    case 'mysql': {
      const mysql = (await optional('mysql2/promise')).default ?? (await optional('mysql2/promise'));
      const c = await mysql.createConnection({ uri: url, connectTimeout: 10_000 });
      await c.query('SET SESSION TRANSACTION READ ONLY');
      return {
        query: async (sql, params) => (await c.query({ sql, timeout: timeoutMs }, params))[0] as Row[],
        close: () => c.end(),
      };
    }
    case 'mssql': {
      const mssql = (await optional('mssql')).default ?? (await optional('mssql'));
      const pool = await new mssql.ConnectionPool(`${url}${url.includes('requestTimeout') ? '' : `;requestTimeout=${timeoutMs}`}`).connect();
      return {
        query: async (sql, params) => {
          const req = pool.request();
          params.forEach((p, i) => req.input(`p${i + 1}`, p));
          return (await req.query(sql)).recordset as Row[];
        },
        close: () => pool.close(),
      };
    }
    case 'sqlite': {
      const db = new DatabaseSync(url, { readOnly: true });
      return {
        query: async (sql, params) => db.prepare(sql).all(...(params as never[])) as Row[],
        close: async () => db.close(),
      };
    }
  }
}

const placeholder = (driver: Driver, i: number) => (driver === 'postgres' ? `$${i}` : driver === 'mssql' ? `@p${i}` : '?');

/** Wrap a query to page it by a key column. Exported for tests. */
export function keysetQuery(driver: Driver, query: string, column: string, pageSize: number, hasAfter: boolean): string {
  validateIdent(column);
  const inner = query.trim().replace(/;+\s*$/, '');
  const where = hasAfter ? ` WHERE q.${column} > ${placeholder(driver, 1)}` : '';
  if (driver === 'mssql') return `SELECT TOP (${pageSize}) * FROM (${inner}) q${where} ORDER BY q.${column}`;
  return `SELECT * FROM (${inner}) q${where} ORDER BY q.${column} LIMIT ${pageSize}`;
}

export const sqlSource: Source = {
  info: {
    type: 'sql',
    title: 'SQL database',
    description: 'Read rows of a read-only query from Postgres, MySQL, SQL Server or SQLite.',
    kinds: ['row'],
    example: {
      type: 'sql',
      config: {
        driver: 'postgres',
        url: '${secret:CMDB_DATABASE_URL}',
        queries: { application: 'SELECT code, name, owner, tier FROM applications' },
        keyset: { column: 'code', pageSize: 1000 },
        timeoutSeconds: 30,
      },
      mappings: [{ kind: 'application', entity: { blueprint: 'system', identifier: 'code', title: 'name', properties: { tier: 'tier' } } }],
    },
  },
  validate(c) {
    requireFields(c, ['url'], 'sql');
    if (!DRIVERS.includes(str(c.driver) as Driver)) throw new Error(`sql: driver must be one of ${DRIVERS.join(', ')}`);
    const queries = (c.queries as Record<string, string> | undefined) ?? (c.query ? { row: str(c.query) } : undefined);
    if (!queries || !Object.keys(queries).length) throw new Error('sql: give "queries" ({ kind: query }) or "query"');
    for (const [k, q] of Object.entries(queries)) {
      try {
        assertReadOnly(String(q));
      } catch (err) {
        throw new Error(`sql: query "${k}": ${(err as Error).message}`, { cause: err });
      }
    }
    const ks = c.keyset as { column?: string; pageSize?: number } | undefined;
    if (ks) {
      validateIdent(ks.column ?? '');
      if (ks.pageSize !== undefined && !(Number.isInteger(ks.pageSize) && ks.pageSize > 0 && ks.pageSize <= 10_000))
        throw new Error('sql: keyset.pageSize is 1-10000');
    }
  },
  async *list(kind, { config, log, incomplete }) {
    const driver = str(config.driver) as Driver;
    const queries = (config.queries as Record<string, string> | undefined) ?? { row: str(config.query) };
    const query = queries[kind];
    if (!query) throw new Error(`sql: no query for kind "${kind}" (available: ${Object.keys(queries).join(', ')})`);
    assertReadOnly(query); // checked again at run time: configuration may have been edited out of band
    const timeoutMs = Number(config.timeoutSeconds ?? 30) * 1000;
    const keyset = config.keyset as { column: string; pageSize?: number } | undefined;
    const conn = await connect(driver, str(config.url), timeoutMs);
    try {
      if (keyset) {
        const size = keyset.pageSize ?? 1000;
        let after: unknown;
        for (let page = 0; page < MAX_PAGES; page++) {
          const rows = await conn.query(keysetQuery(driver, query, keyset.column, size, after !== undefined), after !== undefined ? [after] : []);
          log(`page ${page + 1}: ${rows.length} rows`);
          if (rows.length) yield rows;
          if (rows.length < size) return;
          after = rows[rows.length - 1]![keyset.column];
          if (after === undefined) throw new Error(`sql: keyset column "${keyset.column}" is not in the result`);
        }
        incomplete(`stopped after ${MAX_PAGES} pages`);
      } else {
        const rows = await conn.query(query.trim().replace(/;+\s*$/, ''), []);
        log(`${rows.length} rows`);
        if (rows.length > MAX_ROWS) incomplete(`more than ${MAX_ROWS} rows: use keyset paging`);
        for (let i = 0; i < Math.min(rows.length, MAX_ROWS); i += 1000) yield rows.slice(i, i + 1000);
      }
    } finally {
      await conn.close();
    }
  },
};
