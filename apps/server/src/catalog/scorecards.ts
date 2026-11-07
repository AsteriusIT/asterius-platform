import type { Entity, RuleResult, Scorecard, ScorecardResult, ScorecardSummary } from '@asterius/shared';
import { all, bool, json, now, one, run } from '../db.js';
import { badRequest, errorMessage, managedError, notFound } from '../lib/errors.js';
import { checkExpression, evaluate } from '../lib/expr.js';
import { emit } from '../events.js';
import { scorecardDef, type ScorecardDef } from '../schemas.js';
import { searchEntities, related, getEntity } from './entities.js';
import { orgId } from '../orgs/context.js';
import { forEachOrg } from '../orgs/orgs.js';

/**
 * Scorecards: rules (JSONata over an entity and its relations) grouped into ordered levels. Results are stored
 * per entity, re-computed when the entity is written and on a schedule (housekeeping), and every level change is
 * recorded in `scorecard_history` (trends) and announced as a `scorecard.changed` event.
 */

interface Row {
  identifier: string;
  title: string;
  description: string;
  blueprint: string;
  levels: string;
  rules: string;
  managed: number;
}

const toScorecard = (r: Row): Scorecard => ({
  identifier: r.identifier,
  title: r.title,
  description: r.description,
  blueprint: r.blueprint,
  levels: json(r.levels, []),
  rules: json(r.rules, []),
  managed: bool(r.managed),
});

export async function listScorecards(blueprint?: string): Promise<Scorecard[]> {
  const rows = blueprint
    ? await all<Row>('SELECT * FROM scorecards WHERE org_id = ? AND blueprint = ? ORDER BY title', orgId(), blueprint)
    : await all<Row>('SELECT * FROM scorecards WHERE org_id = ? ORDER BY title', orgId());
  return rows.map(toScorecard);
}

export async function getScorecard(id: string): Promise<Scorecard> {
  const r = await one<Row>('SELECT * FROM scorecards WHERE org_id = ? AND identifier = ?', orgId(), id);
  if (!r) throw notFound(`Scorecard ${id}`);
  return toScorecard(r);
}

// Entity writes consult the scorecards of their blueprint on every call (syncs write thousands): cache briefly.
const byBlueprint = new Map<string, { at: number; list: Scorecard[] }>();
async function scorecardsOf(blueprint: string): Promise<Scorecard[]> {
  const key = `${orgId()}/${blueprint}`;
  const c = byBlueprint.get(key);
  if (c && Date.now() - c.at < 5_000) return c.list;
  const list = await listScorecards(blueprint);
  byBlueprint.set(key, { at: Date.now(), list });
  return list;
}

export async function upsertScorecard(input: unknown, opts: { managed?: boolean; knownBlueprints?: Set<string> } = {}) {
  const def: ScorecardDef = scorecardDef.parse(input);
  if (!opts.knownBlueprints?.has(def.blueprint)) {
    if (!(await one('SELECT identifier FROM blueprints WHERE org_id = ? AND identifier = ?', orgId(), def.blueprint)))
      throw badRequest(`Blueprint "${def.blueprint}" does not exist`);
  }
  for (const r of def.rules) checkExpression(r.expression);
  const org = orgId();
  const existing = await one<Row>('SELECT * FROM scorecards WHERE org_id = ? AND identifier = ?', org, def.identifier);
  if (existing && bool(existing.managed) && !opts.managed) throw managedError('Scorecard', def.identifier);
  if (existing && existing.blueprint !== def.blueprint) throw badRequest('The blueprint of a scorecard cannot change; create a new scorecard');
  const t = now();
  const vals = [def.title, def.description, def.blueprint, JSON.stringify(def.levels), JSON.stringify(def.rules), opts.managed ? 1 : 0, t];
  if (existing)
    await run(
      'UPDATE scorecards SET title = ?, description = ?, blueprint = ?, levels = ?, rules = ?, managed = ?, updated_at = ? WHERE org_id = ? AND identifier = ?',
      ...vals,
      org,
      def.identifier,
    );
  else
    await run(
      'INSERT INTO scorecards (title, description, blueprint, levels, rules, managed, updated_at, created_at, org_id, identifier) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ...vals,
      t,
      org,
      def.identifier,
    );
  byBlueprint.delete(`${org}/${def.blueprint}`);
  const scorecard = await getScorecard(def.identifier);
  return {
    scorecard,
    created: !existing,
    changed: !existing || existing.levels !== JSON.stringify(def.levels) || existing.rules !== JSON.stringify(def.rules),
  };
}

