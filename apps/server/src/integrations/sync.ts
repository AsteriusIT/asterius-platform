import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import type { SyncRun, SyncStats } from '@asterius/shared';
import { all, bool, json, later, newId, now, run } from '../db.js';
import { errorMessage } from '../lib/errors.js';
import { redact, render } from '../lib/expr.js';
import { resolveRef } from '../secrets.js';
import { deleteEntities, upsertEntities } from '../catalog/entities.js';
import { metrics } from '../metrics.js';
import { beat, registerLoop } from '../health.js';
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
  /** Resolved secret values of the integration: upstream error bodies and item errors may echo them. */
  secrets: string[] = [];
  add = (line: string) => {
    if (this.lines.length < MAX_LOG_LINES) this.lines.push(`${new Date().toISOString().slice(11, 19)} ${redact(line, this.secrets)}`);
  };
  error = (line: string) => {
    this.errors++;
    if (this.errors <= 50) this.add(`ERROR ${line}`);
    else if (this.errors === 51) this.add('ERROR … further item errors omitted');
  };
}

export async function renderConfigWithSecrets(r: IntegrationRow) {
  const { value, secrets } = await render(json(r.config, {}), { integration: { identifier: r.identifier } }, resolveRef);
  return { config: value as Record<string, unknown>, secrets };
}

export async function renderConfig(r: IntegrationRow) {
  return (await renderConfigWithSecrets(r)).config;
}

/** Mapped entities of the current page/payload, applied in batches (grouped by blueprint and merge mode). */
interface Batch {
  upserts: { m: Mapped; merge: boolean }[];
  deletes: Mapped[];
}
const newBatch = (): Batch => ({ upserts: [], deletes: [] });

async function applyBatch(integration: string, batch: Batch, stats: SyncStats, log: SyncLog, seen?: Set<string>) {
  const groups = new Map<string, { m: Mapped; merge: boolean }[]>();
  for (const u of batch.upserts) {
    const key = `${u.m.blueprint}\u0000${u.merge}`;
    groups.set(key, [...(groups.get(key) ?? []), u]);
  }
  for (const group of groups.values()) {
    const { blueprint } = group[0]!.m;
    try {
      const results = await upsertEntities(
        blueprint,
        group.map(({ m }) => ({ identifier: m.identifier, title: m.title, team: m.team, properties: m.properties, relations: m.relations })),
        { source: entitySource(integration), actor: SYSTEM_ACTOR, merge: group[0]!.merge },
      );
      for (const [i, r] of results.entries()) {
        const m = group[i]!.m;
        seen?.add(`${m.blueprint}/${m.identifier}`); // invalid now, but not gone: never delete on validation errors
        if (!r.ok) {
          stats.failed++;
          log.error(`${m.blueprint}/${m.identifier}: ${r.error}`);
        } else if (r.changed) stats.upserted++;
        else stats.skipped++;
      }
    } catch (err) {
      for (const { m } of group) {
        stats.failed++;
        seen?.add(`${m.blueprint}/${m.identifier}`);
      }
      log.error(`${blueprint}: ${errorMessage(err)}`);
    }
  }
  if (batch.deletes.length) {
    try {
      const r = await deleteEntities(batch.deletes, SYSTEM_ACTOR);
      stats.deleted += r.deleted;
      stats.skipped += r.absent + r.refused.length; // already absent, or refused by a restricting relation
      for (const x of r.refused) log.error(`NOT deleted ${x.blueprint}/${x.identifier}: ${x.error}`);
    } catch (err) {
      stats.failed += batch.deletes.length;
      log.error(`delete: ${errorMessage(err)}`);
    }
  }
}

async function processItem(mapping: MappingDef, item: unknown, bindings: Bindings, stats: SyncStats, log: SyncLog, batch: Batch) {
  try {
    const { mapped, skipped } = await mapItem(mapping, item, bindings);
    stats.skipped += skipped;
    for (const m of mapped) {
      if (m.delete) batch.deletes.push(m);
      else batch.upserts.push({ m, merge: mapping.merge });
    }
  } catch (err) {
    stats.failed++;
    log.error(`mapping ${mapping.kind} → ${mapping.entity.blueprint}: ${errorMessage(err)}`);
  }
}

