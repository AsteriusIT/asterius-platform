import { z } from 'zod';
import { exportDefinitions } from './config-loader.js';
import { upsertTeam, listTeams } from './auth/teams.js';
import { listBlueprints, upsertBlueprint } from './catalog/blueprints.js';
import { findEntity, searchEntities, upsertEntity } from './catalog/entities.js';
import { listActions, upsertAction } from './actions/actions.js';
import { listIntegrations, upsertIntegration } from './integrations/integrations.js';
import { listWebhooks, upsertWebhook } from './webhooks/webhooks.js';
import { listSecrets } from './secrets.js';
import { errorMessage } from './lib/errors.js';

/**
 * Portable archive of the platform state that is not secret: resource definitions (teams, blueprints, actions,
 * integrations, webhooks), catalog entities with their relations, and the NAMES of the secrets (never values: those
 * are encrypted with SECRETS_KEY and are restored from your secret manager). Used by the admin API and the CLI.
 * Run history, audit log, users and API tokens belong to the database backup, not to the archive.
 */

export const ARCHIVE_FORMAT = 'asterius-archive';
export const ARCHIVE_VERSION = 1;
const PAGE = 1000;

export interface ArchiveEntity {
  blueprint: string;
  identifier: string;
  title: string;
  team: string | null;
  properties: Record<string, unknown>;
  relations: Record<string, unknown>;
  source: string;
}

export interface Archive {
  format: typeof ARCHIVE_FORMAT;
  version: number;
  exportedAt: string;
  definitions: Awaited<ReturnType<typeof exportDefinitions>>;
  secrets: { name: string; description: string }[];
  entities: ArchiveEntity[];
}

export async function exportArchive(): Promise<Archive> {
  const entities: ArchiveEntity[] = [];
  for (const bp of await listBlueprints())
    for (let offset = 0; ; offset += PAGE) {
      const { items } = await searchEntities({ blueprint: bp.identifier, sort: 'identifier', limit: PAGE, offset });
      for (const e of items)
        entities.push({
          blueprint: e.blueprint,
          identifier: e.identifier,
          title: e.title,
          team: e.team,
          properties: e.properties,
          relations: e.relations,
          source: e.source,
        });
      if (items.length < PAGE) break;
    }
  return {
    format: ARCHIVE_FORMAT,
    version: ARCHIVE_VERSION,
    exportedAt: new Date().toISOString(),
    definitions: await exportDefinitions(),
    secrets: (await listSecrets()).map((s) => ({ name: s.name, description: s.description })),
    entities,
  };
}

const archiveShape = z.object({
  format: z.literal(ARCHIVE_FORMAT),
  version: z.number().int().max(ARCHIVE_VERSION),
  definitions: z
    .object({
      teams: z.array(z.record(z.string(), z.unknown())).default([]),
      blueprints: z.array(z.record(z.string(), z.unknown())).default([]),
      actions: z.array(z.record(z.string(), z.unknown())).default([]),
      integrations: z.array(z.record(z.string(), z.unknown())).default([]),
      webhooks: z.array(z.record(z.string(), z.unknown())).default([]),
    })
    .default({ teams: [], blueprints: [], actions: [], integrations: [], webhooks: [] }),
  secrets: z.array(z.object({ name: z.string(), description: z.string().optional() })).default([]),
  entities: z.array(z.record(z.string(), z.unknown())).default([]),
});

export type ConflictMode = 'skip' | 'overwrite';
export interface ImportOptions {
  /** What to do with a resource or entity that already exists. */
  mode: ConflictMode;
  /** Report what would happen without writing anything. */
  dryRun?: boolean;
}

type Kind = 'teams' | 'blueprints' | 'actions' | 'integrations' | 'webhooks' | 'entities';
export interface ImportReport {
  dryRun: boolean;
  mode: ConflictMode;
  created: Record<Kind, number>;
  updated: Record<Kind, number>;
  skipped: Record<Kind, number>;
  failed: Record<Kind, number>;
  errors: string[];
  /** Secrets referenced by the archive that do not exist here: create them (values are never archived). */
  missingSecrets: string[];
}

