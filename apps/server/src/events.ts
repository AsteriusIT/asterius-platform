import { all, json, newId, now, run, type Driver, type SqlValue } from './db.js';
import { evaluate } from './lib/expr.js';
import { componentLogger } from './logger.js';
import { metrics } from './metrics.js';
import { bumpConfigVersion, onConfigChange, syncCaches } from './lib/config-version.js';
import { getBlueprintCached } from './catalog/blueprints.js';
import { maybeOrgId } from './orgs/context.js';

/**
 * Domain events. Each event is written to the outbox (`deliveries`) once per matching outbound webhook;
 * workers deliver them with retries (webhooks/delivery.ts). Writing to the database rather than an in-memory
 * bus means no event is lost when a pod restarts and any replica can deliver.
 */

export type EventType =
  | 'entity.created'
  | 'entity.updated'
  | 'entity.deleted'
  | 'entity.expired'
  | 'run.created'
  | 'run.updated'
  | 'approval.requested'
  | 'approval.decided'
  | 'sync.finished'
  | 'sync.failed'
  | 'step.started'
  | 'step.finished'
  | 'step.sla_breached'
  | 'run.sla_breached'
  | 'team.created'
  | 'team.updated'
  | 'team.deleted'
  | 'user.created'
  | 'user.updated'
  | 'scorecard.changed';

/** `run.finished` is internal: it fires event triggers of workflows but is not offered to outbound webhooks. */
export interface DomainEvent {
  type: EventType | 'run.finished';
  blueprint: string | null;
  data: unknown;
  actor?: { id: string | null; email: string | null };
}

interface Sub {
  identifier: string;
  events: string[];
  blueprints: string[];
  filter: string | null;
  transform: string | null;
}

const log = componentLogger('events');

/** Subscriptions per organization, cached briefly (events of a sync come in thousands). */
const cache = new Map<string, { at: number; subs: Sub[] }>();
const CACHE_MS = 15_000;

onConfigChange(() => {
  cache.clear();
});

/** A webhook definition changed: drop the local cache and tell the other replicas. */
export async function invalidateWebhookCache() {
  await bumpConfigVersion();
}

async function subscriptions(org: string): Promise<Sub[]> {
  await syncCaches();
  const hit = cache.get(org);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.subs;
  const rows = await all<{ identifier: string; events: string; blueprints: string; filter: string | null; transform: string | null }>(
    'SELECT identifier, events, blueprints, filter, transform FROM webhooks WHERE org_id = ? AND enabled = 1',
    org,
  );
  const subs = rows.map((r) => ({
    identifier: r.identifier,
    events: json<string[]>(r.events, []),
    blueprints: json<string[]>(r.blueprints, []),
    filter: r.filter,
    transform: r.transform,
  }));
  cache.set(org, { at: Date.now(), subs });
  return subs;
}

export const eventMatches = (sub: Pick<Sub, 'events' | 'blueprints'>, type: string, blueprint: string | null) =>
  sub.events.some((e) => e === '*' || e === type || (e.endsWith('.*') && type.startsWith(e.slice(0, -1)))) &&
  (!sub.blueprints.length || (blueprint !== null && sub.blueprints.includes(blueprint)));

async function isReadRestricted(blueprint: string) {
  try {
    const r = (await getBlueprintCached(blueprint)).permissions?.read;
    return !!(r && (r.roles?.length || r.teams?.length || r.users?.length || r.ownerTeam));
  } catch {
    return false;
  }
}

/**
 * Resolve the matching webhooks now (a read, done before a transaction opens so it never needs a second pooled
 * connection while holding one) and return the function that writes the outbox rows (multi-row INSERTs).
 * Called with `d` (the caller's transaction) the inserts commit or roll back together with the write that caused the
 * events, and a failure propagates so that write fails too: the outbox exists so that no committed change loses its event.
 * Called without `d` (state already committed, e.g. run updates) enqueueing is best effort and failures are only logged.
 */
export async function prepareEvents(events: DomainEvent[]): Promise<(d?: Driver) => Promise<void>> {
  for (const e of events) metrics.event(e.type);
  // Platform-level events (accounts, outside any organization) have no organization webhooks.
  const org = maybeOrgId();
  if (!org) return async () => undefined;
  const subs = await subscriptions(org);
  const rows: SqlValue[][] = [];
  for (const e of events) {
    if (e.type === 'run.finished') continue; // internal: never offered to outbound webhooks
    // Blueprints with a read rule are never broadcast by wildcard subscriptions: a webhook must list them explicitly.
    const restricted = e.blueprint && e.type.startsWith('entity.') ? await isReadRestricted(e.blueprint) : false;
    const matching = subs.filter((s) => eventMatches(s, e.type, e.blueprint) && (!restricted || s.blueprints.includes(e.blueprint!)));
    if (!matching.length) continue;
    const event = { id: newId(), type: e.type, at: now(), blueprint: e.blueprint, actor: e.actor?.email ?? null, data: e.data };
    for (const s of matching) {
      let body: unknown = event;
      try {
        // JSON round trip: JSONata works on plain data (dates, undefined…).
        const plain = JSON.parse(JSON.stringify(event)) as unknown;
        if (s.filter && !(await evaluate(s.filter, plain))) continue;
        if (s.transform) {
          body = await evaluate(s.transform, plain);
          if (body === undefined || body === null) continue; // the transform chose not to send anything
        }
      } catch (err) {
        log.error({ err, webhook: s.identifier }, 'webhook filter/transform failed');
        continue;
      }
      rows.push([newId(), org, s.identifier, e.type, JSON.stringify(body), 'pending', now(), now()]);
    }
  }
  return async (d) => {
    try {
      for (let i = 0; i < rows.length; i += OUTBOX_CHUNK) {
        const chunk = rows.slice(i, i + OUTBOX_CHUNK);
        const sql = `INSERT INTO deliveries (id, org_id, webhook, event, payload, status, next_attempt_at, created_at) VALUES ${chunk.map(() => '(?, ?, ?, ?, ?, ?, ?, ?)').join(', ')}`;
        if (d) await d.query(sql, chunk.flat());
        else await run(sql, ...chunk.flat());
      }
    } catch (err) {
      if (d) throw err;
      log.error({ err, type: events[0]?.type }, 'could not enqueue event');
    }
  };
}

export const prepareEvent = (e: DomainEvent) => prepareEvents([e]);

type Listener = (e: DomainEvent) => Promise<void>;
const listeners: Listener[] = [];

/** In-process subscribers (workflow event triggers). They run in the process that emits the event, after the write committed. */
export function onEvent(l: Listener) {
  listeners.push(l);
}

/** Run the in-process subscribers. Callers that wrote through `prepareEvents` + a transaction call this after the commit. */
export async function notifyListeners(events: DomainEvent[]) {
  for (const e of events) for (const l of listeners) await l(e).catch((err) => log.error({ err, type: e.type }, 'event listener failed'));
}

const OUTBOX_CHUNK = 100;

export async function emit(e: DomainEvent) {
  await emitMany([e]);
}

/** Enqueue several events with one subscription lookup. Never throws: events are best-effort. */
export async function emitMany(events: DomainEvent[]) {
  try {
    await (
      await prepareEvents(events)
    )();
    await notifyListeners(events);
  } catch (err) {
    log.error({ err, type: events[0]?.type }, 'could not enqueue event');
  }
}
