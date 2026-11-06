import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import type { SyncItemError, SyncRun, SyncStats } from '@asterius/shared';
import { all, bool, json, later, newId, now, one, run } from '../db.js';
import { badRequest, errorMessage } from '../lib/errors.js';
import { render } from '../lib/expr.js';
import { resolveRef } from '../secrets.js';
import { deleteEntity, upsertEntity } from '../catalog/entities.js';
import { emit } from '../events.js';
import { metrics } from '../metrics.js';
import { withSpan } from '../tracing.js';
import { nextCron } from '../lib/cron.js';
import { withCircuit } from '../lib/resilience.js';
import type { MappingDef } from '../schemas.js';
import { getSource } from './sources/index.js';
import type { SourceEnv } from './types.js';
import { mapItem, type Bindings, type Mapped } from './mapping.js';
import { entitySource, getIntegrationRow, toSyncRun, type IntegrationRow } from './integrations.js';

const LEASE_MS = 30 * 60_000;
const MAX_LOG_LINES = 300;
const MAX_ITEM_ERRORS = 200;
const DEFAULT_RECONCILE_HOURS = 24;
export const DEFAULT_MAX_DELETE_PERCENT = 20;

/** Incremental state of an integration, stored in `integrations.sync_state`. */
interface SyncState {
  kinds: Record<string, unknown>;
  /** Last run that listed everything completely (the reference of the periodic full reconcile). */
  lastFullAt?: string;
}
interface KindListing {
  kind: string;
  blueprints: string[];
  items: number;
  /** Listed incrementally (only what changed): cannot tell what disappeared. */
  partial?: boolean;
  incomplete?: string;
}
const SYSTEM_ACTOR = { id: null, email: 'integration' };

/** Short identification of a raw item for error records. */
function itemKey(item: unknown): string {
  if (item && typeof item === 'object') {
    for (const k of ['id', 'identifier', 'name', 'key', 'code', 'full_name'])
      if (typeof (item as Record<string, unknown>)[k] === 'string' || typeof (item as Record<string, unknown>)[k] === 'number')
        return String((item as Record<string, unknown>)[k]).slice(0, 100);
  }
  return JSON.stringify(item)?.slice(0, 100) ?? '';
}

class SyncLog {
  lines: string[] = [];
  errors = 0;
  /** Structured per-item errors (mapping kind, item key, message), capped. */
  items: SyncItemError[] = [];
  add = (line: string) => {
    if (this.lines.length < MAX_LOG_LINES) this.lines.push(`${new Date().toISOString().slice(11, 19)} ${line}`);
  };
  private conflicts = 0;
  /** Ownership conflicts: logged (capped) without counting as errors. */
  conflict = (line: string) => {
    this.conflicts++;
    if (this.conflicts <= 20) this.add(line);
    else if (this.conflicts === 21) this.add('CONFLICT … further conflicts omitted');
  };
  error = (line: string, rec?: Omit<SyncItemError, 'message'> & { message: string }) => {
    if (rec && this.items.length < MAX_ITEM_ERRORS) this.items.push(rec);
    this.errors++;
    if (this.errors <= 50) this.add(`ERROR ${line}`);
    else if (this.errors === 51) this.add('ERROR … further item errors omitted');
  };
}

export async function renderConfig(r: IntegrationRow) {
  const { value } = await render(json(r.config, {}), { integration: { identifier: r.identifier } }, resolveRef);
  return value as Record<string, unknown>;
}

/**
 * Ownership of entities written by several integrations (`entities.source` names the owner, `entities.field_owners`
 * records, per property, who wrote it when that is not the owner):
 *  - priority: `priority`, plus a large bonus for the integrations listed in `primaryFor` for that blueprint;
 *  - an entity owned by an integration with a higher or equal priority keeps its owner (the incumbent wins ties);
 *  - a mapping with `merge: false` then skips the entity (reported as a CONFLICT in the sync log);
 *  - a mapping with `merge: true` writes the properties that are unset or whose current writer it outranks, and
 *    records itself as their owner (field-level ownership); the entity owner does not change;
 *  - a higher priority integration takes the entity over; the fields it does not map keep their writers;
 *  - an owner never overwrites a field another integration owns with a higher priority.
 * Entities of unknown / removed integrations, manual and config entities are taken over as before.
 */
