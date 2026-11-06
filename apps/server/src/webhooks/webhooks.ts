import { createHmac } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import type { Delivery, Webhook } from '@asterius/shared';
import { all, bool, json, later, now, one, run } from '../db.js';
import { badRequest, errorMessage, managedError, notFound } from '../lib/errors.js';
import { http, UpstreamError } from '../lib/http.js';
import { decodeCursor, encodeCursor } from '../lib/cursor.js';
import { checkExpression, render } from '../lib/expr.js';
import { invalidateWebhookCache } from '../events.js';
import { resolveRef, resolveValue, setSecret } from '../secrets.js';
import { SECRET_REF, webhookDef, type WebhookDef } from '../schemas.js';
import { metrics } from '../metrics.js';
import { beat, registerLoop } from '../health.js';
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
  secondary_secret: string | null;
  headers: string | null;
  filter: string | null;
  transform: string | null;
  enabled: number;
  managed: number;
}

const toWebhook = (r: Row): Webhook => ({
  identifier: r.identifier,
  title: r.title,
  url: r.url,
  events: json(r.events, []),
  blueprints: json(r.blueprints, []),
  headers: json<Record<string, string>>(r.headers, {}),
  filter: r.filter,
  transform: r.transform,
  enabled: bool(r.enabled),
  managed: bool(r.managed),
  hasSecret: !!r.secret,
  hasSecondarySecret: !!r.secondary_secret,
});

export async function listWebhooks(): Promise<Webhook[]> {
  return (await all<Row>('SELECT * FROM webhooks ORDER BY title')).map(toWebhook);
}

export async function getWebhook(id: string) {
  const r = await one<Row>('SELECT * FROM webhooks WHERE identifier = ?', id);
  if (!r) throw notFound(`Webhook ${id}`);
  // Defence in depth: only ever expose a reference, never a literal value.
  const ref = (v: string | null) => (v && SECRET_REF.test(v.trim()) ? v : null);
  return { ...toWebhook(r), secret: ref(r.secret), secondarySecret: ref(r.secondary_secret) };
}

export async function upsertWebhook(input: unknown, opts: { managed?: boolean } = {}) {
  const def: WebhookDef = webhookDef.parse(input);
  const existing = await one<Row>('SELECT * FROM webhooks WHERE identifier = ?', def.identifier);
  if (existing && bool(existing.managed) && !opts.managed) throw managedError('Webhook', def.identifier);
  for (const [what, expr] of [
    ['filter', def.filter],
    ['transform', def.transform],
  ] as const) {
    if (!expr) continue;
    try {
      checkExpression(expr);
    } catch (err) {
      throw badRequest(`${what}: ${errorMessage(err)}`);
    }
  }
  const t = now();
  // An omitted secret keeps the current one (the API never returns it).
  const secret = def.secret === undefined ? (existing?.secret ?? null) : (def.secret ?? null);
  const secondary = def.secondarySecret === undefined ? (existing?.secondary_secret ?? null) : (def.secondarySecret ?? null);
  const vals = [
    def.title,
    def.url,
    JSON.stringify(def.events),
    JSON.stringify(def.blueprints),
    secret,
    secondary,
    JSON.stringify(def.headers),
    def.filter ?? null,
    def.transform ?? null,
    def.enabled ? 1 : 0,
    opts.managed ? 1 : 0,
  ];
  if (existing)
    await run(
      'UPDATE webhooks SET title = ?, url = ?, events = ?, blueprints = ?, secret = ?, secondary_secret = ?, headers = ?, filter = ?, transform = ?, enabled = ?, managed = ?, updated_at = ? WHERE identifier = ?',
      ...vals,
      t,
      def.identifier,
    );
  else
    await run(
      'INSERT INTO webhooks (title, url, events, blueprints, secret, secondary_secret, headers, filter, transform, enabled, managed, created_at, updated_at, identifier) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ...vals,
      t,
      t,
      def.identifier,
    );
  await invalidateWebhookCache();
  return { webhook: toWebhook((await one<Row>('SELECT * FROM webhooks WHERE identifier = ?', def.identifier))!), created: !existing };
}

