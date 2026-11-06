import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { HomeSummary } from '@asterius/shared';
import { audit } from '../audit.js';
import { actorOf, canEditEntity, isAdmin, requireAdmin, requireUser, type Principal } from '../auth/users.js';
import { deleteBlueprint, getBlueprint, homeBlueprints, listBlueprints, upsertBlueprint } from '../catalog/blueprints.js';
import { deleteEntity, getEntity, related, searchEntities, upsertEntities, upsertEntity } from '../catalog/entities.js';
import { entityGraph, MAX_DEPTH, MAX_NODES } from '../catalog/graph.js';
import { parseFilterParams } from '../catalog/query.js';
import { nextPageHeaders } from '../lib/cursor.js';
import { badRequest, forbidden } from '../lib/errors.js';
import { countPendingApprovals, listRuns } from '../actions/runs.js';
import { entityInput, entityQueryBody, SORT_RE, type EntityInput } from '../schemas.js';
import type { Entity } from '@asterius/shared';
import { bpParam, entityParam, page } from './util.js';

/** Humans write entities of their teams (admins: all); API tokens of service accounts follow the same rule. */
function assertCanWrite(p: Principal, existing: Entity | undefined, team: string | null | undefined) {
  if (existing?.source.startsWith('integration:'))
    throw badRequest(`This entity is written by ${existing.source}; manual changes would be overwritten at the next sync`);
  if (existing && !canEditEntity(p, existing.team)) throw forbidden(`Only members of team "${existing.team ?? '—'}" or admins can change this entity`);
  const nextTeam = team === undefined ? (existing?.team ?? null) : team;
  if (!isAdmin(p) && !canEditEntity(p, nextTeam)) throw forbidden('Assign the entity to one of your teams');
}