export interface Me {
  priority: number;
  primaryFor: string[];
}
const PRIMARY_BONUS = 1_000_000;
const effective = (m: Me, blueprint: string) => m.priority + (m.primaryFor.includes(blueprint) ? PRIMARY_BONUS : 0);

const infos = new Map<string, Me | null>();
async function infoOf(source: string): Promise<Me | null> {
  if (!source.startsWith('integration:')) return null;
  const id = source.slice('integration:'.length);
  if (infos.has(id)) return infos.get(id)!;
  const row = await one<{ priority: number; primary_for: string | null }>('SELECT priority, primary_for FROM integrations WHERE identifier = ?', id);
  const info = row ? { priority: Number(row.priority), primaryFor: json<string[]>(row.primary_for, []) } : null;
  infos.set(id, info);
  return info;
}

type Ownership =
  | { action: 'write'; oldSource?: string; oldKeys: string[]; hadOwners: boolean }
  | { action: 'skip'; owner: string }
  | { action: 'fill'; source: string; owner: string; properties: Record<string, unknown>; relations: Record<string, unknown>; owners: Record<string, string> };

export async function resolveOwnership(integration: string, me: Me, m: Mapped, merge: boolean): Promise<Ownership> {
  const mine = entitySource(integration);
  const row = await one<{ source: string; properties: string; relations: string; field_owners: string | null }>(
    'SELECT source, properties, relations, field_owners FROM entities WHERE blueprint = ? AND identifier = ?',
    m.blueprint,
    m.identifier,
  );
  const plain: Ownership = { action: 'write', oldKeys: [], hadOwners: false };
  if (!row || (row.source !== mine && !row.source.startsWith('integration:'))) return plain;
  const owners = json<Record<string, string>>(row.field_owners, {});
  const have = json<Record<string, unknown>>(row.properties, {});
  const haveRel = json<Record<string, unknown>>(row.relations, {});
  const myEff = effective(me, m.blueprint);
  const foreign = Object.values(owners).some((o) => o !== mine);

  if (row.source === mine && !foreign) return { action: 'write', oldKeys: [], hadOwners: Object.keys(owners).length > 0 };
  if (row.source !== mine) {
    const theirs = await infoOf(row.source);
    if (myEff > (theirs ? effective(theirs, m.blueprint) : Number.NEGATIVE_INFINITY))
      return {
        action: 'write',
        oldSource: row.source,
        oldKeys: [...Object.keys(have), ...Object.keys(haveRel).map((k) => `rel:${k}`)],
        hadOwners: Object.keys(owners).length > 0,
      };
    if (!merge) return { action: 'skip', owner: row.source };
  }
  // Field level: write what is unset or whose writer we outrank.
  const canWrite = async (key: string, existing: Record<string, unknown>, ownerKey: string) => {
    if (existing[key.replace(/^rel:/, '')] === undefined || existing[key.replace(/^rel:/, '')] === null) return true;
    const writer = owners[ownerKey] ?? row.source;
    if (writer === mine) return true;
    const info = await infoOf(writer);
    return myEff > (info ? effective(info, m.blueprint) : Number.NEGATIVE_INFINITY);
  };
  const properties: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(m.properties ?? {})) if (await canWrite(k, have, k)) properties[k] = v;
  const relations: Record<string, unknown> = {};
  for (const [k, v] of Object.entries((m.relations ?? {}) as Record<string, unknown>)) if (await canWrite(k, haveRel, `rel:${k}`)) relations[k] = v;
  return { action: 'fill', source: row.source, owner: row.source, properties, relations, owners };
}

async function recordOwners(blueprint: string, identifier: string, owners: Record<string, string> | null) {
  await run(
    'UPDATE entities SET field_owners = ? WHERE blueprint = ? AND identifier = ?',
    owners && Object.keys(owners).length ? JSON.stringify(owners) : null,
    blueprint,
    identifier,
  );
}

