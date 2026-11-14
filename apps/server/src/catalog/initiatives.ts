import type {
  Initiative,
  InitiativeCounts,
  InitiativeDetail,
  InitiativeEntity,
  InitiativeExemption,
  InitiativeStatus,
  InitiativeTeamProgress,
  InitiativeTodo,
  InitiativeView,
  RuleResult,
  Scorecard,
} from '@asterius/shared';
import { all, bool, json, newId, now, one, run } from '../db.js';
import { badRequest, errorMessage, forbidden, managedError, notFound } from '../lib/errors.js';
import { initiativeDef, initiativeExemptionInput, type InitiativeDef } from '../schemas.js';
import { emit } from '../events.js';
import { audit } from '../audit.js';
import { orgId } from '../orgs/context.js';
import { appUrl, forEachOrg } from '../orgs/orgs.js';
import { isAdmin, type Principal, type UserRow } from '../auth/users.js';
import { canRead } from './entities.js';
import { getBlueprintCached } from './blueprints.js';
import { visibleBlueprints } from '../auth/access.js';
import { getScorecard } from './scorecards.js';
import { notify } from '../inbox.js';
import { deliver } from '../notifications/dispatch.js';
import { getNotificationPrefs } from '../notifications/settings.js';

/**
 * Initiatives turn a scorecard into tracked work: entities of the scorecard's blueprint (optionally of some teams)
 * must reach a target level and/or pass given rules by a deadline. Progress is computed from the stored scorecard
 * results; a daily snapshot per initiative (claimed by a conditional UPDATE of `snapshot_day`) gives the trend.
 * Status changes are announced once as `initiative.*` events (claimed on the stored `status`), reminders go to the
 * members of the teams with failing entities (claimed on `remind_at`). Exempted entities leave the counts until expiry.
 */

const DAY = 86_400_000;
/** At risk: more than this behind the straight line from the start to the deadline. */
const RISK_MARGIN = 0.1;
const MAX_ENTITIES = 5000;
const MAX_RECIPIENTS = 200;

interface Row {
  identifier: string;
  title: string;
  description: string;
  scorecard: string;
  target_level: string | null;
  rules: string;
  start_date: string;
  deadline: string;
  teams: string;
  owner: string | null;
  enabled: number;
  reminder_days: number;
  status: string | null;
  remind_at: string | null;
  managed: number;
}

const toInitiative = (r: Row): Initiative => ({
  identifier: r.identifier,
  title: r.title,
  description: r.description,
  scorecard: r.scorecard,
  targetLevel: r.target_level,
  rules: json(r.rules, []),
  startDate: r.start_date,
  deadline: r.deadline,
  teams: json(r.teams, []),
  owner: r.owner,
  enabled: bool(r.enabled),
  reminderDays: Number(r.reminder_days),
  managed: bool(r.managed),
});

export const today = (at = Date.now()) => new Date(at).toISOString().slice(0, 10);
const startMs = (i: Pick<Initiative, 'startDate'>) => Date.parse(`${i.startDate}T00:00:00Z`);
const endMs = (i: Pick<Initiative, 'deadline'>) => Date.parse(`${i.deadline}T00:00:00Z`) + DAY;

async function rows(): Promise<Row[]> {
  return all<Row>('SELECT * FROM initiatives WHERE org_id = ? ORDER BY deadline, title', orgId());
}

export async function listInitiatives(): Promise<Initiative[]> {
  return (await rows()).map(toInitiative);
}

export async function getInitiative(id: string): Promise<Initiative> {
  const r = await one<Row>('SELECT * FROM initiatives WHERE org_id = ? AND identifier = ?', orgId(), id);
  if (!r) throw notFound(`Initiative ${id}`);
  return toInitiative(r);
}

/** The target must exist in the scorecard: a level of it, rules of it. */
function checkTarget(def: Pick<InitiativeDef, 'targetLevel' | 'rules' | 'scorecard'>, sc: Scorecard) {
  if (def.targetLevel && !sc.levels.some((l) => l.name === def.targetLevel))
    throw badRequest(`Level "${def.targetLevel}" is not a level of scorecard ${sc.identifier} (${sc.levels.map((l) => l.name).join(', ')})`);
  for (const r of def.rules) if (!sc.rules.some((x) => x.identifier === r)) throw badRequest(`Rule "${r}" is not a rule of scorecard ${sc.identifier}`);
}

