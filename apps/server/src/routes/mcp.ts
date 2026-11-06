import type { FastifyInstance, FastifyReply } from 'fastify';
import { authenticate } from '../auth/users.js';
import { handleMcp } from '../ai/mcp-server.js';

/** `POST /api/v1/mcp`: the platform as an MCP server (Streamable HTTP). Authenticate with an API token. */
export async function mcpRoutes(app: FastifyInstance) {
  app.post('/mcp', { config: { rateLimit: { max: 300, timeWindow: '1 minute' } } }, async (req, reply) => {
    const p = await authenticate(req);
    if (!p) return reply.code(401).header('www-authenticate', 'Bearer realm="asterius-platform"').send({ error: 'unauthorized' });
    const out = await handleMcp(req.body, p);
    if (out === undefined) return reply.code(202).send();
    return reply.send(out);
  });
  // No server-initiated stream and no sessions: clients that probe with GET/DELETE are told so.
  const notAllowed = async (_req: unknown, reply: FastifyReply) => reply.code(405).header('allow', 'POST').send();
  app.get('/mcp', notAllowed);
  app.delete('/mcp', notAllowed);
}
