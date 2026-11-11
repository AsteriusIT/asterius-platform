import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit.js';
import { actorOf, requireAdmin } from '../auth/users.js';
import { requireRole } from '../auth/access.js';
import { ifMatchOf } from '../lib/conflict.js';
import { diffDefinitions } from '../actions/versions.js';
import { badRequest } from '../lib/errors.js';
import {
  deleteConnector,
  findConnectorDef,
  getConnector,
  getConnectorVersion,
  listConnectors,
  listConnectorVersions,
  upsertConnector,
} from '../integrations/connectors/definitions.js';
import {
  checkConnectionsOf,
  connectionUsage,
  deleteConnection,
  getConnection,
  listConnections,
  testConnection,
  upsertConnection,
} from '../integrations/connectors/connections.js';
import { fieldsWithDefaults, operationRequest } from '../integrations/connectors/request.js';
import { idParam } from './util.js';

const versionNumber = z.coerce.number().int().min(1);

/**
 * Connector definitions and connections (integrations/connectors/). Reading definitions and managing connections:
 * admins and integration admins. Writing definitions (they describe what requests the platform sends): admins.
 */
export async function connectorRoutes(app: FastifyInstance) {
  await app.register(async (r) => {
    r.addHook('preHandler', requireRole('integration-admin'));

    // ---------- definitions ----------
    r.get('/connectors', async () => listConnectors());
    r.get('/connectors/:id', async (req) => getConnector(idParam.parse(req.params).id));
    r.get('/connectors/:id/versions', async (req) => listConnectorVersions(idParam.parse(req.params).id));
    r.get('/connectors/:id/versions/:version', async (req) => {
      const { id, version } = z.object({ id: z.string().min(1).max(200), version: versionNumber }).parse(req.params);
      return getConnectorVersion(id, version);
    });
    r.get('/connectors/:id/diff', async (req) => {
      const { id } = idParam.parse(req.params);
      const q = z.object({ from: versionNumber, to: versionNumber }).parse(req.query);
      const [from, to] = await Promise.all([getConnectorVersion(id, q.from), getConnectorVersion(id, q.to)]);
      return diffDefinitions(from.definition, to.definition);
    });
    /**
     * Preview the request of an operation (nothing is sent, no credentials): `{ fields, inputs }` →
     * `{ method, url, headers, body }`. For editors and the workflow step builder.
     */
    r.post('/connectors/:id/operations/:operation/render', async (req) => {
      const { id, operation } = z.object({ id: z.string().min(1).max(200), operation: z.string().min(1).max(64) }).parse(req.params);
      const body = z
        .object({ fields: z.record(z.string(), z.unknown()).default({}), inputs: z.record(z.string(), z.unknown()).default({}) })
        .parse(req.body ?? {});
      const def = await findConnectorDef(id);
      if (!def) throw badRequest(`Unknown connector "${id}"`);
      const { request, inputs } = await operationRequest(def, operation, fieldsWithDefaults(def, body.fields), body.inputs);
      return { ...request, inputs };
    });
    r.put('/connectors/:id', { preHandler: requireAdmin }, async (req) => {
      const { id } = idParam.parse(req.params);
      const { connector, created, changed } = await upsertConnector(
        { ...(req.body as object), identifier: id },
        { actor: actorOf(req.principal), ifMatch: ifMatchOf(req.headers['if-match']), checkConnections: checkConnectionsOf },
      );
      if (created || changed) await audit(actorOf(req.principal), created ? 'connector.created' : 'connector.updated', id, { version: connector.version });
      return connector;
    });
    /** Restore an old definition as a new version (the connections using it must stay valid). */
    r.post('/connectors/:id/rollback', { preHandler: requireAdmin }, async (req) => {
      const { id } = idParam.parse(req.params);
      const { version } = z.object({ version: versionNumber }).parse(req.body ?? {});
      const target = await getConnectorVersion(id, version);
      const { connector, changed } = await upsertConnector(
        { ...target.definition, identifier: id },
        { actor: actorOf(req.principal), checkConnections: checkConnectionsOf },
      );
      if (changed) await audit(actorOf(req.principal), 'connector.rolled_back', id, { to: version, version: connector.version });
      return connector;
    });
    r.delete('/connectors/:id', { preHandler: requireAdmin }, async (req) => {
      const { id } = idParam.parse(req.params);
      await deleteConnector(id);
      await audit(actorOf(req.principal), 'connector.deleted', id);
      return { ok: true };
    });

    // ---------- connections ----------
    r.get('/connections', async () => listConnections());
    r.get('/connections/:id', async (req) => getConnection(idParam.parse(req.params).id));
    r.get('/connections/:id/usage', async (req) => connectionUsage(idParam.parse(req.params).id));
    r.put('/connections/:id', async (req) => {
      const { id } = idParam.parse(req.params);
      const { connection, created, changed } = await upsertConnection(
        { ...(req.body as object), identifier: id },
        { ifMatch: ifMatchOf(req.headers['if-match']) },
      );
      if (created || changed)
        await audit(actorOf(req.principal), created ? 'connection.created' : 'connection.updated', id, {
          connector: connection.connector,
          access: connection.access,
          auth: connection.auth?.type ?? null,
          version: connection.version,
        });
      return connection;
    });
    r.delete('/connections/:id', async (req) => {
      const { id } = idParam.parse(req.params);
      await deleteConnection(id);
      await audit(actorOf(req.principal), 'connection.deleted', id);
      return { ok: true };
    });
    /** Send the definition's test request with the connection's credentials: `{ ok, status, latencyMs, error? }`. */
    r.post('/connections/:id/test', async (req) => {
      const { id } = idParam.parse(req.params);
      const result = await testConnection(id);
      await audit(actorOf(req.principal), 'connection.tested', id, { ok: result.ok, status: result.status });
      return result;
    });
  });
}