async function applyMapped(integration: string, me: Me, kind: string, m: Mapped, merge: boolean, stats: SyncStats, log: SyncLog, seen?: Set<string>) {
  try {
    if (m.delete) {
      await deleteEntity(m.blueprint, m.identifier, SYSTEM_ACTOR).then(
        () => stats.deleted++,
        () => stats.skipped++, // already absent
      );
      return;
    }
    const own = await resolveOwnership(integration, me, m, merge);
    if (own.action === 'skip') {
      log.conflict(`CONFLICT ${m.blueprint}/${m.identifier} is owned by ${own.owner} (higher or equal priority): not written`);
      stats.skipped++;
      return;
    }
    const mine = entitySource(integration);
    let res;
    if (own.action === 'fill') {
      res = await upsertEntity(
        m.blueprint,
        { identifier: m.identifier, properties: own.properties, relations: own.relations },
        { source: own.source, actor: SYSTEM_ACTOR, merge: true },
      );
      const written = [...Object.keys(own.properties), ...Object.keys(own.relations).map((k) => `rel:${k}`)];
      if (written.length) await recordOwners(m.blueprint, m.identifier, { ...own.owners, ...Object.fromEntries(written.map((k) => [k, mine])) });
      if (res.changed)
        log.conflict(`CONFLICT ${m.blueprint}/${m.identifier} owned by ${own.owner}: wrote ${written.length} field(s) it does not own at a higher priority`);
    } else {
      res = await upsertEntity(
        m.blueprint,
        { identifier: m.identifier, title: m.title, team: m.team, properties: m.properties, relations: m.relations },
        { source: mine, actor: SYSTEM_ACTOR, merge },
      );
      if (own.oldSource && merge) {
        // Taken over from another owner: the fields this mapping does not write keep their writer.
        const written = new Set([...Object.keys(m.properties ?? {}), ...Object.keys(m.relations ?? {}).map((k) => `rel:${k}`)]);
        await recordOwners(m.blueprint, m.identifier, Object.fromEntries(own.oldKeys.filter((k) => !written.has(k)).map((k) => [k, own.oldSource!])));
      } else if (own.hadOwners || own.oldSource) await recordOwners(m.blueprint, m.identifier, null);
    }
    seen?.add(`${m.blueprint}/${m.identifier}`);
    if (res.changed) stats.upserted++;
    else stats.skipped++;
  } catch (err) {
    stats.failed++;
    seen?.add(`${m.blueprint}/${m.identifier}`); // invalid now, but not gone: never delete on validation errors
    log.error(`${m.blueprint}/${m.identifier}: ${errorMessage(err)}`, { mapping: kind, key: `${m.blueprint}/${m.identifier}`, message: errorMessage(err) });
  }
}

async function processItem(r: IntegrationRow, mapping: MappingDef, item: unknown, bindings: Bindings, stats: SyncStats, log: SyncLog, seen?: Set<string>) {
  try {
    const { mapped, skipped } = await mapItem(mapping, item, bindings);
    stats.skipped += skipped;
    for (const m of mapped)
      await applyMapped(
        r.identifier,
        { priority: Number(r.priority ?? 0), primaryFor: json<string[]>(r.primary_for, []) },
        mapping.kind,
        m,
        mapping.merge,
        stats,
        log,
        seen,
      );
  } catch (err) {
    stats.failed++;
    log.error(`mapping ${mapping.kind} → ${mapping.entity.blueprint}: ${errorMessage(err)}`, {
      mapping: mapping.kind,
      key: itemKey(item),
      message: errorMessage(err),
    });
  }
}

