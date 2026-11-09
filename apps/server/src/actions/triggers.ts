import { beat, registerLoop } from '../health.js';
import type { FastifyBaseLogger } from 'fastify';
import type { Action, Entity } from '@asterius/shared';
import { all, json, later, newId, now, one, run } from '../db.js';
import { conflict, errorMessage, HttpError, notFound } from '../lib/errors.js';
import { evaluate, render } from '../lib/expr.js';
import { onEvent, type DomainEvent } from '../events.js';
import { scopedResolver } from './limits.js';
import { verifyWebhook } from '../integrations/sync.js';
import { startAutomatedRun, type RunSource } from './runs.js';
import { getAction } from './actions.js';
import { nextTick } from './trigger-defs.js';
import { activeBlackout } from './blackouts.js';
import { nextCron, parseCron } from '../lib/cron.js';
import { searchEntities } from '../catalog/entities.js';
import { audit, SYSTEM } from '../audit.js';
import type { WorkflowTriggerDef } from '../schemas.js';
import { maybeOrgId, orgId, withOrg } from '../orgs/context.js';

/**
 * Automatic workflow triggers (everything but forms):
 *  - schedule: `fireDueSchedules` runs on every worker; a tick is claimed with a conditional UPDATE of
 *    `actions.next_fire_at`, so exactly one replica starts the run;
 *  - event: catalog events and finished runs, matched in the process that emits them (see events.ts);
 *  - webhook: `POST /api/v1/hooks/:org/:action` (`/hooks/:action`: the default organization), authenticated with the
 *    trigger's secret.
 * Schedules are found across organizations; each run starts in the organization of its action.
 *
 * Schedules may catch up missed ticks (`catchUp`) and fan out over entities (`entities`): the claim of
 * `next_fire_at` covers every tick up to now, and each run carries a deterministic idempotency key
 * (`schedule:<tick>[:<entity>]`), so a tick never starts twice. During a blackout window of the action, automated
 * starts are skipped (audited) or deferred (`deferred_starts`, started by `fireDeferred` once the window ends).
 */

type Trigger<T extends WorkflowTriggerDef['type']> = Extract<WorkflowTriggerDef, { type: T }>;

const noSecrets = async () => {
  throw new Error('Secret references are not allowed in trigger inputs');
};

async function renderInputs(inputs: Record<string, unknown>, ctx: unknown): Promise<Record<string, unknown>> {
  return (await render(inputs, ctx, noSecrets)).value as Record<string, unknown>;
}

async function renderEntity(template: string | undefined, ctx: unknown): Promise<string | null> {
  if (!template) return null;
  const v = (await render(template, ctx, noSecrets)).value;
  return v == null || v === '' ? null : String(v as string | number);
}

// ---------- blackouts ----------
interface StartOpts {
  blueprint?: string | null;
  entity?: string | null;
  inputs: Record<string, unknown>;
  source: RunSource;
  idempotencyKey?: string;
}
type StartResult = { runId: string } | { skipped: string } | { deferredUntil: string } | { duplicate: true };

const isDuplicate = (err: unknown, o: StartOpts) => !!o.idempotencyKey && err instanceof HttpError && err.statusCode === 409;

/**
 * Start an automated run unless the action is in a blackout window: then skip it (audited) or, with
 * `blackoutMode: defer`, hold it in `deferred_starts` until the window ends. `action` is preloaded by fan-outs.
 */
async function startOrHold(actionId: string, o: StartOpts, action?: Action): Promise<StartResult> {
  const a = action ?? (await getAction(actionId));
  const blackout = activeBlackout(a.blackouts);
  if (blackout) {
    const detail = { blackout: blackout.name, until: blackout.until, source: o.source.type, ...(o.entity ? { entity: o.entity } : {}) };
    if (a.blackoutMode === 'defer') {
      const key = o.idempotencyKey ?? `deferred:${newId()}`;
      await run(
        'INSERT INTO deferred_starts (id, org_id, action, dedupe_key, payload, due_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING',
        newId(),
        orgId(),
        actionId,
        key,
        JSON.stringify({ ...o, idempotencyKey: key }),
        blackout.until,
        now(),
      );
      await audit(SYSTEM, 'run.deferred', actionId, detail);
      return { deferredUntil: blackout.until };
    }
    await audit(SYSTEM, 'run.skipped', actionId, detail);
    return { skipped: blackout.name };
  }
  try {
    return { runId: await startAutomatedRun(actionId, o) };
  } catch (err) {
    if (isDuplicate(err, o)) return { duplicate: true };
    throw err;
  }
}

