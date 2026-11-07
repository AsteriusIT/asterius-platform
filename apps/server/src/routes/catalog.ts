import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { HomeSummary, ObjectSchema, Scorecard } from '@asterius/shared';
import { audit } from '../audit.js';
import { assertCan, can, effectivePermissions, invalidateAccessCache, requireRole, visibleBlueprints } from '../auth/access.js';
import { actorOf, isAdmin, requireAdmin, requireUser, type Principal } from '../auth/users.js';
import {
  deleteBlueprint,
  getBlueprint,
  getBlueprintCached,
  homeBlueprints,
  listBlueprints,
  repairRelationIndex,
  upsertBlueprint,
} from '../catalog/blueprints.js';
import {
  canRead,
  deleteEntity,
  listTombstones,
  purgeTombstone,
  restoreEntity,
  findEntity,
  getEntity,
  related,
  searchEntities,
  upsertEntities,
  upsertEntity,
} from '../catalog/entities.js';
import { docsUrlOf, fetchDocs } from '../catalog/docs.js';
import { entityGraph, MAX_DEPTH, MAX_NODES } from '../catalog/graph.js';
import { parseFilterParams } from '../catalog/query.js';
import { nextPageHeaders } from '../lib/cursor.js';
import { badRequest, forbidden, notFound } from '../lib/errors.js';
import { dashboardData, deleteDashboard, getDashboard, listDashboards, resolveDashboard, upsertDashboard } from '../catalog/dashboards.js';
import { getVersion, listVersions } from '../catalog/history.js';
import { checkEntities, getReport, migrateEntities, migrationList } from '../catalog/impact.js';
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
import { countPendingApprovals, listRuns } from '../actions/runs.js';
import { blueprintDef, entityInput, entityQueryBody, SORT_RE, type EntityInput } from '../schemas.js';
import type { Entity } from '@asterius/shared';
import { bpParam, entityParam, idParam, page } from './util.js';

/**
 * Writes follow the blueprint's `write` rule; by default humans write entities of their teams (admins: all) and
 * API tokens of service accounts follow the same rule.
 */
