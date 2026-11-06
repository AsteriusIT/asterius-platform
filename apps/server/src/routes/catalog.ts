import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { HomeSummary } from '@asterius/shared';
import { audit } from '../audit.js';
import { actorOf, canEditEntity, isAdmin, requireAdmin, requireUser, type Principal } from '../auth/users.js';
import { deleteBlueprint, getBlueprint, listBlueprints, upsertBlueprint } from '../catalog/blueprints.js';
import { deleteEntity, findEntity, getEntity, related, searchEntities, upsertEntity } from '../catalog/entities.js';
import { badRequest, forbidden } from '../lib/errors.js';
import { getVersion, listVersions } from '../catalog/history.js';
import {
  deleteScorecard,
  evaluateAllEntities,
  getScorecard,
  levelsFor,
  listScorecards,
  resultsForEntity,
  scorecardSummary,
  upsertScorecard,
} from '../catalog/scorecards.js';
import { listRuns, pendingApprovals } from '../actions/runs.js';
import { entityInput } from '../schemas.js';
import { bpParam, entityParam, filtersOf, idParam, page } from './util.js';

/** Humans write entities of their teams (admins: all); API tokens of service accounts follow the same rule. */
async function assertCanWrite(p: Principal, bp: string, identifier: string, team: string | null | undefined) {
  const existing = await findEntity(bp, identifier);
  if (existing?.source.startsWith('integration:'))
    throw badRequest(`This entity is written by ${existing.source}; manual changes would be overwritten at the next sync`);
  if (existing && !canEditEntity(p, existing.team)) throw forbidden(`Only members of team "${existing.team ?? '—'}" or admins can change this entity`);
  const nextTeam = team === undefined ? (existing?.team ?? null) : team;
  if (!isAdmin(p) && !canEditEntity(p, nextTeam)) throw forbidden('Assign the entity to one of your teams');
}

