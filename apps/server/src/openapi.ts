import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { DESCRIPTOR_SCHEMA } from './integrations/sources/descriptors.js';
import { actionDef, blueprintDef, configFile, entityInput, integrationDef, teamDef, webhookDef } from './schemas.js';

/**
 * OpenAPI 3.1 description of the REST API. Paths come from the registered Fastify routes (so they cannot drift),
 * request bodies of the configurable resources from the zod schemas that validate them (blueprints, actions,
 * integrations, webhooks, teams, entities). These component shapes are the stable contract for generated clients
 * and for a Terraform provider: they are exactly the resources of the configuration files.
 */

const COMPONENTS: Record<string, z.ZodType> = {
  Blueprint: blueprintDef,
  Action: actionDef as unknown as z.ZodType,
  Integration: integrationDef,
  Webhook: webhookDef,
  Team: teamDef,
  EntityInput: entityInput,
  ConfigFile: configFile,
};

const str = z.string();
const iso = z.string().describe('ISO 8601 timestamp');
const obj = z.record(z.string(), z.unknown());

/** Response shapes (what the API returns), written to match packages/shared/index.d.ts. */
const SyncStatsOut = z.object({ upserted: z.number(), deleted: z.number(), skipped: z.number(), failed: z.number() });
const SyncRunOut = z.object({
  id: str,
  integration: str,
  trigger: z.enum(['schedule', 'manual', 'webhook', 'startup']),
  status: z.enum(['running', 'success', 'partial', 'failure']),
  stats: SyncStatsOut,
  logs: z.array(str),
  errors: z.array(z.object({ mapping: str, key: str, message: str })),
  startedAt: iso,
  endedAt: iso.nullable(),
});
const OUTPUTS: Record<string, z.ZodType> = {
  Entity: z.object({
    blueprint: str,
    identifier: str,
    title: str,
    team: str.nullable(),
    properties: obj,
    relations: obj,
    source: str,
    createdAt: iso,
    updatedAt: iso,
  }),
  SyncRun: SyncRunOut,
  IntegrationView: integrationDef.safeExtend({
    managed: z.boolean(),
    lastSync: SyncRunOut.nullable(),
    lastSuccessAt: iso.nullable(),
    webhookUrl: str.optional(),
  }),
  WebhookView: webhookDef.safeExtend({ managed: z.boolean(), hasSecret: z.boolean() }),
  Delivery: z.object({
    id: str,
    webhook: str,
    event: str,
    status: z.enum(['pending', 'success', 'failed']),
    attempts: z.number(),
    responseStatus: z.number().nullable(),
    lastError: str.nullable(),
    createdAt: iso,
    deliveredAt: iso.nullable(),
  }),
  Run: z.object({ id: str, action: str, actionTitle: str, status: str, inputs: obj, createdAt: iso, endedAt: iso.nullable() }).catchall(z.unknown()),
  ConfigStatus: z
    .object({ appliedHash: str.nullable(), appliedAt: iso.nullable(), errors: z.array(str), readError: str.nullable(), inSync: z.boolean() })
    .catchall(z.unknown()),
};
const page = (name: string) => z.object({ items: z.array(z.unknown()), total: z.number() }).describe(`Page of ${name}`);
OUTPUTS.EntityPage = page('Entity');
OUTPUTS.RunPage = page('Run');

/** Success response of a route: component name, `[]` suffix for arrays. */
const RESPONSES: Record<string, string> = {
  'GET /api/v1/blueprints': 'Blueprint[]',
  'GET /api/v1/blueprints/:bp': 'Blueprint',
  'PUT /api/v1/blueprints/:bp': 'Blueprint',
  'GET /api/v1/blueprints/:bp/entities': 'EntityPage',
  'GET /api/v1/blueprints/:bp/entities/:id': 'Entity',
  'POST /api/v1/blueprints/:bp/entities': 'Entity',
  'PUT /api/v1/blueprints/:bp/entities/:id': 'Entity',
  'GET /api/v1/entities': 'EntityPage',
  'GET /api/v1/integrations': 'IntegrationView[]',
  'GET /api/v1/integrations/:id': 'IntegrationView',
  'PUT /api/v1/integrations/:id': 'IntegrationView',
  'GET /api/v1/integrations/:id/syncs': 'SyncRun[]',
  'GET /api/v1/webhooks': 'WebhookView[]',
  'PUT /api/v1/webhooks/:id': 'WebhookView',
  'GET /api/v1/webhooks/:id/deliveries': 'Delivery[]',
  'GET /api/v1/deliveries': 'Delivery[]',
  'GET /api/v1/runs': 'RunPage',
  'GET /api/v1/runs/:id': 'Run',
  'GET /api/v1/config/status': 'ConfigStatus',
  'GET /api/v1/teams': 'Team[]',
  'PUT /api/v1/teams/:id': 'Team',
};