/** Full pull of one integration. Returns undefined when another worker holds it. */
export async function runSync(identifier: string, trigger: SyncRun['trigger'], opts: { kind?: string } = {}): Promise<SyncRun | undefined> {
  const t = now();
  const { changes } = await run(
    'UPDATE integrations SET locked_until = ? WHERE identifier = ? AND (locked_until IS NULL OR locked_until < ?)',
    later(LEASE_MS),
    identifier,
    t,
  );
  if (!changes) return undefined;
  infos.clear(); // ownership priorities are read afresh by every run
  const r = await getIntegrationRow(identifier);
  const id = newId();
  await run("INSERT INTO sync_runs (id, integration, trigger, status, started_at) VALUES (?, ?, ?, 'running', ?)", id, identifier, trigger, t);
  const stats: SyncStats = { upserted: 0, deleted: 0, skipped: 0, failed: 0 };
  const log = new SyncLog();
  let ok = true;

  let state = undefined as SyncState | undefined;
  await withSpan('integration.sync', { 'integration.id': identifier, 'integration.type': r.type }, () =>
    withCircuit(identifier, async () => {
      try {
        const source = getSource(r.type);
        if (!source.list) throw new Error(`${r.type} integrations are push-only`);
        const mappings = json<MappingDef[]>(r.mappings, []);
        const config = await renderConfig(r);
        const bindings: Bindings = { integration: { identifier, config: json(r.config, {}) } };
        const seen = new Set<string>();
        let n = 0;
        // Incremental sources only list what changed since the stored state, except on the periodic full reconcile
        // (the only run allowed to delete: a partial listing cannot tell what disappeared).
        const prev = json<SyncState>(r.sync_state, { kinds: {} });
        const reconcileMs = Math.max(0, Number(config.fullReconcileHours ?? DEFAULT_RECONCILE_HOURS)) * 3_600_000;
        if (opts.kind && !mappings.some((m) => m.kind === opts.kind)) throw new Error(`no mapping for kind "${opts.kind}"`);
        if (opts.kind) log.add(`syncing only kind "${opts.kind}": no deletions, full reconcile clock untouched`);
        const full = !!opts.kind || !source.incremental || !prev.lastFullAt || Date.now() - Date.parse(prev.lastFullAt) >= reconcileMs;
        if (source.incremental) log.add(full ? 'full sync' : `incremental sync (full reconcile after ${prev.lastFullAt})`);
        const nextKinds: Record<string, unknown> = { ...prev.kinds };
        const listings: KindListing[] = [];
        // One listing per kind, shared by the mappings of that kind.
        for (const kind of [...new Set(mappings.map((m) => m.kind))].filter((k) => !opts.kind || k === opts.kind)) {
          const forKind = mappings.filter((m) => m.kind === kind);
          const listing: KindListing = { kind, blueprints: forKind.map((m) => m.entity.blueprint), items: 0 };
          listing.partial = !full && prev.kinds[kind] !== undefined;
          listings.push(listing);
          let newState: unknown;
          let stateSet = false;
          const env: SourceEnv = {
            config,
            log: log.add,
            startedAt: t,
            state: full ? undefined : prev.kinds[kind],
            setState: (s) => {
              newState = s;
              stateSet = true;
            },
            incomplete: (reason) => {
              listing.incomplete ??= reason;
              log.add(`WARNING ${kind}: incomplete listing (${reason})`);
            },
          };
          for await (const page of source.list(kind, env)) {
            for (const item of page) for (const m of forKind) await processItem(r, m, item, bindings, stats, log, seen);
            n += page.length;
            listing.items += page.length;
            await run('UPDATE integrations SET locked_until = ? WHERE identifier = ?', later(LEASE_MS), identifier); // renew the lease
          }
          if (stateSet && !listing.incomplete) nextKinds[kind] = newState;
        }
        log.add(`${n} items read`);
        if (listings.some((l) => l.partial)) log.add('deletions of incrementally listed kinds are deferred to the next full reconcile');
        if (bool(r.delete_missing) && !opts.kind)
          await deleteMissing(r, listings, seen, stats, log, {
            maxPercent: Number(r.delete_max_percent ?? DEFAULT_MAX_DELETE_PERCENT),
            dryRun: bool(r.delete_dry_run),
          });
        if (source.incremental) {
          const complete = listings.every((l) => !l.incomplete);
          state = { kinds: nextKinds, ...(full && !opts.kind && complete ? { lastFullAt: t } : prev.lastFullAt ? { lastFullAt: prev.lastFullAt } : {}) };
        }
      } catch (err) {
        ok = false;
        log.add(`FAILED ${errorMessage(err)}`);
      }
    }),
  );
  if (ok && state) await run('UPDATE integrations SET sync_state = ? WHERE identifier = ?', JSON.stringify(state), identifier);

  const status = !ok ? 'failure' : stats.failed ? 'partial' : 'success';
  await run(
    'UPDATE sync_runs SET status = ?, stats = ?, logs = ?, errors = ?, ended_at = ? WHERE id = ?',
    status,
    JSON.stringify(stats),
    JSON.stringify(log.lines),
    JSON.stringify(log.items),
    now(),
    id,
  );
  await run('UPDATE integrations SET locked_until = NULL, requested_kind = NULL, next_sync_at = ? WHERE identifier = ?', nextSyncAt(r), identifier);
  metrics.sync(identifier, status, stats.upserted, stats.deleted);
  await emit({
    type: status === 'failure' ? 'sync.failed' : 'sync.finished',
    blueprint: null,
    data: { integration: identifier, status, stats, runId: id, errors: log.items.slice(0, 20) },
  });
  return toSyncRun({
    id,
    integration: identifier,
    trigger,
    status,
    stats: JSON.stringify(stats),
    logs: JSON.stringify(log.lines),
    errors: JSON.stringify(log.items),
    started_at: t,
    ended_at: now(),
  });
}