const etag = (e: Entity) => `"${e.version}"`;
/** `If-Match: "3"` (or a bare 3) → 3; `*` and absent → no precondition. */
function ifMatchOf(header: string | undefined): number | undefined {
  if (!header || header.trim() === '*') return undefined;
  const n = Number(header.trim().replace(/^W\//, '').replace(/"/g, ''));
  if (!Number.isInteger(n) || n < 0) throw badRequest('If-Match must be an entity ETag (its version number)');
  return n;
}

export async function catalogRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireUser);

  app.get('/home', async (req): Promise<HomeSummary> => {
    const bps = await homeBlueprints();
    const recent = await searchEntities({ sort: 'updated', limit: 8, offset: 0 });
    return {
      blueprints: bps.map((b) => ({ identifier: b.identifier, title: b.title, icon: b.icon, count: b.entityCount ?? 0 })),
      pendingApprovals: await countPendingApprovals(req.principal),
      myRuns: (await listRuns({ mine: req.principal.id, limit: 8, offset: 0 }, req.principal)).items,
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

  // ---- entities ----
  /**
   * Query string: search, team, source, sort (title|updated|identifier|relevance|prop:<name>), dir, limit, offset, cursor,
   * count=false, filter.<prop>[op]=value and relation.<name>=<target>[,…] (see catalog/query.ts).
   */
  const listQuery = page.extend({
    search: z.string().max(200).optional(),
    team: z.string().optional(),
    source: z.string().optional(),
    sort: z.string().regex(SORT_RE, 'title | updated | identifier | relevance | prop:<name>').optional(),
    dir: z.enum(['asc', 'desc']).optional(),
    cursor: z.string().max(2000).optional(),
    count: z
      .enum(['true', 'false'])
      .transform((v) => v === 'true')
      .optional(),
  });

  app.get('/entities', async (req, reply) => {
    const q = listQuery.extend({ blueprint: z.string().optional() }).parse(req.query);
    const result = await searchEntities({ ...q, ...parseFilterParams(req.query as Record<string, unknown>) });
    nextPageHeaders(req, reply, result.nextCursor);
    return result;
  });
  app.get('/blueprints/:bp/entities', async (req, reply) => {
    const { bp } = bpParam.parse(req.params);
    const q = listQuery.parse(req.query);
    const result = await searchEntities({ ...q, blueprint: bp, ...parseFilterParams(req.query as Record<string, unknown>) });
    nextPageHeaders(req, reply, result.nextCursor);
    return result;
  });
  /** Complex queries as a JSON body (the same structure the query-string form compiles to). */
  app.post('/entities/query', async (req) => searchEntities(entityQueryBody.parse(req.body)));
  app.post('/blueprints/:bp/entities/query', async (req) => {
    const { bp } = bpParam.parse(req.params);
    return searchEntities({ ...entityQueryBody.parse(req.body), blueprint: bp });
  });
  app.get('/blueprints/:bp/entities/:id', async (req, reply) => {
    const { bp, id } = entityParam.parse(req.params);
    const e = await getEntity(bp, id);
    return reply.header('etag', etag(e)).send(e);
  });
  /**
   * Multi-hop graph: `direction=out` (dependencies), `in` (what depends on it: impact analysis) or `both`; `depth` up to 6.
   * Also served as /entities/:bp/:id/graph.
   */
  const graphQuery = z.object({
    depth: z.coerce.number().int().min(1).max(MAX_DEPTH).default(2),
    direction: z.enum(['out', 'in', 'both']).default('both'),
    limit: z.coerce.number().int().min(1).max(MAX_NODES).default(MAX_NODES),
  });
  for (const url of ['/blueprints/:bp/entities/:id/graph', '/entities/:bp/:id/graph'])
    app.get(url, async (req) => {
      const { bp, id } = entityParam.parse(req.params);
      const q = graphQuery.parse(req.query);
      return entityGraph(bp, id, { depth: q.depth, direction: q.direction, maxNodes: q.limit });
    });
  app.get('/blueprints/:bp/entities/:id/related', async (req) => {
    const { bp, id } = entityParam.parse(req.params);
    return related(bp, id);
  });

  app.post('/blueprints/:bp/entities', async (req, reply) => {
    const { bp } = bpParam.parse(req.params);
    const input = entityInput.parse(req.body);
    const { entity } = await upsertEntity(bp, input, {
      source: req.principal.provider === 'service' ? 'api' : 'ui',
      actor: actorOf(req.principal),
      createOnly: true,
      authorize: (i, existing) => assertCanWrite(req.principal, existing, i.team ?? null),
    });
    await audit(actorOf(req.principal), 'entity.created', `${bp}/${entity.identifier}`);
    return reply.code(201).header('etag', etag(entity)).send(entity);
  });

  /** PUT replaces, PATCH merges properties/relations. Both create when missing (idempotent upsert for automation). */
  for (const method of ['put', 'patch'] as const)
    app[method]('/blueprints/:bp/entities/:id', async (req, reply) => {
      const { bp, id } = entityParam.parse(req.params);
      const input = entityInput.parse({ ...(req.body as object), identifier: id });
      const { entity, created, changed } = await upsertEntity(bp, input, {
        source: req.principal.provider === 'service' ? 'api' : 'ui',
        actor: actorOf(req.principal),
        merge: method === 'patch',
        ifMatch: ifMatchOf(req.headers['if-match']),
        authorize: (i, existing) => assertCanWrite(req.principal, existing, i.team),
      });
      if (changed) await audit(actorOf(req.principal), created ? 'entity.created' : 'entity.updated', `${bp}/${id}`);
      return reply.header('etag', etag(entity)).send(entity);
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
    const outcomes = await upsertEntities(bp, body.entities, {
      source: 'api',
      actor: actorOf(req.principal),
      merge: body.merge,
      authorize: (i: EntityInput, existing) => assertCanWrite(req.principal, existing, i.team),
    });
    for (const [index, r] of outcomes.entries()) {
      if (!r.ok) result.errors.push({ index, error: r.error });
      else if (r.changed) result.upserted++;
      else result.unchanged++;
    }
    await audit(actorOf(req.principal), 'entity.bulk', bp, { upserted: result.upserted, errors: result.errors.length });
    return result;
  });
}