/** Start the deferred runs whose blackout ended (any replica: claimed with a lease on `due_at`). */
export async function fireDeferred(log?: Pick<FastifyBaseLogger, 'error' | 'info'>) {
  const due = await all<{ id: string; org_id: string; action: string; payload: string; due_at: string }>(
    'SELECT id, org_id, action, payload, due_at FROM deferred_starts WHERE due_at <= ? ORDER BY due_at LIMIT 100',
    now(),
  );
  let started = 0;
  for (const d of due) {
    // Lease: a replica that dies half way leaves the row to be retried later (the idempotency key prevents doubles).
    const { changes } = await run('UPDATE deferred_starts SET due_at = ? WHERE id = ? AND due_at = ?', later(5 * 60_000), d.id, d.due_at);
    if (!changes) continue;
    await withOrg(d.org_id, async () => {
      const o = json<StartOpts>(d.payload, { inputs: {}, source: { type: 'schedule' } });
      try {
        const action = await getAction(d.action).catch(() => null);
        if (!action?.enabled) {
          await run('DELETE FROM deferred_starts WHERE id = ?', d.id);
          return;
        }
        const blackout = activeBlackout(action.blackouts);
        if (blackout && action.blackoutMode === 'defer') {
          await run('UPDATE deferred_starts SET due_at = ? WHERE id = ?', blackout.until, d.id); // another window followed
          return;
        }
        const res = await startOrHold(d.action, { ...o, source: { ...o.source, info: { ...o.source.info, deferred: true } } }, action);
        await run('DELETE FROM deferred_starts WHERE id = ?', d.id);
        if ('runId' in res) {
          started++;
          log?.info({ org: d.org_id, action: d.action, runId: res.runId }, 'deferred run started');
        }
      } catch (err) {
        log?.error({ err, org: d.org_id, action: d.action }, 'deferred run could not start');
      }
    });
  }
  return started;
}

// ---------- schedule ----------
/** catchUp: all only replays ticks of this window. */
export const CATCH_UP_WINDOW_MS = 7 * 86_400_000;
const MAX_TICK_SCAN = 20_000;
const MAX_FANOUT_SCAN = 10_000;

/**
 * The ticks a claim of `next_fire_at` (the oldest due tick) at `nowMs` starts runs for:
 *  - none: the claimed tick only (the others are dropped);
 *  - last: the most recent tick up to now;
 *  - all: every tick up to now within the catch-up window, at most `maxCatchUp` (the most recent).
 */
export function dueTicks(t: Trigger<'schedule'>, nextFireAt: string, nowMs: number): string[] {
  const mode = t.catchUp ?? 'none';
  if (mode === 'none') return [nextFireAt];
  const max = mode === 'last' ? 1 : (t.maxCatchUp ?? 10);
  const spec = parseCron(t.cron);
  const ticks: number[] = [];
  // nextCron is strictly after its start: start one millisecond before the claimed tick to include it.
  let at = nextCron(spec, Math.max(Date.parse(nextFireAt), nowMs - CATCH_UP_WINDOW_MS) - 1, t.timezone);
  for (let i = 0; at !== undefined && at <= nowMs && i < MAX_TICK_SCAN; i++) {
    ticks.push(at);
    if (ticks.length > max) ticks.shift();
    at = nextCron(spec, at, t.timezone);
  }
  // `last`: nothing in the window (a rare schedule, missed long ago) still runs the claimed tick.
  if (!ticks.length) return mode === 'last' ? [nextFireAt] : [];
  return ticks.map((x) => new Date(x).toISOString());
}

/** Entities a fan-out schedule runs on: the blueprint's entities (by identifier) passing the filter, bounded. */
async function fanOutEntities(f: NonNullable<Trigger<'schedule'>['entities']>, schedule: object): Promise<Entity[]> {
  const limit = f.limit ?? 200;
  const out: Entity[] = [];
  let cursor: string | undefined;
  for (let scanned = 0; out.length < limit && scanned < MAX_FANOUT_SCAN;) {
    const page = await searchEntities({ blueprint: f.blueprint, sort: 'identifier', dir: 'asc', limit: 500, offset: 0, cursor, count: false });
    for (const e of page.items) {
      scanned++;
      if (f.filter && !(await evaluate(f.filter, { entity: e, schedule }))) continue;
      out.push(e);
      if (out.length >= limit) break;
    }
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }
  return out;
}

type Log = Pick<FastifyBaseLogger, 'error' | 'info'>;

