import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import type { SyncRun, SyncStats } from '@asterius/shared';
import { all, bool, json, later, newId, now, run } from '../db.js';
import { errorMessage } from '../lib/errors.js';
import { render } from '../lib/expr.js';
import { resolveRef } from '../secrets.js';
import { deleteEntity, upsertEntity } from '../catalog/entities.js';
import { metrics } from '../metrics.js';
import { audit, SYSTEM } from '../audit.js';
import { withSpan } from '../tracing.js';
import type { MappingDef } from '../schemas.js';
import { getSource } from './sources/index.js';
import { mapItem, type Bindings, type Mapped } from './mapping.js';
import { entitySource, getIntegrationRow, toSyncRun, type IntegrationRow } from './integrations.js';

const LEASE_MS = 30 * 60_000;
const MAX_LOG_LINES = 300;
const SYSTEM_ACTOR = { id: null, email: 'integration' };

class SyncLog {
  lines: string[] = [];
  errors = 0;
  add = (line: string) => {
    if (this.lines.length < MAX_LOG_LINES) this.lines.push(`${new Date().toISOString().slice(11, 19)} ${line}`);
  };
  error = (line: string) => {
    this.errors++;
    if (this.errors <= 50) this.add(`ERROR ${line}`);
    else if (this.errors === 51) this.add('ERROR … further item errors omitted');
  };
}

export async function renderConfig(r: IntegrationRow) {
  const { value } = await render(json(r.config, {}), { integration: { identifier: r.identifier } }, resolveRef);
  return value as Record<string, unknown>;
}

async function applyMapped(integration: string, m: Mapped, merge: boolean, stats: SyncStats, log: SyncLog, seen?: Set<string>) {
  try {
    if (m.delete) {
      await deleteEntity(m.blueprint, m.identifier, SYSTEM_ACTOR).then(
        () => stats.deleted++,
        () => stats.skipped++, // already absent
      );
      return;
    }
    const res = await upsertEntity(
      m.blueprint,
      { identifier: m.identifier, title: m.title, team: m.team, properties: m.properties, relations: m.relations },
      { source: entitySource(integration), actor: SYSTEM_ACTOR, merge },
    );
    seen?.add(`${m.blueprint}/${m.identifier}`);
    if (res.changed) stats.upserted++;
    else stats.skipped++;
  } catch (err) {
    stats.failed++;
    seen?.add(`${m.blueprint}/${m.identifier}`); // invalid now, but not gone: never delete on validation errors
    log.error(`${m.blueprint}/${m.identifier}: ${errorMessage(err)}`);
  }
}

async function processItem(r: IntegrationRow, mapping: MappingDef, item: unknown, bindings: Bindings, stats: SyncStats, log: SyncLog, seen?: Set<string>) {
  try {
    const { mapped, skipped } = await mapItem(mapping, item, bindings);
    stats.skipped += skipped;
    for (const m of mapped) await applyMapped(r.identifier, m, mapping.merge, stats, log, seen);
  } catch (err) {
    stats.failed++;
    log.error(`mapping ${mapping.kind} → ${mapping.entity.blueprint}: ${errorMessage(err)}`);
  }
}

/** Full pull of one integration. Returns undefined when another worker holds it. */
export async function runSync(identifier: string, trigger: SyncRun['trigger']): Promise<SyncRun | undefined> {
  const t = now();
  const { changes } = await run(
    'UPDATE integrations SET locked_until = ? WHERE identifier = ? AND (locked_until IS NULL OR locked_until < ?)',
    later(LEASE_MS),
    identifier,
    t,
  );
  if (!changes) return undefined;
  const r = await getIntegrationRow(identifier);
  const id = newId();
  await run("INSERT INTO sync_runs (id, integration, trigger, status, started_at) VALUES (?, ?, ?, 'running', ?)", id, identifier, trigger, t);
  const stats: SyncStats = { upserted: 0, deleted: 0, skipped: 0, failed: 0 };
  const log = new SyncLog();
  let ok = true;

  await withSpan('integration.sync', { 'integration.id': identifier, 'integration.type': r.type }, async () => {
    try {
      const source = getSource(r.type);
      if (!source.list) throw new Error(`${r.type} integrations are push-only`);
      const mappings = json<MappingDef[]>(r.mappings, []);
      const config = await renderConfig(r);
      const bindings: Bindings = { integration: { identifier, config: json(r.config, {}) } };
      const seen = new Set<string>();
      let n = 0;
      // One listing per kind, shared by the mappings of that kind.
      for (const kind of [...new Set(mappings.map((m) => m.kind))]) {
        const forKind = mappings.filter((m) => m.kind === kind);
        for await (const page of source.list(kind, { config, log: log.add })) {
          for (const item of page) for (const m of forKind) await processItem(r, m, item, bindings, stats, log, seen);
          n += page.length;
          await run('UPDATE integrations SET locked_until = ? WHERE identifier = ?', later(LEASE_MS), identifier); // renew the lease
        }
      }
      log.add(`${n} items read`);
      if (bool(r.delete_missing)) await deleteMissing(r, mappings, seen, stats, log);
    } catch (err) {
      ok = false;
      log.add(`FAILED ${errorMessage(err)}`);
    }
  });

  const status = ok ? 'success' : 'failure';
  const interval = Number(r.interval_minutes);
  await run(
    'UPDATE sync_runs SET status = ?, stats = ?, logs = ?, ended_at = ? WHERE id = ?',
    status,
    JSON.stringify(stats),
    JSON.stringify(log.lines),
    now(),
    id,
  );
  await run('UPDATE integrations SET locked_until = NULL, next_sync_at = ? WHERE identifier = ?', interval > 0 ? later(interval * 60_000) : null, identifier);
  metrics.sync(identifier, status, stats.upserted, stats.deleted);
  await audit(SYSTEM, 'integration.synced', identifier, { trigger, status, ...stats });
  return toSyncRun({
    id,
    integration: identifier,
    trigger,
    status,
    stats: JSON.stringify(stats),
    logs: JSON.stringify(log.lines),
    started_at: t,
    ended_at: now(),
  });
}

