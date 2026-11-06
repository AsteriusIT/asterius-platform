import type { FastifyBaseLogger } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { all, json, later, newId, now, one, run } from '../db.js';
import { audit, SYSTEM, type Actor } from '../audit.js';
import { listBlueprints } from '../catalog/blueprints.js';
import { aiConfigured, ask, wrapUntrusted } from './model.js';

/**
 * Catalog quality reviews. Findings are computed with SQL (stale data, missing owners, dangling or missing relations),
 * so they are exact and free; when AI is configured a model then prioritises them in a short summary.
 * A review runs on a schedule (AI_REVIEW_INTERVAL_HOURS, one replica at a time) or on demand, and is stored in `ai_reviews`.
 */

export type FindingKind = 'missing_owner' | 'stale' | 'dangling_relation' | 'missing_required_relation';

export interface Finding {
  kind: FindingKind;
  blueprint: string;
  identifier: string;
  detail: string;
}

export interface Review {
  id: string;
  at: string;
  trigger: 'schedule' | 'manual';
  status: 'success' | 'failure';
  findings: Finding[];
  counts: Record<string, number>;
  summary: string;
  costUsd: number | null;
  error: string | null;
}

const PER_KIND = 200;

interface EntityRef {
  blueprint: string;
  identifier: string;
}

export async function collectFindings(staleDays = config.AI_REVIEW_STALE_DAYS): Promise<{ findings: Finding[]; counts: Record<string, number> }> {
  const findings: Finding[] = [];
  const counts: Record<string, number> = {};
  const add = async (kind: FindingKind, countSql: string, listSql: string, params: (string | number)[], detail: (r: Record<string, string>) => string) => {
    counts[kind] = Number((await one<{ n: number }>(countSql, ...params))?.n ?? 0);
    for (const r of await all<Record<string, string>>(listSql, ...params, PER_KIND))
      findings.push({ kind, blueprint: r.blueprint, identifier: r.identifier, detail: detail(r) });
  };

  await add(
    'missing_owner',
    "SELECT count(*) AS n FROM entities WHERE team IS NULL OR team = ''",
    "SELECT blueprint, identifier FROM entities WHERE team IS NULL OR team = '' ORDER BY blueprint, identifier LIMIT ?",
    [],
    () => 'No owning team',
  );
  const cutoff = new Date(Date.now() - staleDays * 86400_000).toISOString();
  await add(
    'stale',
    'SELECT count(*) AS n FROM entities WHERE updated_at < ?',
    'SELECT blueprint, identifier, updated_at FROM entities WHERE updated_at < ? ORDER BY updated_at LIMIT ?',
    [cutoff],
    (r) => `Not updated since ${r.updated_at.slice(0, 10)}`,
  );
  const dangling = `FROM entity_relations r LEFT JOIN entities t ON t.blueprint = r.target_blueprint AND t.identifier = r.target_identifier WHERE t.identifier IS NULL`;
  await add(
    'dangling_relation',
    `SELECT count(*) AS n ${dangling}`,
    `SELECT r.blueprint, r.identifier, r.relation, r.target_blueprint, r.target_identifier ${dangling} ORDER BY r.blueprint, r.identifier LIMIT ?`,
    [],
    (r) => `Relation "${r.relation}" points to ${r.target_blueprint}/${r.target_identifier}, which does not exist`,
  );
  for (const bp of await listBlueprints()) {
    for (const [name, rel] of Object.entries(bp.relations ?? {})) {
      if (!rel.required) continue;
      const from = `FROM entities e WHERE e.blueprint = ? AND NOT EXISTS (SELECT 1 FROM entity_relations r WHERE r.blueprint = e.blueprint AND r.identifier = e.identifier AND r.relation = ?)`;
      const n = Number((await one<{ n: number }>(`SELECT count(*) AS n ${from}`, bp.identifier, name))?.n ?? 0);
      counts.missing_required_relation = (counts.missing_required_relation ?? 0) + n;
      for (const r of await all<EntityRef>(`SELECT e.blueprint, e.identifier ${from} LIMIT ?`, bp.identifier, name, PER_KIND))
        findings.push({ kind: 'missing_required_relation', ...r, detail: `Required relation "${name}" is empty` });
    }
  }
  return { findings, counts };
}