export async function catalogRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireUser);

  app.get('/home', async (req): Promise<HomeSummary> => {
    const bps = await listBlueprints();
    const recent = await searchEntities({ sort: 'updated', limit: 8, offset: 0 });
    return {
      blueprints: bps.map((b) => ({ identifier: b.identifier, title: b.title, icon: b.icon, count: b.entityCount ?? 0 })),
      pendingApprovals: (await pendingApprovals(req.principal)).length,
      myRuns: (await listRuns({ mine: req.principal.id, limit: 8, offset: 0 })).items,
      recentEntities: recent.items,
    };
  });

  // ---- blueprints ----
  app.get('/blueprints', async () => listBlueprints());
  app.get('/blueprints/:bp', async (req) => getBlueprint(bpParam.parse(req.params).bp));
  app.put('/blueprints/:bp', { preHandler: requireAdmin }, async (req) => {
    const { bp } = bpParam.parse(req.params);
    const { blueprint, created } = await upsertBlueprint({ ...(req.body as object), identifier: bp });
    await audit(actorOf(req.principal), created ? 'blueprint.created' : 'blueprint.updated', bp);
    return blueprint;
  });
  app.delete('/blueprints/:bp', { preHandler: requireAdmin }, async (req) => {
    const { bp } = bpParam.parse(req.params);
    await deleteBlueprint(bp);
    await audit(actorOf(req.principal), 'blueprint.deleted', bp);
    return { ok: true };
  });

  // ---- scorecards ----
  app.get('/scorecards', async (req) => listScorecards(z.object({ blueprint: z.string().optional() }).parse(req.query).blueprint));
  app.get('/scorecards/:id', async (req) => getScorecard(idParam.parse(req.params).id));
  app.get('/scorecards/:id/summary', async (req) => {
    const { id } = idParam.parse(req.params);
    const { days } = z.object({ days: z.coerce.number().int().min(1).max(365).default(30) }).parse(req.query);
    return scorecardSummary(id, days);
  });
  app.put('/scorecards/:id', { preHandler: requireAdmin }, async (req) => {
    const { id } = idParam.parse(req.params);
    const { scorecard, created, changed } = await upsertScorecard({ ...(req.body as object), identifier: id });
    await audit(actorOf(req.principal), created ? 'scorecard.created' : 'scorecard.updated', id);
    if (changed) void evaluateAllEntities(scorecard).catch((err) => req.log.error({ err }, 'scorecard evaluation failed'));
    return scorecard;
  });
  app.delete('/scorecards/:id', { preHandler: requireAdmin }, async (req) => {
    const { id } = idParam.parse(req.params);
    await deleteScorecard(id);
    await audit(actorOf(req.principal), 'scorecard.deleted', id);
    return { ok: true };
  });
  app.post('/scorecards/:id/evaluate', { preHandler: requireAdmin }, async (req) => {
    const evaluated = await evaluateAllEntities(await getScorecard(idParam.parse(req.params).id));
    return { evaluated };
  });
  /** Levels of the entities of one page of a table: `?ids=a,b,c`. */
  app.get('/blueprints/:bp/scorecard-levels', async (req) => {
    const { bp } = bpParam.parse(req.params);
    const { ids } = z.object({ ids: z.string().max(20_000).default('') }).parse(req.query);
    return levelsFor(bp, ids.split(',').filter(Boolean).slice(0, 500));
  });
  app.get('/blueprints/:bp/entities/:id/scorecards', async (req) => {
    const { bp, id } = entityParam.parse(req.params);
    return resultsForEntity(bp, id);
  });

  // ---- entities ----
  const listQuery = page.extend({
    search: z.string().max(200).optional(),
    team: z.string().optional(),
    source: z.string().optional(),
    sort: z.enum(['title', 'updated', 'identifier']).default('title'),
  });

  app.get('/entities', async (req) => {
    const q = listQuery.extend({ blueprint: z.string().optional() }).parse(req.query);
    return searchEntities({ ...q, filters: filtersOf(req.query as Record<string, unknown>) });
  });
  app.get('/blueprints/:bp/entities', async (req) => {
    const { bp } = bpParam.parse(req.params);
    const q = listQuery.parse(req.query);
    return searchEntities({ ...q, blueprint: bp, filters: filtersOf(req.query as Record<string, unknown>) });
  });
  app.get('/blueprints/:bp/entities/:id', async (req) => {
    const { bp, id } = entityParam.parse(req.params);
    return getEntity(bp, id);
  });
  app.get('/blueprints/:bp/entities/:id/related', async (req) => {
    const { bp, id } = entityParam.parse(req.params);
    return related(bp, id);
  });

  // ---- history ----
  const historyQuery = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50), offset: z.coerce.number().int().min(0).default(0) });
  for (const path of ['/blueprints/:bp/entities/:id/history', '/entities/:bp/:id/history'])
    app.get(path, async (req) => {
      const { bp, id } = entityParam.parse(req.params);
      const q = historyQuery.parse(req.query);
      return listVersions(bp, id, q.limit, q.offset);
    });
  /** Write an old snapshot back: a new version (`revert`) is recorded, nothing is rewritten. */
  app.post('/blueprints/:bp/entities/:id/history/:version/revert', async (req) => {
    const { bp, id } = entityParam.parse(req.params);
    const { version } = z.object({ version: z.coerce.number().int().min(1) }).parse(req.params);
    const v = await getVersion(bp, id, version);
    await assertCanWrite(req.principal, bp, id, v.snapshot.team);
    const { entity } = await upsertEntity(
      bp,
      { identifier: id, ...v.snapshot },
      {
        source: req.principal.provider === 'service' ? 'api' : 'ui',
        actor: actorOf(req.principal),
        op: 'revert',
      },
    );
    await audit(actorOf(req.principal), 'entity.reverted', `${bp}/${id}`, { toVersion: version });
    return entity;
  });

  app.post('/blueprints/:bp/entities', async (req, reply) => {
    const { bp } = bpParam.parse(req.params);
    const input = entityInput.parse(req.body);
    await assertCanWrite(req.principal, bp, input.identifier, input.team ?? null);
    const { entity } = await upsertEntity(bp, input, {
      source: req.principal.provider === 'service' ? 'api' : 'ui',
      actor: actorOf(req.principal),
      createOnly: true,
    });
    await audit(actorOf(req.principal), 'entity.created', `${bp}/${entity.identifier}`);
    return reply.code(201).send(entity);
  });

  /** PUT replaces, PATCH merges properties/relations. Both create when missing (idempotent upsert for automation). */
  for (const method of ['put', 'patch'] as const)
    app[method]('/blueprints/:bp/entities/:id', async (req) => {
      const { bp, id } = entityParam.parse(req.params);
      const input = entityInput.parse({ ...(req.body as object), identifier: id });
      await assertCanWrite(req.principal, bp, id, (req.body as { team?: string | null }).team);
      const { entity, created, changed } = await upsertEntity(bp, input, {
        source: req.principal.provider === 'service' ? 'api' : 'ui',
        actor: actorOf(req.principal),
        merge: method === 'patch',
      });
      if (changed) await audit(actorOf(req.principal), created ? 'entity.created' : 'entity.updated', `${bp}/${id}`);
      return entity;
    });

  app.delete('/blueprints/:bp/entities/:id', async (req) => {
    const { bp, id } = entityParam.parse(req.params);
    const existing = await getEntity(bp, id);
    if (!canEditEntity(req.principal, existing.team)) throw forbidden();
    await deleteEntity(bp, id, actorOf(req.principal));
    await audit(actorOf(req.principal), 'entity.deleted', `${bp}/${id}`);
    return { ok: true };
  });

  /**
   * Bulk upsert from automation (CI jobs, scripts, custom exporters): up to 1000 entities per call.
   * The same team rules as single writes apply per entity; errors are reported per entity instead of failing the batch.
   */
  app.post('/blueprints/:bp/entities/bulk', async (req) => {
    const { bp } = bpParam.parse(req.params);
    await getBlueprint(bp);
    const body = z.object({ entities: z.array(z.unknown()).min(1).max(1000), merge: z.boolean().default(false) }).parse(req.body);
    const result = { upserted: 0, unchanged: 0, errors: [] as { index: number; error: string }[] };
    for (const [index, raw] of body.entities.entries()) {
      try {
        const input = entityInput.parse(raw);
        await assertCanWrite(req.principal, bp, input.identifier, input.team);
        const r = await upsertEntity(bp, input, { source: 'api', actor: actorOf(req.principal), merge: body.merge });
        if (r.changed) result.upserted++;
        else result.unchanged++;
      } catch (err) {
        result.errors.push({ index, error: (err as Error).message });
      }
    }
    await audit(actorOf(req.principal), 'entity.bulk', bp, { upserted: result.upserted, errors: result.errors.length });
    return result;
  });
}
