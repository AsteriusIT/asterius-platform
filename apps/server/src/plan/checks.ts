import type { PlanCheckOutput, PlanChangeAction, PlanSeverity, PlanViolation, Policy } from '@asterius/shared';
import { errorMessage } from '../lib/errors.js';
import { evaluate, render } from '../lib/expr.js';
import { http } from '../lib/http.js';
import type { Plan } from './plan.js';
import { CARBON_METHOD, type Estimate } from './pricing.js';

/**
 * Plan policies. Three sources, one result (`violations` with a severity):
 *  - JSONata rules: the organization's `target: plan` policies (Admin → Policies, guard rails workflow authors cannot
 *    remove) and the step's own `policies`. Like every policy, `true` complies; a list (`[changes[...].address]`)
 *    complies when empty and otherwise gives one violation per item; anything else, and an evaluation error, is a
 *    violation (fail closed).
 *  - OPA: `POST <url>/v1/data/<path>` with `{ input: <plan> }` (conftest / OPA terraform conventions): a list of
 *    messages, or `{ deny|violation: [...], warn: [...], advisory|info: [...] }`. Unreachable OPA is critical.
 *  - Budget and pricing gaps: `budget: { maxMonthly, maxDelta, severity }`, `unpriced: <severity>`.
 */

export const SEVERITIES: PlanSeverity[] = ['critical', 'warning', 'advisory'];

export interface Rule {
  id: string;
  title?: string;
  severity?: PlanSeverity;
  expression: string;
  message?: string;
}

export interface OpaConfig {
  url: string;
  /** Data path: `terraform/deny` → POST /v1/data/terraform/deny. */
  path: string;
  headers?: Record<string, string>;
  /** Severity of plain messages (default critical). */
  severity?: PlanSeverity;
  /** `plan` (default): the plan as is; `context`: `{ plan, cost, carbon, inputs, action, principal }`. */
  input?: 'plan' | 'context';
}

export interface CheckOptions {
  rules: Rule[];
  policies: Policy[];
  opa?: OpaConfig;
  budget?: { maxMonthly?: number; maxDelta?: number; severity?: PlanSeverity };
  unpriced?: PlanSeverity | 'ignore';
  context: { inputs: unknown; action: unknown; principal: unknown; entity: unknown };
}

const short = (s: string, n = 500) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** The data rules see: the plan, its resources with their estimate, the cost and carbon totals, and the run. */
export function ruleContext(plan: Plan, est: Estimate, c: CheckOptions['context']) {
  const byAddress = new Map(est.resources.map((r) => [r.address, r]));
  const resources = plan.resources.map((r) => {
    const e = byAddress.get(r.address);
    return { ...r, cost: e ? { monthly: e.monthly, before: e.before, delta: e.delta, pricing: e.pricing } : null, co2eKg: e?.co2eKg ?? 0 };
  });
  return {
    plan: plan.raw,
    resources,
    changes: resources.filter((r) => r.action !== 'no-op'),
    cost: { currency: est.currency, monthly: est.monthly, before: est.before, delta: est.delta, unmatched: est.unmatched, usageBased: est.usageBased },
    carbon: est.carbon,
    ...c,
  };
}

async function message(tpl: string | undefined, fallback: string, ctx: unknown): Promise<string> {
  const t = tpl || fallback;
  if (!t.includes('{{')) return t;
  try {
    return String((await render(t, ctx, async () => '', { noRefs: true })).value ?? '');
  } catch {
    return t;
  }
}

/** One rule (a plan policy or a step rule): its violations. */
async function evaluateRule(
  r: { id: string; title: string; severity: PlanSeverity; expression: string; message?: string; source: PlanViolation['source'] },
  ctx: Record<string, unknown>,
): Promise<PlanViolation[]> {
  const base = { policy: r.id, title: r.title, severity: r.severity, source: r.source };
  let v: unknown;
  try {
    v = await evaluate(r.expression, ctx);
  } catch (err) {
    return [{ ...base, message: short(`${await message(r.message, r.title, ctx)} (evaluation failed: ${errorMessage(err)})`) }];
  }
  if (v === true) return [];
  if (Array.isArray(v)) {
    const out: PlanViolation[] = [];
    for (const item of v.slice(0, 50)) {
      const o = item && typeof item === 'object' ? (item as { address?: unknown; message?: unknown }) : null;
      const address = typeof item === 'string' && item.includes('.') && !item.includes(' ') ? item : typeof o?.address === 'string' ? o.address : undefined;
      const detail = typeof o?.message === 'string' ? o.message : typeof item === 'string' ? item : JSON.stringify(item);
      const text = await message(r.message, r.title, { ...ctx, item });
      out.push({ ...base, message: short(text.includes(detail) ? text : `${text}: ${detail}`), ...(address ? { address } : {}) });
    }
    return out;
  }
  const text = await message(r.message, r.title, ctx);
  return [{ ...base, message: short(typeof v === 'string' && v ? `${text}: ${v}` : text) }];
}

