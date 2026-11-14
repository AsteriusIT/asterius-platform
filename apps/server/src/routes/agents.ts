import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit.js';
import { actorOf, createApiToken, getUser, isAdmin, listApiTokens, requireAdmin, requireUser, tokenLifetime } from '../auth/users.js';
import { deleteAgent, getAgent, listAgents, mayActAs, upsertAgent } from '../agents/agents.js';
import { deleteMcpServer, getMcpServer, listMcpServers, testMcpServer, upsertMcpServer } from '../agents/mcp-servers.js';
import { ifMatchOf } from '../lib/conflict.js';
import { badRequest, forbidden, notFound } from '../lib/errors.js';
import { membership } from '../orgs/orgs.js';
import { orgId } from '../orgs/context.js';
import { idParam } from './util.js';

/**
 * Agent governance: the agent registry (admins manage it; owner-team members see their agents and issue their tokens) and
 * the external MCP servers AI agent steps may call (admins).
 */
export async function agentRoutes(app: FastifyInstance) {
  // ---- agents ----
  app.get('/agents', { preHandler: requireUser }, async (req) => {
    const all = await listAgents();
    return isAdmin(req.principal) ? all : all.filter((a) => mayActAs(req.principal, a));
  });
  app.get('/agents/:id', { preHandler: requireUser }, async (req) => {
    const a = await getAgent(idParam.parse(req.params).id);
    if (!isAdmin(req.principal) && !mayActAs(req.principal, a)) throw notFound(`Agent ${a.identifier}`);
    return a;
  });
  app.put('/agents/:id', { preHandler: requireAdmin }, async (req) => {
    const { id } = idParam.parse(req.params);
    const { agent, created, changed } = await upsertAgent({ ...(req.body as object), identifier: id }, { ifMatch: ifMatchOf(req.headers['if-match']) });
    if (created || changed)
      await audit(actorOf(req.principal), created ? 'agent.created' : 'agent.updated', id, {
        version: agent.version,
        enabled: agent.enabled,
        workflows: agent.workflows,
        blueprints: agent.blueprints,
      });
    return agent;
  });
  app.delete('/agents/:id', { preHandler: requireAdmin }, async (req) => {
    const { id } = idParam.parse(req.params);
    await deleteAgent(id);
    await audit(actorOf(req.principal), 'agent.deleted', id);
    return { ok: true };
  });

  /** Tokens bound to the agent (admins and owner-team members; revoke with DELETE /tokens/:id). */
  app.get('/agents/:id/tokens', { preHandler: requireUser }, async (req) => {
    const a = await getAgent(idParam.parse(req.params).id);
    if (!mayActAs(req.principal, a)) throw notFound(`Agent ${a.identifier}`);
    return listApiTokens(isAdmin(req.principal) ? undefined : req.principal.id, a.identifier);
  });
  /**
   * Issue a token bound to the agent. It acts as the caller (or, for admins, as `userId`: a service account of the
   * organization) narrowed by the agent's allow-lists. Shown once.
   */
  app.post('/agents/:id/tokens', { preHandler: requireUser }, async (req, reply) => {
    const a = await getAgent(idParam.parse(req.params).id);
    const body = z
      .object({
        name: z.string().min(1).max(100).optional(),
        expiresInDays: z.number().int().min(1).max(730).nullish(),
        userId: z.string().max(100).optional(),
      })
      .parse(req.body ?? {});
    if (req.principal.channel !== 'ui' || req.principal.agent) throw forbidden('Agent tokens are issued from a signed-in session');
    if (!mayActAs(req.principal, a)) throw forbidden(`Only admins and members of team ${a.ownerTeam} can issue tokens for this agent`);
    if (!a.enabled) throw badRequest(`Agent "${a.identifier}" is disabled`);
    let userId = req.principal.id;
    if (body.userId && body.userId !== req.principal.id) {
      if (!isAdmin(req.principal)) throw forbidden('Only admins can issue agent tokens for another account');
      const u = await getUser(body.userId);
      if (!u || u.provider !== 'service' || !(await membership(orgId(), u.id))) throw badRequest('userId: a service account of this organization');
      userId = u.id;
    }
    const name = body.name ?? `${a.title} agent token`;
    const t = await createApiToken({
      name,
      userId,
      createdBy: req.principal.id,
      expiresInDays: tokenLifetime(body.expiresInDays, 90),
      agent: a.identifier,
    });
    await audit(actorOf(req.principal), 'agent.token_created', a.identifier, { tokenId: t.id, name, userId });
    return reply.code(201).send(t);
  });

  // ---- external MCP servers (admins) ----
  app.get('/mcp-servers', { preHandler: requireAdmin }, async () => listMcpServers());
  app.get('/mcp-servers/:id', { preHandler: requireAdmin }, async (req) => getMcpServer(idParam.parse(req.params).id));
  app.put('/mcp-servers/:id', { preHandler: requireAdmin }, async (req) => {
    const { id } = idParam.parse(req.params);
    const { server, created, changed } = await upsertMcpServer({ ...(req.body as object), identifier: id }, { ifMatch: ifMatchOf(req.headers['if-match']) });
    if (created || changed)
      await audit(actorOf(req.principal), created ? 'mcp_server.created' : 'mcp_server.updated', id, {
        version: server.version,
        tools: server.tools,
        url: server.url,
      });
    return server;
  });
  app.delete('/mcp-servers/:id', { preHandler: requireAdmin }, async (req) => {
    const { id } = idParam.parse(req.params);
    await deleteMcpServer(id);
    await audit(actorOf(req.principal), 'mcp_server.deleted', id);
    return { ok: true };
  });
  /** Connect and list the server's tools against the allow-list (nothing is called). */
  app.post('/mcp-servers/:id/test', { preHandler: requireAdmin }, async (req) => testMcpServer(idParam.parse(req.params).id));
}
