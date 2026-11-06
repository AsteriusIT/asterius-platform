import type { FastifyBaseLogger } from 'fastify';
import { all, later, newId, now, run } from '../db.js';
import { errorMessage } from '../lib/errors.js';
import { getIntegrationRow, type IntegrationRow } from './integrations.js';
import { ingest } from './sync.js';

/**
 * Inbound webhooks are acknowledged immediately and processed by workers: the raw payload is persisted in
 * `inbound_events` (so nothing is lost on a restart and providers with short timeouts, e.g. GitHub's 10 s, are happy).
 * Integrations with `config.sync: true` keep the old behaviour (process in the request, answer with the stats).
 */

export const MAX_ITEMS_PER_EVENT = 1000;
const MAX_ATTEMPTS = 5;
const LEASE_MS = 5 * 60_000;

/** Decode a body by content type into the value mappings run on: JSON, form fields, or the text itself (XML, plain). */
export function decodeBody(contentType: string, raw: string): unknown {
  const ct = contentType.toLowerCase();
  if (!raw) return null;
  if (ct.includes('json')) return JSON.parse(raw);
  if (ct.includes('x-www-form-urlencoded')) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of new URLSearchParams(raw)) {
      // Slack/GitLab style `payload=<json>` forms carry a JSON document in one field.
      if (k === 'payload') {
        try {
          return JSON.parse(v);
        } catch {
          /* plain value */
        }
      }
      out[k] = v;
    }
    return out;
  }
  return raw;
}

export async function enqueueInbound(integration: string, headers: Record<string, unknown>, contentType: string, raw: string): Promise<string> {
  const id = newId();
  await run(
    "INSERT INTO inbound_events (id, integration, headers, content_type, payload, status, attempts, next_attempt_at, received_at) VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, ?)",
    id,
    integration,
    JSON.stringify(headers),
    contentType,
    raw,
    now(),
    now(),
  );
  return id;
}

interface InboundRow {
  id: string;
  integration: string;
  headers: string;
  content_type: string;
  payload: string;
  attempts: number;
}

async function handle(ev: InboundRow) {
  const attempts = Number(ev.attempts) + 1;
  try {
    const r: IntegrationRow = await getIntegrationRow(ev.integration);
    const body = decodeBody(ev.content_type, ev.payload);
    if (Array.isArray(body) && body.length > MAX_ITEMS_PER_EVENT) throw new Error(`payload has ${body.length} items (max ${MAX_ITEMS_PER_EVENT})`);
    await ingest(r, body, JSON.parse(ev.headers) as Record<string, unknown>);
    await run(
      "UPDATE inbound_events SET status = 'done', attempts = ?, error = NULL, processed_at = ?, payload = '', locked_until = NULL WHERE id = ?",
      attempts,
      now(),
      ev.id,
    );
  } catch (err) {
    const final = attempts >= MAX_ATTEMPTS || err instanceof SyntaxError;
    await run(
      'UPDATE inbound_events SET status = ?, attempts = ?, error = ?, next_attempt_at = ?, locked_until = NULL WHERE id = ?',
      final ? 'failed' : 'pending',
      attempts,
      errorMessage(err).slice(0, 500),
      later(Math.min(600_000, 5_000 * 2 ** attempts)),
      ev.id,
    );
  }
}

/** Process pending inbound events (any replica; claimed with a lease). Returns how many were handled. */
export async function processInbound(limit = 20): Promise<number> {
  const due = await all<InboundRow>(
    "SELECT id, integration, headers, content_type, payload, attempts FROM inbound_events WHERE status = 'pending' AND next_attempt_at <= ? AND (locked_until IS NULL OR locked_until < ?) ORDER BY next_attempt_at LIMIT ?",
    now(),
    now(),
    limit,
  );
  let n = 0;
  for (const ev of due) {
    const { changes } = await run(
      "UPDATE inbound_events SET locked_until = ? WHERE id = ? AND status = 'pending' AND (locked_until IS NULL OR locked_until < ?)",
      later(LEASE_MS),
      ev.id,
      now(),
    );
    if (!changes) continue;
    await handle(ev);
    n++;
  }
  return n;
}

export function startInboundWorker(log: FastifyBaseLogger) {
  let busy = false;
  const timer = setInterval(() => {
    if (busy) return;
    busy = true;
    processInbound()
      .catch((err) => log.error({ err }, 'inbound event processing failed'))
      .finally(() => (busy = false));
  }, 2_000);
  timer.unref();
  return () => clearInterval(timer);
}