/**
 * Remove entities this integration wrote earlier and did not see in this complete listing.
 * Guard: an empty listing never wipes existing entities (an expired token often returns nothing).
 */
async function deleteMissing(r: IntegrationRow, mappings: MappingDef[], seen: Set<string>, stats: SyncStats, log: SyncLog) {
  const blueprints = [...new Set(mappings.map((m) => m.entity.blueprint))];
  const existing = await all<{ blueprint: string; identifier: string }>(
    `SELECT blueprint, identifier FROM entities WHERE source = ? AND blueprint IN (${blueprints.map(() => '?').join(',')})`,
    entitySource(r.identifier),
    ...blueprints,
  );
  const stale = existing.filter((e) => !seen.has(`${e.blueprint}/${e.identifier}`));
  if (!stale.length) return;
  if (!seen.size) {
    log.add(`SKIPPED deleting ${stale.length} entities: the source returned nothing`);
    return;
  }
  for (const e of stale) {
    await deleteEntity(e.blueprint, e.identifier, SYSTEM_ACTOR);
    stats.deleted++;
  }
  log.add(`${stale.length} entities no longer in the source were deleted`);
}

// ---------- inbound webhooks ----------
export function verifyWebhook(cfg: Record<string, unknown>, headers: Record<string, string | string[] | undefined>, rawBody: string) {
  const secret = typeof cfg.secret === 'string' ? cfg.secret : '';
  if (!secret) return true; // explicitly unauthenticated (not recommended; documented)
  const eq = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
  const header = (name: string) => {
    const v = headers[name.toLowerCase()];
    return Array.isArray(v) ? v[0] : v;
  };
  const sigHeader = typeof cfg.signatureHeader === 'string' ? cfg.signatureHeader : '';
  if (sigHeader) {
    const got = header(sigHeader) ?? '';
    const hex = createHmac('sha256', secret).update(rawBody).digest('hex');
    return eq(got, `sha256=${hex}`) || eq(got, hex);
  }
  const token = header('x-asterius-token') ?? header('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
  return eq(token, secret);
}

/** Apply the mappings of a webhook integration to one received payload. */
export async function ingest(r: IntegrationRow, payload: unknown, headers: Record<string, unknown>): Promise<SyncStats & { errors: string[] }> {
  const stats: SyncStats = { upserted: 0, deleted: 0, skipped: 0, failed: 0 };
  const log = new SyncLog();
  const bindings: Bindings = { integration: { identifier: r.identifier, config: json(r.config, {}) }, headers };
  const items = Array.isArray(payload) ? payload : [payload];
  for (const item of items) for (const m of json<MappingDef[]>(r.mappings, [])) await processItem(r, m, item, bindings, stats, log);
  const t = now();
  await run(
    'INSERT INTO sync_runs (id, integration, trigger, status, stats, logs, started_at, ended_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    newId(),
    r.identifier,
    'webhook',
    stats.failed ? 'failure' : 'success',
    JSON.stringify(stats),
    JSON.stringify(log.lines),
    t,
    t,
  );
  metrics.sync(r.identifier, stats.failed ? 'failure' : 'success', stats.upserted, stats.deleted);
  await audit(SYSTEM, 'integration.ingested', r.identifier, { ...stats });
  return { ...stats, errors: log.lines };
}

// ---------- scheduler ----------
/** `next_sync_at` value meaning "requested by someone" (sorts first, labelled manual in the history). */
export const MANUAL = '1970-01-01T00:00:00.000Z';
const MAX_PARALLEL_SYNCS = 2;
let running = 0;

export function startSyncScheduler(log: FastifyBaseLogger) {
  const tick = async () => {
    if (running >= MAX_PARALLEL_SYNCS) return;
    const due = await all<{ identifier: string; type: string; next_sync_at: string }>(
      `SELECT identifier, type, next_sync_at FROM integrations
       WHERE enabled = 1 AND next_sync_at IS NOT NULL AND next_sync_at <= ? AND (locked_until IS NULL OR locked_until < ?)
       ORDER BY next_sync_at LIMIT ?`,
      now(),
      now(),
      MAX_PARALLEL_SYNCS - running,
    );
    for (const d of due) {
      if (getSource(d.type).push) {
        await run('UPDATE integrations SET next_sync_at = NULL WHERE identifier = ?', d.identifier);
        continue;
      }
      running++;
      runSync(d.identifier, d.next_sync_at === MANUAL ? 'manual' : 'schedule')
        .then((res) => res && log.info({ integration: d.identifier, status: res.status, stats: res.stats }, 'integration synced'))
        .catch((err) => log.error({ err, integration: d.identifier }, 'integration sync crashed'))
        .finally(() => running--);
    }
  };
  const timer = setInterval(() => tick().catch((err) => log.error({ err }, 'sync scheduler failed')), 10_000);
  timer.unref();
  return () => clearInterval(timer);
}
