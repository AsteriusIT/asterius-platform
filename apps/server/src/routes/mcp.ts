import type { FastifyInstance, FastifyReply } from 'fastify';
import { authenticate, bearer, withChannel } from '../auth/users.js';
import { authenticateAccessToken, MCP_PATHS, mcpChallenge, protectedResourceMetadata } from '../auth/mcp-oauth.js';
import { handleMcp } from '../ai/mcp-server.js';

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

/**
 * `POST /api/mcp` (and `/api/v1/mcp`): the platform as an MCP server (Streamable HTTP). Authenticate with an API token or
 * an OIDC access token of the trusted issuer (OAuth 2.1, see mcp-oauth.ts); calls run in the caller's organization and
 * are recorded with the `mcp` channel.
 */
export async function mcpRoutes(app: FastifyInstance) {
  app.post('/mcp', { config: { rateLimit: { max: 300, timeWindow: '1 minute' } } }, async (req, reply) => {
    const path = req.url.split('?')[0].replace(/\/$/, '').endsWith('/v1/mcp') ? MCP_PATHS[1] : MCP_PATHS[0];
    // Every request takes both checks in this order: an OIDC access token of a trusted issuer (fully verified, else
    // undefined), then the platform's own credentials (API or session token, cookie with CSRF). Neither branch is
    // skipped on the strength of what the client sent.
    const p0 = (await authenticateAccessToken(req, bearer(req), path)) ?? (await authenticate(req));
    if (!p0) return reply.code(401).header('www-authenticate', mcpChallenge(path)).send({ error: 'unauthorized' });
    if (!p0.org) return reply.code(403).send({ error: 'Join or create an organization first', code: 'NO_ORGANIZATION' });
    const p = withChannel(p0, 'mcp');
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
