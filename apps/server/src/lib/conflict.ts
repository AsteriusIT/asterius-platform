import type { EditConflict } from '@asterius/shared';
import { one } from '../db.js';
import { HttpError } from './errors.js';

/**
 * Optimistic concurrency for editors: a client sends `If-Match: <version>` with the version it loaded; when the
 * stored version differs the write is refused with 412 and a `conflict` body naming who changed it and when, so the
 * UI can explain it and offer to reload or overwrite. Without If-Match nothing is checked (API clients, config).
 */

/** `If-Match: "3"`, `W/"3"` or a bare 3 → 3; `*` and absent → no precondition. */
export function ifMatchOf(header: string | string[] | undefined): number | undefined {
  const h = Array.isArray(header) ? header[0] : header;
  if (!h || h.trim() === '*') return undefined;
  const n = Number(h.trim().replace(/^W\//, '').replace(/"/g, ''));
  if (!Number.isInteger(n) || n < 0) throw new HttpError(400, 'If-Match must be an ETag (the version number)');
  return n;
}

/** The last change as recorded in a version history table. */
export interface LastChange {
  actor_id: string | null;
  actor_email: string | null;
  at: string;
}

/** A 412 carrying who made the current version and when (the user's display name when the actor is a user). */
export async function staleVersion(message: string, currentVersion: number | null, last: LastChange | undefined): Promise<HttpError> {
  const user = last?.actor_id ? await one<{ name: string; email: string }>('SELECT name, email FROM users WHERE id = ?', last.actor_id) : undefined;
  const email = user?.email ?? last?.actor_email ?? null;
  const name = user?.name || null;
  const details: EditConflict = {
    currentVersion,
    changedBy: email || name ? { email, name } : null,
    changedAt: last?.at ?? null,
  };
  return new HttpError(412, message, { conflict: details });
}