interface Row {
  id: string;
  at: string;
  trigger: Review['trigger'];
  status: Review['status'];
  findings: string;
  summary: string;
  cost_usd: number | null;
  error: string | null;
}

const toReview = (r: Row): Review => {
  const stored = json<{ findings: Finding[]; counts: Record<string, number> }>(r.findings, { findings: [], counts: {} });
  return {
    id: r.id,
    at: r.at,
    trigger: r.trigger,
    status: r.status,
    findings: stored.findings,
    counts: stored.counts,
    summary: r.summary,
    costUsd: r.cost_usd === null ? null : Number(r.cost_usd),
    error: r.error,
  };
};

export const listReviews = async (limit = 20): Promise<Review[]> => (await all<Row>('SELECT * FROM ai_reviews ORDER BY at DESC LIMIT ?', limit)).map(toReview);
export async function getReview(id: string): Promise<Review | undefined> {
  const r = await one<Row>('SELECT * FROM ai_reviews WHERE id = ?', id);
  return r && toReview(r);
}

const summarySchema = { properties: { summary: { type: 'string' as const, description: 'Markdown summary' } }, required: ['summary'] };

/** Run one review now and store it. The AI summary is best effort: findings are kept when the model is unavailable or over budget. */
export async function runReview(trigger: Review['trigger'], actor: Actor = SYSTEM): Promise<Review> {
  const id = newId();
  const at = now();
  let summary = '';
  let costUsd: number | null = null;
  let error: string | null = null;
  const { findings, counts } = await collectFindings();
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  if (total && aiConfigured()) {
    try {
      const r = await ask({
        scope: { kind: 'review', userId: actor.id },
        system:
          'You review the quality of a software catalog for its platform team. From the findings, write a short Markdown report: the three most important problems first, ' +
          'which teams or blueprints concentrate them, and concrete next steps. Use only the findings given; do not invent entities.',
        prompt: `Totals by kind: ${JSON.stringify(counts)}\n${wrapUntrusted(JSON.stringify(findings.slice(0, 150)), 'findings')}`,
        output: summarySchema as never,
        maxTokens: 2000,
      });
      summary = String(r.output.summary ?? '');
      costUsd = r.usage.costUsd;
    } catch (err) {
      error = `AI summary unavailable: ${(err as Error).message}`;
    }
  }
  await run(
    'INSERT INTO ai_reviews (id, at, trigger, status, findings, summary, cost_usd, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    id,
    at,
    trigger,
    'success',
    JSON.stringify({ findings, counts }),
    summary,
    costUsd,
    error,
  );
  await audit(actor, 'ai.review', id, { trigger, counts });
  return (await getReview(id))!;
}

// ---------- scheduling ----------
/** Claim the right to run the review: exactly one replica wins each period (conditional UPDATE on a lease row). */
export async function claimReview(periodMs: number, leaseMs = 15 * 60_000): Promise<boolean> {
  await run('INSERT INTO ai_leases (name, locked_until) VALUES (?, ?) ON CONFLICT (name) DO NOTHING', 'review', new Date(0).toISOString());
  const t = now();
  const { changes } = await run(
    'UPDATE ai_leases SET locked_until = ?, last_run_at = ? WHERE name = ? AND locked_until < ? AND (last_run_at IS NULL OR last_run_at < ?)',
    later(leaseMs),
    t,
    'review',
    t,
    new Date(Date.now() - periodMs).toISOString(),
  );
  return changes > 0;
}

export function startAiScheduler(log: FastifyBaseLogger) {
  const hours = config.AI_REVIEW_INTERVAL_HOURS;
  const tick = async () => {
    // Usage history is kept longer than other records: it is the basis of cost reports.
    await run('DELETE FROM llm_usage WHERE at < ?', new Date(Date.now() - Math.max(config.RETENTION_DAYS, 400) * 86400_000).toISOString());
    if (hours > 0 && (await claimReview(hours * 3600_000))) {
      const r = await runReview('schedule');
      log.info({ review: r.id, counts: r.counts }, 'catalog quality review done');
    }
  };
  const run1 = () => tick().catch((err) => log.error({ err }, 'ai scheduler'));
  setTimeout(run1, 60_000).unref();
  const timer = setInterval(run1, 10 * 60_000);
  timer.unref();
  return () => clearInterval(timer);
}

export const reviewIdParam = z.object({ id: z.string().min(1).max(100) });
