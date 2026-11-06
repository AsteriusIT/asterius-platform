import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { HomeSummary } from '@asterius/shared';
import { audit } from '../audit.js';
import { assertCan, can, effectivePermissions, invalidateAccessCache, requireRole, visibleBlueprints } from '../auth/access.js';
import { actorOf, isAdmin, requireUser, type Principal } from '../auth/users.js';
import { deleteBlueprint, getBlueprint, getBlueprintCached, listBlueprints, upsertBlueprint } from '../catalog/blueprints.js';
import { canRead, deleteEntity, findEntity, getEntity, related, searchEntities, upsertEntity } from '../catalog/entities.js';
import { badRequest, forbidden, notFound } from '../lib/errors.js';
import { listRuns, pendingApprovals } from '../actions/runs.js';
import { entityInput } from '../schemas.js';
import { bpParam, entityParam, filtersOf, page } from './util.js';

/**
 * Writes follow the blueprint's `write` rule; by default humans write entities of their teams (admins: all) and
 * API tokens of service accounts follow the same rule.
 */
async function assertCanWrite(p: Principal, bp: string, identifier: string, team: string | null | undefined) {
  const blueprint = await getBlueprintCached(bp);
  const existing = await findEntity(bp, identifier);
  if (existing?.source.startsWith('integration:'))
    throw badRequest(`This entity is written by ${existing.source}; manual changes would be overwritten at the next sync`);
  if (existing && !can(p, blueprint, 'write', existing.team))
    throw forbidden(`You are not allowed to change this entity (owner team "${existing.team ?? '—'}")`);
  const nextTeam = team === undefined ? (existing?.team ?? null) : team;
  if (!isAdmin(p) && !can(p, blueprint, 'write', nextTeam)) throw forbidden('You are not allowed to write entities with this owner team');
}

export async function catalogRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireUser);

  app.get('/permissions', async (req) => effectivePermissions(req.principal));

  app.get('/home', async (req): Promise<HomeSummary> => {
    const bps = await visibleBlueprints(req.principal, await listBlueprints());
    const recent = await searchEntities({ sort: 'updated', limit: 8, offset: 0, viewer: req.principal });
    return {
      blueprints: bps.map((b) => ({ identifier: b.identifier, title: b.title, icon: b.icon, count: b.entityCount ?? 0 })),
      pendingApprovals: (await pendingApprovals(req.principal)).length,
      myRuns: (await listRuns({ mine: req.principal.id, limit: 8, offset: 0 })).items,
      recentEntities: recent.items,
    };
  });

  // ---- blueprints ----
  app.get('/blueprints', async (req) => visibleBlueprints(req.principal, await listBlueprints()));
  app.get('/blueprints/:bp', async (req) => {
    const bp = await getBlueprint(bpParam.parse(req.params).bp);
    if (!(await visibleBlueprints(req.principal, [bp])).length) throw notFound(`Blueprint ${bp.identifier}`);
    return bp;
  });
  const blueprintAdmin = requireRole('blueprint-owner');
  app.put('/blueprints/:bp', { preHandler: blueprintAdmin }, async (req) => {
    const { bp } = bpParam.parse(req.params);
    const { blueprint, created } = await upsertBlueprint({ ...(req.body as object), identifier: bp });
    invalidateAccessCache();
    await audit(actorOf(req.principal), created ? 'blueprint.created' : 'blueprint.updated', bp);
    return blueprint;
  });
  app.delete('/blueprints/:bp', { preHandler: blueprintAdmin }, async (req) => {
    const { bp } = bpParam.parse(req.params);
    await deleteBlueprint(bp);
    invalidateAccessCache();
    await audit(actorOf(req.principal), 'blueprint.deleted', bp);
    return { ok: true };
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
    return searchEntities({ ...q, filters: filtersOf(req.query as Record<string, unknown>), viewer: req.principal });
  });
  app.get('/blueprints/:bp/entities', async (req) => {
    const { bp } = bpParam.parse(req.params);
    const q = listQuery.parse(req.query);
    return searchEntities({ ...q, blueprint: bp, filters: filtersOf(req.query as Record<string, unknown>), viewer: req.principal });
  });
  app.get('/blueprints/:bp/entities/:id', async (req) => {
    const { bp, id } = entityParam.parse(req.params);
    const e = await getEntity(bp, id);
    // 404 rather than 403: do not reveal that a hidden entity exists.
    if (!(await canRead(req.principal, e))) throw notFound(`Entity ${bp}/${id}`);
    return e;
  });
  app.get('/blueprints/:bp/entities/:id/related', async (req) => {
    const { bp, id } = entityParam.parse(req.params);
    if (!(await canRead(req.principal, await getEntity(bp, id)))) throw notFound(`Entity ${bp}/${id}`);
    return related(bp, id, req.principal);
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
    assertCan(req.principal, await getBlueprintCached(bp), 'delete', existing.team);
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