/** The runs of one tick (one, or one per entity of a fan-out); returns how many started. */
async function fireTick(actionId: string, trig: Trigger<'schedule'>, tick: string, log?: Log): Promise<number> {
  const schedule = { at: tick, cron: trig.cron, timezone: trig.timezone };
  const info = { cron: trig.cron, tick };
  if (!trig.entities) {
    const res = await startOrHold(actionId, {
      inputs: await renderInputs(trig.inputs, { schedule }),
      source: { type: 'schedule', info },
      idempotencyKey: `schedule:${tick}`,
    });
    if (!('runId' in res)) return 0;
    log?.info({ org: orgId(), action: actionId, runId: res.runId, tick }, 'scheduled run started');
    return 1;
  }
  const action = await getAction(actionId);
  const blackout = activeBlackout(action.blackouts);
  if (blackout && action.blackoutMode !== 'defer') {
    // One audit entry for the whole tick rather than one per entity.
    await audit(SYSTEM, 'run.skipped', actionId, { blackout: blackout.name, until: blackout.until, source: 'schedule', tick });
    return 0;
  }
  const { blueprint } = trig.entities;
  let started = 0;
  for (const e of await fanOutEntities(trig.entities, schedule)) {
    try {
      const res = await startOrHold(
        actionId,
        {
          blueprint,
          entity: e.identifier,
          inputs: await renderInputs(trig.inputs, { schedule, entity: e }),
          source: { type: 'schedule', info: { ...info, entity: e.identifier } },
          idempotencyKey: `schedule:${tick}:${e.identifier}`,
        },
        action,
      );
      if ('runId' in res) started++;
    } catch (err) {
      log?.error({ err, org: orgId(), action: actionId, entity: e.identifier }, 'scheduled run could not start');
    }
  }
  log?.info({ org: orgId(), action: actionId, tick, started }, 'scheduled fan-out started');
  return started;
}

export async function fireDueSchedules(log?: Log) {
  const due = await all<{ org_id: string; identifier: string; trigger_config: string; next_fire_at: string }>(
    'SELECT org_id, identifier, trigger_config, next_fire_at FROM actions WHERE enabled = 1 AND next_fire_at IS NOT NULL AND next_fire_at <= ? ORDER BY next_fire_at LIMIT 50',
    now(),
  );
  let started = 0;
  for (const d of due) {
    const trig = json<Trigger<'schedule'> | null>(d.trigger_config, null);
    if (trig?.type !== 'schedule') continue;
    const nowMs = Date.now();
    // Whoever moves next_fire_at forward owns every tick up to now, whatever the number of replicas.
    const { changes } = await run(
      'UPDATE actions SET next_fire_at = ? WHERE org_id = ? AND identifier = ? AND next_fire_at = ?',
      nextTick(trig, nowMs),
      d.org_id,
      d.identifier,
      d.next_fire_at,
    );
    if (!changes) continue;
    for (const tick of dueTicks(trig, d.next_fire_at, nowMs)) {
      try {
        started += await withOrg(d.org_id, () => fireTick(d.identifier, trig, tick, log));
      } catch (err) {
        log?.error({ err, org: d.org_id, action: d.identifier, tick }, 'scheduled run could not start');
      }
    }
  }
  return started;
}

export function startTriggerScheduler(log: FastifyBaseLogger) {
  const timer = setInterval(
    () =>
      fireDueSchedules(log)
        .then(() => fireDeferred(log))
        .catch((err) => log.error({ err }, 'schedule tick failed'))
        .finally(() => beat('trigger-scheduler')),
    15_000,
  );
  timer.unref();
  const unregister = registerLoop('trigger-scheduler', 180_000);
  return () => {
    clearInterval(timer);
    unregister();
  };
}

// ---------- events ----------
const MAX_EVENT_DEPTH = 3;
const MAX_EVENT_RUNS_PER_MINUTE = 30;
const CACHE_MS = 5_000;
/** Event-triggered actions per organization (events are emitted in the organization of the change). */
const cache = new Map<string, { at: number; actions: { identifier: string; trigger: Trigger<'event'> }[] }>();

export const invalidateTriggerCache = () => {
  cache.clear();
};

async function eventActions() {
  const org = orgId();
  const hit = cache.get(org);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.actions;
  const rows = await all<{ identifier: string; trigger_config: string }>(
    "SELECT identifier, trigger_config FROM actions WHERE org_id = ? AND enabled = 1 AND trigger = 'event'",
    org,
  );
  const actions = rows.flatMap((r) => {
    const trigger = json<Trigger<'event'> | null>(r.trigger_config, null);
    return trigger?.type === 'event' ? [{ identifier: r.identifier, trigger }] : [];
  });
  cache.set(org, { at: Date.now(), actions });
  return actions;
}

interface RunData {
  run?: { action?: string; trigger?: { type?: string; depth?: number } };
  entity?: { identifier?: string };
}

