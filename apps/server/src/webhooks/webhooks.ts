import { createHmac } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import type { Delivery, Webhook } from '@asterius/shared';
import { all, bool, json, later, newId, now, one, run } from '../db.js';
import { errorMessage, managedError, notFound } from '../lib/errors.js';
import { http, UpstreamError } from '../lib/http.js';
import { invalidateWebhookCache } from '../events.js';
import { resolveValue } from '../secrets.js';
import { webhookDef, type WebhookDef } from '../schemas.js';
import { metrics } from '../metrics.js';
import { withSpan } from '../tracing.js';

/**
 * Outbound webhooks: notify other systems of catalog changes and runs (Teams/Slack relays, CMDB, audit sinks…).
 * At-least-once delivery from the `deliveries` outbox, exponential backoff, 8 attempts. Consumers should
 * de-duplicate on the payload `id`.
 */

interface Row {
  identifier: string;
  title: string;
  url: string;
  events: string;
  blueprints: string;
  secret: string | null;
  enabled: number;
  managed: number;
}

const toWebhook = (r: Row): Webhook => ({
  identifier: r.identifier,
  title: r.title,
  url: r.url,
  events: json(r.events, []),
  blueprints: json(r.blueprints, []),
  enabled: bool(r.enabled),
  managed: bool(r.managed),
  hasSecret: !!r.secret,
});

export async function listWebhooks(): Promise<Webhook[]> {
  return (await all<Row>('SELECT * FROM webhooks ORDER BY title')).map(toWebhook);
}

export async function getWebhook(id: string) {
  const r = await one<Row>('SELECT * FROM webhooks WHERE identifier = ?', id);
  if (!r) throw notFound(`Webhook ${id}`);
  return { ...toWebhook(r), secret: r.secret };
}

export async function upsertWebhook(input: unknown, opts: { managed?: boolean } = {}) {
  const def: WebhookDef = webhookDef.parse(input);
  const existing = await one<Row>('SELECT * FROM webhooks WHERE identifier = ?', def.identifier);
  if (existing && bool(existing.managed) && !opts.managed) throw managedError('Webhook', def.identifier);
  const t = now();
  // An omitted secret keeps the current one (the API never returns it).
  const secret = def.secret === undefined ? (existing?.secret ?? null) : (def.secret ?? null);
  const vals = [def.title, def.url, JSON.stringify(def.events), JSON.stringify(def.blueprints), secret, def.enabled ? 1 : 0, opts.managed ? 1 : 0];
  if (existing)
    await run(
      'UPDATE webhooks SET title = ?, url = ?, events = ?, blueprints = ?, secret = ?, enabled = ?, managed = ?, updated_at = ? WHERE identifier = ?',
      ...vals,
      t,
      def.identifier,
    );
  else
    await run(
      'INSERT INTO webhooks (title, url, events, blueprints, secret, enabled, managed, created_at, updated_at, identifier) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ...vals,
      t,
      t,
      def.identifier,
    );
  invalidateWebhookCache();
  return { webhook: toWebhook((await one<Row>('SELECT * FROM webhooks WHERE identifier = ?', def.identifier))!), created: !existing };
}

export async function deleteWebhook(id: string, opts: { managed?: boolean } = {}) {
  const w = await getWebhook(id);
  if (w.managed && !opts.managed) throw managedError('Webhook', id);
  await run('DELETE FROM webhooks WHERE identifier = ?', id);
  invalidateWebhookCache();
}

interface DeliveryRow {
  id: string;
  webhook: string;
  event: string;
  payload: string;
  status: Delivery['status'];
  attempts: number;
  response_status: number | null;
  last_error: string | null;
  created_at: string;
  delivered_at: string | null;
}

export async function listDeliveries(webhook: string, limit = 50): Promise<Delivery[]> {
  const rows = await all<DeliveryRow>('SELECT * FROM deliveries WHERE webhook = ? ORDER BY created_at DESC LIMIT ?', webhook, limit);
  return rows.map((r) => ({
    id: r.id,
    webhook: r.webhook,
    event: r.event,
    status: r.status,
    attempts: Number(r.attempts),
    responseStatus: r.response_status,
    lastError: r.last_error,
    createdAt: r.created_at,
    deliveredAt: r.delivered_at,
  }));
}

const toDelivery = (r: DeliveryRow): Delivery => ({
  id: r.id,
  webhook: r.webhook,
  event: r.event,
  status: r.status,
  attempts: Number(r.attempts),
  responseStatus: r.response_status,
  lastError: r.last_error,
  createdAt: r.created_at,
  deliveredAt: r.delivered_at,
});

