import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { authenticate, bearer, withChannel, type Principal } from '../auth/users.js';
import { authenticateAccessToken, MCP_PATHS, mcpChallenge, protectedResourceMetadata } from '../auth/mcp-oauth.js';
import { handleMcp } from '../ai/mcp-server.js';
import { agentGrant, agentOfOauthClient, grantOf } from '../agents/agents.js';
import { forbidden } from '../lib/errors.js';

/**
 * RFC 9728 Protected Resource Metadata, at the root: `/.well-known/oauth-protected-resource` (the default MCP address)
 * and the path-suffixed variant for each MCP endpoint.
 */
export async function mcpMetadataRoutes(app: FastifyInstance) {
  const serve = (path: string) => async (_req: unknown, reply: FastifyReply) =>
    reply.header('cache-control', 'public, max-age=300').header('access-control-allow-origin', '*').send(protectedResourceMetadata(path));
  app.get('/.well-known/oauth-protected-resource', serve(MCP_PATHS[0]));
  for (const p of MCP_PATHS) app.get(`/.well-known/oauth-protected-resource${p}`, serve(p));
}

/** Header (or `?agent=` query parameter, for clients that cannot set headers) selecting the agent an MCP client is. */
export const AGENT_HEADER = 'x-asterius-agent';

/**
 * The agent an MCP call acts as, in order: the agent its API token is bound to; the agent registered for the OAuth client
 * of its access token; the agent the caller selects (`X-Asterius-Agent` / `?agent=`, admins and owner-team members only).
 * A selection that contradicts the token's binding is refused.
 */
async function mcpAgent(req: FastifyRequest, p: Principal): Promise<Principal> {
  const header = req.headers[AGENT_HEADER];
  const query = (req.query as { agent?: unknown } | undefined)?.agent;
  const asked = typeof header === 'string' && header ? header : typeof query === 'string' && query ? query : undefined;
  let agent = p.agent;
  if (!agent && p.oauthClient) {
    const a = await agentOfOauthClient(p.oauthClient);
    if (a) {
      if (!a.enabled) throw forbidden(`Agent "${a.identifier}" is disabled`);
      agent = grantOf(a);
    }
  }
  if (asked && agent && asked !== agent.identifier) throw forbidden(`This credential belongs to agent "${agent.identifier}", not "${asked}"`);
  if (asked && !agent) agent = await agentGrant(asked, p);
  return agent ? { ...p, agent } : p;
}

/**
 * `POST /api/mcp` (and `/api/v1/mcp`): the platform as an MCP server (Streamable HTTP). Authenticate with an API token or
 * an OIDC access token of the trusted issuer (OAuth 2.1, see mcp-oauth.ts); calls run in the caller's organization, as
 * the caller or as a registered agent (see mcpAgent).
 */
export async function mcpRoutes(app: FastifyInstance) {
  app.post('/mcp', { config: { rateLimit: { max: 300, timeWindow: '1 minute' } } }, async (req, reply) => {
    const path = req.url.split('?')[0].replace(/\/$/, '').endsWith('/v1/mcp') ? MCP_PATHS[1] : MCP_PATHS[0];
    const token = bearer(req);
    const p0 = (token && (await authenticateAccessToken(req, token, path))) || (await authenticate(req));
    if (!p0) return reply.code(401).header('www-authenticate', mcpChallenge(path)).send({ error: 'unauthorized' });
    if (!p0.org) return reply.code(403).send({ error: 'Join or create an organization first', code: 'NO_ORGANIZATION' });
    const p = withChannel(await mcpAgent(req, p0), 'mcp');
    req.principal = p;
    const out = await handleMcp(req.body, p);
    if (out === undefined) return reply.code(202).send();
    return reply.send(out);
  });
  // No server-initiated stream and no sessions: clients that probe with GET/DELETE are told so.
  const notAllowed = async (_req: unknown, reply: FastifyReply) => reply.code(405).header('allow', 'POST').send();
  app.get('/mcp', notAllowed);
  app.delete('/mcp', notAllowed);
}