async function onDomainEvent(e: DomainEvent) {
  if (!maybeOrgId()) return; // platform-level events (accounts) start no workflow
  const data = (e.data ?? {}) as RunData;
  const finishedRun = e.type === 'run.finished' ? data.run : undefined;
  const depth = (finishedRun?.trigger?.type === 'event' ? (finishedRun.trigger.depth ?? 0) : 0) + 1;
  for (const { identifier, trigger } of await eventActions()) {
    if (trigger.event !== e.type) continue;
    if (e.type === 'run.finished' ? trigger.action && trigger.action !== finishedRun?.action : trigger.blueprint && trigger.blueprint !== e.blueprint) continue;
    // Loops (an action reacting to its own effects) are cut by a depth limit on run chains and by a rate limit.
    if (depth > MAX_EVENT_DEPTH) continue;
    const recent = await one<{ n: number }>(
      "SELECT count(*) AS n FROM runs WHERE org_id = ? AND action = ? AND trigger_type = 'event' AND created_at > ?",
      orgId(),
      identifier,
      new Date(Date.now() - 60_000).toISOString(),
    );
    if (Number(recent?.n ?? 0) >= MAX_EVENT_RUNS_PER_MINUTE) {
      console.warn(`[triggers] ${identifier}: more than ${MAX_EVENT_RUNS_PER_MINUTE} event-triggered runs per minute, event ignored`);
      continue;
    }
    try {
      const ctx = { event: { type: e.type, blueprint: e.blueprint, actor: e.actor?.email ?? null, ...data } };
      if (trigger.filter && !(await evaluate(trigger.filter, ctx))) continue;
      const entity =
        (await renderEntity(
          trigger.entity ??
            ((e.type.startsWith('entity.') || e.type === 'scorecard.changed') && trigger.blueprint ? '{{ event.entity.identifier }}' : undefined),
          ctx,
        )) ?? null;
      await startOrHold(identifier, {
        blueprint: trigger.blueprint,
        entity: e.type === 'entity.deleted' ? null : entity, // the entity is gone: pass its identifier through the inputs
        inputs: await renderInputs(trigger.inputs, ctx),
        source: { type: 'event', info: { event: e.type, depth, ...(entity ? { entity } : {}) } },
      });
    } catch (err) {
      console.error(`[triggers] ${identifier} could not start on ${e.type}: ${errorMessage(err)}`);
    }
  }
}

let registered = false;
/** Subscribe event triggers to the domain events of this process (idempotent). */
export function registerTriggerListeners() {
  if (registered) return;
  registered = true;
  onEvent(onDomainEvent);
}

// ---------- inbound webhook (in the organization of the request) ----------
export async function receiveWebhook(
  actionId: string,
  req: { headers: Record<string, string | string[] | undefined>; rawBody: string; body: unknown; query: unknown },
): Promise<{ runId: string | null; skipped?: string; deferredUntil?: string }> {
  const row = await one<{ identifier: string; trigger_config: string | null; enabled: number; allowed_secrets: string | null }>(
    "SELECT identifier, trigger_config, enabled, allowed_secrets FROM actions WHERE org_id = ? AND identifier = ? AND trigger = 'webhook'",
    orgId(),
    actionId,
  );
  const trig = json<Trigger<'webhook'> | null>(row?.trigger_config, null);
  if (!row || trig?.type !== 'webhook') throw notFound('Webhook trigger');
  if (!row.enabled) throw conflict('This workflow is disabled');
  const secret = String((await render(trig.secret, {}, scopedResolver(json<string[] | null>(row.allowed_secrets, null)))).value ?? '');
  if (!secret) throw Object.assign(new Error('The webhook secret is not configured'), { statusCode: 503 });
  if (!verifyWebhook({ secret, signatureHeader: trig.signatureHeader }, req.headers, req.rawBody))
    throw Object.assign(new Error('invalid signature or token'), { statusCode: 401 });
  const headers = Object.fromEntries(Object.entries(req.headers).filter(([k]) => !['authorization', 'cookie', 'x-asterius-token'].includes(k)));
  const ctx = { body: req.body ?? null, headers, query: req.query ?? {} };
  const entity = await renderEntity(trig.entity, ctx);
  const res = await startOrHold(row.identifier, {
    blueprint: trig.blueprint,
    entity,
    inputs: await renderInputs(trig.inputs, ctx),
    source: { type: 'webhook', info: { ...(entity ? { entity } : {}) } },
  });
  // During a blackout the delivery is accepted (202) but starts nothing now.
  if ('runId' in res) return { runId: res.runId };
  return { runId: null, ...('duplicate' in res ? {} : res) };
}