/** Which component is the JSON body of a write route (`METHOD url` with Fastify-style `:param`). */
const BODIES: Record<string, string> = {
  'PUT /api/v1/blueprints/:bp': 'Blueprint',
  'PUT /api/v1/actions/:id': 'Action',
  'PUT /api/v1/integrations/:id': 'Integration',
  'PUT /api/v1/webhooks/:id': 'Webhook',
  'PUT /api/v1/teams/:id': 'Team',
  'POST /api/v1/blueprints/:bp/entities': 'EntityInput',
  'PUT /api/v1/blueprints/:bp/entities/:id': 'EntityInput',
};

const HIDDEN = [/^\/api\/v1\/ingest\//, /^\/api\/auth\//, /^\/api\/openapi/, /^\/api\/docs/];

interface RouteInfo {
  method: string;
  url: string;
}

/** Call before registering the routes: records them as they are added. */
export function collectRoutes(app: FastifyInstance): RouteInfo[] {
  const routes: RouteInfo[] = [];
  app.addHook('onRoute', (r) => {
    for (const method of [r.method].flat()) {
      if (method === 'HEAD' || method === 'OPTIONS') continue;
      if (r.url.startsWith('/api/') && !HIDDEN.some((h) => h.test(r.url))) routes.push({ method, url: r.url });
    }
  });
  return routes;
}

const toOpenApiPath = (url: string) => url.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
const camel = (s: string) => s.replace(/[^A-Za-z0-9]+(.)?/g, (_m, c: string | undefined) => (c ? c.toUpperCase() : ''));

/** zod emits recursive schemas with a local `$defs`; OpenAPI wants them as components. */
function hoistDefs(schemas: Record<string, unknown>) {
  for (const [name, schema] of Object.entries(schemas)) {
    const defs = (schema as { $defs?: Record<string, unknown> }).$defs;
    if (!defs) continue;
    const rename = (key: string) => `${name}${key.replace(/^_+/, '_')}`;
    const fix = (v: unknown) => JSON.stringify(v).replace(/#\/\$defs\/([A-Za-z0-9_]+)/g, (_m, k: string) => `#/components/schemas/${rename(k)}`);
    for (const [k, def] of Object.entries(defs)) schemas[rename(k)] = JSON.parse(fix(def));
    const { $defs: _d, ...rest } = schema as Record<string, unknown>;
    void _d;
    schemas[name] = JSON.parse(fix(rest));
  }
}

function success(ref: string | undefined) {
  if (!ref) return { description: 'Success' };
  const item = { $ref: `#/components/schemas/${ref.replace('[]', '')}` };
  return { description: 'Success', content: { 'application/json': { schema: ref.endsWith('[]') ? { type: 'array', items: item } : item } } };
}

export function buildOpenApi(routes: RouteInfo[], version = '0.1.0') {
  const schemas: Record<string, unknown> = {};
  for (const [name, schema] of Object.entries(COMPONENTS)) {
    try {
      const { $schema: _ignored, ...js } = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>;
      void _ignored;
      schemas[name] = js;
    } catch {
      schemas[name] = { type: 'object', additionalProperties: true };
    }
  }
  for (const [name, schema] of Object.entries(OUTPUTS)) {
    try {
      const { $schema: _s, ...js } = z.toJSONSchema(schema, { io: 'output', unrepresentable: 'any' }) as Record<string, unknown>;
      void _s;
      schemas[name] = js;
    } catch {
      schemas[name] = { type: 'object', additionalProperties: true };
    }
  }
  hoistDefs(schemas);
  schemas.Error = { type: 'object', properties: { error: { type: 'string' } }, required: ['error'] };

  const paths: Record<string, Record<string, unknown>> = {};
  const used = new Set<string>();
  for (const r of [...routes].sort((a, b) => a.url.localeCompare(b.url) || a.method.localeCompare(b.method))) {
    const url = toOpenApiPath(r.url);
    const method = r.method.toLowerCase();
    const params = [...r.url.matchAll(/:([A-Za-z0-9_]+)/g)].map((m) => ({ name: m[1]!, in: 'path', required: true, schema: { type: 'string' } }));
    const body = BODIES[`${r.method} ${r.url}`];
    const segs = url.split('/').filter((s) => s && !s.startsWith('{'));
    paths[url] ??= {};
    const by = params.length ? `-by-${params.map((p) => p.name).join('-')}` : '';
    let operationId = camel(`${method}-${segs.filter((x) => x !== 'api' && x !== 'v1').join('-') || 'root'}${by}`);
    // The same route under /api and /api/v1 (e.g. the MCP endpoint): keep the full path in the second id.
    if (used.has(operationId)) operationId = camel(`${method}-${segs.join('-')}${by}`);
    used.add(operationId);
    paths[url]![method] = {
      operationId,
      tags: [segs.filter((x) => x !== 'api' && x !== 'v1')[0] ?? 'api'],
      summary: `${r.method} ${url}`,
      parameters: params,
      ...(body ? { requestBody: { required: true, content: { 'application/json': { schema: { $ref: `#/components/schemas/${body}` } } } } } : {}),
      responses: {
        '200': success(RESPONSES[`${r.method} ${r.url}`]),
        '400': { description: 'Validation error', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        '401': { description: 'Not authenticated' },
        '403': { description: 'Forbidden' },
        '404': { description: 'Not found' },
      },
    };
  }
  return {
    openapi: '3.1.0',
    info: {
      title: 'Asterius Platform API',
      version,
      description:
        'REST API of the developer portal. Authenticate with a personal API token (`Authorization: Bearer …`). Resource schemas (Blueprint, Action, Integration, Webhook, Team) are the same documents as the configuration files.',
    },
    servers: [{ url: '/' }],
    security: [{ bearer: [] }],
    components: { securitySchemes: { bearer: { type: 'http', scheme: 'bearer', description: 'Personal API token' } }, schemas },
    paths,
  };
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** A dependency-free reference page (the CSP forbids third-party scripts). */
export function renderDocs(spec: ReturnType<typeof buildOpenApi>): string {
  const rows = Object.entries(spec.paths)
    .flatMap(([p, ops]) => Object.entries(ops).map(([m, op]) => ({ p, m: m.toUpperCase(), tag: (op as { tags: string[] }).tags[0] ?? '' })))
    .map((r) => `<tr><td>${esc(r.m)}</td><td><code>${esc(r.p)}</code></td><td>${esc(r.tag)}</td></tr>`)
    .join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Asterius Platform API</title>
<style>body{font:14px system-ui;margin:2rem auto;max-width:960px;padding:0 1rem}td,th{padding:.25rem .75rem;text-align:left;border-bottom:1px solid #ddd}code{font-size:13px}</style></head>
<body><h1>Asterius Platform API</h1>
<p>OpenAPI 3.1 document: <a href="/api/openapi.json">/api/openapi.json</a>. Generate clients with <code>npx openapi-typescript</code> or <code>openapi-python-client</code>.</p>
<table><thead><tr><th>Method</th><th>Path</th><th>Area</th></tr></thead><tbody>${rows}</tbody></table></body></html>`;
}

/** Serve /api/openapi.json and /api/docs from the routes collected so far (call after all routes are registered). */
export function registerOpenApi(app: FastifyInstance, routes: RouteInfo[], version: string) {
  app.get('/api/descriptor-schema.json', async () => DESCRIPTOR_SCHEMA);
  let spec: ReturnType<typeof buildOpenApi> | undefined;
  const get = () => (spec ??= buildOpenApi(routes, version));
  app.get('/api/openapi.json', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async () => get());
  app.get('/api/docs', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (_req, reply) =>
    reply.type('text/html; charset=utf-8').send(renderDocs(get())),
  );
}
