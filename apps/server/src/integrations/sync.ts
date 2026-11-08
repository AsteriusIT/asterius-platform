import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import type { SyncItemError, SyncRun, SyncStats } from '@asterius/shared';
import { all, bool, json, later, newId, now, one, run } from '../db.js';
import { badRequest, errorMessage } from '../lib/errors.js';
import { render } from '../lib/expr.js';
import { maskText } from '../lib/mask.js';
import { resolveRef } from '../secrets.js';
import { deleteEntities, upsertEntities, upsertEntity } from '../catalog/entities.js';
import { emit } from '../events.js';
import { metrics } from '../metrics.js';
import { beat, registerLoop } from '../health.js';
import { audit, SYSTEM } from '../audit.js';
import { withSpan } from '../tracing.js';
import { nextCron, parseCron } from '../lib/cron.js';
import { withCircuit } from '../lib/resilience.js';
import type { MappingDef } from '../schemas.js';
import { getSource } from './sources/index.js';
import { orgId, withOrg } from '../orgs/context.js';
import type { SourceEnv } from './types.js';
import { mapItem, type Bindings, type Mapped, type PruneScope } from './mapping.js';
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
  /** Resolved secret values of the integration: upstream error bodies and item errors may echo them. */
  secrets: string[] = [];
  /** Structured per-item errors (mapping kind, item key, message), capped. */
  items: SyncItemError[] = [];
  add = (line: string) => {
    if (this.lines.length < MAX_LOG_LINES) this.lines.push(`${new Date().toISOString().slice(11, 19)} ${maskText(line, this.secrets)}`);
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

export async function renderConfigWithSecrets(r: IntegrationRow) {
  const { value, secrets } = await render(json(r.config, {}), { integration: { identifier: r.identifier } }, resolveRef);
  return { config: value as Record<string, unknown>, secrets };
}

export async function renderConfig(r: IntegrationRow) {
  return (await renderConfigWithSecrets(r)).config;
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

/** Ownership priorities of the integrations writing entities, by organization and integration. */
const infos = new Map<string, Me | null>();
async function infoOf(source: string): Promise<Me | null> {
  if (!source.startsWith('integration:')) return null;
  const id = source.slice('integration:'.length);
  const org = orgId();
  const key = `${org}/${id}`;
  if (infos.has(key)) return infos.get(key)!;
  const row = await one<{ priority: number; primary_for: string | null }>(
    'SELECT priority, primary_for FROM integrations WHERE org_id = ? AND identifier = ?',
    org,
    id,
  );
  const info = row ? { priority: Number(row.priority), primaryFor: json<string[]>(row.primary_for, []) } : null;
  infos.set(key, info);
  return info;
}

type Ownership =
  | { action: 'write'; oldSource?: string; oldKeys: string[]; hadOwners: boolean }
  | { action: 'skip'; owner: string }
  | { action: 'fill'; source: string; owner: string; properties: Record<string, unknown>; relations: Record<string, unknown>; owners: Record<string, string> };

export async function resolveOwnership(integration: string, me: Me, m: Mapped, merge: boolean): Promise<Ownership> {
  const mine = entitySource(integration);
  const row = await one<{ source: string; properties: string; relations: string; field_owners: string | null }>(
    'SELECT source, properties, relations, field_owners FROM entities WHERE org_id = ? AND blueprint = ? AND identifier = ?',
    orgId(),
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
    'UPDATE entities SET field_owners = ? WHERE org_id = ? AND blueprint = ? AND identifier = ?',
    owners && Object.keys(owners).length ? JSON.stringify(owners) : null,
    orgId(),
    blueprint,
    identifier,
  );
}

/** Mapped entities of the current page/payload, applied in batches (grouped by blueprint and merge mode). */
interface Pending {
  kind: string;
  m: Mapped;
  merge: boolean;
  /** `MappingDef.setOnce`: properties written only while the entity has no value for them. */
  setOnce?: string[];
}

/** Drop the set-once properties the stored entity already has a value for. */
async function dropSetOnce(m: Mapped, keys: string[]) {
  if (!keys.some((k) => k in m.properties)) return;
  const row = await one<{ properties: string }>(
    'SELECT properties FROM entities WHERE org_id = ? AND blueprint = ? AND identifier = ?',
    orgId(),
    m.blueprint,
    m.identifier,
  );
  if (!row) return;
  const have = json<Record<string, unknown>>(row.properties, {});
  for (const k of keys) if (have[k] !== undefined && have[k] !== null && have[k] !== '') delete m.properties[k];
}
interface Batch {
  upserts: Pending[];
  deletes: Mapped[];
}
const newBatch = (): Batch => ({ upserts: [], deletes: [] });

/**
 * Apply one page of mapped entities. Ownership is resolved per entity (one read); entities this integration may write
 * outright are upserted in batches (`upsertEntities`), the rare field-level fills one by one.
 */
async function applyBatch(integration: string, me: Me, batch: Batch, stats: SyncStats, log: SyncLog, seen?: Set<string>) {
  const mine = entitySource(integration);
  const fail = (p: Pending, message: string) => {
    stats.failed++;
    seen?.add(`${p.m.blueprint}/${p.m.identifier}`); // invalid now, but not gone: never delete on validation errors
    log.error(`${p.m.blueprint}/${p.m.identifier}: ${message}`, { mapping: p.kind, key: `${p.m.blueprint}/${p.m.identifier}`, message });
  };
  const writes: { p: Pending; own: Extract<Ownership, { action: 'write' }> }[] = [];
  for (const p of batch.upserts) {
    const { m, merge } = p;
    try {
      if (p.setOnce?.length) await dropSetOnce(m, p.setOnce);
      const own = await resolveOwnership(integration, me, m, merge);
      if (own.action === 'skip') {
        log.conflict(`CONFLICT ${m.blueprint}/${m.identifier} is owned by ${own.owner} (higher or equal priority): not written`);
        stats.skipped++;
      } else if (own.action === 'fill') {
        const res = await upsertEntity(
          m.blueprint,
          { identifier: m.identifier, properties: own.properties, relations: own.relations },
          { source: own.source, actor: SYSTEM_ACTOR, merge: true },
        );
        const written = [...Object.keys(own.properties), ...Object.keys(own.relations).map((k) => `rel:${k}`)];
        if (written.length) await recordOwners(m.blueprint, m.identifier, { ...own.owners, ...Object.fromEntries(written.map((k) => [k, mine])) });
        if (res.changed)
          log.conflict(`CONFLICT ${m.blueprint}/${m.identifier} owned by ${own.owner}: wrote ${written.length} field(s) it does not own at a higher priority`);
        seen?.add(`${m.blueprint}/${m.identifier}`);
        if (res.changed) stats.upserted++;
        else stats.skipped++;
      } else writes.push({ p, own });
    } catch (err) {
      fail(p, errorMessage(err));
    }
  }
  const groups = new Map<string, typeof writes>();
  for (const w of writes) {
    const key = `${w.p.m.blueprint}\u0000${w.p.merge}`;
    groups.set(key, [...(groups.get(key) ?? []), w]);
  }
  for (const group of groups.values()) {
    const { blueprint } = group[0]!.p.m;
    try {
      const results = await upsertEntities(
        blueprint,
        group.map(({ p: { m } }) => ({ identifier: m.identifier, title: m.title, team: m.team, properties: m.properties, relations: m.relations })),
        { source: mine, actor: SYSTEM_ACTOR, merge: group[0]!.p.merge },
      );
      for (const [i, r] of results.entries()) {
        const { p, own } = group[i]!;
        const { m } = p;
        if (!r.ok) {
          fail(p, r.error);
          continue;
        }
        seen?.add(`${m.blueprint}/${m.identifier}`);
        if (own.oldSource && p.merge) {
          // Taken over from another owner: the fields this mapping does not write keep their writer.
          const written = new Set([...Object.keys(m.properties ?? {}), ...Object.keys(m.relations ?? {}).map((k) => `rel:${k}`)]);
          await recordOwners(m.blueprint, m.identifier, Object.fromEntries(own.oldKeys.filter((k) => !written.has(k)).map((k) => [k, own.oldSource!])));
        } else if (own.hadOwners || own.oldSource) await recordOwners(m.blueprint, m.identifier, null);
        if (r.changed) stats.upserted++;
        else stats.skipped++;
      }
    } catch (err) {
      for (const w of group) fail(w.p, errorMessage(err));
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

async function processItem(mapping: MappingDef, item: unknown, bindings: Bindings, stats: SyncStats, log: SyncLog, batch: Batch, prunes?: PruneScope[]) {
  try {
    const { mapped, skipped, prune } = await mapItem(mapping, item, bindings);
    stats.skipped += skipped;
    if (prune) prunes?.push(prune);
    for (const m of mapped) {
      if (m.delete) batch.deletes.push(m);
      else batch.upserts.push({ kind: mapping.kind, m, merge: mapping.merge, setOnce: mapping.setOnce });
    }
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
export async function runSync(identifier: string, trigger: SyncRun['trigger'], opts: { kind?: string; scope?: string } = {}): Promise<SyncRun | undefined> {
  const t = now();
  const org = orgId();
  // The lease carries an owner token: only the holder can renew or release it, so a sync that outlived its lease
  // (and whose integration another worker has since claimed) can neither extend nor clear the new holder's lease.
  const owner = newId();
  const { changes } = await run(
    'UPDATE integrations SET locked_until = ?, lock_owner = ? WHERE org_id = ? AND identifier = ? AND (locked_until IS NULL OR locked_until < ?)',
    later(LEASE_MS),
    owner,
    org,
    identifier,
    t,
  );
  if (!changes) return undefined;
  for (const k of infos.keys()) if (k.startsWith(`${org}/`)) infos.delete(k); // ownership priorities are read afresh by every run
  const r = await getIntegrationRow(identifier);
  const id = newId();
  await run("INSERT INTO sync_runs (id, org_id, integration, trigger, status, started_at) VALUES (?, ?, ?, ?, 'running', ?)", id, org, identifier, trigger, t);
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
        const rendered = await renderConfigWithSecrets(r);
        const config = rendered.config;
        log.secrets = rendered.secrets;
        const bindings: Bindings = { integration: { identifier, config: json(r.config, {}) } };
        const seen = new Set<string>();
        const me: Me = { priority: Number(r.priority ?? 0), primaryFor: json<string[]>(r.primary_for, []) };
        let n = 0;
        // Incremental sources only list what changed since the stored state, except on the periodic full reconcile
        // (the only run allowed to delete: a partial listing cannot tell what disappeared).
        const prev = json<SyncState>(r.sync_state, { kinds: {} });
        const reconcileMs = Math.max(0, Number(config.fullReconcileHours ?? DEFAULT_RECONCILE_HOURS)) * 3_600_000;
        if (opts.kind && !mappings.some((m) => m.kind === opts.kind)) throw new Error(`no mapping for kind "${opts.kind}"`);
        if (opts.scope) log.add(`targeted sync of "${opts.scope}": no deletions, full reconcile clock untouched`);
        if (opts.kind) log.add(`syncing only kind "${opts.kind}": no deletions, full reconcile clock untouched`);
        const full = !!opts.kind || !!opts.scope || !source.incremental || !prev.lastFullAt || Date.now() - Date.parse(prev.lastFullAt) >= reconcileMs;
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
            scope: opts.scope,
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
            const batch = newBatch();
            for (const item of page) for (const m of forKind) await processItem(m, item, bindings, stats, log, batch);
            await applyBatch(r.identifier, me, batch, stats, log, seen);
            n += page.length;
            listing.items += page.length;
            const renewed = await run(
              'UPDATE integrations SET locked_until = ? WHERE org_id = ? AND identifier = ? AND lock_owner = ?',
              later(LEASE_MS),
              org,
              identifier,
              owner,
            );
            if (!renewed.changes) throw new Error('The sync lease was lost to another worker; stopping'); // renew the lease
          }
          if (stateSet && !listing.incomplete) nextKinds[kind] = newState;
        }
        log.add(`${n} items read`);
        if (listings.some((l) => l.partial)) log.add('deletions of incrementally listed kinds are deferred to the next full reconcile');
        if (bool(r.delete_missing) && !opts.kind && !opts.scope)
          await deleteMissing(r, listings, seen, stats, log, {
            maxPercent: Number(r.delete_max_percent ?? DEFAULT_MAX_DELETE_PERCENT),
            dryRun: bool(r.delete_dry_run),
          });
        if (source.incremental) {
          const complete = listings.every((l) => !l.incomplete);
          state = {
            kinds: nextKinds,
            ...(full && !opts.kind && !opts.scope && complete ? { lastFullAt: t } : prev.lastFullAt ? { lastFullAt: prev.lastFullAt } : {}),
          };
        }
      } catch (err) {
        ok = false;
        log.add(`FAILED ${errorMessage(err)}`);
      }
    }),
  );
  if (ok && state) await run('UPDATE integrations SET sync_state = ? WHERE org_id = ? AND identifier = ?', JSON.stringify(state), org, identifier);

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
  await run(
    'UPDATE integrations SET locked_until = NULL, lock_owner = NULL, requested_kind = NULL, requested_scope = NULL, next_sync_at = ? WHERE org_id = ? AND identifier = ? AND lock_owner = ?',
    nextSyncAt(r),
    org,
    identifier,
    owner,
  );
  metrics.sync(identifier, status, stats.upserted, stats.deleted, (Date.now() - Date.parse(t)) / 1000);
  await audit(SYSTEM, 'integration.synced', identifier, { trigger, status, ...stats });
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
    `SELECT blueprint, identifier FROM entities WHERE org_id = ? AND source = ? AND blueprint IN (${blueprints.map(() => '?').join(',')})`,
    orgId(),
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
  const res = await deleteEntities(stale, SYSTEM_ACTOR);
  stats.deleted += res.deleted;
  stats.skipped += res.refused.length;
  // A relation may restrict the deletion (onDelete: restrict): the entity is kept and reported.
  for (const x of res.refused) log.add(`NOT deleted ${x.blueprint}/${x.identifier}: ${x.error}`);
  log.add(`${res.deleted} entities no longer in the source were deleted`);
}

/**
 * `prune` on a webhook mapping: the delivery is the complete set for one scope (for example the SBOM of one service).
 * Deletes the entities of the blueprint that this integration owns (`source`), that point at the scope through the
 * relation, and that this delivery did not emit. Guards: nothing is pruned when anything in the delivery failed; entities
 * written after the delivery started (a concurrent delivery on another replica) are kept (`updated_at <= startedAt`);
 * entities owned by another integration or created by hand are never touched.
 */
async function prune(integration: string, scopes: PruneScope[], batch: Batch, startedAt: string, stats: SyncStats, log: SyncLog) {
  const emitted = new Set(batch.upserts.map((p) => `${p.m.blueprint}/${p.m.identifier}`));
  const done = new Set<string>();
  for (const s of scopes) {
    const key = JSON.stringify([s.blueprint, s.relation, s.target]);
    if (done.has(key)) continue;
    done.add(key);
    const candidates = await all<{ blueprint: string; identifier: string }>(
      `SELECT e.blueprint, e.identifier FROM entities e
       JOIN entity_relations r ON r.org_id = e.org_id AND r.blueprint = e.blueprint AND r.identifier = e.identifier
       WHERE e.org_id = ? AND e.source = ? AND e.blueprint = ? AND e.updated_at <= ? AND r.relation = ? AND r.target_identifier = ?`,
      orgId(),
      entitySource(integration),
      s.blueprint,
      startedAt,
      s.relation,
      s.target,
    );
    const stale = candidates.filter((e) => !emitted.has(`${e.blueprint}/${e.identifier}`));
    if (!stale.length) continue;
    const res = await deleteEntities(stale, SYSTEM_ACTOR);
    stats.deleted += res.deleted;
    stats.skipped += res.refused.length;
    for (const x of res.refused) log.add(`NOT pruned ${x.blueprint}/${x.identifier}: ${x.error}`);
    log.add(`${res.deleted} ${s.blueprint} entities no longer in the delivery for ${s.relation}=${s.target} were pruned`);
  }
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
  if (!secret) return cfg.allowUnauthenticated === true; // anonymous only when the admin explicitly opted in
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
  const org = orgId();
  await run('DELETE FROM ingest_deliveries WHERE org_id = ? AND integration = ? AND delivery_id = ? AND received_at < ?', org, integration, deliveryId, cutoff);
  const { changes } = await run(
    'INSERT INTO ingest_deliveries (org_id, integration, delivery_id, received_at) VALUES (?, ?, ?, ?) ON CONFLICT (org_id, integration, delivery_id) DO NOTHING',
    org,
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
  const prunes: PruneScope[] = [];
  const startedAt = now();
  for (const item of items) for (const m of json<MappingDef[]>(r.mappings, [])) await processItem(m, item, bindings, stats, log, batch, prunes);
  await applyBatch(r.identifier, { priority: Number(r.priority ?? 0), primaryFor: json<string[]>(r.primary_for, []) }, batch, stats, log);
  if (prunes.length && !stats.failed) await prune(r.identifier, prunes, batch, startedAt, stats, log);
  const t = now();
  await run(
    'INSERT INTO sync_runs (id, org_id, integration, trigger, status, stats, logs, started_at, ended_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    newId(),
    orgId(),
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
      const next = nextCron(parseCron(r.schedule), Date.now());
      return next === undefined ? null : new Date(next).toISOString();
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
    // Across organizations; each sync runs in the organization of its integration.
    const due = await all<{
      org_id: string;
      identifier: string;
      type: string;
      next_sync_at: string;
      requested_kind: string | null;
      requested_scope: string | null;
    }>(
      `SELECT org_id, identifier, type, next_sync_at, requested_kind, requested_scope FROM integrations
       WHERE enabled = 1 AND next_sync_at IS NOT NULL AND next_sync_at <= ? AND (locked_until IS NULL OR locked_until < ?)
       ORDER BY next_sync_at LIMIT ?`,
      now(),
      now(),
      MAX_PARALLEL_SYNCS - running,
    );
    metrics.loopTick('syncs');
    for (const d of due) {
      if (getSource(d.type).push) {
        await run('UPDATE integrations SET next_sync_at = NULL WHERE org_id = ? AND identifier = ?', d.org_id, d.identifier);
        continue;
      }
      running++;
      withOrg(d.org_id, () =>
        runSync(d.identifier, d.next_sync_at === MANUAL ? 'manual' : 'schedule', {
          kind: d.requested_kind ?? undefined,
          scope: d.requested_scope ?? undefined,
        }),
      )
        .then((res) => res && log.info({ org: d.org_id, integration: d.identifier, status: res.status, stats: res.stats }, 'integration synced'))
        .catch((err) => log.error({ err, org: d.org_id, integration: d.identifier }, 'integration sync crashed'))
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