/**
 * Remove entities this integration wrote earlier and did not see in this full listing. Guards:
 *  - a kind whose listing was incomplete (page / result caps) or empty never deletes its blueprints;
 *  - a blueprint also fed by an ineligible kind is left alone;
 *  - more than `maxPercent` of the existing entities being stale cancels the whole deletion;
 *  - `dryRun` only reports what would be deleted.
 */
async function deleteMissing(
  r: IntegrationRow,
  listings: KindListing[],
  seen: Set<string>,
  stats: SyncStats,
  log: SyncLog,
  opts: { maxPercent: number; dryRun: boolean },
) {
  const blocked = new Map<string, string>(); // blueprint → why it is protected
  for (const l of listings) {
    const why = l.incomplete
      ? `${l.kind} listing incomplete (${l.incomplete})`
      : l.partial
        ? `${l.kind} listed incrementally`
        : l.items === 0
          ? `${l.kind} returned nothing`
          : undefined;
    if (why) for (const bp of l.blueprints) blocked.set(bp, why);
  }
  const blueprints = [...new Set(listings.flatMap((l) => l.blueprints))];
  if (!blueprints.length) return;
  const existing = await all<{ blueprint: string; identifier: string }>(
    `SELECT blueprint, identifier FROM entities WHERE source = ? AND blueprint IN (${blueprints.map(() => '?').join(',')})`,
    entitySource(r.identifier),
    ...blueprints,
  );
  const isStale = (e: { blueprint: string; identifier: string }) => !seen.has(`${e.blueprint}/${e.identifier}`);
  for (const [bp, why] of blocked) {
    const n = existing.filter((e) => e.blueprint === bp && isStale(e)).length;
    if (n) log.add(`SKIPPED deleting ${n} entities of blueprint ${bp}: ${why}`);
  }
  const candidates = existing.filter((e) => !blocked.has(e.blueprint));
  const stale = candidates.filter(isStale);
  if (!stale.length) return;
  const percent = (stale.length / candidates.length) * 100;
  if (opts.maxPercent < 100 && percent > opts.maxPercent) {
    log.add(
      `SKIPPED deleting ${stale.length} of ${candidates.length} entities (${Math.round(percent)}% > deleteMaxPercent ${opts.maxPercent}%): check the source, or raise deleteMaxPercent`,
    );
    return;
  }
  if (opts.dryRun) {
    log.add(
      `DRY RUN: would delete ${stale.length} entities: ${stale
        .slice(0, 20)
        .map((e) => `${e.blueprint}/${e.identifier}`)
        .join(', ')}${stale.length > 20 ? ', …' : ''}`,
    );
    return;
  }
  for (const e of stale) {
    await deleteEntity(e.blueprint, e.identifier, SYSTEM_ACTOR);
    stats.deleted++;
  }
  log.add(`${stale.length} entities no longer in the source were deleted`);
}

// ---------- inbound webhooks ----------
/**
 * Authenticate an inbound webhook against the raw request bytes. `config.preset` selects the provider's scheme:
 *   github        HMAC-SHA256 in X-Hub-Signature-256
 *   gitlab        X-Gitlab-Token equals the secret
 *   azure-devops  HTTP basic auth, the password is the secret
 *   slack         X-Slack-Signature = v0=HMAC("v0:<X-Slack-Request-Timestamp>:<body>"), timestamp within 5 minutes
 * Without a preset: `signatureHeader` (HMAC), or X-Asterius-Token / Bearer token.
 */