async function assertCanWrite(p: Principal, bp: string, existing: Entity | undefined, team: string | null | undefined) {
  const blueprint = await getBlueprintCached(bp);
  if (existing?.source.startsWith('integration:'))
    throw badRequest(`This entity is written by ${existing.source}; manual changes would be overwritten at the next sync`);
  if (existing && !can(p, blueprint, 'write', existing.team))
    throw forbidden(`You are not allowed to change this entity (owner team "${existing.team ?? '—'}")`);
  const nextTeam = team === undefined ? (existing?.team ?? null) : team;
  if (!isAdmin(p) && !can(p, blueprint, 'write', nextTeam)) throw forbidden('You are not allowed to write entities with this owner team');
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

  app.get('/permissions', async (req) => effectivePermissions(req.principal));

  app.get('/home', async (req): Promise<HomeSummary> => {
    const bps = await visibleBlueprints(req.principal, await homeBlueprints());
    const recent = await searchEntities({ sort: 'updated', limit: 8, offset: 0, viewer: req.principal });
    return {
      blueprints: bps.map((b) => ({ identifier: b.identifier, title: b.title, icon: b.icon, count: b.entityCount ?? 0 })),
      pendingApprovals: await countPendingApprovals(req.principal),
      myRuns: (await listRuns({ mine: req.principal.id, limit: 8, offset: 0 }, req.principal)).items,
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
  /** Dry run: how many existing entities would be invalid under a proposed definition (after optional migrations). */
  app.post('/blueprints/:bp/impact', { preHandler: blueprintAdmin }, async (req) => {
    const { bp } = bpParam.parse(req.params);
    const body = z.object({ blueprint: z.unknown(), migrations: migrationList.default([]) }).parse(req.body);
    const def = blueprintDef.parse({ ...(body.blueprint as object), identifier: bp });
    await getBlueprint(bp);
    return checkEntities(bp, { schema: def.schema as ObjectSchema, relations: def.relations }, body.migrations, 5000);
  });
  /** Apply data migrations (rename, default, remove) to the properties of every entity of the blueprint. */
  app.post('/blueprints/:bp/migrate', { preHandler: blueprintAdmin }, async (req) => {
    const { bp } = bpParam.parse(req.params);
    const { migrations } = z.object({ migrations: migrationList.min(1) }).parse(req.body);
    const result = await migrateEntities(bp, migrations, actorOf(req.principal));
    await audit(actorOf(req.principal), 'blueprint.migrated', bp, { migrations, ...result });
    return result;
  });
  /** Report of the last background validation (after a blueprint save). */
  app.get('/blueprints/:bp/validation', { preHandler: blueprintAdmin }, async (req) => getReport(bpParam.parse(req.params).bp));
  app.post('/blueprints/:bp/repair-relations', { preHandler: blueprintAdmin }, async (req) => {
    const { bp } = bpParam.parse(req.params);
    const result = await repairRelationIndex(bp);
    await audit(actorOf(req.principal), 'blueprint.relations_repaired', bp, result);
    return result;
  });
  app.delete('/blueprints/:bp', { preHandler: blueprintAdmin }, async (req) => {
    const { bp } = bpParam.parse(req.params);
    await deleteBlueprint(bp);
    invalidateAccessCache();
    await audit(actorOf(req.principal), 'blueprint.deleted', bp);
    return { ok: true };
  });

  // ---- dashboards ----
  app.get('/dashboards', async () => listDashboards());
  app.get('/dashboards/resolve', async (req) => {
    const { blueprint } = z.object({ blueprint: z.string().optional() }).parse(req.query);
    return resolveDashboard(req.principal, blueprint);
  });
  app.get('/dashboards/:id', async (req) => getDashboard(idParam.parse(req.params).id));
  app.get('/dashboards/:id/data', async (req) => dashboardData(await getDashboard(idParam.parse(req.params).id), req.principal));
  app.put('/dashboards/:id', { preHandler: requireAdmin }, async (req) => {
    const { id } = idParam.parse(req.params);
    const { dashboard, created } = await upsertDashboard({ ...(req.body as object), identifier: id });
    await audit(actorOf(req.principal), created ? 'dashboard.created' : 'dashboard.updated', id);
    return dashboard;
  });
  app.delete('/dashboards/:id', { preHandler: requireAdmin }, async (req) => {
    const { id } = idParam.parse(req.params);
    await deleteDashboard(id);
    await audit(actorOf(req.principal), 'dashboard.deleted', id);
    return { ok: true };
  });

  // ---- scorecards ----
  // Scorecards of blueprints the viewer cannot read (per-blueprint read rules) are left out.
  const visibleCards = async (p: Principal, cards: Scorecard[]) => {
    if (isAdmin(p)) return cards;
    const seen = new Map<string, boolean>();
    const out: Scorecard[] = [];
    for (const c of cards) {
      if (!seen.has(c.blueprint)) seen.set(c.blueprint, (await visibleBlueprints(p, [await getBlueprintCached(c.blueprint)])).length > 0);
      if (seen.get(c.blueprint)) out.push(c);
    }
    return out;
  };
  const cardOf = async (p: Principal, id: string) => {
    const sc = await getScorecard(id);
    if (!(await visibleCards(p, [sc])).length) throw notFound(`Scorecard ${id}`);
    return sc;
  };
  app.get('/scorecards', async (req) =>
    visibleCards(req.principal, await listScorecards(z.object({ blueprint: z.string().optional() }).parse(req.query).blueprint)),
  );
  app.get('/scorecards/:id', async (req) => cardOf(req.principal, idParam.parse(req.params).id));
  app.get('/scorecards/:id/summary', async (req) => {
    const { id } = idParam.parse(req.params);
    const { days } = z.object({ days: z.coerce.number().int().min(1).max(365).default(30) }).parse(req.query);
    await cardOf(req.principal, id);
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
    if (!isAdmin(req.principal) && !(await visibleBlueprints(req.principal, [await getBlueprintCached(bp)])).length) throw notFound(`Blueprint ${bp}`);
    return levelsFor(bp, ids.split(',').filter(Boolean).slice(0, 500));
  });
  app.get('/blueprints/:bp/entities/:id/scorecards', async (req) => {
    const { bp, id } = entityParam.parse(req.params);
    if (!(await canRead(req.principal, await getEntity(bp, id)))) throw notFound(`Entity ${bp}/${id}`);
    return resultsForEntity(bp, id);
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
    /** Alias of `dir` (the web app's table sorting). */
    order: z.enum(['asc', 'desc']).optional(),
    cursor: z.string().max(2000).optional(),
    count: z
      .enum(['true', 'false'])
      .transform((v) => v === 'true')
      .optional(),
  });

  app.get('/entities', async (req, reply) => {
    const q = listQuery.extend({ blueprint: z.string().optional() }).parse(req.query);
    const result = await searchEntities({ ...q, dir: q.dir ?? q.order, ...parseFilterParams(req.query as Record<string, unknown>), viewer: req.principal });
    nextPageHeaders(req, reply, result.nextCursor);
    return result;
  });
  app.get('/blueprints/:bp/entities', async (req, reply) => {
    const { bp } = bpParam.parse(req.params);
    const q = listQuery.parse(req.query);
    const result = await searchEntities({
      ...q,
      dir: q.dir ?? q.order,
      blueprint: bp,
      ...parseFilterParams(req.query as Record<string, unknown>),
      viewer: req.principal,
    });
    nextPageHeaders(req, reply, result.nextCursor);
    return result;
  });
  /** Complex queries as a JSON body (the same structure the query-string form compiles to). */
  app.post('/entities/query', async (req) => searchEntities({ ...entityQueryBody.parse(req.body), viewer: req.principal }));
  app.post('/blueprints/:bp/entities/query', async (req) => {
    const { bp } = bpParam.parse(req.params);
    return searchEntities({ ...entityQueryBody.parse(req.body), blueprint: bp, viewer: req.principal });
  });
  app.get('/blueprints/:bp/entities/:id', async (req, reply) => {
    const { bp, id } = entityParam.parse(req.params);
    const e = await getEntity(bp, id);
    // 404 rather than 403: do not reveal that a hidden entity exists.
    if (!(await canRead(req.principal, e))) throw notFound(`Entity ${bp}/${id}`);
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
      if (!(await canRead(req.principal, await getEntity(bp, id)))) throw notFound(`Entity ${bp}/${id}`);
      const g = await entityGraph(bp, id, { depth: q.depth, direction: q.direction, maxNodes: q.limit });
      if (isAdmin(req.principal)) return g;
      // Neighbours the viewer may not read are left out (missing placeholders carry no data and stay), with their edges.
      const key = (n: { blueprint: string; identifier: string }) => `${n.blueprint}/${n.identifier}`;
      const hidden = new Set<string>();
      for (const n of g.nodes) if (!n.missing && !(await canRead(req.principal, n))) hidden.add(key(n));
      if (!hidden.size) return g;
      return {
        ...g,
        nodes: g.nodes.filter((n) => !hidden.has(key(n))),
        edges: g.edges.filter((e) => !hidden.has(key(e.from)) && !hidden.has(key(e.to))),
      };
    });
  /** Markdown of the entity's `docs` property, fetched server-side through the SSRF guard. */
  app.get('/blueprints/:bp/entities/:id/docs', async (req) => {
    const { bp, id } = entityParam.parse(req.params);
    const { property } = z.object({ property: z.string().optional() }).parse(req.query);
    const e = await getEntity(bp, id);
    if (!(await canRead(req.principal, e))) throw notFound(`Entity ${bp}/${id}`);
    const doc = docsUrlOf(await getBlueprintCached(bp), e, property);
    return { property: doc.property, ...(await fetchDocs(doc.url)) };
  });
  app.get('/blueprints/:bp/entities/:id/related', async (req) => {
    const { bp, id } = entityParam.parse(req.params);
    if (!(await canRead(req.principal, await getEntity(bp, id)))) throw notFound(`Entity ${bp}/${id}`);
    return related(bp, id, req.principal);
  });

  // ---- history ----
  const historyQuery = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50), offset: z.coerce.number().int().min(0).default(0) });
  for (const path of ['/blueprints/:bp/entities/:id/history', '/entities/:bp/:id/history'])
    app.get(path, async (req) => {
      const { bp, id } = entityParam.parse(req.params);
      const q = historyQuery.parse(req.query);
      const current = await findEntity(bp, id);
      // Same answer as a missing entity when the viewer may not read it; the history of a deleted one is for admins.
      if (current ? !(await canRead(req.principal, current)) : !isAdmin(req.principal)) throw notFound(`Entity ${bp}/${id}`);
      const page = await listVersions(bp, id, q.limit, q.offset);
      if (!current && !page.total) throw notFound(`Entity ${bp}/${id}`);
      return page;
    });
  /** Write an old snapshot back: a new version (`revert`) is recorded, nothing is rewritten. */
  app.post('/blueprints/:bp/entities/:id/history/:version/revert', async (req) => {
    const { bp, id } = entityParam.parse(req.params);
    const { version } = z.object({ version: z.coerce.number().int().min(1) }).parse(req.params);
    const v = await getVersion(bp, id, version);
    await assertCanWrite(req.principal, bp, await findEntity(bp, id), v.snapshot.team);
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

  // ---- deleted entities (tombstones, admins) ----
  app.get('/deleted-entities', { preHandler: requireAdmin }, async (req) => listTombstones(page.extend({ blueprint: z.string().optional() }).parse(req.query)));
  app.post('/blueprints/:bp/entities/:id/restore', { preHandler: requireAdmin }, async (req) => {
    const { bp, id } = entityParam.parse(req.params);
    const entity = await restoreEntity(bp, id, actorOf(req.principal));
    await audit(actorOf(req.principal), 'entity.restored', `${bp}/${id}`);
    return entity;
  });
  app.delete('/deleted-entities/:bp/:id', { preHandler: requireAdmin }, async (req) => {
    const { bp, id } = entityParam.parse(req.params);
    await purgeTombstone(bp, id);
    await audit(actorOf(req.principal), 'entity.purged', `${bp}/${id}`);
    return { ok: true };
  });

  app.post('/blueprints/:bp/entities', async (req, reply) => {
    const { bp } = bpParam.parse(req.params);
    const input = entityInput.parse(req.body);
    const { entity } = await upsertEntity(bp, input, {
      source: req.principal.provider === 'service' ? 'api' : 'ui',
      actor: actorOf(req.principal),
      createOnly: true,
      authorize: (i, existing) => assertCanWrite(req.principal, bp, existing, i.team ?? null),
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
        authorize: (i, existing) => assertCanWrite(req.principal, bp, existing, i.team),
      });
      if (changed) await audit(actorOf(req.principal), created ? 'entity.created' : 'entity.updated', `${bp}/${id}`);
      return reply.header('etag', etag(entity)).send(entity);
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
    const outcomes = await upsertEntities(bp, body.entities, {
      source: 'api',
      actor: actorOf(req.principal),
      merge: body.merge,
      authorize: (i: EntityInput, existing) => assertCanWrite(req.principal, bp, existing, i.team),
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
