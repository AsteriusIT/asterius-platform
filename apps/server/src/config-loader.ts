import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import { parseAllDocuments, stringify } from 'yaml';
import { config } from './config.js';
import { all, now, one, run, tryAdvisoryLock } from './db.js';
import { configFile, type ConfigFile } from './schemas.js';
import { errorMessage } from './lib/errors.js';
import { audit, SYSTEM } from './audit.js';
import { deleteTeam, listTeams, upsertTeam } from './auth/teams.js';
import { deleteBlueprint, listBlueprints, upsertBlueprint } from './catalog/blueprints.js';
import { deleteEntity, upsertEntity } from './catalog/entities.js';
import { deleteAction, listActions, upsertAction } from './actions/actions.js';
import { deleteIntegration, listIntegrations, upsertIntegration } from './integrations/integrations.js';
import { deleteScorecard, evaluateAllEntities, listScorecards, upsertScorecard } from './catalog/scorecards.js';
import { deleteDashboard, listDashboards, upsertDashboard } from './catalog/dashboards.js';
import { deleteWebhook, getWebhook, listWebhooks, upsertWebhook } from './webhooks/webhooks.js';

/**
 * Configuration as code. Every *.yaml / *.yml / *.json file of CONFIG_DIR (in production a ConfigMap or a
 * git-sync volume) may declare `teams`, `blueprints`, `actions`, `integrations`, `webhooks` and seed `entities`.
 * Declared resources are "managed": read-only in the UI/API, updated when the files change, and deleted when
 * removed from the files. Resources created in the UI live alongside them.
 * Files are re-read every minute; a change is applied by one replica at a time.
 */

const LOCK_KEY = 726202;

export interface LoadedConfig {
  files: string[];
  hash: string;
  data: ConfigFile;
}

