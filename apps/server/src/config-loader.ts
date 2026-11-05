import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import { parseAllDocuments, stringify } from 'yaml';
import { config } from './config.js';
import { all, withAdvisoryLock } from './db.js';
import { configFile, type ConfigFile } from './schemas.js';
import { errorMessage } from './lib/errors.js';
import { audit, SYSTEM } from './audit.js';
import { deleteTeam, listTeams, upsertTeam } from './auth/teams.js';
import { deleteBlueprint, listBlueprints, upsertBlueprint } from './catalog/blueprints.js';
import { deleteEntity, upsertEntity } from './catalog/entities.js';
import { deleteAction, listActions, upsertAction } from './actions/actions.js';
import { deleteIntegration, listIntegrations, upsertIntegration } from './integrations/integrations.js';
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

export async function applyConfig(loaded: LoadedConfig, log: FastifyBaseLogger) {
  const { data } = loaded;
  const m = { managed: true };
  await applyKind(
    log,
    'team',
    data.teams,
    await listTeams(),
    (t) => upsertTeam(t, m),
    (id) => deleteTeam(id, m),
  );
  const knownTargets = new Set([...data.blueprints.map((b) => b.identifier), ...(await listBlueprints()).map((b) => b.identifier)]);
  await applyKind(
    log,
    'blueprint',
    data.blueprints,
    await listBlueprints(),
    (b) => upsertBlueprint(b, { ...m, knownTargets }),
    async () => undefined,
  );
  await applyKind(
    log,
    'action',
    data.actions,
    await listActions(),
    (a) => upsertAction(a, m),
    (id) => deleteAction(id, m),
  );
  await applyKind(
    log,
    'integration',
    data.integrations,
    await listIntegrations(),
    (i) => upsertIntegration(i, m),
    (id) => deleteIntegration(id, m),
  );
  await applyKind(
    log,
    'webhook',
    data.webhooks,
    await listWebhooks(),
    (w) => upsertWebhook(w, m),
    (id) => deleteWebhook(id, m),
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
    await upsertEntity(blueprint, entity, { source: 'config', skipExisting: true }).catch((err) =>
      log.error(`config: entity ${blueprint}/${e.identifier}: ${errorMessage(err)}`),
    );
  }
}

let lastHash: string | undefined;

/** Load once at startup, then watch for changes (ConfigMap updates, git-sync). */
export async function startConfigLoader(log: FastifyBaseLogger) {
  const check = async () => {
    let loaded: LoadedConfig;
    try {
      loaded = readConfigDir();
    } catch (err) {
      log.error(`config: ${errorMessage(err)} (keeping the current configuration)`);
      return;
    }
    if (loaded.hash === lastHash) return;
    await withAdvisoryLock(LOCK_KEY, async () => {
      await applyConfig(loaded, log);
      lastHash = loaded.hash;
    });
    if (loaded.files.length) {
      log.info(`config: applied ${loaded.files.length} file(s) from ${config.CONFIG_DIR}`);
      await audit(SYSTEM, 'config.applied', config.CONFIG_DIR, {
        files: loaded.files.map((f) => path.relative(config.CONFIG_DIR, f)),
        hash: loaded.hash.slice(0, 12),
      });
    }
  };
  await check();
  const timer = setInterval(() => check().catch((err) => log.error({ err }, 'config reload failed')), 60_000);
  timer.unref();
  return {
    reload: async () => {
      lastHash = undefined;
      await check();
    },
    stop: () => clearInterval(timer),
  };
}

/** Everything configurable, as a config file: move resources created in the UI into Git. */
export async function exportConfig(): Promise<string> {
  const strip = <T extends Record<string, unknown>>(o: T, keys: string[]) => Object.fromEntries(Object.entries(o).filter(([k]) => !keys.includes(k)));
  const webhooks = await Promise.all(
    (await listWebhooks()).map(async (w) => ({ ...strip(w as never, ['managed', 'hasSecret']), secret: (await getWebhook(w.identifier)).secret ?? undefined })),
  );
  const doc = {
    teams: (await listTeams()).map((t) => strip(t as never, ['managed', 'members'])),
    blueprints: (await listBlueprints()).map((b) => strip(b as never, ['managed', 'entityCount', 'createdAt', 'updatedAt'])),
    actions: (await listActions()).map((a) => strip(a as never, ['managed'])),
    integrations: (await listIntegrations()).map((i) => strip(i as never, ['managed', 'lastSync', 'webhookUrl'])),
    webhooks,
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
     UNION ALL SELECT 'teams', count(*) FROM teams WHERE managed = 1`,
  );
  return Object.fromEntries(rows.map((r) => [r.k, Number(r.n)]));
}
