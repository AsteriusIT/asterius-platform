import type Anthropic from '@anthropic-ai/sdk';
import { listBlueprints } from '../catalog/blueprints.js';
import { findEntity, searchEntities, upsertEntity } from '../catalog/entities.js';
import { actorOf, canEditEntity, type Principal } from '../auth/users.js';
import { audit } from '../audit.js';
import { http } from '../lib/http.js';
import { triggerRun } from '../actions/runs.js';
import type { AgentStepGuardrails } from './guardrails.js';
import type { ToolSet } from './model.js';

/** Tools offered to models: read-only catalog lookups, and write tools that act as the run's user inside allow-lists. */

type Tool = Anthropic.Beta.BetaTool;

const SEARCH_LIMIT = 10;

export const CATALOG_TOOLS: Tool[] = [
  {
    name: 'list_blueprints',
    description: 'List the kinds of entities in the software catalog (blueprints), with their properties and relations.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'search_catalog',
    description:
      'Search catalog entities by name or identifier, optionally within one blueprint. Returns up to 10 entities with their team, properties and relations.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Text to look for in titles and identifiers; empty lists everything' },
        blueprint: { type: 'string', description: 'Blueprint identifier to search in (optional)' },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_entity',
    description: 'Get one catalog entity by blueprint and identifier.',
    input_schema: {
      type: 'object',
      properties: { blueprint: { type: 'string' }, identifier: { type: 'string' } },
      required: ['blueprint', 'identifier'],
      additionalProperties: false,
    },
  },
];

const str = (v: unknown) => (typeof v === 'string' ? v : '');

export async function runCatalogTool(name: string, input: Record<string, unknown>): Promise<string> {
  if (name === 'list_blueprints')
    return JSON.stringify(
      (await listBlueprints()).map((b) => ({ identifier: b.identifier, title: b.title, properties: Object.keys(b.schema.properties), relations: b.relations })),
    );
  if (name === 'search_catalog') {
    const page = await searchEntities({ search: str(input.query), blueprint: str(input.blueprint) || undefined, limit: SEARCH_LIMIT, offset: 0 });
    return JSON.stringify({ total: page.total, items: page.items.map(({ createdAt: _c, ...e }) => e) });
  }
  if (name === 'get_entity') {
    const e = await findEntity(str(input.blueprint), str(input.identifier));
    return e ? JSON.stringify(e) : `No entity ${str(input.blueprint)}/${str(input.identifier)}`;
  }
  throw new Error(`Unknown tool ${name}`);
}

export const catalogToolSet = (): ToolSet => ({ defs: CATALOG_TOOLS, run: runCatalogTool });

// ---------- governed write tools ----------
const WRITE_TOOLS: Record<string, Tool> = {
  upsert_entity: {
    name: 'upsert_entity',
    description: 'Create or update a catalog entity (properties are merged into an existing entity). Only the allowed blueprints can be written.',
    input_schema: {
      type: 'object',
      properties: {
        blueprint: { type: 'string' },
        identifier: { type: 'string' },
        title: { type: 'string' },
        team: { type: 'string', description: 'Owning team identifier (optional)' },
        properties: { type: 'object', description: 'Entity properties' },
        relations: { type: 'object', description: 'Relation name → target identifier(s)' },
      },
      required: ['blueprint', 'identifier'],
    },
  },
  trigger_action: {
    name: 'trigger_action',
    description: 'Start a self-service action with inputs, as the user who started this workflow. Only the allowed actions can be started.',
    input_schema: {
      type: 'object',
      properties: {
        action: { type: 'string' },
        entity: { type: 'string', description: 'Target entity identifier for day-2 actions' },
        inputs: { type: 'object' },
      },
      required: ['action'],
    },
  },
  http: {
    name: 'http',
    description: 'Make an HTTP request to an allowed host. Redirects are not followed; the response is truncated.',
    input_schema: {
      type: 'object',
      properties: { method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] }, url: { type: 'string' }, body: { type: 'object' } },
      required: ['url'],
    },
  },
};

export interface AgentToolContext {
  runId: string;
  stepId: string;
  actionId: string;
  principal: Principal;
}

const MAX_HTTP_BODY_BYTES = 20_000;

