import { all, json, newId, now, run } from './db.js';
import { metrics } from './metrics.js';

/**
 * Domain events. Each event is written to the outbox (`deliveries`) once per matching outbound webhook;
 * workers deliver them with retries (webhooks/delivery.ts). Writing to the database rather than an in-memory
 * bus means no event is lost when a pod restarts and any replica can deliver.
 */

export type EventType = 'entity.created' | 'entity.updated' | 'entity.deleted' | 'run.created' | 'run.updated';

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

type Listener = (e: DomainEvent) => Promise<void>;
const listeners: Listener[] = [];

/** In-process subscribers (workflow event triggers). They run in the process that emits the event. */
export function onEvent(l: Listener) {
  listeners.push(l);
}

export async function emit(e: DomainEvent) {
  metrics.event(e.type);
  for (const l of listeners) await l(e).catch((err) => console.error('[events] listener failed', e.type, err));
  if (e.type === 'run.finished') return;
  try {
    const subs = (await subscriptions()).filter((s) => eventMatches(s, e.type, e.blueprint));
    if (!subs.length) return;
    const payload = JSON.stringify({ id: newId(), type: e.type, at: now(), blueprint: e.blueprint, actor: e.actor?.email ?? null, data: e.data });
    for (const s of subs)
      await run(
        "INSERT INTO deliveries (id, webhook, event, payload, status, next_attempt_at, created_at) VALUES (?, ?, ?, ?, 'pending', ?, ?)",
        newId(),
        s.identifier,
        e.type,
        payload,
        now(),
        now(),
      );
  } catch (err) {
    console.error('[events] could not enqueue', e.type, err);
  }
}
