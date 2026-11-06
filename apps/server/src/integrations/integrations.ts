import type { Integration, SyncRun } from '@asterius/shared';
import { config as platform } from '../config.js';
import { all, bool, json, now, one, run } from '../db.js';
import { badRequest, managedError, notFound } from '../lib/errors.js';
import { parseCron } from '../lib/cron.js';
import { checkTemplate } from '../lib/expr.js';
import { integrationDef, type IntegrationDef } from '../schemas.js';
import { getSource } from './sources/index.js';
import { checkMapping } from './mapping.js';

export interface IntegrationRow {
  identifier: string;
  title: string;
  type: string;
  enabled: number;
  config: string;
  mappings: string;
  interval_minutes: number;
  delete_missing: number;
  delete_max_percent: number | null;
  delete_dry_run: number;
  sync_state: string | null;
  schedule: string | null;
  priority: number;
  primary_for: string | null;
  requested_kind: string | null;
  managed: number;
  next_sync_at: string | null;
  locked_until: string | null;
}

interface SyncRow {
  id: string;
  integration: string;
  trigger: SyncRun['trigger'];
  status: SyncRun['status'];
  stats: string;
  logs: string;
  errors?: string | null;
  started_at: string;
  ended_at: string | null;
}

export const toSyncRun = (r: SyncRow): SyncRun => ({
  id: r.id,
  integration: r.integration,
  trigger: r.trigger,
  status: r.status,
  stats: json(r.stats, { upserted: 0, deleted: 0, skipped: 0, failed: 0 }),
  logs: json(r.logs, []),
  errors: json(r.errors ?? '[]', []),
  startedAt: r.started_at,
  endedAt: r.ended_at,
});

export const entitySource = (identifier: string) => `integration:${identifier}`;
export const webhookUrl = (identifier: string) => `${platform.PUBLIC_URL}/api/v1/ingest/${identifier}`;

export function toIntegration(r: IntegrationRow, lastSync: SyncRun | null, lastSuccessAt: string | null = null): Integration {
  return {
    identifier: r.identifier,
    title: r.title,
    type: r.type,
    enabled: bool(r.enabled),
    config: json(r.config, {}),
    mappings: json(r.mappings, []),
    intervalMinutes: Number(r.interval_minutes),
    deleteMissing: bool(r.delete_missing),
    deleteMaxPercent: Number(r.delete_max_percent ?? 20),
    deleteDryRun: bool(r.delete_dry_run),
    managed: bool(r.managed),
    schedule: r.schedule ?? undefined,
    priority: Number(r.priority ?? 0),
    primaryFor: json<string[]>(r.primary_for, []),
    lastSync,
    lastSuccessAt,
    ...(r.type === 'webhook' ? { webhookUrl: webhookUrl(r.identifier) } : {}),
  };
}

async function lastSyncs(): Promise<Map<string, SyncRun>> {
  const rows = await all<SyncRow>(
    `SELECT s.* FROM sync_runs s JOIN (SELECT integration, max(started_at) AS m FROM sync_runs GROUP BY integration) l
     ON l.integration = s.integration AND l.m = s.started_at`,
  );
  return new Map(rows.map((r) => [r.integration, toSyncRun(r)]));
}

async function lastSuccesses(): Promise<Map<string, string>> {
  const rows = await all<{ integration: string; t: string }>(
    "SELECT integration, max(ended_at) AS t FROM sync_runs WHERE status = 'success' GROUP BY integration",
  );
  return new Map(rows.map((r) => [r.integration, r.t]));
}

export async function listIntegrations(): Promise<Integration[]> {
  const [last, ok] = await Promise.all([lastSyncs(), lastSuccesses()]);
  return (await all<IntegrationRow>('SELECT * FROM integrations ORDER BY title')).map((r) =>
    toIntegration(r, last.get(r.identifier) ?? null, ok.get(r.identifier) ?? null),
  );
}

export async function getIntegrationRow(id: string): Promise<IntegrationRow> {
  const r = await one<IntegrationRow>('SELECT * FROM integrations WHERE identifier = ?', id);
  if (!r) throw notFound(`Integration ${id}`);
  return r;
}

export async function getIntegration(id: string): Promise<Integration> {
  const r = await getIntegrationRow(id);
  const last = await one<SyncRow>('SELECT * FROM sync_runs WHERE integration = ? ORDER BY started_at DESC LIMIT 1', id);
  const ok = await one<{ t: string | null }>("SELECT max(ended_at) AS t FROM sync_runs WHERE integration = ? AND status = 'success'", id);
  return toIntegration(r, last ? toSyncRun(last) : null, ok?.t ?? null);
}