/** Is `url` on an allow-listed host (exact `host` / `host:port` match, credentials and redirects never allowed)? */
export function httpAllowed(url: string, hosts: string[]): URL {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error('Invalid URL');
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('Only http(s) URLs are allowed');
  if (u.username || u.password) throw new Error('URLs with credentials are not allowed');
  const allowed = hosts.map((h) => h.toLowerCase());
  if (!allowed.includes(u.host.toLowerCase())) throw new Error(`Host ${u.host} is not in the allow-list of this step`);
  return u;
}

/** Tools of an agent step. Every write is checked against the step's guardrails and the run user's permissions, counted and audited. */
export function agentToolSet(tools: string[], g: AgentStepGuardrails, ctx: AgentToolContext): ToolSet | undefined {
  const defs: Tool[] = [];
  if (tools.includes('catalog')) defs.push(...CATALOG_TOOLS);
  for (const t of tools) if (WRITE_TOOLS[t]) defs.push(WRITE_TOOLS[t]);
  if (!defs.length) return undefined;
  let writes = 0;
  const actor = actorOf(ctx.principal);
  const write = async (kind: string, target: string, detail: Record<string, unknown>, fn: () => Promise<unknown>) => {
    if (++writes > g.maxWrites) throw new Error(`Write limit reached (${g.maxWrites} per step)`);
    await audit(actor, `agent.${kind}`, target, { runId: ctx.runId, stepId: ctx.stepId, ...detail });
    return JSON.stringify(await fn());
  };

  return {
    defs,
    async run(name, input) {
      if (CATALOG_TOOLS.some((t) => t.name === name) && tools.includes('catalog')) return runCatalogTool(name, input);
      if (name === 'upsert_entity' && tools.includes(name)) {
        const blueprint = str(input.blueprint);
        if (!g.entityBlueprints.includes(blueprint)) throw new Error(`Blueprint "${blueprint}" is not allowed (allowed: ${g.entityBlueprints.join(', ')})`);
        const identifier = str(input.identifier);
        const existing = await findEntity(blueprint, identifier);
        const team = typeof input.team === 'string' ? input.team : (existing?.team ?? null);
        if (!canEditEntity(ctx.principal, existing?.team ?? team)) throw new Error('The user who started this run cannot edit entities of that team');
        return write('upsert_entity', `${blueprint}/${identifier}`, {}, async () => {
          const r = await upsertEntity(blueprint, { ...input, team }, { source: `agent:${ctx.runId}`, actor, merge: true });
          return { created: r.created, changed: r.changed, identifier: r.entity.identifier };
        });
      }
      if (name === 'trigger_action' && tools.includes(name)) {
        const action = str(input.action);
        if (!g.actions.includes(action)) throw new Error(`Action "${action}" is not allowed (allowed: ${g.actions.join(', ')})`);
        if (action === ctx.actionId) throw new Error('An agent cannot start the action it belongs to');
        return write('trigger_action', action, {}, async () => {
          const r = await triggerRun(ctx.principal, action, {
            entity: str(input.entity) || null,
            inputs: input.inputs && typeof input.inputs === 'object' ? (input.inputs as Record<string, unknown>) : {},
          });
          return { runId: r.id, status: r.status };
        });
      }
      if (name === 'http' && tools.includes(name)) {
        const method = (str(input.method) || 'GET').toUpperCase();
        if (!(g.httpMethods as string[]).includes(method)) throw new Error(`Method ${method} is not allowed (allowed: ${g.httpMethods.join(', ')})`);
        const url = httpAllowed(str(input.url), g.httpHosts);
        const body = input.body === undefined ? undefined : JSON.stringify(input.body);
        if (body && body.length > MAX_HTTP_BODY_BYTES) throw new Error('Request body too large');
        const call = async () => {
          const res = await http(url.toString(), { method, body, redirect: 'error' });
          return { status: res.status, body: res.text.slice(0, MAX_HTTP_BODY_BYTES) };
        };
        // Reads are free; anything else counts as a write and is audited.
        return method === 'GET' ? JSON.stringify(await call()) : write('http', `${method} ${url.host}${url.pathname}`, {}, call);
      }
      throw new Error(`Unknown tool ${name}`);
    },
  };
}