export function verifyWebhook(cfg: Record<string, unknown>, headers: Record<string, string | string[] | undefined>, rawBody: string) {
  const secret = typeof cfg.secret === 'string' ? cfg.secret : '';
  if (!secret) return true; // explicitly unauthenticated (not recommended; documented)
  const eq = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
  const header = (name: string) => {
    const v = headers[name.toLowerCase()];
    return Array.isArray(v) ? v[0] : v;
  };
  const hmac = (data: string) => createHmac('sha256', secret).update(data).digest('hex');
  switch (cfg.preset) {
    case 'github':
      return eq(header('x-hub-signature-256') ?? '', `sha256=${hmac(rawBody)}`);
    case 'gitlab':
      return eq(header('x-gitlab-token') ?? '', secret);
    case 'azure-devops': {
      const m = /^Basic\s+(.+)$/i.exec(header('authorization') ?? '');
      const password = m ? Buffer.from(m[1]!, 'base64').toString().split(':').slice(1).join(':') : '';
      return eq(password, secret);
    }
    case 'slack': {
      const ts = header('x-slack-request-timestamp') ?? '';
      if (!/^\d+$/.test(ts) || Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false;
      return eq(header('x-slack-signature') ?? '', `v0=${hmac(`v0:${ts}:${rawBody}`)}`);
    }
  }
  const sigHeader = typeof cfg.signatureHeader === 'string' ? cfg.signatureHeader : '';
  if (sigHeader) {
    const got = header(sigHeader) ?? '';
    const hex = hmac(rawBody);
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
  return { ...stats, errors: log.lines };
}

/** Connection test: lists the first page of every mapped kind without writing anything. */
export async function testIntegration(identifier: string) {
  const r = await getIntegrationRow(identifier);
  const source = getSource(r.type);
  if (!source.list) throw badRequest(`${r.type} integrations are push-only: nothing to test`);
  const kinds = [...new Set(json<MappingDef[]>(r.mappings, []).map((m) => m.kind))];
  const config = await renderConfig(r);
  const log = new SyncLog();
  const results: Array<{ kind: string; ok: boolean; items?: number; sample?: unknown; error?: string; warnings: string[] }> = [];
  await withCircuit(`test:${identifier}`, async () => {
    for (const kind of kinds) {
      const warnings: string[] = [];
      try {
        const env: SourceEnv = { config, log: log.add, startedAt: now(), setState: () => undefined, incomplete: (w) => warnings.push(w) };
        const iter = source.list!(kind, env)[Symbol.asyncIterator]();
        const first = await iter.next();
        await iter.return?.();
        const page = first.done ? [] : first.value;
        results.push({ kind, ok: true, items: page.length, sample: page[0], warnings });
      } catch (err) {
        results.push({ kind, ok: false, error: errorMessage(err), warnings });
      }
    }
  });
  return { ok: results.every((x) => x.ok), kinds: results };
}

/** When the next scheduled sync is due: a cron `schedule` wins over the interval; null means manual only. */
export function nextSyncAt(r: Pick<IntegrationRow, 'schedule' | 'interval_minutes'>): string | null {
  if (r.schedule) {
    try {
      return nextCron(r.schedule).toISOString();
    } catch {
      return null;
    }
  }
  const interval = Number(r.interval_minutes);
  return interval > 0 ? later(interval * 60_000) : null;
}

// ---------- scheduler ----------
/** `next_sync_at` value meaning "requested by someone" (sorts first, labelled manual in the history). */
export const MANUAL = '1970-01-01T00:00:00.000Z';
const MAX_PARALLEL_SYNCS = 2;
let running = 0;

export function startSyncScheduler(log: FastifyBaseLogger) {
  const tick = async () => {
    if (running >= MAX_PARALLEL_SYNCS) return;
    const due = await all<{ identifier: string; type: string; next_sync_at: string; requested_kind: string | null }>(
      `SELECT identifier, type, next_sync_at, requested_kind FROM integrations
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
      runSync(d.identifier, d.next_sync_at === MANUAL ? 'manual' : 'schedule', { kind: d.requested_kind ?? undefined })
        .then((res) => res && log.info({ integration: d.identifier, status: res.status, stats: res.stats }, 'integration synced'))
        .catch((err) => log.error({ err, integration: d.identifier }, 'integration sync crashed'))
        .finally(() => running--);
    }
  };
  const timer = setInterval(() => tick().catch((err) => log.error({ err }, 'sync scheduler failed')), 10_000);
  timer.unref();
  return () => clearInterval(timer);
}