export async function syncHistory(id: string, limit = 30): Promise<SyncRun[]> {
  return (await all<SyncRow>('SELECT * FROM sync_runs WHERE integration = ? ORDER BY started_at DESC LIMIT ?', id, limit)).map(toSyncRun);
}

export async function upsertIntegration(input: unknown, opts: { managed?: boolean } = {}): Promise<{ integration: Integration; created: boolean }> {
  const def: IntegrationDef = integrationDef.parse(input);
  const source = getSource(def.type);
  try {
    source.validate(def.config);
  } catch (err) {
    throw badRequest((err as Error).message);
  }
  checkTemplate(def.config);
  if (def.schedule) {
    try {
      parseCron(def.schedule);
    } catch (err) {
      throw badRequest(`schedule: ${(err as Error).message}`);
    }
  }
  const kinds = source.info.kinds ?? [];
  for (const m of def.mappings) {
    checkMapping(m);
    if (
      !source.push &&
      kinds.length > 0 &&
      !['kubernetes', 'http', 'graphql', 'sql', 'external', 'azure-resource-graph'].includes(def.type) &&
      !kinds.includes(m.kind)
    )
      throw badRequest(`${def.type}: unknown kind "${m.kind}" (available: ${kinds.join(', ')})`);
    if (!(await one('SELECT identifier FROM blueprints WHERE identifier = ?', m.entity.blueprint)))
      throw badRequest(`Blueprint "${m.entity.blueprint}" does not exist`);
  }
  const existing = await one<IntegrationRow>('SELECT * FROM integrations WHERE identifier = ?', def.identifier);
  if (existing && bool(existing.managed) && !opts.managed) throw managedError('Integration', def.identifier);
  const t = now();
  const vals = [
    def.title,
    def.type,
    def.enabled ? 1 : 0,
    JSON.stringify(def.config),
    JSON.stringify(def.mappings),
    def.intervalMinutes,
    def.deleteMissing ? 1 : 0,
    def.deleteMaxPercent,
    def.deleteDryRun ? 1 : 0,
    def.schedule ?? null,
    def.priority,
    JSON.stringify(def.primaryFor),
    opts.managed ? 1 : 0,
  ];
  if (existing)
    await run(
      'UPDATE integrations SET title = ?, type = ?, enabled = ?, config = ?, mappings = ?, interval_minutes = ?, delete_missing = ?, delete_max_percent = ?, delete_dry_run = ?, schedule = ?, priority = ?, primary_for = ?, managed = ?, sync_state = NULL, updated_at = ? WHERE identifier = ?',
      ...vals,
      t,
      def.identifier,
    );
  else
    await run(
      'INSERT INTO integrations (title, type, enabled, config, mappings, interval_minutes, delete_missing, delete_max_percent, delete_dry_run, schedule, priority, primary_for, managed, created_at, updated_at, next_sync_at, identifier) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ...vals,
      t,
      t,
      t, // first sync as soon as a worker sees it
      def.identifier,
    );
  return { integration: await getIntegration(def.identifier), created: !existing };
}

export async function deleteIntegration(id: string, opts: { managed?: boolean; deleteEntities?: boolean } = {}) {
  const r = await getIntegrationRow(id);
  if (bool(r.managed) && !opts.managed) throw managedError('Integration', id);
  await run('DELETE FROM integrations WHERE identifier = ?', id);
  // Entities stay in the catalog unless asked; they then show `integration:<id>` as an orphaned source.
  if (opts.deleteEntities) await run('DELETE FROM entities WHERE source = ?', entitySource(id));
}

/** Ask workers to sync now (works from API-only pods: the next worker tick picks it up). */
export async function requestSync(id: string, kind?: string) {
  const r = await getIntegrationRow(id);
  if (getSource(r.type).push) throw badRequest('Webhook integrations receive data; there is nothing to pull');
  if (kind && !json<Array<{ kind: string }>>(r.mappings, []).some((m) => m.kind === kind)) throw badRequest(`No mapping for kind "${kind}"`);
  await run('UPDATE integrations SET next_sync_at = ?, requested_kind = ? WHERE identifier = ?', '1970-01-01T00:00:00.000Z', kind ?? null, id); // MANUAL in sync.ts
}
