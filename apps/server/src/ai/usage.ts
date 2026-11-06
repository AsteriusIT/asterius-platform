import { z } from 'zod';
import { config } from '../config.js';
import { all, newId, now, one, run, type SqlValue } from '../db.js';
import { badRequest } from '../lib/errors.js';

/**
 * AI cost governance: every model call is recorded in `llm_usage` (successful or not), prices come from the
 * database, then AI_PRICES, then a built-in table, and budgets (action, team, global, per run) are checked before each call.
 */

export interface Price {
  /** $ per million tokens. */
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}

export const priceSchema = z.object({
  input: z.number().min(0),
  output: z.number().min(0),
  cacheWrite: z.number().min(0).optional(),
  cacheRead: z.number().min(0).optional(),
});

const withCacheRates = (p: z.infer<typeof priceSchema>): Price => ({
  input: p.input,
  output: p.output,
  cacheWrite: p.cacheWrite ?? p.input * 1.25,
  cacheRead: p.cacheRead ?? p.input * 0.1,
});

/** Built-in fallback ($ / MTok). Override with AI_PRICES or the admin API. */
const FALLBACK: Record<string, z.infer<typeof priceSchema>> = {
  'claude-fable-5-1': { input: 10, output: 50 },
  'claude-opus-5-5': { input: 4, output: 20 },
  'claude-opus-5': { input: 4, output: 20 },
  'claude-sonnet-5-5': { input: 2, output: 10 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5 },
};

function envPrices(): Record<string, z.infer<typeof priceSchema>> {
  if (!config.AI_PRICES) return {};
  try {
    return z.record(z.string(), priceSchema).parse(JSON.parse(config.AI_PRICES));
  } catch {
    console.warn('[ai] AI_PRICES is not valid JSON of {model: {input, output, cacheWrite?, cacheRead?}}: ignored');
    return {};
  }
}

export async function priceOf(model: string): Promise<Price | undefined> {
  const row = await one<{ input: number; output: number; cache_write: number; cache_read: number }>('SELECT * FROM ai_prices WHERE model = ?', model);
  if (row) return { input: Number(row.input), output: Number(row.output), cacheWrite: Number(row.cache_write), cacheRead: Number(row.cache_read) };
  const p = envPrices()[model] ?? FALLBACK[model];
  return p ? withCacheRates(p) : undefined;
}

export async function listPrices(): Promise<(Price & { model: string; source: 'database' | 'config' | 'builtin' })[]> {
  const out = new Map<string, Price & { model: string; source: 'database' | 'config' | 'builtin' }>();
  for (const [model, p] of Object.entries(FALLBACK)) out.set(model, { model, ...withCacheRates(p), source: 'builtin' });
  for (const [model, p] of Object.entries(envPrices())) out.set(model, { model, ...withCacheRates(p), source: 'config' });
  for (const r of await all<{ model: string; input: number; output: number; cache_write: number; cache_read: number }>('SELECT * FROM ai_prices'))
    out.set(r.model, {
      model: r.model,
      input: Number(r.input),
      output: Number(r.output),
      cacheWrite: Number(r.cache_write),
      cacheRead: Number(r.cache_read),
      source: 'database',
    });
  return [...out.values()].sort((a, b) => a.model.localeCompare(b.model));
}

export async function setPrice(model: string, raw: unknown) {
  const p = withCacheRates(priceSchema.parse(raw));
  await run('DELETE FROM ai_prices WHERE model = ?', model);
  await run(
    'INSERT INTO ai_prices (model, input, output, cache_write, cache_read) VALUES (?, ?, ?, ?, ?)',
    model,
    p.input,
    p.output,
    p.cacheWrite,
    p.cacheRead,
  );
}

export async function deletePrice(model: string) {
  await run('DELETE FROM ai_prices WHERE model = ?', model);
}

export interface Tokens {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}

/** Cost in dollars, or null when the model has no known price. */
export function costOf(price: Price | undefined, t: Tokens): number | null {
  if (!price) return null;
  return (t.input * price.input + t.output * price.output + t.cacheWrite * price.cacheWrite + t.cacheRead * price.cacheRead) / 1e6;
}

export type UsageKind = 'agent' | 'assist' | 'authoring' | 'review';
export type UsageOutcome = 'success' | 'error' | 'refused' | 'truncated' | 'budget';

/** Who a call is made for. */
export interface UsageScope {
  kind: UsageKind;
  runId?: string | null;
  stepId?: string | null;
  action?: string | null;
  team?: string | null;
  userId?: string | null;
}

export interface UsageRecord extends UsageScope {
  model: string;
  tokens: Tokens;
  costUsd: number | null;
  outcome: UsageOutcome;
  error?: string;
}

export const ZERO_TOKENS: Tokens = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };

