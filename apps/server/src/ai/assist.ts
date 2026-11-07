import type { ObjectSchema } from '@asterius/shared';
import { z } from 'zod';
import type { Principal } from '../auth/users.js';
import { getRun } from '../actions/runs.js';
import { validateWorkflow } from '../actions/workflow.js';
import { getBlueprint, listBlueprints } from '../catalog/blueprints.js';
import { badRequest } from '../lib/errors.js';
import { mapItem } from '../integrations/mapping.js';
import { checkExpression } from '../lib/expr.js';
import { blueprintDef, mappingDef, workflowStep } from '../schemas.js';
import { aiConfigured, ask, StepError, truncate, wrapUntrusted, type ConverseResult } from './model.js';
import { catalogToolSet } from './tools.js';
import type { UsageKind } from './usage.js';

/**
 * AI assistance for people: catalog questions, run explanations and authoring drafts.
 * Everything the user typed or the platform stores is passed as untrusted data, answers are validated with the same
 * schemas as hand-written resources (a draft is returned to the form for review, never saved), and every call is metered.
 */

const scopeOf = (kind: UsageKind, p: Principal) => ({ kind, userId: p.id, team: p.teams[0] ?? null });

async function run<T>(fn: () => Promise<T>): Promise<T> {
  if (!aiConfigured()) throw badRequest('The AI assistant is not configured: set ANTHROPIC_API_KEY (or another provider) on the platform');
  try {
    return await fn();
  } catch (err) {
    // Budget, key and API problems are the operator's to fix; they are reported as a 400 with the reason.
    if (err instanceof StepError) throw badRequest(err.message);
    throw err;
  }
}

const field = (type: 'string' | 'array' | 'boolean', description: string) => ({ type, description });
const schemaOf = (properties: Record<string, Record<string, unknown>>, required: string[]) => ({ properties, required }) as ObjectSchema;

// ---------- natural-language catalog query ----------
export async function askCatalog(p: Principal, question: string): Promise<{ answer: string; costUsd: number | null }> {
  return run(async () => {
    const r = await ask({
      scope: scopeOf('assist', p),
      system:
        'You answer questions about the company software catalog. Use the tools to look things up (list_blueprints first when unsure of the model), ' +
        'then answer concisely in Markdown, naming entities as `blueprint/identifier`. If the catalog does not contain the answer, say so: never guess.',
      prompt: `Question:\n${wrapUntrusted(question, 'user question')}`,
      tools: catalogToolSet(),
      maxTokens: 2000,
    });
    return { answer: r.text, costUsd: r.usage.costUsd };
  });
}

// ---------- run explanation ----------
export async function explainRun(p: Principal, runId: string, mode: 'explain' | 'summarise'): Promise<{ answer: string; costUsd: number | null }> {
  const r = await getRun(runId, p); // same visibility as the run page
  const steps = (r.steps ?? []).map((s) => ({
    id: s.id,
    type: s.type,
    status: s.status,
    statusLabel: s.statusLabel,
    attempt: s.attempt,
    output: s.status === 'SUCCESS' ? s.output : undefined,
  }));
  const logs = (r.logs ?? [])
    .slice(-150)
    .map((l) => `${l.at} ${l.level} ${l.stepId ? `[${l.stepId}] ` : ''}${l.message}`)
    .join('\n');
  const data = truncate(JSON.stringify({ action: r.action, status: r.status, statusLabel: r.statusLabel, inputs: r.inputs, steps }, null, 1), 12_000);
  const task =
    mode === 'explain'
      ? r.status === 'SUCCESS'
        ? 'Explain what this run did, step by step, in plain language.'
        : 'Explain why this run did not succeed: the failing step, the most likely cause from the logs, and what the user can do next. If the logs do not say, say so.'
      : 'Summarise these run logs in five bullet points or fewer: what happened, anything surprising, and the outcome.';
  return run(async () => {
    const out = await ask({
      scope: { ...scopeOf('assist', p), runId, action: r.action },
      system: 'You help engineers understand runs of a developer portal workflow. Be concrete and brief, answer in Markdown, and never invent log lines.',
      prompt: `${task}\n\n${wrapUntrusted(data, 'run')}\n\n${wrapUntrusted(truncate(logs, 12_000), 'run logs')}`,
      maxTokens: 1500,
    });
    return { answer: out.text, costUsd: out.usage.costUsd };
  });
}