/** Full pull of one integration. Returns undefined when another worker holds it. */
export async function runSync(identifier: string, trigger: SyncRun['trigger']): Promise<SyncRun | undefined> {
  const t = now();
  // The lease carries an owner token: only the holder can renew or release it, so a sync that outlived its lease
  // (and whose integration another worker has since claimed) can neither extend nor clear the new holder's lease.
  const owner = newId();
  const { changes } = await run(
    'UPDATE integrations SET locked_until = ?, lock_owner = ? WHERE identifier = ? AND (locked_until IS NULL OR locked_until < ?)',
    later(LEASE_MS),
    owner,
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
      const rendered = await renderConfigWithSecrets(r);
      const config = rendered.config;
      log.secrets = rendered.secrets;
      const bindings: Bindings = { integration: { identifier, config: json(r.config, {}) } };
      const seen = new Set<string>();
      let n = 0;
      // One listing per kind, shared by the mappings of that kind.
      for (const kind of [...new Set(mappings.map((m) => m.kind))]) {
        const forKind = mappings.filter((m) => m.kind === kind);
        for await (const page of source.list(kind, { config, log: log.add })) {
          const batch = newBatch();
          for (const item of page) for (const m of forKind) await processItem(m, item, bindings, stats, log, batch);
          await applyBatch(r.identifier, batch, stats, log, seen);
          n += page.length;
          const renewed = await run('UPDATE integrations SET locked_until = ? WHERE identifier = ? AND lock_owner = ?', later(LEASE_MS), identifier, owner);
          if (!renewed.changes) throw new Error('The sync lease was lost to another worker; stopping'); // renew the lease
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
  await run(
    'UPDATE integrations SET locked_until = NULL, lock_owner = NULL, next_sync_at = ? WHERE identifier = ? AND lock_owner = ?',
    interval > 0 ? later(interval * 60_000) : null,
    identifier,
    owner,
  );
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
  const res = await deleteEntities(stale, SYSTEM_ACTOR);
  stats.deleted += res.deleted;
  stats.skipped += res.refused.length;
  // A relation may restrict the deletion (onDelete: restrict): the entity is kept and reported.
  for (const x of res.refused) log.add(`NOT deleted ${x.blueprint}/${x.identifier}: ${x.error}`);
  log.add(`${res.deleted} entities no longer in the source were deleted`);
}

// ---------- inbound webhooks ----------
export function verifyWebhook(cfg: Record<string, unknown>, headers: Record<string, string | string[] | undefined>, rawBody: string) {
  const secret = typeof cfg.secret === 'string' ? cfg.secret : '';
  if (!secret) return cfg.allowUnauthenticated === true; // anonymous only when the admin explicitly opted in
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

/** Provider delivery ids: GitHub `X-GitHub-Delivery`, GitLab `X-Gitlab-Event-UUID`, generic `X-Asterius-Delivery`. */
export function deliveryIdOf(headers: Record<string, string | string[] | undefined>): string | undefined {
  for (const h of ['x-github-delivery', 'x-gitlab-event-uuid', 'x-asterius-delivery']) {
    const v = headers[h];
    const id = Array.isArray(v) ? v[0] : v;
    if (id) return id.slice(0, 200);
  }
  return undefined;
}

export const DELIVERY_WINDOW_MS = 24 * 3600_000;

/** Remember a delivery id; false when it was already seen inside the window (a replay). */
export async function recordDelivery(integration: string, deliveryId: string): Promise<boolean> {
  const cutoff = new Date(Date.now() - DELIVERY_WINDOW_MS).toISOString();
  await run('DELETE FROM ingest_deliveries WHERE integration = ? AND delivery_id = ? AND received_at < ?', integration, deliveryId, cutoff);
  const { changes } = await run(
    'INSERT INTO ingest_deliveries (integration, delivery_id, received_at) VALUES (?, ?, ?) ON CONFLICT (integration, delivery_id) DO NOTHING',
    integration,
    deliveryId,
    now(),
  );
  return changes > 0;
}

/** Apply the mappings of a webhook integration to one received payload. */
export async function ingest(r: IntegrationRow, payload: unknown, headers: Record<string, unknown>): Promise<SyncStats & { errors: string[] }> {
  const stats: SyncStats = { upserted: 0, deleted: 0, skipped: 0, failed: 0 };
  const log = new SyncLog();
  log.secrets = await renderConfigWithSecrets(r).then(
    (x) => x.secrets,
    () => [],
  );
  const bindings: Bindings = { integration: { identifier: r.identifier, config: json(r.config, {}) }, headers };
  const items = Array.isArray(payload) ? payload : [payload];
  const batch = newBatch();
  for (const item of items) for (const m of json<MappingDef[]>(r.mappings, [])) await processItem(m, item, bindings, stats, log, batch);
  await applyBatch(r.identifier, batch, stats, log);
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
  const unregister = registerLoop('sync-scheduler', 120_000);
  const timer = setInterval(
    () =>
      tick()
        .catch((err) => log.error({ err }, 'sync scheduler failed'))
        .finally(() => beat('sync-scheduler')),
    10_000,
  );
  timer.unref();
  return () => {
    clearInterval(timer);
    unregister();
  };
}
