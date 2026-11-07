import type { DoraBand, Entity, Insights } from '@asterius/shared';
import type { Principal } from '../auth/users.js';
import { visibleBlueprints } from '../auth/access.js';
import { listRuns } from '../actions/runs.js';
import type { InsightsConfig } from '../schemas.js';
import { getBlueprintCached } from './blueprints.js';
import { findEntity, searchEntities } from './entities.js';

/**
 * DORA metrics over a window, computed from the catalog (deployment and incident entities, e.g. the Argo CD and
 * PagerDuty presets) and from runs of actions declared as deployments. Everything is scoped to the current organization
 * and to what the viewer may read. A metric without data is null, never NaN.
 */

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const SCAN_PAGE = 500;
const SCAN_MAX = 10_000;

/** DORA performance bands (State of DevOps thresholds). */
export const bands = {
  deploymentFrequency: (perDay: number): DoraBand => (perDay >= 1 ? 'elite' : perDay >= 1 / 7 ? 'high' : perDay >= 1 / 30 ? 'medium' : 'low'),
  leadTime: (hours: number): DoraBand => (hours < 24 ? 'elite' : hours < 24 * 7 ? 'high' : hours < 24 * 30 ? 'medium' : 'low'),
  changeFailureRate: (ratio: number): DoraBand => (ratio <= 0.05 ? 'elite' : ratio <= 0.1 ? 'high' : ratio <= 0.15 ? 'medium' : 'low'),
  mttr: (hours: number): DoraBand => (hours < 1 ? 'elite' : hours < 24 ? 'high' : hours < 24 * 7 ? 'medium' : 'low'),
};

const ms = (v: unknown): number | null => {
  if (typeof v !== 'string' && typeof v !== 'number') return null;
  const t = typeof v === 'number' ? v : Date.parse(v);
  return Number.isFinite(t) ? t : null;
};

const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

const round = (n: number, d = 2) => Math.round(n * 10 ** d) / 10 ** d;

async function readable(blueprint: string, p: Principal): Promise<boolean> {
  try {
    return (await visibleBlueprints(p, [await getBlueprintCached(blueprint)])).length > 0;
  } catch {
    return false; // unknown blueprint: no data
  }
}

/** Entities of a blueprint the viewer may read (capped), filtered by owner team. */
async function scan(blueprint: string, team: string | undefined, p: Principal): Promise<Entity[]> {
  const out: Entity[] = [];
  for (let offset = 0; offset < SCAN_MAX; offset += SCAN_PAGE) {
    const page = await searchEntities({ blueprint, team, limit: SCAN_PAGE, offset, count: false, viewer: p });
    out.push(...page.items);
    if (page.items.length < SCAN_PAGE) break;
  }
  return out;
}

const relationTargets = (e: Entity, relation: string): string[] => {
  const v = (e.relations as Record<string, unknown>)[relation];
  return (Array.isArray(v) ? v : v == null ? [] : [v]).map(String);
};

const matchesService = (e: Entity, service: string | undefined, relation: string) =>
  !service || e.identifier === service || relationTargets(e, relation).includes(service);

interface Deploy {
  at: number;
  failed: boolean;
  mergedAt: number | null;
}

export async function computeInsights(cfg: InsightsConfig, p: Principal, nowMs = Date.now()): Promise<Insights> {
  const until = nowMs;
  const since = until - cfg.days * DAY;
  const inWindow = (t: number | null): t is number => t !== null && t >= since && t <= until;
  const dep = cfg.deployments;

  // ---- deployments ----
  let haveDeploySource = false;
  const deploys: Deploy[] = [];
  if (await readable(dep.blueprint, p)) {
    haveDeploySource = true;
    const ok = new Set(dep.successValues.map((s) => s.toLowerCase()));
    const bad = new Set(dep.failureValues.map((s) => s.toLowerCase()));
    for (const e of await scan(dep.blueprint, cfg.team, p)) {
      if (!matchesService(e, cfg.service, dep.serviceRelation)) continue;
      const at = ms(e.properties[dep.timeProperty]) ?? ms(e.createdAt);
      if (!inWindow(at)) continue;
      const status = String(e.properties[dep.statusProperty] ?? '').toLowerCase();
      // Entities in a state that is neither success nor failure (in progress, unknown) are not finished deployments.
      if (!ok.has(status) && !bad.has(status)) continue;
      deploys.push({ at, failed: bad.has(status), mergedAt: ms(e.properties[dep.mergedProperty]) });
    }
  }
  if (cfg.deploymentActions.length) {
    haveDeploySource = true;
    const teamOf = new Map<string, string | null>();
    for (const action of cfg.deploymentActions) {
      let cursor: string | undefined;
      for (let pages = 0; pages < 50; pages++) {
        const page = await listRuns({ action, status: ['SUCCESS', 'FAILURE'], limit: 200, offset: 0, cursor, count: false }, p);
        let older = false;
        for (const r of page.items) {
          const at = ms(r.endedAt) ?? ms(r.createdAt);
          if ((ms(r.createdAt) ?? 0) < since) older = true;
          if (!inWindow(at)) continue;
          if (cfg.service && r.entity !== cfg.service) continue;
          if (cfg.team) {
            const key = `${r.blueprint}/${r.entity}`;
            if (!teamOf.has(key)) teamOf.set(key, r.blueprint && r.entity ? ((await findEntity(r.blueprint, r.entity))?.team ?? null) : null);
            if (teamOf.get(key) !== cfg.team) continue;
          }
          deploys.push({ at, failed: r.status === 'FAILURE', mergedAt: null });
        }
        if (older || !page.nextCursor) break;
        cursor = page.nextCursor;
      }
    }
  }

  const failed = deploys.filter((d) => d.failed).length;
  const successes = deploys.filter((d) => !d.failed);
  const freq = haveDeploySource ? successes.length / cfg.days : null;
  const leads = successes.flatMap((d) => (d.mergedAt !== null && d.at >= d.mergedAt ? [(d.at - d.mergedAt) / HOUR] : []));
  const lead = median(leads);
  const cfr = deploys.length ? failed / deploys.length : null;

  // ---- incidents ----
  const inc = cfg.incidents;
  const durations: number[] = [];
  if (await readable(inc.blueprint, p)) {
    for (const e of await scan(inc.blueprint, cfg.team, p)) {
      if (!matchesService(e, cfg.service, inc.serviceRelation)) continue;
      const created = ms(e.properties[inc.createdProperty]) ?? ms(e.createdAt);
      const resolved = ms(e.properties[inc.resolvedProperty]);
      if (!inWindow(created) || resolved === null || resolved < created) continue;
      durations.push((resolved - created) / HOUR);
    }
  }
  const mttr = median(durations);

  return {
    days: cfg.days,
    since: new Date(since).toISOString(),
    until: new Date(until).toISOString(),
    deploymentFrequency: {
      value: freq === null ? null : round(freq, 3),
      unit: 'per_day',
      count: successes.length,
      band: freq === null ? null : bands.deploymentFrequency(freq),
    },
    leadTime: { value: lead === null ? null : round(lead), unit: 'hours', samples: leads.length, band: lead === null ? null : bands.leadTime(lead) },
    changeFailureRate: {
      value: cfr === null ? null : round(cfr, 4),
      unit: 'ratio',
      failed,
      total: deploys.length,
      band: cfr === null ? null : bands.changeFailureRate(cfr),
    },
    mttr: { value: mttr === null ? null : round(mttr), unit: 'hours', incidents: durations.length, band: mttr === null ? null : bands.mttr(mttr) },
  };
}