export function readConfigDir(dir = config.CONFIG_DIR): LoadedConfig {
  const empty: ConfigFile = configFile.parse({});
  if (!fs.existsSync(dir)) return { files: [], hash: '', data: empty };
  const files = fs
    .readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((f) => f.isFile() && /\.(ya?ml|json)$/i.test(f.name) && !f.name.startsWith('.'))
    .map((f) => path.join(f.parentPath, f.name))
    .sort();
  const hash = createHash('sha256');
  const merged: ConfigFile = empty;
  const seen = new Map<string, string>();
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    hash.update(file).update(text);
    // merge: YAML merge keys (`<<: *anchor`) to share settings between resources of one file.
    const docs = parseAllDocuments(text, { merge: true });
    for (const doc of docs) {
      if (doc.errors.length) throw new Error(`${file}: ${doc.errors[0].message}`);
      const raw = doc.toJS();
      if (raw == null) continue;
      const parsed = configFile.safeParse(raw);
      if (!parsed.success) throw new Error(`${file}: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
      for (const kind of ['teams', 'blueprints', 'actions', 'integrations', 'webhooks'] as const)
        for (const item of parsed.data[kind]) {
          const key = `${kind}/${item.identifier}`;
          if (seen.has(key)) throw new Error(`${kind} "${item.identifier}" is declared twice (${seen.get(key)} and ${file})`);
          seen.set(key, file);
          (merged[kind] as unknown[]).push(item);
        }
      merged.entities.push(...parsed.data.entities);
    }
  }
  return { files, hash: hash.digest('hex'), data: merged };
}

async function applyKind<T extends { identifier: string }>(
  log: FastifyBaseLogger,
  errors: string[],
  kind: string,
  declared: T[],
  existing: { identifier: string; managed: boolean }[],
  upsert: (item: T) => Promise<{ created: boolean }>,
  remove: (id: string) => Promise<void>,
) {
  const ids = new Set(declared.map((d) => d.identifier));
  for (const item of declared) {
    try {
      const was = existing.find((e) => e.identifier === item.identifier);
      const { created } = await upsert(item);
      if (created) log.info(`config: ${kind} ${item.identifier} created`);
      else if (was && !was.managed) log.warn(`config: ${kind} ${item.identifier} created in the UI is now managed by configuration`);
    } catch (err) {
      errors.push(`${kind} ${item.identifier}: ${errorMessage(err)}`);
      log.error(`config: ${kind} ${item.identifier}: ${errorMessage(err)}`);
    }
  }
  for (const e of existing)
    if (e.managed && !ids.has(e.identifier))
      await remove(e.identifier).then(
        () => log.info(`config: ${kind} ${e.identifier} removed (no longer declared)`),
        (err) => log.warn(`config: ${kind} ${e.identifier} is no longer declared but cannot be removed: ${errorMessage(err)}`),
      );
}

/** Apply the declared resources; returns the per-item errors (the rest is applied regardless). */
export async function applyConfig(loaded: LoadedConfig, log: FastifyBaseLogger): Promise<string[]> {
  const { data } = loaded;
  const errs: string[] = [];
  const m = { managed: true };
  await applyKind(
    log,
    errs,
    'team',
    data.teams,
    await listTeams(),
    (t) => upsertTeam(t, m),
    (id) => deleteTeam(id, m),
  );
  const knownTargets = new Set([...data.blueprints.map((b) => b.identifier), ...(await listBlueprints()).map((b) => b.identifier)]);
  await applyKind(
    log,
    errs,
    'blueprint',
    data.blueprints,
    await listBlueprints(),
    (b) => upsertBlueprint(b, { ...m, knownTargets }),
    async () => undefined,
  );
  await applyKind(
    log,
    errs,
    'action',
    data.actions,
    await listActions(),
    (a) => upsertAction(a, m),
    (id) => deleteAction(id, m),
  );
  await applyKind(
    log,
    errs,
    'integration',
    data.integrations,
    await listIntegrations(),
    (i) => upsertIntegration(i, m),
    (id) => deleteIntegration(id, m),
  );
  await applyKind(
    log,
    errs,
    'webhook',
    data.webhooks,
    await listWebhooks(),
    (w) => upsertWebhook(w, m),
    (id) => deleteWebhook(id, m),
  );
  await applyKind(
    log,
    errs,
    'scorecard',
    data.scorecards,
    await listScorecards(),
    async (sc) => {
      const r = await upsertScorecard(sc, { ...m, knownBlueprints: knownTargets });
      if (r.changed) void evaluateAllEntities(r.scorecard).catch((err) => log.error(`config: scorecard ${sc.identifier}: ${errorMessage(err)}`));
      return r;
    },
    (id) => deleteScorecard(id, m),
  );
  await applyKind(
    log,
    errs,
    'dashboard',
    data.dashboards,
    await listDashboards(),
    (d) => upsertDashboard(d, m),
    (id) => deleteDashboard(id, m),
  );
  // Blueprints last: actions and integrations that used a removed blueprint are gone by now.
  // The entities the configuration seeded go with them; entities created by people or integrations keep their
  // blueprint (it stays, with a warning). Removed blueprints may relate to each other: retry until no progress.
  const declared = new Set(data.blueprints.map((b) => b.identifier));
  let removed = (await listBlueprints()).filter((b) => b.managed && !declared.has(b.identifier)).map((b) => b.identifier);
  for (const id of removed)
    for (const e of await all<{ identifier: string }>("SELECT identifier FROM entities WHERE blueprint = ? AND source = 'config'", id))
      await deleteEntity(id, e.identifier).catch((err) => log.warn(`config: entity ${id}/${e.identifier}: ${errorMessage(err)}`));
  const errors = new Map<string, string>();
  for (let progress = true; removed.length && progress;) {
    progress = false;
    for (const id of removed)
      await deleteBlueprint(id, m).then(
        () => {
          log.info(`config: blueprint ${id} removed`);
          removed = removed.filter((r) => r !== id);
          progress = true;
        },
        (err) => errors.set(id, errorMessage(err)),
      );
  }
  for (const id of removed) log.warn(`config: blueprint ${id} is no longer declared but cannot be removed: ${errors.get(id)}`);
  for (const e of data.entities) {
    const { blueprint, ...entity } = e;
    await upsertEntity(blueprint, entity, { source: 'config', skipExisting: true }).catch((err) => {
      errs.push(`entity ${blueprint}/${e.identifier}: ${errorMessage(err)}`);
      log.error(`config: entity ${blueprint}/${e.identifier}: ${errorMessage(err)}`);
    });
  }
  return errs;
}

let lastHash: string | undefined;
let failedAttempts = 0;
const MAX_RETRIES = 5;

export interface ConfigStatus {
  dir: string;
  /** Hash of the files on disk now (this replica). */
  currentHash: string | null;
  /** Hash last applied by any replica, when, and the errors it ended with. */
  appliedHash: string | null;
  appliedAt: string | null;
  files: string[];
  errors: string[];
  /** The files cannot be read or validated: the previous configuration stays in force. */
  readError: string | null;
  inSync: boolean;
}

let readError: string | null = null;

export async function configStatus(): Promise<ConfigStatus> {
  let currentHash: string | null = null;
  try {
    currentHash = readConfigDir().hash;
    readError = null;
  } catch (err) {
    readError = errorMessage(err);
  }
  const row = await one<{ hash: string; files: string; errors: string; applied_at: string }>('SELECT * FROM config_status WHERE id = 1');
  const errors: string[] = row ? JSON.parse(row.errors) : [];
  return {
    dir: config.CONFIG_DIR,
    currentHash,
    appliedHash: row?.hash ?? null,
    appliedAt: row?.applied_at ?? null,
    files: row ? JSON.parse(row.files) : [],
    errors,
    readError,
    inSync: !readError && !errors.length && (row?.hash ?? '') === (currentHash ?? ''),
  };
}

async function recordStatus(loaded: LoadedConfig, errors: string[]) {
  const files = JSON.stringify(loaded.files.map((f) => path.relative(config.CONFIG_DIR, f)));
  const vals = [loaded.hash, files, JSON.stringify(errors.slice(0, 100)), now()];
  const { changes } = await run('UPDATE config_status SET hash = ?, files = ?, errors = ?, applied_at = ? WHERE id = 1', ...vals);
  if (!changes) await run('INSERT INTO config_status (hash, files, errors, applied_at, id) VALUES (?, ?, ?, ?, 1)', ...vals);
}

type PlanAction = 'create' | 'update' | 'delete' | 'unchanged';
export interface PlanItem {
  kind: string;
  identifier: string;
  action: PlanAction;
  /** Top-level fields that differ (update). */
  changes?: string[];
}

/** What applying the files would do, without doing it: compares declared resources with the stored ones. */
export async function planConfig(loaded: LoadedConfig = readConfigDir()): Promise<PlanItem[]> {
  const out: PlanItem[] = [];
  // Actions are stored normalised (legacy `invoker` becomes `steps`/`trigger`): those fields cannot be compared textually.
  const plan = (kind: string, declared: Array<{ identifier: string }>, existing: Array<{ identifier: string; managed: boolean }>, ignore: string[] = []) => {
    const have = new Map(existing.map((e) => [e.identifier, e as unknown as Record<string, unknown>]));
    for (const d of declared) {
      const cur = have.get(d.identifier);
      if (!cur) {
        out.push({ kind, identifier: d.identifier, action: 'create' });
        continue;
      }
      const diff = Object.entries(d as Record<string, unknown>)
        .filter(([k, v]) => v !== undefined && !ignore.includes(k) && k in cur && JSON.stringify(cur[k]) !== JSON.stringify(v))
        .map(([k]) => k);
      if (!cur.managed) diff.push('managed');
      out.push({ kind, identifier: d.identifier, action: diff.length ? 'update' : 'unchanged', ...(diff.length ? { changes: diff } : {}) });
    }
    const ids = new Set(declared.map((d) => d.identifier));
    for (const e of existing) if (e.managed && !ids.has(e.identifier)) out.push({ kind, identifier: e.identifier, action: 'delete' });
  };
  const d = loaded.data;
  plan('team', d.teams, await listTeams());
  plan('blueprint', d.blueprints, await listBlueprints());
  plan('action', d.actions, await listActions(), ['trigger', 'steps', 'invoker']);
  plan('integration', d.integrations, await listIntegrations());
  plan('webhook', d.webhooks, await listWebhooks());
  return out;
}

/** Load once at startup, then watch for changes (ConfigMap updates, git-sync). */
export async function startConfigLoader(log: FastifyBaseLogger) {
  const check = async () => {
    let loaded: LoadedConfig;
    try {
      loaded = readConfigDir();
      readError = null;
    } catch (err) {
      readError = errorMessage(err);
      log.error(`config: ${readError} (keeping the current configuration)`);
      return;
    }
    if (loaded.hash === lastHash) return;
    // Try once: when another replica is applying, skip and look again at the next tick.
    const value = await tryAdvisoryLock(LOCK_KEY, async () => {
      const row = await one<{ hash: string; errors: string }>('SELECT hash, errors FROM config_status WHERE id = 1');
      if (row?.hash === loaded.hash && !JSON.parse(row.errors).length) return 'already-applied' as const; // another replica did it
      if (row?.hash === loaded.hash && failedAttempts >= MAX_RETRIES) return 'gave-up' as const;
      const errors = await applyConfig(loaded, log);
      await recordStatus(loaded, errors);
      failedAttempts = errors.length ? failedAttempts + 1 : 0;
      return errors.length ? ('errors' as const) : ('applied' as const);
    });
    if (value === undefined) return;
    if (value === 'applied' || value === 'already-applied' || value === 'gave-up') lastHash = loaded.hash;
    if (value === 'applied' && loaded.files.length) {
      log.info(`config: applied ${loaded.files.length} file(s) from ${config.CONFIG_DIR}`);
      await audit(SYSTEM, 'config.applied', config.CONFIG_DIR, {
        files: loaded.files.map((f) => path.relative(config.CONFIG_DIR, f)),
        hash: loaded.hash.slice(0, 12),
      });
    }
    if (value === 'errors') log.warn(`config: applied with errors, retrying (${failedAttempts}/${MAX_RETRIES})`);
  };
  await check();
  const timer = setInterval(() => check().catch((err) => log.error({ err }, 'config reload failed')), 60_000);
  timer.unref();
  return {
    reload: async () => {
      lastHash = undefined;
      failedAttempts = 0;
      await check();
    },
    stop: () => clearInterval(timer),
  };
}

/** Everything configurable, as a config file: move resources created in the UI into Git. */
export async function exportConfig(): Promise<string> {
  const strip = <T extends Record<string, unknown>>(o: T, keys: string[]) => Object.fromEntries(Object.entries(o).filter(([k]) => !keys.includes(k)));
  const webhooks = await Promise.all(
    (await listWebhooks()).map(async (w) => {
      const full = await getWebhook(w.identifier);
      return {
        ...strip(w as never, ['managed', 'hasSecret', 'hasSecondarySecret']),
        secret: full.secret ?? undefined,
        secondarySecret: full.secondarySecret ?? undefined,
      };
    }),
  );
  const doc = {
    teams: (await listTeams()).map((t) => strip(t as never, ['managed', 'members'])),
    blueprints: (await listBlueprints()).map((b) => strip(b as never, ['managed', 'entityCount', 'createdAt', 'updatedAt'])),
    actions: (await listActions()).map((a) => strip(a as never, ['managed'])),
    integrations: (await listIntegrations()).map((i) => strip(i as never, ['managed', 'lastSync', 'webhookUrl'])),
    webhooks,
    scorecards: (await listScorecards()).map((s) => strip(s as never, ['managed'])),
    dashboards: (await listDashboards()).map((d) => strip(d as never, ['managed'])),
  };
  return `# Exported ${new Date().toISOString()} — secrets are references (\${secret:NAME}), never values.\n${stringify(doc, { lineWidth: 140 })}`;
}

/** Counts shown on the admin page. */
export async function managedCounts() {
  const rows = await all<{ k: string; n: number }>(
    `SELECT 'blueprints' AS k, count(*) AS n FROM blueprints WHERE managed = 1
     UNION ALL SELECT 'actions', count(*) FROM actions WHERE managed = 1
     UNION ALL SELECT 'integrations', count(*) FROM integrations WHERE managed = 1
     UNION ALL SELECT 'webhooks', count(*) FROM webhooks WHERE managed = 1
     UNION ALL SELECT 'scorecards', count(*) FROM scorecards WHERE managed = 1
     UNION ALL SELECT 'dashboards', count(*) FROM dashboards WHERE managed = 1
     UNION ALL SELECT 'teams', count(*) FROM teams WHERE managed = 1`,
  );
  return Object.fromEntries(rows.map((r) => [r.k, Number(r.n)]));
}
