import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import { parseAllDocuments, stringify } from 'yaml';
import { config } from './config.js';
import { all, now, one, run, tryAdvisoryLock } from './db.js';
import { configFile, type ConfigFile, type OrgDecl } from './schemas.js';
import type { ConfigSyncStatus } from '@asterius/shared';
import { DEFAULT_ORG, orgId, withOrg } from './orgs/context.js';
import { addMember, createOrg, findOrg, listOrgRows, patchSettings, settingsOf, updateOrg, type OrgRow } from './orgs/orgs.js';
import { pullGitSource } from './orgs/git-source.js';
import { errorMessage } from './lib/errors.js';
import { audit, SYSTEM } from './audit.js';
import { deleteTeam, listTeams, upsertTeam } from './auth/teams.js';
import { deleteBlueprint, listBlueprints, upsertBlueprint } from './catalog/blueprints.js';
import { deleteEntity, upsertEntity } from './catalog/entities.js';
import { deleteAction, listActions, upsertAction } from './actions/actions.js';
import { deleteIntegration, listIntegrations, upsertIntegration } from './integrations/integrations.js';
import { deleteScorecard, evaluateAllEntities, listScorecards, upsertScorecard } from './catalog/scorecards.js';
import { deletePolicy, listPolicies, upsertPolicy } from './policies/policies.js';
import { deleteDashboard, listDashboards, upsertDashboard } from './catalog/dashboards.js';
import { deleteWebhook, getWebhook, listWebhooks, upsertWebhook } from './webhooks/webhooks.js';
import { deleteFragment, dependencyOrder, listFragments, upsertFragment } from './actions/fragments.js';

/**
 * Configuration as code, per organization. Files (*.yaml / *.yml / *.json) declare `teams`, `blueprints`, `fragments`, `actions`,
 * `integrations`, `webhooks`, `scorecards`, `policies`, `dashboards` and seed `entities` of one organization:
 *   CONFIG_DIR/*                 the default organization, plus `organizations:` (platform-level declarations)
 *   CONFIG_DIR/orgs/<slug>/**    organization <slug> (a ConfigMap or git-sync volume per tenant)
 *   a Git repository             set by the organization's admins (Settings → Configuration as code)
 * Declared resources are "managed": read-only in the UI/API, updated when the files change, and deleted when
 * removed from the files. Resources created in the UI live alongside them.
 * Sources are re-read every minute; a change is applied by one replica at a time.
 */

const LOCK_KEY = 726202;

export interface LoadedConfig {
  files: string[];
  hash: string;
  data: ConfigFile;
}

const MAX_FILES = 500;

/**
 * Read the configuration files under `dir`. `platform`: the CONFIG_DIR root (may declare organizations; the per-org
 * directories under orgs/ are skipped). Otherwise an organization's own files (no `organizations:` allowed).
 */