const OPA_KEYS: Record<string, PlanSeverity> = {
  deny: 'critical',
  violation: 'critical',
  violations: 'critical',
  critical: 'critical',
  warn: 'warning',
  warning: 'warning',
  warnings: 'warning',
  advisory: 'advisory',
  info: 'advisory',
  notice: 'advisory',
};

const sev = (v: unknown, d: PlanSeverity): PlanSeverity => (SEVERITIES.includes(v as PlanSeverity) ? (v as PlanSeverity) : d);

/** Messages of an OPA decision (strings, or `{ msg | message, severity?, address? }`; sets come back as lists). */
export function opaViolations(result: unknown, defaults: { severity: PlanSeverity; path: string }): PlanViolation[] {
  const out: PlanViolation[] = [];
  const push = (item: unknown, severity: PlanSeverity) => {
    const o = item && typeof item === 'object' ? (item as Record<string, unknown>) : null;
    const msg = o ? String(o.msg ?? o.message ?? JSON.stringify(o)) : String(item);
    const address = typeof o?.address === 'string' ? o.address : typeof o?.resource === 'string' ? o.resource : undefined;
    out.push({
      policy: `opa:${defaults.path}`,
      title: `OPA ${defaults.path}`,
      severity: sev(o?.severity, severity),
      message: short(msg),
      source: 'opa',
      ...(address ? { address } : {}),
    });
  };
  const list = (v: unknown, s: PlanSeverity) => {
    if (Array.isArray(v)) v.slice(0, 100).forEach((x) => push(x, s));
    else if (typeof v === 'string' && v) push(v, s);
  };
  if (result === undefined || result === null || result === true) return out;
  if (result === false) push(`OPA decision ${defaults.path} is false`, defaults.severity);
  else if (Array.isArray(result) || typeof result === 'string') list(result, defaults.severity);
  else if (typeof result === 'object') {
    const o = result as Record<string, unknown>;
    if (o.allow === false) push(`OPA decision ${defaults.path}: not allowed`, defaults.severity);
    for (const [k, s] of Object.entries(OPA_KEYS)) if (k in o) list(o[k], s);
  }
  return out;
}

async function queryOpa(opa: OpaConfig, input: unknown): Promise<PlanViolation[]> {
  const path = opa.path.replace(/^\/+|\/+$/g, '').replace(/\./g, '/');
  const url = `${opa.url.replace(/\/+$/, '')}/v1/data/${path.split('/').map(encodeURIComponent).join('/')}`;
  const severity = opa.severity ?? 'critical';
  try {
    const res = await http<{ result?: unknown }>(url, { method: 'POST', headers: opa.headers, body: { input }, retry: { retries: 1 } });
    const data = typeof res.data === 'string' ? (JSON.parse(res.data) as { result?: unknown }) : res.data;
    if (!data || !('result' in data))
      return [
        {
          policy: `opa:${path}`,
          title: `OPA ${path}`,
          severity,
          message: `OPA has no decision at ${path} (undefined document): check the package path`,
          source: 'opa',
        },
      ];
    return opaViolations(data.result, { severity, path });
  } catch (err) {
    return [
      { policy: `opa:${path}`, title: `OPA ${path}`, severity: 'critical', message: short(`OPA could not be queried: ${errorMessage(err)}`), source: 'opa' },
    ];
  }
}

export async function runChecks(plan: Plan, est: Estimate, o: CheckOptions): Promise<PlanViolation[]> {
  const ctx = ruleContext(plan, est, o.context);
  const out: PlanViolation[] = [];
  for (const p of o.policies)
    out.push(
      ...(await evaluateRule({ id: p.identifier, title: p.title, severity: p.severity, expression: p.expression, message: p.message, source: 'policy' }, ctx)),
    );
  for (const r of o.rules)
    out.push(
      ...(await evaluateRule(
        { id: r.id, title: r.title ?? r.id, severity: r.severity ?? 'critical', expression: r.expression, message: r.message, source: 'rule' },
        ctx,
      )),
    );
  if (o.opa) out.push(...(await queryOpa(o.opa, o.opa.input === 'context' ? ctx : plan.raw)));
  const b = o.budget;
  if (b) {
    const s = b.severity ?? 'warning';
    const money = (n: number) => `${n.toFixed(2)} ${est.currency}`;
    if (b.maxMonthly !== undefined && est.monthly > b.maxMonthly)
      out.push({
        policy: 'budget:monthly',
        title: 'Monthly budget',
        severity: s,
        source: 'budget',
        message: `Estimated monthly cost ${money(est.monthly)} exceeds the budget of ${money(b.maxMonthly)}`,
      });
    if (b.maxDelta !== undefined && est.delta > b.maxDelta)
      out.push({
        policy: 'budget:delta',
        title: 'Cost increase',
        severity: s,
        source: 'budget',
        message: `Estimated increase ${money(est.delta)}/month exceeds the allowed ${money(b.maxDelta)}`,
      });
  }
  const unpriced = o.unpriced ?? 'advisory';
  if (unpriced !== 'ignore') {
    const changed = new Set(plan.resources.filter((r) => r.action !== 'no-op').map((r) => r.address));
    const missing = est.unmatched.filter((a) => changed.has(a));
    if (missing.length)
      out.push({
        policy: 'pricing:unmatched',
        title: 'Resources without a price',
        severity: unpriced,
        source: 'pricing',
        message: short(`${missing.length} changed resource(s) have no price in catalog ${est.catalog} and are not in the estimate: ${missing.join(', ')}`),
      });
  }
  return out;
}