export async function deleteScorecard(id: string, opts: { managed?: boolean } = {}) {
  const sc = await getScorecard(id);
  if (sc.managed && !opts.managed) throw managedError('Scorecard', id);
  const org = orgId();
  await run('DELETE FROM scorecard_results WHERE org_id = ? AND scorecard = ?', org, id);
  await run('DELETE FROM scorecard_history WHERE org_id = ? AND scorecard = ?', org, id);
  await run('DELETE FROM scorecards WHERE org_id = ? AND identifier = ?', org, id);
  byBlueprint.delete(`${org}/${sc.blueprint}`);
}

// ---------- evaluation ----------
const slimEntity = (e: Entity) => ({ identifier: e.identifier, title: e.title, team: e.team, properties: e.properties, relations: e.relations });

async function contextOf(e: Entity, withRelated: boolean) {
  const ctx: Record<string, unknown> = {
    blueprint: e.blueprint,
    identifier: e.identifier,
    title: e.title,
    team: e.team,
    source: e.source,
    properties: e.properties,
    relations: e.relations,
    computed: e.computed ?? {},
    createdAt: e.createdAt,
    updatedAt: e.updatedAt,
    related: {},
    incoming: {},
  };
  if (withRelated) {
    const rel = await related(e.blueprint, e.identifier);
    ctx.related = Object.fromEntries(Object.entries(rel.outgoing).map(([k, list]) => [k, list.filter((x) => x.source !== 'missing').map(slimEntity)]));
    ctx.incoming = Object.fromEntries(Object.entries(rel.incoming).map(([k, list]) => [k, list.map(slimEntity)]));
  }
  return ctx;
}

/** Evaluate one scorecard on an entity (pure: nothing is stored). */
export async function evaluateScorecard(sc: Scorecard, e: Entity): Promise<ScorecardResult> {
  const needsRelated = sc.rules.some((r) => /\b(related|incoming)\b/.test(r.expression));
  const ctx = await contextOf(e, needsRelated);
  const results: RuleResult[] = [];
  for (const r of sc.rules) {
    try {
      results.push({ rule: r.identifier, title: r.title, level: r.level, passed: !!(await evaluate(r.expression, ctx)) });
    } catch (err) {
      results.push({ rule: r.identifier, title: r.title, level: r.level, passed: false, error: errorMessage(err) });
    }
  }
  // An entity reaches a level when every rule of that level and of the levels below pass.
  let reached = -1;
  for (const [i, l] of sc.levels.entries()) {
    if (results.some((x) => x.level === l.name && !x.passed)) break;
    reached = i;
  }
  const level = reached >= 0 ? sc.levels[reached] : undefined;
  return {
    scorecard: sc.identifier,
    scorecardTitle: sc.title,
    blueprint: e.blueprint,
    entity: e.identifier,
    level: level?.name ?? null,
    levelColor: level?.color ?? null,
    passed: results.filter((x) => x.passed).length,
    total: results.length,
    rules: results,
    evaluatedAt: now(),
  };
}

/** Evaluate, store, and record/announce changes. */
async function evaluateAndStore(sc: Scorecard, e: Entity) {
  const res = await evaluateScorecard(sc, e);
  const org = orgId();
  const prev = await one<{ level: string | null; passed: number; total: number }>(
    'SELECT level, passed, total FROM scorecard_results WHERE org_id = ? AND scorecard = ? AND blueprint = ? AND entity = ?',
    org,
    sc.identifier,
    e.blueprint,
    e.identifier,
  );
  await run(
    `INSERT INTO scorecard_results (org_id, scorecard, blueprint, entity, level, passed, total, rules, evaluated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (org_id, scorecard, blueprint, entity) DO UPDATE SET level = excluded.level, passed = excluded.passed, total = excluded.total, rules = excluded.rules, evaluated_at = excluded.evaluated_at`,
    org,
    sc.identifier,
    e.blueprint,
    e.identifier,
    res.level,
    res.passed,
    res.total,
    JSON.stringify(res.rules),
    res.evaluatedAt,
  );
  const levelChanged = !prev || (prev.level ?? null) !== res.level;
  if (levelChanged || Number(prev?.passed) !== res.passed || Number(prev?.total) !== res.total)
    await run(
      'INSERT INTO scorecard_history (org_id, scorecard, blueprint, entity, level, passed, total, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      org,
      sc.identifier,
      e.blueprint,
      e.identifier,
      res.level,
      res.passed,
      res.total,
      res.evaluatedAt,
    );
  // The first evaluation is not a change.
  if (prev && levelChanged)
    await emit({
      type: 'scorecard.changed',
      blueprint: e.blueprint,
      data: {
        scorecard: sc.identifier,
        entity: { blueprint: e.blueprint, identifier: e.identifier, title: e.title },
        from: prev.level ?? null,
        to: res.level,
        passed: res.passed,
        total: res.total,
      },
    });
  return res;
}