export function readConfigDir(dir = config.CONFIG_DIR, opts: { platform?: boolean } = { platform: true }): LoadedConfig {
  const empty: ConfigFile = configFile.parse({});
  if (!fs.existsSync(dir)) return { files: [], hash: '', data: empty };
  const orgsDir = path.join(dir, 'orgs');
  const root = fs.realpathSync(dir);
  const files = fs
    .readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((f) => (f.isFile() || f.isSymbolicLink()) && /\.(ya?ml|json)$/i.test(f.name))
    .map((f) => path.join(f.parentPath, f.name))
    // Hidden files and directories are skipped: .git, and the ..data / ..<timestamp> directories of Kubernetes
    // ConfigMap and Secret volumes, which hold a second copy of every file.
    .filter((f) =>
      path
        .relative(dir, f)
        .split(path.sep)
        .every((s) => !s.startsWith('.')),
    )
    .filter((f) => !opts.platform || !(f === orgsDir || f.startsWith(`${orgsDir}${path.sep}`)))
    // Symlinks are followed to regular files inside the directory only (ConfigMap volumes are symlinks into
    // ..data); an organization's repository cannot point the loader at a file elsewhere on the server.
    .filter((f) => {
      try {
        const real = fs.realpathSync(f);
        return real.startsWith(`${root}${path.sep}`) && fs.statSync(real).isFile();
      } catch {
        return false; // dangling link
      }
    })
    .sort();
  if (files.length > MAX_FILES) throw new Error(`too many configuration files (${files.length}, max ${MAX_FILES})`);
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
      if (!opts.platform && parsed.data.organizations.length) throw new Error(`${file}: organizations can only be declared in the platform configuration`);
      merged.organizations.push(...parsed.data.organizations);
      for (const kind of ['teams', 'blueprints', 'fragments', 'actions', 'integrations', 'webhooks', 'scorecards', 'policies', 'dashboards'] as const)
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
      if (created) log.info({ component: 'config', kind, identifier: item.identifier }, 'config resource created');
      else if (was && !was.managed)
        log.warn({ component: 'config', kind, identifier: item.identifier }, 'resource created in the UI is now managed by configuration');
    } catch (err) {
      errors.push(`${kind} ${item.identifier}: ${errorMessage(err)}`);
      log.error({ component: 'config', kind, identifier: item.identifier, err }, 'config resource rejected');
    }
  }
  for (const e of existing)
    if (e.managed && !ids.has(e.identifier))
      await remove(e.identifier).then(
        () => log.info({ component: 'config', kind, identifier: e.identifier }, 'config resource removed (no longer declared)'),
        (err) => log.warn({ component: 'config', kind, identifier: e.identifier, err }, 'resource is no longer declared but cannot be removed'),
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
  // Fragments before the actions that include them; removed ones after the actions (deleting a used one is refused).
  await applyKind(
    log,
    errs,
    'fragment',
    dependencyOrder(data.fragments),
    await listFragments(),
    (f) => upsertFragment(f, m),
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
  const fragmentIds = new Set(data.fragments.map((f) => f.identifier));
  for (const f of await listFragments())
    if (f.managed && !fragmentIds.has(f.identifier))
      await deleteFragment(f.identifier, m).then(
        () => log.info({ component: 'config', kind: 'fragment', identifier: f.identifier }, 'config resource removed (no longer declared)'),
        (err) => log.warn({ component: 'config', kind: 'fragment', identifier: f.identifier, err }, 'resource is no longer declared but cannot be removed'),
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
    'policy',
    data.policies,
    await listPolicies(),
    (p) => upsertPolicy(p, m),
    (id) => deletePolicy(id, m),
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
    for (const e of await all<{ identifier: string }>("SELECT identifier FROM entities WHERE org_id = ? AND blueprint = ? AND source = 'config'", orgId(), id))
      await deleteEntity(id, e.identifier).catch((err) =>
        log.warn({ component: 'config', blueprint: id, identifier: e.identifier, err }, 'seeded entity cannot be removed'),
      );
  const errors = new Map<string, string>();
  for (let progress = true; removed.length && progress;) {
    progress = false;
    for (const id of removed)
      await deleteBlueprint(id, m).then(
        () => {
          log.info({ component: 'config', kind: 'blueprint', identifier: id }, 'config resource removed');
          removed = removed.filter((r) => r !== id);
          progress = true;
        },
        (err) => errors.set(id, errorMessage(err)),
      );
  }
  for (const id of removed)
    log.warn({ component: 'config', kind: 'blueprint', identifier: id, reason: errors.get(id) }, 'blueprint is no longer declared but cannot be removed');
  for (const e of data.entities) {
    const { blueprint, ...entity } = e;
    await upsertEntity(blueprint, entity, { source: 'config', skipExisting: true }).catch((err) => {
      errs.push(`entity ${blueprint}/${e.identifier}: ${errorMessage(err)}`);
      log.error({ component: 'config', blueprint, identifier: e.identifier, err }, 'seeded entity rejected');
    });
  }
  return errs;
}

// ---------- status (per organization) ----------
const MAX_RETRIES = 5;
/** Per replica: last content applied per organization (the advisory lock serializes applies across replicas). */
const lastHash = new Map<string, string>();
const failedAttempts = new Map<string, number>();
const lastGitPull = new Map<string, number>();
const GIT_PULL_MS = 120_000;

const sourceOf = (o: OrgRow) => settingsOf(o).configSource ?? { type: o.id === DEFAULT_ORG ? ('directory' as const) : ('none' as const) };

/** Directory holding an organization's files on this replica (directory sources): CONFIG_DIR or CONFIG_DIR/orgs/<slug>. */
function orgDir(o: OrgRow): string | null {
  if (sourceOf(o).type !== 'directory') return null;
  return o.id === DEFAULT_ORG ? config.CONFIG_DIR : path.join(config.CONFIG_DIR, 'orgs', o.slug);
}

/** The configuration declared for an organization now: its directory, its Git repository (pulled), or nothing. */
async function loadOrgSource(o: OrgRow): Promise<LoadedConfig> {
  const src = sourceOf(o);
  if (src.type === 'git') {
    const { dir } = await withOrg(o.id, () => pullGitSource(o.id, src));
    return readConfigDir(dir, { platform: false });
  }
  const dir = orgDir(o);
  return dir ? readConfigDir(dir, { platform: o.id === DEFAULT_ORG }) : { files: [], hash: '', data: configFile.parse({}) };
}

const currentOrgRow = async () => (await findOrg(orgId()))!;

export interface ConfigStatus {
  source: 'directory' | 'git' | 'none';
  /** Directory of the files (directory sources). */
  dir: string | null;
  /** Hash of the files on disk now (this replica, directory sources). */
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

/** Configuration-as-code status of the current organization. */
export async function configStatus(): Promise<ConfigStatus> {
  const org = await currentOrgRow();
  const dir = orgDir(org);
  let currentHash: string | null = null;
  let readError: string | null = null;
  if (dir)
    try {
      currentHash = readConfigDir(dir, { platform: org.id === DEFAULT_ORG }).hash;
    } catch (err) {
      readError = errorMessage(err);
    }
  const row = await one<{ hash: string; files: string; errors: string; applied_at: string }>('SELECT * FROM config_status WHERE org_id = ?', org.id);
  const errors: string[] = row ? JSON.parse(row.errors) : [];
  return {
    source: sourceOf(org).type,
    dir,
    currentHash,
    appliedHash: row?.hash ?? null,
    appliedAt: row?.applied_at ?? null,
    files: row ? JSON.parse(row.files) : [],
    errors,
    readError,
    inSync: !readError && !errors.length && (!dir || (row?.hash ?? '') === (currentHash ?? '')),
  };
}

async function recordStatus(org: string, loaded: LoadedConfig, errors: string[], base: string | null) {
  const files = JSON.stringify(loaded.files.map((f) => (base ? path.relative(base, f) : path.basename(f))));
  const vals = [loaded.hash, files, JSON.stringify(errors.slice(0, 100)), now()];
  const { changes } = await run('UPDATE config_status SET hash = ?, files = ?, errors = ?, applied_at = ? WHERE org_id = ?', ...vals, org);
  if (!changes) await run('INSERT INTO config_status (hash, files, errors, applied_at, org_id) VALUES (?, ?, ?, ?, ?)', ...vals, org);
}

type PlanAction = 'create' | 'update' | 'delete' | 'unchanged';
export interface PlanItem {
  kind: string;
  identifier: string;
  action: PlanAction;
  /** Top-level fields that differ (update). */
  changes?: string[];
}

/** What applying the current organization's files would do, without doing it: declared vs stored resources. */
export async function planConfig(loaded?: LoadedConfig): Promise<PlanItem[]> {
  loaded ??= await loadOrgSource(await currentOrgRow());
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
  plan('fragment', d.fragments, await listFragments());
  plan('action', d.actions, await listActions(), ['trigger', 'steps', 'invoker']);
  plan('integration', d.integrations, await listIntegrations());
  plan('webhook', d.webhooks, await listWebhooks());
  plan('scorecard', d.scorecards, await listScorecards());
  plan('policy', d.policies, await listPolicies());
  plan('dashboard', d.dashboards, await listDashboards());
  return out;
}

const KINDS = ['teams', 'blueprints', 'fragments', 'actions', 'integrations', 'webhooks', 'scorecards', 'policies', 'dashboards'] as const;

/** What a reload of the current organization would change: declared vs currently managed identifiers. Nothing is applied. */
export async function configDiff() {
  const org = await currentOrgRow();
  let loaded: LoadedConfig;
  try {
    loaded = await loadOrgSource(org);
  } catch (err) {
    return { error: errorMessage(err), kinds: {} as Record<string, { added: string[]; removed: string[]; kept: string[] }> };
  }
  const current: Record<(typeof KINDS)[number], { identifier: string; managed: boolean }[]> = {
    teams: await listTeams(),
    blueprints: await listBlueprints(),
    fragments: await listFragments(),
    actions: await listActions(),
    integrations: await listIntegrations(),
    webhooks: await listWebhooks(),
    scorecards: await listScorecards(),
    policies: await listPolicies(),
    dashboards: await listDashboards(),
  };
  const kinds: Record<string, { added: string[]; removed: string[]; kept: string[] }> = {};
  for (const k of KINDS) {
    const declared = new Set(loaded.data[k].map((d) => d.identifier));
    const managed = new Set(current[k].filter((c) => c.managed).map((c) => c.identifier));
    kinds[k] = {
      added: [...declared].filter((d) => !managed.has(d)),
      removed: [...managed].filter((m) => !declared.has(m)),
      kept: [...declared].filter((d) => managed.has(d)),
    };
  }
  return { error: null, pending: loaded.hash !== lastHash.get(org.id), kinds };
}

/**
 * Import resources from an exported YAML into the current organization: validates every document, then (unless
 * `dryRun`) creates or updates them as regular, editable resources (not managed). Returns counts per kind.
 */
export async function importConfig(text: string, dryRun: boolean): Promise<Record<string, number>> {
  const merged: ConfigFile = configFile.parse({});
  for (const doc of parseAllDocuments(text, { merge: true })) {
    if (doc.errors.length) throw new Error(doc.errors[0].message);
    const raw = doc.toJS();
    if (raw == null) continue;
    const parsed = configFile.safeParse(raw);
    if (!parsed.success) throw new Error(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
    if (parsed.data.organizations.length) throw new Error('organizations can only be declared in the platform configuration');
    for (const k of KINDS) (merged[k] as unknown[]).push(...parsed.data[k]);
  }
  const counts = Object.fromEntries(KINDS.map((k) => [k, merged[k].length]));
  if (dryRun) return counts;
  for (const t of merged.teams) await upsertTeam(t);
  const knownTargets = new Set([...merged.blueprints.map((b) => b.identifier), ...(await listBlueprints()).map((b) => b.identifier)]);
  for (const b of merged.blueprints) await upsertBlueprint(b, { knownTargets });
  for (const f of dependencyOrder(merged.fragments)) await upsertFragment(f);
  for (const a of merged.actions) await upsertAction(a);
  for (const i of merged.integrations) await upsertIntegration(i);
  for (const w of merged.webhooks) await upsertWebhook(w);
  for (const sc of merged.scorecards) await upsertScorecard(sc, { knownBlueprints: knownTargets });
  for (const p of merged.policies) await upsertPolicy(p);
  for (const d of merged.dashboards) await upsertDashboard(d);
  return counts;
}

// ---------- sources and scheduling ----------

async function setStatus(orgIdValue: string, status: ConfigSyncStatus) {
  await patchSettings(orgIdValue, { configStatus: status }).catch(() => undefined);
}

/**
 * Apply one organization's files when they changed. Non-blocking across replicas: when another replica holds the
 * lock, skip and look again at the next tick. A content that keeps failing is retried MAX_RETRIES times.
 */
async function applyOrgConfig(org: OrgRow, loaded: LoadedConfig, log: FastifyBaseLogger, label: string, revision: string | null = null) {
  if (loaded.hash === lastHash.get(org.id)) return;
  const outcome = await tryAdvisoryLock(LOCK_KEY, () =>
    withOrg(org.id, async () => {
      const row = await one<{ hash: string; errors: string }>('SELECT hash, errors FROM config_status WHERE org_id = ?', org.id);
      if (row?.hash === loaded.hash && !JSON.parse(row.errors).length) return { state: 'already-applied' as const, errors: [] as string[] };
      if (row?.hash === loaded.hash && (failedAttempts.get(org.id) ?? 0) >= MAX_RETRIES)
        return { state: 'gave-up' as const, errors: JSON.parse(row.errors) as string[] };
      const errors = await applyConfig(loaded, log);
      await recordStatus(org.id, loaded, errors, orgDir(org));
      failedAttempts.set(org.id, errors.length ? (failedAttempts.get(org.id) ?? 0) + 1 : 0);
      return { state: errors.length ? ('errors' as const) : ('applied' as const), errors };
    }),
  );
  if (outcome === undefined) return;
  if (outcome.state !== 'errors') lastHash.set(org.id, loaded.hash);
  if (outcome.state === 'applied' && loaded.files.length) {
    log.info({ component: 'config', org: org.slug, files: loaded.files.length, source: label }, 'config applied');
    await audit(SYSTEM, 'config.applied', label, { files: loaded.files.length, hash: loaded.hash.slice(0, 12), revision }, org.id);
  }
  if (outcome.state === 'errors')
    log.warn({ component: 'config', org: org.slug }, `config applied with errors, retrying (${failedAttempts.get(org.id)}/${MAX_RETRIES})`);
  await setStatus(org.id, {
    at: new Date().toISOString(),
    ok: !outcome.errors.length,
    revision,
    files: loaded.files.length,
    error: outcome.errors.length ? outcome.errors.slice(0, 3).join('; ').slice(0, 500) : null,
  });
}

/** Organizations declared in the platform files: created or updated (never deleted), admins added once they exist. */
async function applyOrganizations(decls: OrgDecl[], log: FastifyBaseLogger) {
  for (const d of decls) {
    try {
      const existing = await findOrg(d.slug);
      const org = existing
        ? await updateOrg(existing.id, { name: d.name, domains: d.domains }, { managed: true })
        : await createOrg({ slug: d.slug, name: d.name, domains: d.domains }, { managed: true });
      if (!existing) log.info({ component: 'config', org: d.slug }, 'organization created');
      for (const email of d.admins) {
        const u = await one<{ id: string }>("SELECT id FROM users WHERE email = ? AND provider != 'service' ORDER BY created_at LIMIT 1", email);
        if (u && (await addMember(org.id, u.id, 'admin', 'config'))) log.info({ component: 'config', org: d.slug, email }, 'organization admin added');
      }
    } catch (err) {
      log.error({ component: 'config', org: d.slug, err }, 'organization declaration rejected');
    }
  }
}

/** Organization sub-directories of CONFIG_DIR/orgs (slugs). */
function orgDirectories(): string[] {
  const dir = path.join(config.CONFIG_DIR, 'orgs');
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => e.name);
}

/** One pass over every source: platform files, per-organization directories, organization Git repositories. */
export async function checkAllConfig(log: FastifyBaseLogger, opts: { force?: string } = {}) {
  if (opts.force) {
    lastHash.delete(opts.force);
    lastGitPull.delete(opts.force);
    failedAttempts.delete(opts.force);
  }
  const failed = async (org: string, err: unknown) =>
    setStatus(org, { at: new Date().toISOString(), ok: false, revision: null, files: 0, error: errorMessage(err).slice(0, 500) });

  // 1. Platform files: organizations, then the default organization's resources.
  let platform: LoadedConfig | undefined;
  try {
    platform = readConfigDir(config.CONFIG_DIR, { platform: true });
  } catch (err) {
    log.error({ component: 'config', err }, 'config unreadable, keeping the current configuration');
    await failed(DEFAULT_ORG, err);
  }
  if (platform) await applyOrganizations(platform.data.organizations, log);
  const defaultOrg = await findOrg(DEFAULT_ORG);
  if (platform && defaultOrg && sourceOf(defaultOrg).type === 'directory') await applyOrgConfig(defaultOrg, platform, log, config.CONFIG_DIR);

  // 2. CONFIG_DIR/orgs/<slug>: organizations whose configuration is mounted next to the platform's.
  for (const slugName of orgDirectories()) {
    try {
      let org = await findOrg(slugName);
      if (!org) {
        org = await createOrg({ slug: slugName, name: slugName }, { managed: true });
        log.info({ component: 'config', org: slugName }, 'organization created from its configuration directory');
      }
      const src = sourceOf(org);
      if (src.type === 'git') {
        log.warn({ component: 'config', org: slugName }, `pulls its configuration from Git; ignoring CONFIG_DIR/orgs/${slugName}`);
        continue;
      }
      if (src.type === 'none') await patchSettings(org.id, { configSource: { type: 'directory' } });
      const dir = path.join(config.CONFIG_DIR, 'orgs', slugName);
      await applyOrgConfig(org, readConfigDir(dir, { platform: false }), log, dir);
    } catch (err) {
      log.error({ component: 'config', org: slugName, err }, 'organization configuration unreadable, keeping its current configuration');
      const org = await findOrg(slugName);
      if (org) await failed(org.id, err);
    }
  }

  // 3. Organization Git repositories (pulled every 2 minutes, or on demand).
  for (const org of await listOrgRows()) {
    const src = sourceOf(org);
    if (src.type !== 'git') continue;
    if ((lastGitPull.get(org.id) ?? 0) > Date.now() - GIT_PULL_MS) continue;
    lastGitPull.set(org.id, Date.now());
    try {
      const { dir, revision } = await withOrg(org.id, () => pullGitSource(org.id, src));
      await applyOrgConfig(org, readConfigDir(dir, { platform: false }), log, `${src.url}#${src.branch}`, revision.slice(0, 12));
    } catch (err) {
      log.warn({ component: 'config', org: org.slug, err }, 'Git configuration source failed');
      await failed(org.id, err);
    }
  }
}

/** Load once at startup, then watch every source (ConfigMap updates, git-sync, organization repositories). */
export async function startConfigLoader(log: FastifyBaseLogger) {
  await checkAllConfig(log).catch((err) => log.error({ component: 'config', err }, 'config load failed'));
  const timer = setInterval(() => checkAllConfig(log).catch((err) => log.error({ component: 'config', err }, 'config reload failed')), 60_000);
  timer.unref();
  return {
    /** Re-read now (one organization, or all of them). */
    reload: async (org?: string) => checkAllConfig(log, { force: org }),
    stop: () => clearInterval(timer),
  };
}

/** Every resource definition (no entities, no secret values). */
export async function exportDefinitions() {
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
  return {
    teams: (await listTeams()).map((t) => strip(t as never, ['managed', 'members'])),
    blueprints: (await listBlueprints()).map((b) => strip(b as never, ['managed', 'entityCount', 'createdAt', 'updatedAt'])),
    fragments: (await listFragments()).map((f) => strip(f as never, ['managed', 'version', 'updatedAt'])),
    actions: (await listActions()).map((a) => strip(a as never, ['managed'])),
    integrations: (await listIntegrations()).map((i) => strip(i as never, ['managed', 'lastSync', 'webhookUrl'])),
    webhooks,
    scorecards: (await listScorecards()).map((s) => strip(s as never, ['managed'])),
    policies: (await listPolicies()).map((p) => strip(p as never, ['managed'])),
    dashboards: (await listDashboards()).map((d) => strip(d as never, ['managed'])),
  };
}

/** Everything configurable, as a config file: move resources created in the UI into Git. */
export async function exportConfig(): Promise<string> {
  const doc = await exportDefinitions();
  return `# Exported ${new Date().toISOString()} — secrets are references (\${secret:NAME}), never values.\n${stringify(doc, { lineWidth: 140 })}`;
}

/** Counts shown on the admin page. */
export async function managedCounts() {
  const rows = await all<{ k: string; n: number }>(
    `SELECT 'blueprints' AS k, count(*) AS n FROM blueprints WHERE managed = 1 AND org_id = ?
     UNION ALL SELECT 'actions', count(*) FROM actions WHERE managed = 1 AND org_id = ?
     UNION ALL SELECT 'integrations', count(*) FROM integrations WHERE managed = 1 AND org_id = ?
     UNION ALL SELECT 'webhooks', count(*) FROM webhooks WHERE managed = 1 AND org_id = ?
     UNION ALL SELECT 'scorecards', count(*) FROM scorecards WHERE managed = 1 AND org_id = ?
     UNION ALL SELECT 'policies', count(*) FROM policies WHERE managed = 1 AND org_id = ?
     UNION ALL SELECT 'dashboards', count(*) FROM dashboards WHERE managed = 1 AND org_id = ?
     UNION ALL SELECT 'fragments', count(*) FROM fragments WHERE managed = 1 AND org_id = ?
     UNION ALL SELECT 'teams', count(*) FROM teams WHERE managed = 1 AND org_id = ?`,
    ...Array(9).fill(orgId()),
  );
  return Object.fromEntries(rows.map((r) => [r.k, Number(r.n)]));
}
