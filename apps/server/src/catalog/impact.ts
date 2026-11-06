import type { Entity, InvalidEntity, ObjectSchema, ValidationReport } from '@asterius/shared';
import { json, now, one, run, tx } from '../db.js';
import { emit } from '../events.js';
import { errorMessage } from '../lib/errors.js';
import { entityMigration, type EntityMigration } from '../schemas.js';
import type { Actor } from '../audit.js';
import { getBlueprint } from './blueprints.js';
import { refreshAfterWrite } from './computed.js';
import { recordVersion, snapshotOf } from './history.js';
import { searchEntities } from './entities.js';
import { evaluateEntity } from './scorecards.js';
import { validator } from './validation.js';
import { z } from 'zod';

/**
 * Blueprint change impact. Editing a blueprint does not touch its entities, so a new required property leaves
 * the catalog inconsistent until the next write. These functions check the existing entities against a
 * (proposed or saved) definition, keep the last report, and apply simple data migrations (rename, default, remove).
 */

export const migrationList = z.array(entityMigration).max(50);

const SAMPLES = 20;
const PAGE = 200;

interface Shape {
  schema: ObjectSchema;
  relations: Record<string, { many?: boolean; required?: boolean }>;
}

/** Apply migrations to a copy of the properties. */
export function migrateProperties(properties: Record<string, unknown>, migrations: EntityMigration[]): Record<string, unknown> {
  const out = { ...properties };
  for (const m of migrations) {
    if (m.type === 'rename') {
      if (m.from in out && !(m.to in out)) {
        out[m.to] = out[m.from];
        delete out[m.from];
      }
    } else if (m.type === 'default') {
      if (out[m.property] === undefined || out[m.property] === null || out[m.property] === '') out[m.property] = m.value;
    } else delete out[m.property];
  }
  return out;
}

/** Problems of an entity against a blueprint shape (empty: valid). */
export function entityProblems(shape: Shape, e: Pick<Entity, 'properties' | 'relations'>): string[] {
  const problems: string[] = [];
  const v = validator(shape.schema);
  // Ajv applies defaults in place: validate a copy so nothing leaks into the entity.
  if (!v(structuredClone(e.properties))) {
    for (const err of v.errors ?? []) {
      const where = err.instancePath ? err.instancePath.slice(1).replace(/\//g, '.') : (err.params as { missingProperty?: string }).missingProperty;
      problems.push(`${where ?? 'value'}: ${err.message}`);
    }
  }
  for (const [name, value] of Object.entries(e.relations)) {
    const rel = shape.relations[name];
    if (!rel) problems.push(`relation "${name}" does not exist anymore`);
    else if (!rel.many && Array.isArray(value) && value.length > 1) problems.push(`relation "${name}" takes a single entity`);
  }
  for (const [name, rel] of Object.entries(shape.relations)) if (rel.required && !e.relations[name]) problems.push(`relation "${name}" is required`);
  return problems;
}

export interface CheckResult {
  total: number;
  invalid: number;
  samples: InvalidEntity[];
  /** The scan stopped at `max` entities. */
  truncated: boolean;
}

/** Check the entities of a blueprint against `shape`, optionally after migrations (dry run). */
export async function checkEntities(blueprint: string, shape: Shape, migrations: EntityMigration[] = [], max = Infinity): Promise<CheckResult> {
  const res: CheckResult = { total: 0, invalid: 0, samples: [], truncated: false };
  for (let offset = 0; ; offset += PAGE) {
    const page = await searchEntities({ blueprint, sort: 'identifier', limit: PAGE, offset });
    for (const e of page.items) {
      if (res.total >= max) {
        res.truncated = true;
        return res;
      }
      res.total++;
      const problems = entityProblems(shape, { properties: migrateProperties(e.properties, migrations), relations: e.relations });
      if (!problems.length) continue;
      res.invalid++;
      if (res.samples.length < SAMPLES) res.samples.push({ identifier: e.identifier, title: e.title, errors: problems.slice(0, 5) });
    }
    if (page.items.length < PAGE) return res;
  }
}

// ---------- stored report ----------
interface ReportRow {
  blueprint: string;
  status: 'running' | 'done';
  total: number;
  invalid: number;
  samples: string;
  started_at: string;
  finished_at: string | null;
}

export async function getReport(blueprint: string): Promise<ValidationReport | null> {
  const r = await one<ReportRow>('SELECT * FROM blueprint_validation WHERE blueprint = ?', blueprint);
  if (!r) return null;
  return {
    blueprint,
    status: r.status,
    total: Number(r.total),
    invalid: Number(r.invalid),
    samples: json(r.samples, []),
    startedAt: r.started_at,
    finishedAt: r.finished_at,
  };
}

/** Validate every entity against the saved blueprint and keep the report (run in the background after a save). */
export async function validateStored(blueprint: string): Promise<ValidationReport | null> {
  const started = now();
  await run(
    `INSERT INTO blueprint_validation (blueprint, status, started_at) VALUES (?, 'running', ?)
     ON CONFLICT (blueprint) DO UPDATE SET status = 'running', started_at = excluded.started_at, finished_at = NULL`,
    blueprint,
    started,
  );
  try {
    const bp = await getBlueprint(blueprint);
    const r = await checkEntities(blueprint, bp);
    await run(
      "UPDATE blueprint_validation SET status = 'done', total = ?, invalid = ?, samples = ?, finished_at = ? WHERE blueprint = ?",
      r.total,
      r.invalid,
      JSON.stringify(r.samples),
      now(),
      blueprint,
    );
  } catch (err) {
    await run('DELETE FROM blueprint_validation WHERE blueprint = ?', blueprint);
    console.error(`[impact] ${blueprint}: ${errorMessage(err)}`);
  }
  return getReport(blueprint);
}

/**
 * Apply migrations to the existing entities of a blueprint. Written directly (the old schema may reject the
 * entity or the new one), with a history version and the usual event per changed entity.
 */
export async function migrateEntities(blueprint: string, migrations: EntityMigration[], actor?: Actor): Promise<{ migrated: number; total: number }> {
  const bp = await getBlueprint(blueprint);
  let migrated = 0;
  let total = 0;
  const changed: { before: Entity; after: Entity }[] = [];
  for (let offset = 0; ; offset += PAGE) {
    const page = await searchEntities({ blueprint, sort: 'identifier', limit: PAGE, offset });
    for (const e of page.items) {
      total++;
      const properties = migrateProperties(e.properties, migrations);
      if (JSON.stringify(properties) === JSON.stringify(e.properties)) continue;
      const t = now();
      await tx(async (d) => {
        await d.query('UPDATE entities SET properties = ?, updated_at = ? WHERE blueprint = ? AND identifier = ?', [
          JSON.stringify(properties),
          t,
          blueprint,
          e.identifier,
        ]);
        await recordVersion(d, {
          blueprint,
          entity: e.identifier,
          op: 'update',
          actor,
          source: 'migration',
          before: snapshotOf(e),
          after: snapshotOf({ ...e, properties }),
        });
      });
      migrated++;
      changed.push({ before: e, after: { ...e, properties } });
    }
    if (page.items.length < PAGE) break;
  }
  for (const { before, after } of changed) {
    await refreshAfterWrite(blueprint, before.identifier, before.relations, before.relations, bp.relations);
    await evaluateEntity(after);
    await emit({ type: 'entity.updated', blueprint, data: { entity: after, before }, actor });
  }
  return { migrated, total };
}