const zero = (): Record<Kind, number> => ({ teams: 0, blueprints: 0, actions: 0, integrations: 0, webhooks: 0, entities: 0 });
const MAX_ERRORS = 50;

export async function importArchive(raw: unknown, opts: ImportOptions): Promise<ImportReport> {
  const parsed = archiveShape.safeParse(raw);
  if (!parsed.success) throw new Error(`Not an Asterius archive: ${parsed.error.issues[0]?.path.join('.') || 'root'}: ${parsed.error.issues[0]?.message}`);
  const a = parsed.data;
  const report: ImportReport = {
    dryRun: !!opts.dryRun,
    mode: opts.mode,
    created: zero(),
    updated: zero(),
    skipped: zero(),
    failed: zero(),
    errors: [],
    missingSecrets: [],
  };
  const fail = (kind: Kind, id: string, err: unknown) => {
    report.failed[kind]++;
    if (report.errors.length < MAX_ERRORS) report.errors.push(`${kind} ${id}: ${errorMessage(err)}`);
  };

  /** Apply one kind. Failures are retried while others succeed (blueprints may reference each other). */
  const apply = async (
    kind: Kind,
    items: Record<string, unknown>[],
    exists: Set<string>,
    id: (i: Record<string, unknown>) => string,
    write: (i: Record<string, unknown>) => Promise<unknown>,
  ) => {
    let pending = items;
    for (let round = 0; pending.length && round < 5; round++) {
      const failed: [Record<string, unknown>, unknown][] = [];
      for (const item of pending) {
        const key = id(item);
        const present = exists.has(key);
        if (present && opts.mode === 'skip') {
          report.skipped[kind]++;
          continue;
        }
        try {
          if (!opts.dryRun) await write(item);
          (present ? report.updated : report.created)[kind]++;
          exists.add(key);
        } catch (err) {
          failed.push([item, err]);
        }
      }
      if (failed.length === pending.length || round === 4) {
        for (const [item, err] of failed) fail(kind, id(item), err);
        return;
      }
      pending = failed.map(([item]) => item);
    }
  };
  const ident = (i: Record<string, unknown>) => String(i.identifier);

  const d = a.definitions;
  await apply('teams', d.teams, new Set((await listTeams()).map((t) => t.identifier)), ident, (i) => upsertTeam(i));
  await apply('blueprints', d.blueprints, new Set((await listBlueprints()).map((b) => b.identifier)), ident, (i) => upsertBlueprint(i));
  await apply('actions', d.actions, new Set((await listActions()).map((x) => x.identifier)), ident, (i) => upsertAction(i));
  await apply('integrations', d.integrations, new Set((await listIntegrations()).map((x) => x.identifier)), ident, (i) => upsertIntegration(i));
  await apply('webhooks', d.webhooks, new Set((await listWebhooks()).map((x) => x.identifier)), ident, (i) => upsertWebhook(i));

  // Entities: existence is checked one by one (there can be 100k).
  for (const e of a.entities) {
    const { blueprint, source, ...entity } = e as { blueprint: string; source?: string } & Record<string, unknown>;
    const key = `${blueprint}/${String(entity.identifier)}`;
    try {
      const present = !!(await findEntity(blueprint, String(entity.identifier)).catch(() => undefined));
      if (present && opts.mode === 'skip') {
        report.skipped.entities++;
        continue;
      }
      if (!opts.dryRun) await upsertEntity(blueprint, entity, { source: source ?? 'import' });
      (present ? report.updated : report.created).entities++;
    } catch (err) {
      fail('entities', key, err);
    }
  }

  const have = new Set((await listSecrets()).map((s) => s.name));
  report.missingSecrets = a.secrets.map((s) => s.name).filter((n) => !have.has(n));
  return report;
}