export async function deleteWebhook(id: string, opts: { managed?: boolean } = {}) {
  const w = await getWebhook(id);
  if (w.managed && !opts.managed) throw managedError('Webhook', id);
  await run('DELETE FROM webhooks WHERE identifier = ?', id);
  await invalidateWebhookCache();
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

/** Newest first. Page by `cursor` (keyset, cheap on a large outbox) or `offset`; filter by webhook and status. */
export async function listDeliveries(q: {
  webhook?: string;
  status?: Delivery['status'];
  limit?: number;
  cursor?: string;
  offset?: number;
}): Promise<{ deliveries: Delivery[]; nextCursor?: string }> {
  const limit = q.limit ?? 50;
  const where: string[] = [];
  const args: (string | number)[] = [];
  if (q.webhook) {
    where.push('webhook = ?');
    args.push(q.webhook);
  }
  if (q.status) {
    where.push('status = ?');
    args.push(q.status);
  }
  if (q.cursor) {
    where.push('(created_at, id) < (?, ?)');
    args.push(...decodeCursor(q.cursor, { s: 'deliveries', d: 'desc', n: 2 }));
  }
  const rows = await all<DeliveryRow>(
    `SELECT * FROM deliveries ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
    ...args,
    limit + 1,
    q.cursor ? 0 : (q.offset ?? 0),
  );
  const more = rows.length > limit;
  if (more) rows.pop();
  const last = rows.at(-1);
  return {
    deliveries: rows.map(toDelivery),
    nextCursor: more && last ? encodeCursor({ s: 'deliveries', d: 'desc', v: [last.created_at, last.id] }) : undefined,
  };
}

export async function redeliver(id: string) {
  const { changes } = await run("UPDATE deliveries SET status = 'pending', attempts = 0, next_attempt_at = ?, locked_until = NULL WHERE id = ?", now(), id);
  if (!changes) throw notFound('Delivery');
}

// ---------- signatures ----------
/**
 * `X-Asterius-Signature: t=<unix seconds>,v1=<hex>[,v1=<hex>]` where each v1 is HMAC-SHA256 of `"<t>.<body>"` keyed with
 * a signing secret (two entries while a rotation is in progress). Receivers recompute it, accept any matching v1 and reject
 * timestamps more than 5 minutes old (replay protection). The timestamp is taken at each attempt, so retries stay valid.
 */
export function signPayload(payload: string, secrets: (string | undefined)[], at = Math.floor(Date.now() / 1000)): string | undefined {
  const keys = secrets.filter((s): s is string => !!s);
  if (!keys.length) return undefined;
  return `t=${at},${keys.map((k) => `v1=${createHmac('sha256', k).update(`${at}.${payload}`).digest('hex')}`).join(',')}`;
}

/** Requeue the given deliveries (any status). Returns how many. */
export async function redeliverMany(ids: string[]): Promise<number> {
  if (!ids.length) return 0;
  const { changes } = await run(
    `UPDATE deliveries SET status = 'pending', attempts = 0, next_attempt_at = ?, locked_until = NULL WHERE id IN (${ids.map(() => '?').join(',')})`,
    now(),
    ...ids,
  );
  return Number(changes);
}

/** Requeue every failed delivery (optionally of one webhook). Returns how many. */
export async function redeliverFailed(webhook?: string): Promise<number> {
  const { changes } = await run(
    `UPDATE deliveries SET status = 'pending', attempts = 0, next_attempt_at = ?, locked_until = NULL WHERE status = 'failed'${webhook ? ' AND webhook = ?' : ''}`,
    now(),
    ...(webhook ? [webhook] : []),
  );
  return Number(changes);
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
    for (const [k, v] of Object.entries(json<Record<string, string>>(w.headers, {}))) {
      const value = (await render(v, {}, resolveRef)).value;
      if (typeof value === 'string' && value) headers[k.toLowerCase()] = value;
    }
    const signature = signPayload(d.payload, [await resolveValue(w.secret), await resolveValue(w.secondary_secret)]);
    if (signature) headers['x-asterius-signature'] = signature;
    const res = await withSpan(
      'webhook.deliver',
      { 'webhook.id': w.identifier, event: d.event },
      () => http(w.url, { method: 'POST', headers, body: d.payload, timeoutMs: 15_000, retry: false }), // the outbox owns the retries
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
      beat('webhook-delivery');
    }
  };
  const unregister = registerLoop('webhook-delivery', 120_000);
  const timer = setInterval(() => void tick(), 3_000);
  timer.unref();
  return () => {
    clearInterval(timer);
    unregister();
  };
}

/**
 * Older versions accepted a literal signing secret. Move any such value into the encrypted secret store and rewrite
 * the row as a `${secret:NAME}` reference. Idempotent; runs at startup.
 */
export async function migrateLiteralWebhookSecrets() {
  const rows = await all<{ identifier: string; secret: string }>("SELECT identifier, secret FROM webhooks WHERE secret IS NOT NULL AND secret <> ''");
  for (const r of rows) {
    if (SECRET_REF.test(r.secret.trim())) continue;
    const name = `webhook-${r.identifier}-signing`.slice(0, 100);
    await setSecret(name, r.secret, `Signing secret of webhook ${r.identifier} (migrated from a plaintext value)`, null);
    await run('UPDATE webhooks SET secret = ? WHERE identifier = ?', `\${secret:${name}}`, r.identifier);
  }
  if (rows.length) invalidateWebhookCache();
}