/** Called after an entity write: never fails the write. */
export async function evaluateEntity(e: Entity): Promise<void> {
  try {
    for (const sc of await scorecardsOf(e.blueprint)) await evaluateAndStore(sc, e);
  } catch (err) {
    console.error(`[scorecards] ${e.blueprint}/${e.identifier}: ${errorMessage(err)}`);
  }
}

export async function removeEntityResults(blueprint: string, identifier: string) {
  await run('DELETE FROM scorecard_results WHERE org_id = ? AND blueprint = ? AND entity = ?', orgId(), blueprint, identifier);
  await run('DELETE FROM scorecard_history WHERE org_id = ? AND blueprint = ? AND entity = ?', orgId(), blueprint, identifier);
}

/** Re-evaluate every entity of the scorecard's blueprint, page by page. Returns the number evaluated. */
export async function evaluateAllEntities(sc: Scorecard): Promise<number> {
  let n = 0;
  const seen = new Set<string>();
  for (let offset = 0; ; offset += 200) {
    const page = await searchEntities({ blueprint: sc.blueprint, sort: 'identifier', limit: 200, offset });
    for (const e of page.items) {
      seen.add(e.identifier);
      try {
        await evaluateAndStore(sc, e);
        n++;
      } catch (err) {
        console.error(`[scorecards] ${sc.identifier} on ${e.identifier}: ${errorMessage(err)}`);
      }
    }
    if (page.items.length < 200) break;
  }
  // Results of entities that no longer exist.
  for (const r of await all<{ entity: string }>('SELECT entity FROM scorecard_results WHERE org_id = ? AND scorecard = ?', orgId(), sc.identifier))
    if (!seen.has(r.entity)) await removeEntityResults(sc.blueprint, r.entity);
  return n;
}

/** Scheduled pass over every organization (relations change without the entity being written). */
export async function evaluateEverything(): Promise<number> {
  let n = 0;
  await forEachOrg(async () => {
    for (const sc of await listScorecards()) n += await evaluateAllEntities(sc);
  }, 'scorecards');
  return n;
}

// ---------- reads ----------
interface ResultRow {
  scorecard: string;
  blueprint: string;
  entity: string;
  level: string | null;
  passed: number;
  total: number;
  rules: string;
  evaluated_at: string;
}

export async function resultsForEntity(blueprint: string, identifier: string): Promise<ScorecardResult[]> {
  await getEntity(blueprint, identifier);
  const out: ScorecardResult[] = [];
  for (const sc of await listScorecards(blueprint)) {
    const r = await one<ResultRow>(
      'SELECT * FROM scorecard_results WHERE org_id = ? AND scorecard = ? AND blueprint = ? AND entity = ?',
      orgId(),
      sc.identifier,
      blueprint,
      identifier,
    );
    // Not evaluated yet (scorecard created a moment ago): compute now.
    const res = r
      ? ({
          scorecard: sc.identifier,
          scorecardTitle: sc.title,
          blueprint,
          entity: identifier,
          level: r.level,
          passed: Number(r.passed),
          total: Number(r.total),
          rules: json(r.rules, []),
          evaluatedAt: r.evaluated_at,
        } satisfies ScorecardResult)
      : await evaluateAndStore(sc, await getEntity(blueprint, identifier));
    out.push({ ...res, levelColor: sc.levels.find((l) => l.name === res.level)?.color ?? null, levels: sc.levels });
  }
  return out;
}

