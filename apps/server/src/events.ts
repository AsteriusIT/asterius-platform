import { all, json, newId, now, run, type Driver } from './db.js';
import { metrics } from './metrics.js';

/**
 * Domain events. Each event is written to the outbox (`deliveries`) once per matching outbound webhook;
 * workers deliver them with retries (webhooks/delivery.ts). Writing to the database rather than an in-memory
 * bus means no event is lost when a pod restarts and any replica can deliver.
 */

export type EventType = 'entity.created' | 'entity.updated' | 'entity.deleted' | 'run.created' | 'run.updated';

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

export function invalidateWebhookCache() {
  cache = undefined;
}

async function subscriptions(): Promise<Sub[]> {
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
 * connection while holding one) and return the function that writes the outbox rows.
 * Called with `d` (the caller's transaction) the inserts commit or roll back together with the write that caused the
 * event, and a failure propagates so that write fails too: the outbox exists so that no committed change loses its event.
 * Called without `d` (state already committed, e.g. run updates) enqueueing is best effort and failures are only logged.
 */
export async function prepareEvent(e: DomainEvent): Promise<(d?: Driver) => Promise<void>> {
  metrics.event(e.type);
  const subs = (await subscriptions()).filter((s) => eventMatches(s, e.type, e.blueprint));
  const payload = JSON.stringify({ id: newId(), type: e.type, at: now(), blueprint: e.blueprint, actor: e.actor?.email ?? null, data: e.data });
  const sql = "INSERT INTO deliveries (id, webhook, event, payload, status, next_attempt_at, created_at) VALUES (?, ?, ?, ?, 'pending', ?, ?)";
  return async (d) => {
    try {
      for (const s of subs) {
        const params = [newId(), s.identifier, e.type, payload, now(), now()];
        if (d) await d.query(sql, params);
        else await run(sql, ...params);
      }
    } catch (err) {
      if (d) throw err;
      console.error('[events] could not enqueue', e.type, err);
    }
  };
}

export async function emit(e: DomainEvent) {
  try {
    await (
      await prepareEvent(e)
    )();
  } catch (err) {
    console.error('[events] could not enqueue', e.type, err);
  }
}
