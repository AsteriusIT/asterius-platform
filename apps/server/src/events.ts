import { all, json, newId, now, run, type Driver, type SqlValue } from './db.js';
import { metrics } from './metrics.js';
import { bumpConfigVersion, onConfigChange, syncCaches } from './lib/config-version.js';

/**
 * Domain events. Each event is written to the outbox (`deliveries`) once per matching outbound webhook;
 * workers deliver them with retries (webhooks/delivery.ts). Writing to the database rather than an in-memory
 * bus means no event is lost when a pod restarts and any replica can deliver.
 */

export type EventType = 'entity.created' | 'entity.updated' | 'entity.deleted' | 'run.created' | 'run.updated' | 'scorecard.changed';

export interface DomainEvent {
  type: EventType;
  blueprint: string | null;
  data: unknown;
  actor?: { id: string | null; email: string | null };
}

interface Sub {
  identifier: string;
  events: string[];
  blueprints: string[];
}

let cache: { at: number; subs: Sub[] } | undefined;
const CACHE_MS = 15_000;

onConfigChange(() => {
  cache = undefined;
});

/** A webhook definition changed: drop the local cache and tell the other replicas. */
export async function invalidateWebhookCache() {
  await bumpConfigVersion();
}

async function subscriptions(): Promise<Sub[]> {
  await syncCaches();
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.subs;
  const rows = await all<{ identifier: string; events: string; blueprints: string }>('SELECT identifier, events, blueprints FROM webhooks WHERE enabled = 1');
  const subs = rows.map((r) => ({ identifier: r.identifier, events: json<string[]>(r.events, []), blueprints: json<string[]>(r.blueprints, []) }));
  cache = { at: Date.now(), subs };
  return subs;
}

export const eventMatches = (sub: Pick<Sub, 'events' | 'blueprints'>, type: string, blueprint: string | null) =>
  sub.events.some((e) => e === '*' || e === type || (e.endsWith('.*') && type.startsWith(e.slice(0, -1)))) &&
  (!sub.blueprints.length || (blueprint !== null && sub.blueprints.includes(blueprint)));

/**
 * Resolve the matching webhooks now (a read, done before a transaction opens so it never needs a second pooled
 * connection while holding one) and return the function that writes the outbox rows (multi-row INSERTs).
 * Called with `d` (the caller's transaction) the inserts commit or roll back together with the write that caused the
 * events, and a failure propagates so that write fails too: the outbox exists so that no committed change loses its event.
 * Called without `d` (state already committed, e.g. run updates) enqueueing is best effort and failures are only logged.
 */
export async function prepareEvents(events: DomainEvent[]): Promise<(d?: Driver) => Promise<void>> {
  for (const e of events) metrics.event(e.type);
  const subs = await subscriptions();
  const rows: SqlValue[][] = [];
  for (const e of events) {
    const matching = subs.filter((s) => eventMatches(s, e.type, e.blueprint));
    if (!matching.length) continue;
    const payload = JSON.stringify({ id: newId(), type: e.type, at: now(), blueprint: e.blueprint, actor: e.actor?.email ?? null, data: e.data });
    for (const s of matching) rows.push([newId(), s.identifier, e.type, payload, 'pending', now(), now()]);
  }
  return async (d) => {
    try {
      for (let i = 0; i < rows.length; i += OUTBOX_CHUNK) {
        const chunk = rows.slice(i, i + OUTBOX_CHUNK);
        const sql = `INSERT INTO deliveries (id, webhook, event, payload, status, next_attempt_at, created_at) VALUES ${chunk.map(() => '(?, ?, ?, ?, ?, ?, ?)').join(', ')}`;
        if (d) await d.query(sql, chunk.flat());
        else await run(sql, ...chunk.flat());
      }
    } catch (err) {
      if (d) throw err;
      console.error('[events] could not enqueue', events[0]?.type, err);
    }
  };
}

export const prepareEvent = (e: DomainEvent) => prepareEvents([e]);

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
  } catch (err) {
    console.error('[events] could not enqueue', events[0]?.type, err);
  }
}