/** Levels of several entities at once (table badges): scorecard → entity → level. */
export async function levelsFor(blueprint: string, ids: string[]): Promise<Record<string, Record<string, string | null>>> {
  const out: Record<string, Record<string, string | null>> = {};
  if (!ids.length) return out;
  const rows = await all<{ scorecard: string; entity: string; level: string | null }>(
    `SELECT scorecard, entity, level FROM scorecard_results WHERE org_id = ? AND blueprint = ? AND entity IN (${ids.map(() => '?').join(',')})`,
    orgId(),
    blueprint,
    ...ids,
  );
  for (const r of rows) (out[r.scorecard] ??= {})[r.entity] = r.level;
  return out;
}

/** Level of every scorecard of one entity, as exposed to workflow expressions: `entity.scorecards.<id>.level`. */
export async function scorecardLevels(
  blueprint: string,
  identifier: string,
): Promise<Record<string, { level: string | null; rank: number; passed: number; total: number }>> {
  const out: Record<string, { level: string | null; rank: number; passed: number; total: number }> = {};
  for (const sc of await scorecardsOf(blueprint)) {
    const r = await one<{ level: string | null; passed: number; total: number }>(
      'SELECT level, passed, total FROM scorecard_results WHERE org_id = ? AND scorecard = ? AND blueprint = ? AND entity = ?',
      orgId(),
      sc.identifier,
      blueprint,
      identifier,
    );
    if (r) out[sc.identifier] = { level: r.level, rank: sc.levels.findIndex((l) => l.name === r.level) + 1, passed: Number(r.passed), total: Number(r.total) };
  }
  return out;
}

const DAY = 86400_000;

export async function scorecardSummary(id: string, days = 30): Promise<ScorecardSummary> {
  const sc = await getScorecard(id);
  const names = [...sc.levels.map((l) => l.name), 'none'];
  const empty = () => Object.fromEntries(names.map((n) => [n, 0]));
  const dist = empty();
  const org = orgId();
  for (const r of await all<{ level: string | null; n: number }>(
    'SELECT level, count(*) AS n FROM scorecard_results WHERE org_id = ? AND scorecard = ? GROUP BY level',
    org,
    id,
  ))
    dist[r.level ?? 'none'] = (dist[r.level ?? 'none'] ?? 0) + Number(r.n);
  const total = Object.values(dist).reduce((a, b) => a + b, 0);

  // Trend: replay the level changes day by day.
  const start = new Date(Date.now() - (days - 1) * DAY);
  start.setUTCHours(0, 0, 0, 0);
  const since = start.toISOString();
  const state = new Map<string, string>();
  for (const r of await all<{ entity: string; level: string | null }>(
    `SELECT h.entity, h.level FROM scorecard_history h WHERE h.org_id = ? AND h.scorecard = ? AND h.at < ?
       AND h.id = (SELECT max(h2.id) FROM scorecard_history h2 WHERE h2.org_id = h.org_id AND h2.scorecard = h.scorecard AND h2.blueprint = h.blueprint AND h2.entity = h.entity AND h2.at < ?)`,
    org,
    id,
    since,
    since,
  ))
    state.set(r.entity, r.level ?? 'none');
  const events = await all<{ entity: string; level: string | null; at: string }>(
    'SELECT entity, level, at FROM scorecard_history WHERE org_id = ? AND scorecard = ? AND at >= ? ORDER BY id',
    org,
    id,
    since,
  );
  const trend: ScorecardSummary['trend'] = [];
  let i = 0;
  for (let d = 0; d < days; d++) {
    const dayStart = new Date(start.getTime() + d * DAY);
    const end = new Date(dayStart.getTime() + DAY).toISOString();
    while (i < events.length && events[i].at < end) {
      state.set(events[i].entity, events[i].level ?? 'none');
      i++;
    }
    const day = empty();
    for (const l of state.values()) day[l] = (day[l] ?? 0) + 1;
    trend.push({ day: dayStart.toISOString().slice(0, 10), distribution: day });
  }
  return { scorecard: id, total, distribution: dist, trend };
}

/** Retention (every organization). */
export async function purgeScorecardHistory(olderThan: string) {
  return run('DELETE FROM scorecard_history WHERE at < ?', olderThan);
}