// ---------- authoring ----------
const sampleText = (sample: unknown) => truncate(typeof sample === 'string' ? sample : JSON.stringify(sample, null, 1), 12_000);

const parseJsonText = <T>(text: unknown, schema: z.ZodType<T>, what: string): T => {
  try {
    return schema.parse(JSON.parse(typeof text === 'string' && text.trim() ? text : '{}'));
  } catch (err) {
    throw badRequest(
      `The assistant produced an invalid ${what}: ${err instanceof z.ZodError ? err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') : (err as Error).message}`,
    );
  }
};

const exprMap = z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/), z.string());

/** Suggest the JSONata mapping of a sample payload onto a blueprint, and show the entity it produces. */
export async function suggestMapping(p: Principal, input: { sample: unknown; blueprint: string; hint?: string }) {
  const bp = await getBlueprint(input.blueprint);
  return run(async () => {
    const r = await ask({
      scope: scopeOf('authoring', p),
      system:
        'You write JSONata expressions (https://jsonata.org) that map one JSON item from a third-party system to a catalog entity. ' +
        'Paths are relative to the item, e.g. `name`, `owner.login`; string constants are quoted, e.g. `"service"`. Only use fields present in the sample. ' +
        '`properties` and `relations` are JSON objects (as text) of name -> expression, using only the blueprint properties and relations given.',
      prompt: [
        `Blueprint ${bp.identifier}: properties ${JSON.stringify(bp.schema.properties)}; relations ${JSON.stringify(bp.relations)}.`,
        input.hint ? `Hint: ${wrapUntrusted(input.hint, 'hint')}` : '',
        `Sample item:\n${wrapUntrusted(sampleText(input.sample), 'sample payload')}`,
      ].join('\n'),
      output: schemaOf(
        {
          identifier: field('string', 'JSONata expression for the unique identifier'),
          title: field('string', 'JSONata expression for the display name'),
          team: field('string', 'JSONata expression for the owning team identifier, or empty'),
          properties: field('string', 'JSON object text: blueprint property -> JSONata expression'),
          relations: field('string', 'JSON object text: relation -> JSONata expression'),
        },
        ['identifier', 'title', 'team', 'properties', 'relations'],
      ),
      maxTokens: 3000,
    });
    const o = r.output as Record<string, string>;
    const mapping = mappingDef.parse({
      entity: {
        blueprint: bp.identifier,
        identifier: o.identifier,
        title: o.title || undefined,
        team: o.team || undefined,
        properties: parseJsonText(o.properties, exprMap, 'properties mapping'),
        relations: parseJsonText(o.relations, exprMap, 'relations mapping'),
      },
    });
    try {
      for (const e of [
        mapping.entity.identifier,
        mapping.entity.title,
        mapping.entity.team,
        ...Object.values(mapping.entity.properties),
        ...Object.values(mapping.entity.relations),
      ])
        if (e) checkExpression(e);
    } catch (err) {
      throw badRequest(`The assistant produced an invalid expression: ${(err as Error).message}`);
    }
    // Dry run on the sample so the user sees the result before saving.
    const preview = await mapItem(mapping, input.sample).catch((err: Error) => ({ mapped: [], skipped: 0, error: err.message }));
    return { mapping, preview, costUsd: r.usage.costUsd };
  });
}

