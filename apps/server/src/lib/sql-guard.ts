/** Guards for user-supplied SQL run by the sql source: read-only statements, single statement, safe identifiers. */

const FORBIDDEN =
  /\b(insert|update|delete|drop|alter|create|truncate|grant|revoke|merge|call|exec|execute|copy|into|vacuum|attach|detach|pragma|upsert|reindex)\b/i;

/** Remove string literals, quoted identifiers and comments so keyword checks do not trip on data. */
export function stripSqlNoise(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/"(?:[^"]|"")*"/g, '""')
    .replace(/`[^`]*`/g, '``')
    .replace(/\[[^\]]*\]/g, '[]');
}

/**
 * Only a single SELECT / WITH statement is accepted. This is defence in depth: the database account should be
 * read-only anyway (and Postgres runs the query in a READ ONLY transaction, SQLite opens the file read-only).
 */
export function assertReadOnly(sql: string) {
  const clean = stripSqlNoise(sql)
    .trim()
    .replace(/;+\s*$/, '');
  if (!clean) throw new Error('empty query');
  if (clean.includes(';')) throw new Error('only one statement is allowed');
  if (!/^(select|with)\b/i.test(clean)) throw new Error('only SELECT / WITH queries are allowed');
  const bad = FORBIDDEN.exec(clean);
  if (bad) throw new Error(`"${bad[1]}" is not allowed in a read-only query`);
}

export function validateIdent(name: string) {
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(name)) throw new Error(`invalid column name "${name}"`);
}