/** First reminder: one period after the start (or after now, for an initiative already running). */
const firstReminder = (def: InitiativeDef) => (def.reminderDays ? new Date(Math.max(Date.now(), startMs(def)) + def.reminderDays * DAY).toISOString() : null);

export async function upsertInitiative(input: unknown, opts: { managed?: boolean } = {}) {
  const def: InitiativeDef = initiativeDef.parse(input);
  checkTarget(def, await getScorecard(def.scorecard).catch(() => Promise.reject(badRequest(`Scorecard "${def.scorecard}" does not exist`))));
  const org = orgId();
  const existing = await one<Row>('SELECT * FROM initiatives WHERE org_id = ? AND identifier = ?', org, def.identifier);
  if (existing && bool(existing.managed) && !opts.managed) throw managedError('Initiative', def.identifier);
  const t = now();
  // A new schedule restarts the reminders; anything else keeps the next one where it is.
  const rescheduled = !existing || Number(existing.reminder_days) !== def.reminderDays || existing.start_date !== def.startDate;
  const vals = [
    def.title,
    def.description,
    def.scorecard,
    def.targetLevel ?? null,
    JSON.stringify(def.rules),
    def.startDate,
    def.deadline,
    JSON.stringify(def.teams),
    def.owner ?? null,
    def.enabled ? 1 : 0,
    def.reminderDays,
    rescheduled ? firstReminder(def) : existing.remind_at,
    opts.managed ? 1 : 0,
    t,
  ];
  if (existing)
    await run(
      `UPDATE initiatives SET title = ?, description = ?, scorecard = ?, target_level = ?, rules = ?, start_date = ?, deadline = ?, teams = ?, owner = ?,
         enabled = ?, reminder_days = ?, remind_at = ?, managed = ?, updated_at = ? WHERE org_id = ? AND identifier = ?`,
      ...vals,
      org,
      def.identifier,
    );
  else
    await run(
      `INSERT INTO initiatives (title, description, scorecard, target_level, rules, start_date, deadline, teams, owner, enabled, reminder_days, remind_at, managed,
         updated_at, created_at, org_id, identifier) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ...vals,
      t,
      org,
      def.identifier,
    );
  return { initiative: await getInitiative(def.identifier), created: !existing };
}

export async function deleteInitiative(id: string, opts: { managed?: boolean } = {}) {
  const i = await getInitiative(id);
  if (i.managed && !opts.managed) throw managedError('Initiative', id);
  const org = orgId();
  await run('DELETE FROM initiative_exemptions WHERE org_id = ? AND initiative = ?', org, id);
  await run('DELETE FROM initiative_snapshots WHERE org_id = ? AND initiative = ?', org, id);
  await run('DELETE FROM initiatives WHERE org_id = ? AND identifier = ?', org, id);
}

// ---------- evaluation ----------

/** Rules an entity must pass: every rule of the levels up to the target, plus the listed ones. */
export function requiredRules(i: Pick<Initiative, 'targetLevel' | 'rules'>, sc: Scorecard) {
  const rank = i.targetLevel ? sc.levels.findIndex((l) => l.name === i.targetLevel) : -1;
  const levels = new Set(sc.levels.slice(0, rank + 1).map((l) => l.name));
  return sc.rules.filter((r) => levels.has(r.level) || i.rules.includes(r.identifier)).map((r) => ({ rule: r.identifier, title: r.title, level: r.level }));
}

/** Pure: is a result row at the target, and which required rules fail (exempted rules count as passing)? */
export function judge(results: RuleResult[], required: { rule: string; title: string; level: string }[], exemptRules: Set<string>) {
  const byRule = new Map(results.map((r) => [r.rule, r]));
  // A required rule without a result (scorecard changed, not re-evaluated yet) counts as failing.
  const failing = required.filter((r) => !exemptRules.has(r.rule) && !byRule.get(r.rule)?.passed);
  return { passing: failing.length === 0, failing };
}

/** Straight-line expectation from the start (0) to the deadline (1). */
export function expectedRatio(i: Pick<Initiative, 'startDate' | 'deadline'>, at = Date.now()) {
  const s = startMs(i);
  const e = endMs(i);
  return Math.min(1, Math.max(0, (at - s) / Math.max(1, e - s)));
}

export function statusOf(i: Pick<Initiative, 'startDate' | 'deadline'>, c: Pick<InitiativeCounts, 'ratio'>, at = Date.now()): InitiativeStatus {
  if (c.ratio >= 1) return 'done';
  if (today(at) > i.deadline) return 'overdue';
  return c.ratio + RISK_MARGIN < expectedRatio(i, at) ? 'at_risk' : 'on_track';
}

export const daysLeft = (i: Pick<Initiative, 'deadline'>, at = Date.now()) => Math.ceil((endMs(i) - at) / DAY);

const counts = (passing: number, total: number, exempted: number): InitiativeCounts => ({ passing, total, exempted, ratio: total ? passing / total : 1 });

interface Evaluation {
  sc: Scorecard;
  required: { rule: string; title: string; level: string }[];
  entities: InitiativeEntity[];
}

/** Every entity in scope with its verdict. `teams` narrows the scope further (the caller's teams, for the inbox). */
async function evaluateInitiative(i: Initiative, narrow?: string[]): Promise<Evaluation> {
  const sc = await getScorecard(i.scorecard);
  checkTarget(i, sc);
  const required = requiredRules(i, sc);
  const org = orgId();
  const scope = narrow ? (i.teams.length ? i.teams.filter((t) => narrow.includes(t)) : narrow) : i.teams;
  if (narrow && !scope.length) return { sc, required, entities: [] };
  const teamSql = scope.length ? ` AND e.team IN (${scope.map(() => '?').join(',')})` : '';
  const results = await all<{ entity: string; level: string | null; rules: string; title: string; team: string | null }>(
    `SELECT r.entity, r.level, r.rules, e.title, e.team FROM scorecard_results r
       JOIN entities e ON e.org_id = r.org_id AND e.blueprint = r.blueprint AND e.identifier = r.entity
     WHERE r.org_id = ? AND r.scorecard = ? AND r.blueprint = ?${teamSql} ORDER BY r.entity LIMIT ${MAX_ENTITIES}`,
    org,
    sc.identifier,
    sc.blueprint,
    ...scope,
  );
  const exemptions = new Map<string, Set<string>>();
  for (const x of await all<{ entity: string; rule: string }>(
    'SELECT entity, rule FROM initiative_exemptions WHERE org_id = ? AND initiative = ? AND expires_at > ?',
    org,
    i.identifier,
    now(),
  )) {
    const set = exemptions.get(x.entity) ?? new Set<string>();
    set.add(x.rule);
    exemptions.set(x.entity, set);
  }
  const entities = results.map((r): InitiativeEntity => {
    const ex = exemptions.get(r.entity) ?? new Set<string>();
    const v = judge(json<RuleResult[]>(r.rules, []), required, ex);
    return {
      identifier: r.entity,
      title: r.title,
      team: r.team,
      level: r.level,
      passing: v.passing,
      failing: v.failing,
      exempt: ex.has(''),
      exemptRules: [...ex].filter(Boolean),
    };
  });
  return { sc, required, entities };
}

/** Overall and per-team counts of an evaluation. */
export function aggregate(entities: Pick<InitiativeEntity, 'team' | 'passing' | 'exempt'>[]) {
  const teams = new Map<string | null, { passing: number; total: number; exempted: number }>();
  let passing = 0;
  let total = 0;
  let exempted = 0;
  for (const e of entities) {
    const t = teams.get(e.team) ?? { passing: 0, total: 0, exempted: 0 };
    if (e.exempt) {
      exempted++;
      t.exempted++;
    } else {
      total++;
      t.total++;
      if (e.passing) {
        passing++;
        t.passing++;
      }
    }
    teams.set(e.team, t);
  }
  const byTeam: InitiativeTeamProgress[] = [...teams.entries()]
    .map(([team, c]) => ({ team, ...counts(c.passing, c.total, c.exempted) }))
    .sort((a, b) => a.ratio - b.ratio || (a.team ?? '~').localeCompare(b.team ?? '~'));
  return { overall: counts(passing, total, exempted), byTeam };
}

function viewOf(i: Initiative, ev: Evaluation | null, error?: string): InitiativeView {
  const progress = ev ? aggregate(ev.entities).overall : counts(0, 0, 0);
  return {
    ...i,
    blueprint: ev?.sc.blueprint ?? '',
    scorecardTitle: ev?.sc.title ?? i.scorecard,
    status: ev ? statusOf(i, progress) : 'on_track',
    progress,
    expected: expectedRatio(i),
    daysLeft: daysLeft(i),
    ...(error ? { error } : {}),
  };
}

async function safeEvaluate(i: Initiative): Promise<{ ev: Evaluation | null; error?: string }> {
  try {
    return { ev: await evaluateInitiative(i) };
  } catch (err) {
    return { ev: null, error: errorMessage(err) };
  }
}

/** Initiatives the viewer may see: those on blueprints they can read (an unknown scorecard: admins only). */
async function visible(p: Principal, list: Initiative[]): Promise<Initiative[]> {
  if (isAdmin(p)) return list;
  const out: Initiative[] = [];
  const seen = new Map<string, boolean>();
  for (const i of list) {
    if (!seen.has(i.scorecard)) {
      const ok = await getScorecard(i.scorecard)
        .then(async (sc) => (await visibleBlueprints(p, [await getBlueprintCached(sc.blueprint)])).length > 0)
        .catch(() => false);
      seen.set(i.scorecard, ok);
    }
    if (seen.get(i.scorecard)) out.push(i);
  }
  return out;
}

export async function initiativeViews(p: Principal): Promise<InitiativeView[]> {
  const out: InitiativeView[] = [];
  for (const i of await visible(p, await listInitiatives())) {
    const { ev, error } = await safeEvaluate(i);
    out.push(viewOf(i, ev, error));
  }
  return out;
}

export async function visibleInitiative(p: Principal, id: string): Promise<Initiative> {
  const i = await getInitiative(id);
  if (!(await visible(p, [i])).length) throw notFound(`Initiative ${id}`);
  return i;
}

/** Entities of the evaluation the viewer may read (per-entity read rules). */
async function readable(p: Principal, sc: Scorecard, entities: InitiativeEntity[]) {
  if (isAdmin(p)) return entities;
  const byTeam = new Map<string | null, boolean>();
  const out: InitiativeEntity[] = [];
  for (const e of entities) {
    if (!byTeam.has(e.team)) byTeam.set(e.team, await canRead(p, { blueprint: sc.blueprint, team: e.team }));
    if (byTeam.get(e.team)) out.push(e);
  }
  return out;
}

const trendDays = (i: Initiative) => Math.min(366, Math.max(1, Math.ceil((Math.min(Date.now(), endMs(i) + 30 * DAY) - startMs(i)) / DAY)));

export async function initiativeDetail(p: Principal, id: string): Promise<InitiativeDetail> {
  const i = await visibleInitiative(p, id);
  const { ev, error } = await safeEvaluate(i);
  const view = viewOf(i, ev, error);
  const { byTeam } = ev ? aggregate(ev.entities) : { byTeam: [] };
  // Trend: the daily snapshots since the start, today's point computed live.
  const day0 = today(startMs(i));
  const snaps = await all<{ day: string; team: string; passing: number; total: number }>(
    'SELECT day, team, passing, total FROM initiative_snapshots WHERE org_id = ? AND initiative = ? AND day >= ? ORDER BY day',
    orgId(),
    id,
    day0,
  );
  const points = new Map<string, InitiativeDetail['trend'][number]>();
  for (const s of snaps) {
    const pt = points.get(s.day) ?? { day: s.day, passing: 0, total: 0, teams: {} };
    if (s.team === '') Object.assign(pt, { passing: Number(s.passing), total: Number(s.total) });
    else pt.teams[s.team] = { passing: Number(s.passing), total: Number(s.total) };
    points.set(s.day, pt);
  }
  if (ev && today() >= day0) points.set(today(), snapshotPoint(today(), view.progress, byTeam));
  const trend = [...points.values()].sort((a, b) => a.day.localeCompare(b.day)).slice(-trendDays(i));
  return { ...view, byTeam, trend, requiredRules: ev?.required ?? [] };
}

const teamKey = (t: string | null) => t ?? '-';

function snapshotPoint(day: string, overall: InitiativeCounts, byTeam: InitiativeTeamProgress[]): InitiativeDetail['trend'][number] {
  return {
    day,
    passing: overall.passing,
    total: overall.total,
    teams: Object.fromEntries(byTeam.map((t) => [teamKey(t.team), { passing: t.passing, total: t.total }])),
  };
}

export async function initiativeEntities(p: Principal, id: string, filter: 'failing' | 'passing' | 'exempt' | 'all' = 'all', team?: string) {
  const i = await visibleInitiative(p, id);
  const ev = await evaluateInitiative(i);
  const list = (await readable(p, ev.sc, ev.entities)).filter(
    (e) =>
      (team === undefined || teamKey(e.team) === team) &&
      (filter === 'all' || (filter === 'exempt' ? e.exempt : !e.exempt && (filter === 'passing' ? e.passing : !e.passing))),
  );
  return { blueprint: ev.sc.blueprint, items: list };
}

// ---------- exemptions ----------
interface ExemptionRow {
  id: string;
  initiative: string;
  entity: string;
  rule: string;
  reason: string;
  expires_at: string;
  granted_by_id: string | null;
  granted_by_email: string | null;
  created_at: string;
}

const toExemption = (r: ExemptionRow): InitiativeExemption => ({
  id: r.id,
  initiative: r.initiative,
  entity: r.entity,
  rule: r.rule || null,
  reason: r.reason,
  expiresAt: r.expires_at,
  grantedBy: { id: r.granted_by_id, email: r.granted_by_email },
  createdAt: r.created_at,
  active: r.expires_at > now(),
});

export async function listExemptions(id: string): Promise<InitiativeExemption[]> {
  return (await all<ExemptionRow>('SELECT * FROM initiative_exemptions WHERE org_id = ? AND initiative = ? ORDER BY expires_at DESC, entity', orgId(), id)).map(
    toExemption,
  );
}

/** Admins and the initiative's owner grant and revoke exemptions. */
export function assertMayExempt(p: Principal, i: Initiative) {
  if (!isAdmin(p) && !(i.owner && i.owner === p.email.toLowerCase())) throw forbidden('Only admins and the owner of the initiative grant exemptions');
}

export async function grantExemption(p: Principal, id: string, input: unknown): Promise<InitiativeExemption> {
  const i = await getInitiative(id);
  assertMayExempt(p, i);
  const x = initiativeExemptionInput.parse(input);
  const expiresAt = new Date(x.expiresAt).toISOString();
  if (expiresAt <= now()) throw badRequest('expiresAt must be in the future');
  if (Date.parse(expiresAt) > Date.now() + 366 * DAY) throw badRequest('An exemption lasts at most a year');
  const sc = await getScorecard(i.scorecard);
  if (x.rule && !sc.rules.some((r) => r.identifier === x.rule)) throw badRequest(`Rule "${x.rule}" is not a rule of scorecard ${sc.identifier}`);
  if (!(await one('SELECT 1 AS x FROM entities WHERE org_id = ? AND blueprint = ? AND identifier = ?', orgId(), sc.blueprint, x.entity)))
    throw notFound(`Entity ${sc.blueprint}/${x.entity}`);
  const rule = x.rule ?? '';
  await run(
    `INSERT INTO initiative_exemptions (id, org_id, initiative, entity, rule, reason, expires_at, granted_by_id, granted_by_email, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (org_id, initiative, entity, rule) DO UPDATE SET reason = excluded.reason, expires_at = excluded.expires_at,
       granted_by_id = excluded.granted_by_id, granted_by_email = excluded.granted_by_email, created_at = excluded.created_at`,
    newId(),
    orgId(),
    id,
    x.entity,
    rule,
    x.reason,
    expiresAt,
    p.id,
    p.email,
    now(),
  );
  const row = (await one<ExemptionRow>(
    'SELECT * FROM initiative_exemptions WHERE org_id = ? AND initiative = ? AND entity = ? AND rule = ?',
    orgId(),
    id,
    x.entity,
    rule,
  ))!;
  await audit({ id: p.id, email: p.email }, 'initiative.exemption.granted', id, { entity: x.entity, rule: x.rule ?? null, reason: x.reason, expiresAt });
  return toExemption(row);
}

export async function revokeExemption(p: Principal, id: string, exemptionId: string) {
  const i = await getInitiative(id);
  assertMayExempt(p, i);
  const row = await one<ExemptionRow>('SELECT * FROM initiative_exemptions WHERE org_id = ? AND initiative = ? AND id = ?', orgId(), id, exemptionId);
  if (!row) throw notFound(`Exemption ${exemptionId}`);
  await run('DELETE FROM initiative_exemptions WHERE org_id = ? AND id = ?', orgId(), exemptionId);
  await audit({ id: p.id, email: p.email }, 'initiative.exemption.revoked', id, { entity: row.entity, rule: row.rule || null });
}

// ---------- To do inbox ----------

/** Failing entities of the caller's teams, across the running initiatives. */
export async function myInitiativeItems(p: Principal, limit = 200): Promise<InitiativeTodo[]> {
  if (!p.teams.length) return [];
  const out: InitiativeTodo[] = [];
  const day = today();
  for (const i of await visible(p, await listInitiatives())) {
    if (!i.enabled || day < i.startDate) continue;
    let ev: Evaluation;
    try {
      ev = await evaluateInitiative(i, p.teams);
    } catch {
      continue;
    }
    for (const e of await readable(p, ev.sc, ev.entities)) {
      if (e.exempt || e.passing) continue;
      out.push({
        initiative: { identifier: i.identifier, title: i.title, deadline: i.deadline, targetLevel: i.targetLevel, daysLeft: daysLeft(i) },
        entity: { blueprint: ev.sc.blueprint, identifier: e.identifier, title: e.title, team: e.team },
        failing: e.failing,
      });
      if (out.length >= limit) return out;
    }
  }
  return out;
}

// ---------- background: snapshots, status events, reminders ----------
const EVENT: Partial<Record<InitiativeStatus, 'initiative.at_risk' | 'initiative.overdue' | 'initiative.completed'>> = {
  at_risk: 'initiative.at_risk',
  overdue: 'initiative.overdue',
  done: 'initiative.completed',
};

/** Write today's snapshot unless a replica already did (conditional UPDATE of `snapshot_day`). */
async function snapshot(i: Initiative, ev: Evaluation, day: string): Promise<boolean> {
  const org = orgId();
  const { changes } = await run(
    'UPDATE initiatives SET snapshot_day = ? WHERE org_id = ? AND identifier = ? AND (snapshot_day IS NULL OR snapshot_day < ?)',
    day,
    org,
    i.identifier,
    day,
  );
  if (!changes) return false;
  const { overall, byTeam } = aggregate(ev.entities);
  for (const [team, c] of [['', overall] as const, ...byTeam.map((t) => [teamKey(t.team), t] as const)])
    await run(
      `INSERT INTO initiative_snapshots (org_id, initiative, day, team, passing, total) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (org_id, initiative, day, team) DO UPDATE SET passing = excluded.passing, total = excluded.total`,
      org,
      i.identifier,
      day,
      team,
      c.passing,
      c.total,
    );
  return true;
}

/** Announce a status change once: the UPDATE only succeeds for the replica that saw the previous value. */
async function transition(i: Initiative, ev: Evaluation, prev: string | null, status: InitiativeStatus): Promise<boolean> {
  if ((prev ?? '') === status) return false;
  const { changes } = await run(
    "UPDATE initiatives SET status = ? WHERE org_id = ? AND identifier = ? AND COALESCE(status, '') = ?",
    status,
    orgId(),
    i.identifier,
    prev ?? '',
  );
  const type = EVENT[status];
  if (!changes || !type) return false;
  const { overall, byTeam } = aggregate(ev.entities);
  await emit({
    type,
    blueprint: ev.sc.blueprint,
    data: {
      initiative: { identifier: i.identifier, title: i.title, scorecard: i.scorecard, targetLevel: i.targetLevel, deadline: i.deadline, owner: i.owner },
      from: prev,
      status,
      progress: overall,
      teams: byTeam,
    },
  });
  return true;
}

/** Remind the members of the teams with failing entities (and the owner) when a reminder is due; claimed on `remind_at`. */
async function remind(i: Initiative, ev: Evaluation, dueAt: string | null, status: InitiativeStatus): Promise<number> {
  if (!i.reminderDays || !dueAt || dueAt > now() || status === 'done') return 0;
  const day = today();
  if (day < i.startDate || day > i.deadline) return 0;
  const next = new Date(Date.now() + i.reminderDays * DAY).toISOString();
  const { changes } = await run(
    'UPDATE initiatives SET remind_at = ? WHERE org_id = ? AND identifier = ? AND remind_at = ?',
    next,
    orgId(),
    i.identifier,
    dueAt,
  );
  if (!changes) return 0;
  const failingByTeam = new Map<string, number>();
  for (const e of ev.entities) if (!e.exempt && !e.passing && e.team) failingByTeam.set(e.team, (failingByTeam.get(e.team) ?? 0) + 1);
  const teams = [...failingByTeam.keys()];
  const people = new Map<string, { u: UserRow; failing: number }>();
  if (teams.length)
    for (const r of await all<UserRow & { team: string }>(
      `SELECT u.*, tm.team FROM team_members tm JOIN users u ON u.id = tm.user_id
       WHERE tm.org_id = ? AND tm.team IN (${teams.map(() => '?').join(',')}) AND u.active = 1 AND u.provider != 'service' ORDER BY u.name LIMIT 2000`,
      orgId(),
      ...teams,
    )) {
      const cur = people.get(r.id) ?? { u: r, failing: 0 };
      cur.failing += failingByTeam.get(r.team) ?? 0;
      people.set(r.id, cur);
    }
  if (i.owner) {
    const o = await one<UserRow>(
      "SELECT u.* FROM users u JOIN memberships m ON m.user_id = u.id WHERE m.org_id = ? AND u.email = ? AND u.active = 1 AND u.provider != 'service'",
      orgId(),
      i.owner,
    );
    if (o && !people.has(o.id)) people.set(o.id, { u: o, failing: -1 });
  }
  const { overall } = aggregate(ev.entities);
  const link = `/initiatives/${i.identifier}`;
  const url = await appUrl(link);
  let sent = 0;
  for (const { u, failing } of [...people.values()].slice(0, MAX_RECIPIENTS)) {
    const title = `Reminder: ${i.title}`;
    const body =
      failing >= 0
        ? `${failing} entit${failing === 1 ? 'y' : 'ies'} of your teams ${failing === 1 ? 'is' : 'are'} not at the target yet (deadline ${i.deadline}).`
        : `${overall.passing} of ${overall.total} entities are at the target (deadline ${i.deadline}).`;
    const fresh = await notify(u.id, { kind: 'initiative.reminder', title, body, link, dedupe: `initiative:${i.identifier}:${dueAt}` });
    if (!fresh) continue;
    sent++;
    // The channels people chose for requests that need them (Profile → Notifications → approvals).
    const prefs = await getNotificationPrefs(u.id);
    if (prefs.approvals.length) await deliver(u, prefs.approvals, title, body, url);
  }
  return sent;
}

/** One pass over the enabled initiatives of the current organization. */
export async function tickInitiatives(): Promise<{ snapshots: number; events: number; reminders: number }> {
  const out = { snapshots: 0, events: 0, reminders: 0 };
  const day = today();
  for (const r of await rows()) {
    const i = toInitiative(r);
    if (!i.enabled) continue;
    try {
      const ev = await evaluateInitiative(i);
      const status = statusOf(i, aggregate(ev.entities).overall);
      if (day >= i.startDate && (await snapshot(i, ev, day))) out.snapshots++;
      if (await transition(i, ev, r.status, status)) out.events++;
      out.reminders += await remind(i, ev, r.remind_at, status);
    } catch (err) {
      console.error(`[initiatives] ${i.identifier}: ${errorMessage(err)}`);
    }
  }
  return out;
}

/** Every organization (housekeeping). */
export async function tickAllInitiatives() {
  const total = { snapshots: 0, events: 0, reminders: 0 };
  await forEachOrg(async () => {
    const r = await tickInitiatives();
    total.snapshots += r.snapshots;
    total.events += r.events;
    total.reminders += r.reminders;
  }, 'initiatives');
  return total;
}

/** Dashboard widget data. */
export async function initiativeWidget(p: Principal, id: string) {
  const i = await visibleInitiative(p, id);
  const ev = await evaluateInitiative(i);
  const { overall, byTeam } = aggregate(ev.entities);
  return {
    type: 'initiative' as const,
    initiative: i.identifier,
    title: i.title,
    status: statusOf(i, overall),
    deadline: i.deadline,
    daysLeft: daysLeft(i),
    progress: overall,
    teams: byTeam.slice(0, 5),
  };
}