/** Draft a blueprint from sample JSON (and an optional description). */
export async function draftBlueprint(p: Principal, input: { sample?: unknown; description?: string }) {
  if (input.sample === undefined && !input.description?.trim()) throw badRequest('Give a sample JSON or a description');
  const known = (await listBlueprints()).map((b) => b.identifier);
  return run(async () => {
    const r: ConverseResult = await ask({
      scope: scopeOf('authoring', p),
      system:
        'You design software-catalog blueprints (the schema of one kind of entity). Property names use letters, digits and _; types are string, number, integer, boolean, array or object; ' +
        'give each property a short title. Keep to the properties that matter for an engineering catalog. `properties` is a JSON object text: name -> {type, title, description?, enum?, format?}.',
      prompt: [
        `Existing blueprint identifiers (relation targets): ${known.join(', ') || 'none'}.`,
        input.description ? `Description:\n${wrapUntrusted(input.description, 'description')}` : '',
        input.sample === undefined ? '' : `Sample JSON:\n${wrapUntrusted(sampleText(input.sample), 'sample json')}`,
      ].join('\n'),
      output: schemaOf(
        {
          identifier: field('string', 'lowercase identifier: letters, digits, - and _'),
          title: field('string', 'display name'),
          description: field('string', 'one sentence'),
          properties: field('string', 'JSON object text of property schemas'),
          required: field('array', 'names of required properties'),
          relations: field('string', 'JSON object text: relation -> {target, many?, title?}; {} when none'),
        },
        ['identifier', 'title', 'description', 'properties', 'required', 'relations'],
      ),
      maxTokens: 4000,
    });
    const o = r.output as Record<string, unknown>;
    try {
      const blueprint = blueprintDef.parse({
        identifier: o.identifier,
        title: o.title,
        description: o.description,
        schema: { properties: JSON.parse(String(o.properties || '{}')), required: o.required },
        relations: JSON.parse(String(o.relations || '{}')),
      });
      return { blueprint, costUsd: r.usage.costUsd };
    } catch (err) {
      throw badRequest(
        `The assistant produced an invalid blueprint: ${err instanceof z.ZodError ? err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') : (err as Error).message}`,
      );
    }
  });
}

/** Draft a workflow (steps) from a description. The result is validated like a saved workflow. */
export async function draftWorkflow(p: Principal, input: { description: string }) {
  const bps = (await listBlueprints()).map((b) => `${b.identifier}(${Object.keys(b.schema.properties).join(',')})`);
  return run(async () => {
    const r = await ask({
      scope: scopeOf('authoring', p),
      system:
        'You design workflows for a developer portal. A workflow is an ordered list of steps; steps run in order unless `needs` lists earlier step ids. Step types: ' +
        '`approval` {approvers:{roles?:["admin"|"member"],teams?:[..],ownerTeam?:true}, minApprovals, message}; ' +
        '`transform` {output:{key: JSONata}}; `agent` {prompt, system?, output?}; `invoke` {invoker:{type:"webhook"|"catalog"|..., ...}}. ' +
        'Every step has a unique `id` (letters, digits, _), a `name`, and `type`. Templates use {{ expression }} over `inputs`, `entity`, `steps.<id>.output`, `trigger.user`. ' +
        'Put an approval step between an agent and any invoke step that uses the agent output. `steps` is a JSON array text.',
      prompt: `Catalog blueprints: ${bps.join('; ') || 'none'}.\nDraft a workflow for:\n${wrapUntrusted(input.description, 'description')}`,
      output: schemaOf(
        {
          title: field('string', 'workflow title'),
          description: field('string', 'one sentence'),
          steps: field('string', 'JSON array text of steps'),
        },
        ['title', 'description', 'steps'],
      ),
      maxTokens: 6000,
    });
    const o = r.output as Record<string, string>;
    const parsed = parseJsonText(o.steps, z.array(workflowStep).min(1).max(30), 'workflow');
    // A draft never grants powers: agent steps keep read-only tools, no MCP servers and no credentials.
    const steps = parsed.map((s) => (s.type === 'agent' ? { ...s, tools: s.tools.filter((t) => t === 'catalog'), mcpServers: [], apiKey: undefined } : s));
    validateWorkflow(steps as never);
    return { title: o.title, description: o.description, steps, costUsd: r.usage.costUsd };
  });
}