// ---------- the step output ----------

const ACTIONS: PlanChangeAction[] = ['create', 'update', 'replace', 'delete', 'no-op', 'forget'];
const ICON: Record<PlanSeverity, string> = { critical: '⛔', warning: '⚠️', advisory: 'ℹ️' };

const fmt = (n: number, currency: string) => `${n < 0 ? '-' : ''}${Math.abs(n).toFixed(2)} ${currency}`;
const signed = (n: number, currency: string) => `${n > 0 ? '+' : ''}${fmt(n, currency)}`;
const cell = (s: string) => s.replace(/\|/g, '\\|');

/** Markdown for approval messages and notifications: totals, the biggest changes and the violations. */
export function summarize(o: Omit<PlanCheckOutput, 'summary' | 'kind'>, maxRows = 10): string {
  const c = o.cost;
  const lines = [
    `**Estimated cost:** ${fmt(c.monthly, c.currency)}/month (${signed(c.delta, c.currency)}/month) · **Carbon:** ${o.carbon.monthlyKg.toFixed(1)} kgCO2e/month (${o.carbon.deltaKg > 0 ? '+' : ''}${o.carbon.deltaKg.toFixed(1)}, estimate)`,
    `**Changes:** ${
      ACTIONS.filter((a) => o.changes[a])
        .map((a) => `${o.changes[a]} ${a}`)
        .join(', ') || 'none'
    }${c.complete ? '' : ` · **${c.unmatched.length} resource(s) without a price** (not counted)`}`,
  ];
  const changed = [...o.resources].filter((r) => r.action !== 'no-op').sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
  if (changed.length) {
    lines.push('', '| Resource | Change | Monthly | Delta |', '|---|---|---:|---:|');
    for (const r of changed.slice(0, maxRows))
      lines.push(
        `| \`${cell(r.address)}\` | ${r.action} | ${r.pricing === 'unmatched' ? 'no price' : r.pricing === 'usage-based' ? 'usage-based' : fmt(r.monthly, c.currency)} | ${r.pricing === 'unmatched' ? '?' : signed(r.delta, c.currency)} |`,
      );
    if (changed.length > maxRows) lines.push(`| … ${changed.length - maxRows} more | | | |`);
  }
  if (o.violations.length) {
    lines.push(
      '',
      `**Policy findings:** ${SEVERITIES.filter((s) => o.counts[s])
        .map((s) => `${o.counts[s]} ${s}`)
        .join(', ')}`,
    );
    for (const v of o.violations.slice(0, 15)) lines.push(`- ${ICON[v.severity]} **${v.severity}** ${cell(v.title)}: ${v.message}`);
    if (o.violations.length > 15) lines.push(`- … ${o.violations.length - 15} more`);
  } else lines.push('', '**Policy findings:** none');
  return lines.join('\n');
}

export function buildOutput(
  plan: Plan,
  est: Estimate,
  violations: PlanViolation[],
  o: { onWarning: 'override' | 'fail' | 'ignore'; maxResources: number },
): PlanCheckOutput {
  const counts = { critical: 0, warning: 0, advisory: 0 } as Record<PlanSeverity, number>;
  for (const v of violations) counts[v.severity]++;
  const changes = Object.fromEntries(ACTIONS.map((a) => [a, plan.resources.filter((r) => r.action === a).length])) as Record<PlanChangeAction, number>;
  const warnBlocks = counts.warning > 0 && o.onWarning === 'fail';
  const gate: PlanCheckOutput['gate'] = counts.critical || warnBlocks ? 'blocked' : counts.warning && o.onWarning === 'override' ? 'override' : 'pass';
  // Changed resources first, so the truncated list keeps what the request is about.
  const ordered = [...est.resources].sort((a, b) => Number(a.action === 'no-op') - Number(b.action === 'no-op') || Math.abs(b.delta) - Math.abs(a.delta));
  const out: Omit<PlanCheckOutput, 'summary' | 'kind'> = {
    gate,
    requiresOverride: gate === 'override',
    changes,
    cost: {
      currency: est.currency,
      monthly: est.monthly,
      before: est.before,
      delta: est.delta,
      complete: est.unmatched.length === 0,
      unmatched: est.unmatched.slice(0, 50),
      usageBased: est.usageBased.slice(0, 50),
      catalog: est.catalog,
    },
    carbon: { ...est.carbon, method: CARBON_METHOD },
    violations: violations.slice(0, 100),
    counts,
    resources: ordered.slice(0, o.maxResources),
    truncated: Math.max(0, ordered.length - o.maxResources),
  };
  return { kind: 'plan-check', ...out, summary: summarize({ ...out, resources: est.resources }) };
}