export async function recordUsage(u: UsageRecord) {
  await run(
    `INSERT INTO llm_usage (id, at, kind, run_id, step_id, action, team, user_id, model, input_tokens, output_tokens, cache_write_tokens, cache_read_tokens, cost_usd, outcome, error)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    newId(),
    now(),
    u.kind,
    u.runId ?? null,
    u.stepId ?? null,
    u.action ?? null,
    u.team ?? null,
    u.userId ?? null,
    u.model,
    u.tokens.input,
    u.tokens.output,
    u.tokens.cacheWrite,
    u.tokens.cacheRead,
    u.costUsd,
    u.outcome,
    u.error ? u.error.slice(0, 500) : null,
  );
}

// ---------- budgets ----------
export const BUDGET_SCOPES = ['global', 'action', 'team', 'run'] as const;
export type BudgetScope = (typeof BUDGET_SCOPES)[number];

export const budgetSchema = z.object({
  scope: z.enum(BUDGET_SCOPES),
  /** Action or team identifier; `*` for global and run budgets. */
  key: z.string().min(1).max(100).default('*'),
  /** A warning is logged above this amount (null: none). `run` budgets are per run, the others per calendar month. */
  softUsd: z.number().min(0).nullish(),
  /** Calls are refused above this amount (null: none). */
  hardUsd: z.number().min(0).nullish(),
});
export type Budget = z.infer<typeof budgetSchema> & { id: string };

interface BudgetRow {
  id: string;
  scope: BudgetScope;
  key: string;
  soft_usd: number | null;
  hard_usd: number | null;
}
const toBudget = (r: BudgetRow): Budget => ({
  id: r.id,
  scope: r.scope,
  key: r.key,
  softUsd: r.soft_usd === null ? null : Number(r.soft_usd),
  hardUsd: r.hard_usd === null ? null : Number(r.hard_usd),
});

export async function listBudgets(): Promise<Budget[]> {
  return (await all<BudgetRow>('SELECT * FROM ai_budgets ORDER BY scope, key')).map(toBudget);
}

export async function upsertBudget(raw: unknown): Promise<Budget> {
  const b = budgetSchema.parse(raw);
  if (b.softUsd != null && b.hardUsd != null && b.softUsd > b.hardUsd) throw badRequest('The soft limit cannot exceed the hard limit');
  const key = b.scope === 'global' || b.scope === 'run' ? '*' : b.key;
  if (key === '*' && (b.scope === 'action' || b.scope === 'team')) throw badRequest(`A ${b.scope} budget needs the ${b.scope} identifier as key`);
  const existing = await one<BudgetRow>('SELECT * FROM ai_budgets WHERE scope = ? AND key = ?', b.scope, key);
  const id = existing?.id ?? newId();
  if (existing) await run('UPDATE ai_budgets SET soft_usd = ?, hard_usd = ? WHERE id = ?', b.softUsd ?? null, b.hardUsd ?? null, id);
  else await run('INSERT INTO ai_budgets (id, scope, key, soft_usd, hard_usd) VALUES (?, ?, ?, ?, ?)', id, b.scope, key, b.softUsd ?? null, b.hardUsd ?? null);
  return { id, scope: b.scope, key, softUsd: b.softUsd ?? null, hardUsd: b.hardUsd ?? null };
}

export async function deleteBudget(id: string) {
  await run('DELETE FROM ai_budgets WHERE id = ?', id);
}

export const monthStart = (d = new Date()) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString();

async function spent(scope: BudgetScope, key: string, runId?: string | null): Promise<number> {
  const where: string[] = [];
  const params: SqlValue[] = [];
  if (scope === 'run') {
    if (!runId) return 0;
    where.push('run_id = ?');
    params.push(runId);
  } else {
    where.push('at >= ?');
    params.push(monthStart());
    if (scope === 'action' || scope === 'team') {
      where.push(`${scope} = ?`);
      params.push(key);
    }
  }
  const r = await one<{ s: number | null }>(`SELECT COALESCE(SUM(cost_usd), 0) AS s FROM llm_usage WHERE ${where.join(' AND ')}`, ...params);
  return Number(r?.s ?? 0);
}

export class BudgetExceeded extends Error {}

/**
 * Called before each model call. Throws BudgetExceeded above a hard limit; returns warnings above soft limits.
 * Totals are read from llm_usage, so every replica sees the same spend (concurrent calls may overshoot by one call).
 */
export async function checkBudgets(scope: UsageScope, extraRunHardUsd?: number): Promise<string[]> {
  const checks: { scope: BudgetScope; key: string; label: string }[] = [
    { scope: 'global', key: '*', label: 'platform monthly AI budget' },
    { scope: 'run', key: '*', label: 'per-run AI budget' },
  ];
  if (scope.action) checks.push({ scope: 'action', key: scope.action, label: `monthly AI budget of action "${scope.action}"` });
  if (scope.team) checks.push({ scope: 'team', key: scope.team, label: `monthly AI budget of team "${scope.team}"` });
  const budgets = await all<BudgetRow>('SELECT * FROM ai_budgets WHERE scope IN (?, ?, ?, ?)', 'global', 'run', 'action', 'team');
  const warnings: string[] = [];
  for (const c of checks) {
    const b = budgets.find((x) => x.scope === c.scope && x.key === c.key);
    let hard = b?.hard_usd == null ? null : Number(b.hard_usd);
    if (c.scope === 'run' && extraRunHardUsd !== undefined) hard = hard === null ? extraRunHardUsd : Math.min(hard, extraRunHardUsd);
    const soft = b?.soft_usd == null ? null : Number(b.soft_usd);
    if (hard === null && soft === null) continue;
    const total = await spent(c.scope, c.key, scope.runId);
    if (hard !== null && total >= hard)
      throw new BudgetExceeded(`AI budget exceeded: $${total.toFixed(2)} spent against the ${c.label} hard limit of $${hard.toFixed(2)}`);
    if (soft !== null && total >= soft) warnings.push(`AI spend $${total.toFixed(2)} passed the soft limit of $${soft.toFixed(2)} (${c.label})`);
  }
  return warnings;
}

// ---------- reports ----------
export interface UsageReport {
  since: string;
  totals: { calls: number; costUsd: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; failed: number };
  byModel: { model: string; calls: number; costUsd: number }[];
  byAction: { key: string | null; calls: number; costUsd: number }[];
  byTeam: { key: string | null; calls: number; costUsd: number }[];
  byDay: { day: string; costUsd: number }[];
}

export async function usageReport(since = monthStart()): Promise<UsageReport> {
  const group = (col: string) =>
    all<{ key: string | null; calls: number; cost: number | null }>(
      `SELECT ${col} AS key, count(*) AS calls, COALESCE(SUM(cost_usd), 0) AS cost FROM llm_usage WHERE at >= ? GROUP BY ${col} ORDER BY cost DESC LIMIT 50`,
      since,
    );
  const [t] = await all<{ calls: number; cost: number; i: number; o: number; cr: number; cw: number; failed: number }>(
    `SELECT count(*) AS calls, COALESCE(SUM(cost_usd), 0) AS cost, COALESCE(SUM(input_tokens), 0) AS i, COALESCE(SUM(output_tokens), 0) AS o,
            COALESCE(SUM(cache_read_tokens), 0) AS cr, COALESCE(SUM(cache_write_tokens), 0) AS cw,
            COALESCE(SUM(CASE WHEN outcome = 'success' THEN 0 ELSE 1 END), 0) AS failed
     FROM llm_usage WHERE at >= ?`,
    since,
  );
  const days = await all<{ day: string; cost: number }>(
    'SELECT substr(at, 1, 10) AS day, COALESCE(SUM(cost_usd), 0) AS cost FROM llm_usage WHERE at >= ? GROUP BY substr(at, 1, 10) ORDER BY day',
    since,
  );
  return {
    since,
    totals: {
      calls: Number(t?.calls ?? 0),
      costUsd: Number(t?.cost ?? 0),
      inputTokens: Number(t?.i ?? 0),
      outputTokens: Number(t?.o ?? 0),
      cacheReadTokens: Number(t?.cr ?? 0),
      cacheWriteTokens: Number(t?.cw ?? 0),
      failed: Number(t?.failed ?? 0),
    },
    byModel: (await group('model')).map((r) => ({ model: r.key ?? '', calls: Number(r.calls), costUsd: Number(r.cost ?? 0) })),
    byAction: (await group('action')).map((r) => ({ key: r.key, calls: Number(r.calls), costUsd: Number(r.cost ?? 0) })),
    byTeam: (await group('team')).map((r) => ({ key: r.key, calls: Number(r.calls), costUsd: Number(r.cost ?? 0) })),
    byDay: days.map((d) => ({ day: d.day, costUsd: Number(d.cost) })),
  };
}

/** Cost of a run and of each of its steps. */
export async function runCosts(runId: string): Promise<{ total: number; steps: Map<string, number> }> {
  const rows = await all<{ step_id: string | null; cost: number | null }>(
    'SELECT step_id, COALESCE(SUM(cost_usd), 0) AS cost FROM llm_usage WHERE run_id = ? GROUP BY step_id',
    runId,
  );
  const steps = new Map<string, number>();
  let total = 0;
  for (const r of rows) {
    total += Number(r.cost ?? 0);
    if (r.step_id) steps.set(r.step_id, Number(r.cost ?? 0));
  }
  return { total, steps };
}