/** Deliveries across every webhook, newest first (e.g. all the failed ones). */
export async function listAllDeliveries(q: { status?: Delivery['status']; limit: number; offset: number }): Promise<Delivery[]> {
  const rows = await all<DeliveryRow>(
    `SELECT * FROM deliveries ${q.status ? 'WHERE status = ?' : ''} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    ...(q.status ? [q.status] : []),
    q.limit,
    q.offset,
  );
  return rows.map(toDelivery);
}

/** Redeliver several at once; returns how many were queued. */
export async function redeliverMany(ids: string[]): Promise<number> {
  let n = 0;
  for (const id of ids) {
    const { changes } = await run("UPDATE deliveries SET status = 'pending', attempts = 0, next_attempt_at = ?, locked_until = NULL WHERE id = ?", now(), id);
    n += Number(changes) > 0 ? 1 : 0;
  }
  return n;
}

export async function redeliver(id: string) {
  const { changes } = await run("UPDATE deliveries SET status = 'pending', attempts = 0, next_attempt_at = ?, locked_until = NULL WHERE id = ?", now(), id);
  if (!changes) throw notFound('Delivery');
}

// ---------- delivery worker ----------
const MAX_ATTEMPTS = 8;
const backoffMs = (attempt: number) => Math.min(6 * 3600_000, 30_000 * 2 ** (attempt - 1)); // 30 s … 6 h

async function deliver(d: DeliveryRow) {
  const w = await one<Row>('SELECT * FROM webhooks WHERE identifier = ?', d.webhook);
  if (!w || !bool(w.enabled)) {
    await run("UPDATE deliveries SET status = 'failed', last_error = ?, locked_until = NULL WHERE id = ?", 'webhook disabled or deleted', d.id);
    return;
  }
  const attempts = Number(d.attempts) + 1;
  try {
    const headers: Record<string, string> = { 'content-type': 'application/json', 'x-asterius-event': d.event, 'x-asterius-delivery': d.id };
    const secret = await resolveValue(w.secret);
    if (secret) headers['x-asterius-signature'] = `sha256=${createHmac('sha256', secret).update(d.payload).digest('hex')}`;
    const res = await withSpan('webhook.deliver', { 'webhook.id': w.identifier, event: d.event }, () =>
      http(w.url, { method: 'POST', headers, body: d.payload, timeoutMs: 15_000 }),
    );
    await run(
      "UPDATE deliveries SET status = 'success', attempts = ?, response_status = ?, last_error = NULL, delivered_at = ?, locked_until = NULL WHERE id = ?",
      attempts,
      res.status,
      now(),
      d.id,
    );
    metrics.delivery('success');
  } catch (err) {
    const status = err instanceof UpstreamError ? err.status : null;
    const final = attempts >= MAX_ATTEMPTS || (status !== null && status >= 400 && status < 500 && status !== 408 && status !== 429);
    await run(
      'UPDATE deliveries SET status = ?, attempts = ?, response_status = ?, last_error = ?, next_attempt_at = ?, locked_until = NULL WHERE id = ?',
      final ? 'failed' : 'pending',
      attempts,
      status,
      errorMessage(err).slice(0, 500),
      later(backoffMs(attempts)),
      d.id,
    );
    metrics.delivery(final ? 'failed' : 'retry');
  }
}

export function startDeliveryWorker(log: FastifyBaseLogger) {
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const due = await all<DeliveryRow>(
        "SELECT * FROM deliveries WHERE status = 'pending' AND next_attempt_at <= ? AND (locked_until IS NULL OR locked_until < ?) ORDER BY next_attempt_at LIMIT 20",
        now(),
        now(),
      );
      await Promise.all(
        due.map(async (d) => {
          const { changes } = await run(
            "UPDATE deliveries SET locked_until = ? WHERE id = ? AND status = 'pending' AND (locked_until IS NULL OR locked_until < ?)",
            later(60_000),
            d.id,
            now(),
          );
          if (changes) await deliver(d);
        }),
      );
    } catch (err) {
      log.error({ err }, 'webhook delivery tick failed');
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(() => void tick(), 3_000);
  timer.unref();
  return () => clearInterval(timer);
}

export async function queueTestDelivery(webhook: string) {
  const payload = JSON.stringify({
    id: newId(),
    type: 'webhook.test',
    at: now(),
    blueprint: null,
    actor: null,
    data: { message: 'Test delivery from Asterius' },
  });
  await run(
    "INSERT INTO deliveries (id, webhook, event, payload, status, next_attempt_at, created_at) VALUES (?, ?, ?, ?, 'pending', ?, ?)",
    newId(),
    webhook,
    'webhook.test',
    payload,
    now(),
    now(),
  );
}
