import { beat, registerLoop } from '../health.js';
import type { FastifyBaseLogger } from 'fastify';
import { all, json, now, one, run } from '../db.js';
import { conflict, errorMessage, notFound } from '../lib/errors.js';
import { evaluate, render } from '../lib/expr.js';
import { onEvent, type DomainEvent } from '../events.js';
import { scopedResolver } from './limits.js';
import { verifyWebhook } from '../integrations/sync.js';
import { startAutomatedRun } from './runs.js';
import { nextTick } from './trigger-defs.js';
import type { WorkflowTriggerDef } from '../schemas.js';

/**
 * Automatic workflow triggers (everything but forms):
 *  - schedule: `fireDueSchedules` runs on every worker; a tick is claimed with a conditional UPDATE of
 *    `actions.next_fire_at`, so exactly one replica starts the run;
 *  - event: catalog events and finished runs, matched in the process that emits them (see events.ts);
 *  - webhook: `POST /api/v1/hooks/:action`, authenticated with the trigger's secret.
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

// ---------- schedule ----------
export async function fireDueSchedules(log?: Pick<FastifyBaseLogger, 'error' | 'info'>) {
  const t = now();
  const due = await all<{ identifier: string; trigger_config: string; next_fire_at: string }>(
    'SELECT identifier, trigger_config, next_fire_at FROM actions WHERE enabled = 1 AND next_fire_at IS NOT NULL AND next_fire_at <= ? ORDER BY next_fire_at LIMIT 50',
    t,
  );
  let started = 0;
  for (const d of due) {
    const trig = json<Trigger<'schedule'> | null>(d.trigger_config, null);
    if (trig?.type !== 'schedule') continue;
    // One run per tick, whatever the number of replicas or missed ticks: whoever moves next_fire_at forward owns the tick.
    const { changes } = await run(
      'UPDATE actions SET next_fire_at = ? WHERE identifier = ? AND next_fire_at = ?',
      nextTick(trig),
      d.identifier,
      d.next_fire_at,
    );
    if (!changes) continue;
    try {
      const inputs = await renderInputs(trig.inputs, { schedule: { at: d.next_fire_at, cron: trig.cron, timezone: trig.timezone } });
      const id = await startAutomatedRun(d.identifier, { inputs, source: { type: 'schedule', info: { cron: trig.cron, tick: d.next_fire_at } } });
      started++;
      log?.info({ action: d.identifier, runId: id }, 'scheduled run started');
    } catch (err) {
      log?.error({ err, action: d.identifier }, 'scheduled run could not start');
    }
  }
  return started;
}

export function startTriggerScheduler(log: FastifyBaseLogger) {
  const timer = setInterval(
    () =>
      fireDueSchedules(log)
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
let cache: { at: number; actions: { identifier: string; trigger: Trigger<'event'> }[] } | undefined;

export const invalidateTriggerCache = () => {
  cache = undefined;
};

async function eventActions() {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.actions;
  const rows = await all<{ identifier: string; trigger_config: string }>(
    "SELECT identifier, trigger_config FROM actions WHERE enabled = 1 AND trigger = 'event'",
  );
  const actions = rows.flatMap((r) => {
    const trigger = json<Trigger<'event'> | null>(r.trigger_config, null);
    return trigger?.type === 'event' ? [{ identifier: r.identifier, trigger }] : [];
  });
  cache = { at: Date.now(), actions };
  return actions;
}

interface RunData {
  run?: { action?: string; trigger?: { type?: string; depth?: number } };
  entity?: { identifier?: string };
}

async function onDomainEvent(e: DomainEvent) {
  const data = (e.data ?? {}) as RunData;
  const finishedRun = e.type === 'run.finished' ? data.run : undefined;
  const depth = (finishedRun?.trigger?.type === 'event' ? (finishedRun.trigger.depth ?? 0) : 0) + 1;
  for (const { identifier, trigger } of await eventActions()) {
    if (trigger.event !== e.type) continue;
    if (e.type === 'run.finished' ? trigger.action && trigger.action !== finishedRun?.action : trigger.blueprint && trigger.blueprint !== e.blueprint) continue;
    // Loops (an action reacting to its own effects) are cut by a depth limit on run chains and by a rate limit.
    if (depth > MAX_EVENT_DEPTH) continue;
    const recent = await one<{ n: number }>(
      "SELECT count(*) AS n FROM runs WHERE action = ? AND trigger_type = 'event' AND created_at > ?",
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
      await startAutomatedRun(identifier, {
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

// ---------- inbound webhook ----------
export async function receiveWebhook(
  actionId: string,
  req: { headers: Record<string, string | string[] | undefined>; rawBody: string; body: unknown; query: unknown },
): Promise<{ runId: string }> {
  const row = await one<{ identifier: string; trigger_config: string | null; enabled: number; allowed_secrets: string | null }>(
    "SELECT identifier, trigger_config, enabled, allowed_secrets FROM actions WHERE identifier = ? AND trigger = 'webhook'",
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
  const runId = await startAutomatedRun(row.identifier, {
    blueprint: trig.blueprint,
    entity,
    inputs: await renderInputs(trig.inputs, ctx),
    source: { type: 'webhook', info: { ...(entity ? { entity } : {}) } },
  });
  return { runId };
}
