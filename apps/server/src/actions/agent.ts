import Anthropic from '@anthropic-ai/sdk';
import type { ObjectSchema, PropertySchema } from '@asterius/shared';
import { config } from '../config.js';
import { listBlueprints } from '../catalog/blueprints.js';
import { canRead, findEntity, searchEntities } from '../catalog/entities.js';
import { ANONYMOUS, visibleBlueprints } from '../auth/access.js';
import { validator } from '../catalog/validation.js';
import { metrics } from '../metrics.js';
import type { WorkflowStepDef } from '../schemas.js';

/**
 * Agent steps: a Claude call whose answer becomes the step output.
 *  - prompt and system prompt are templates (rendered by the engine with inputs, entity and earlier step outputs);
 *  - `output` (a JSON Schema built in the UI) turns on structured outputs: the answer is validated JSON;
 *  - `tools: [catalog]` lets the model look things up in the catalog (read-only) in a short tool loop.
 * Uses the official SDK. Retryable failures (rate limit, overload, network) are retried by the step's retry policy.
 */

export type AgentStepDef = Extract<WorkflowStepDef, { type: 'agent' }>;

export class StepError extends Error {
  constructor(
    message: string,
    public retryable: boolean,
  ) {
    super(message);
  }
}

/** $ per million tokens (input, output), for the cost estimate in the step log. */
const PRICES: Record<string, [number, number]> = {
  'claude-fable-5-1': [10, 50],
  'claude-opus-5-5': [4, 20],
  'claude-sonnet-5-5': [2, 10],
  'claude-haiku-5-5': [0.1, 0.5],
};
/** Models accepting the server-side refusal fallback in its "default" form. */
const FALLBACK_MODELS = new Set(['claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5']);

// ---------- structured output schema ----------
const SUPPORTED_FORMATS = new Set(['date-time', 'time', 'date', 'duration', 'email', 'hostname', 'uri', 'ipv4', 'ipv6', 'uuid']);

/** Builder property → JSON Schema accepted by structured outputs (no numeric/length constraints, closed objects). */
function apiProperty(p: PropertySchema): Record<string, unknown> {
  const out: Record<string, unknown> = { type: p.type === 'object' ? 'string' : p.type };
  if (p.type === 'object') out.description = `${p.description ? `${p.description} ` : ''}(JSON text)`;
  else if (p.description || p.title) out.description = p.description ?? p.title;
  if (p.enum) out.enum = p.enum;
  const format = p.format === 'url' ? 'uri' : p.format;
  if (format && SUPPORTED_FORMATS.has(format)) out.format = format;
  if (p.type === 'array') out.items = p.items ? apiProperty(p.items) : { type: 'string' };
  return out;
}

export function outputJsonSchema(s: ObjectSchema) {
  return {
    type: 'object',
    properties: Object.fromEntries(Object.entries(s.properties).map(([k, p]) => [k, apiProperty(p)])),
    required: s.required ?? [],
    additionalProperties: false,
  };
}

// ---------- catalog tools (read-only) ----------
const CATALOG_TOOLS: Anthropic.Beta.BetaTool[] = [
  {
    name: 'list_blueprints',
    description: 'List the kinds of entities in the software catalog (blueprints), with their properties and relations.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'search_catalog',
    description:
      'Search catalog entities by name or identifier, optionally within one blueprint. Returns up to 20 entities with their team, properties and relations.',
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

async function runCatalogTool(name: string, input: Record<string, unknown>): Promise<string> {
  if (name === 'list_blueprints')
    return JSON.stringify(
      (await visibleBlueprints(ANONYMOUS, await listBlueprints())).map((b) => ({
        identifier: b.identifier,
        title: b.title,
        properties: Object.keys(b.schema.properties),
        relations: b.relations,
      })),
    );
  if (name === 'search_catalog') {
    const page = await searchEntities({ search: str(input.query), blueprint: str(input.blueprint) || undefined, limit: 20, offset: 0, viewer: ANONYMOUS });
    return JSON.stringify({ total: page.total, items: page.items.map(({ createdAt: _c, ...e }) => e) });
  }
  if (name === 'get_entity') {
    const e = await findEntity(str(input.blueprint), str(input.identifier));
    // Agents run unattended: they only see what has no read rule.
    if (e && !(await canRead(ANONYMOUS, e))) return `No entity ${str(input.blueprint)}/${str(input.identifier)}`;
    return e ? JSON.stringify(e) : `No entity ${str(input.blueprint)}/${str(input.identifier)}`;
  }
  throw new Error(`Unknown tool ${name}`);
}

// ---------- the call ----------
export interface AgentRun {
  output: Record<string, unknown>;
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; costUsd: number | null; turns: number; model: string };
}

/** Map SDK errors to retryable / permanent step failures. */
function classify(err: unknown): StepError {
  if (err instanceof StepError) return err;
  if (err instanceof Anthropic.RateLimitError) return new StepError(`Claude API rate limit: ${err.message}`, true);
  if (err instanceof Anthropic.InternalServerError) return new StepError(`Claude API unavailable (${err.status}): ${err.message}`, true);
  if (err instanceof Anthropic.APIConnectionError) return new StepError(`Cannot reach the Claude API: ${err.message}`, true);
  if (err instanceof Anthropic.AuthenticationError) return new StepError('Claude API key rejected: check ANTHROPIC_API_KEY or the step apiKey', false);
  if (err instanceof Anthropic.BadRequestError) return new StepError(`Claude API rejected the request: ${err.message}`, false);
  if (err instanceof Anthropic.APIError) return new StepError(`Claude API error ${err.status ?? ''}: ${err.message}`, (err.status ?? 0) >= 500);
  return new StepError((err as Error).message, false);
}

/**
 * Run an agent step whose templates are already rendered.
 * @param log step logger (redacts secrets)
 */
export async function runAgent(
  step: AgentStepDef & { prompt: string; system?: string; apiKey?: string },
  log: (message: string, level?: 'info' | 'warn' | 'error') => Promise<void>,
): Promise<AgentRun> {
  const apiKey = step.apiKey || config.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new StepError('No Claude API key: set ANTHROPIC_API_KEY on the platform or `apiKey: ${secret:NAME}` on the step', false);
  // ANTHROPIC_BASE_URL (proxy / gateway) is read by the SDK from the environment.
  const client = new Anthropic({ apiKey, maxRetries: 2, timeout: 10 * 60_000 });
  const model = step.model || config.AGENT_DEFAULT_MODEL;
  const tools = step.tools?.includes('catalog') ? CATALOG_TOOLS : undefined;
  const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: 'user', content: step.prompt }];
  const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costUsd: null as number | null, turns: 0, model };
  const fallback = FALLBACK_MODELS.has(model);

  await log(`Calling ${model} (effort ${step.effort}${tools ? ', catalog tools' : ''}${step.output ? ', structured output' : ''})`);
  try {
    for (let turn = 1; turn <= step.maxTurns; turn++) {
      usage.turns = turn;
      const response = await client.beta.messages.create({
        model,
        max_tokens: step.maxTokens,
        ...(step.system ? { system: step.system } : {}),
        messages,
        ...(tools ? { tools } : {}),
        // Thinking is adaptive by default on current models; effort sets its depth and the token spend.
        output_config: {
          effort: step.effort,
          ...(step.output ? { format: { type: 'json_schema' as const, schema: outputJsonSchema(step.output as ObjectSchema) } } : {}),
        },
        // On a safety decline, the API re-runs the request on a fallback model chosen by refusal category.
        ...(fallback ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {}),
      });
      usage.inputTokens += response.usage.input_tokens;
      usage.outputTokens += response.usage.output_tokens;
      usage.cacheReadTokens += response.usage.cache_read_input_tokens ?? 0;
      metrics.llmTokens(model, response.usage.input_tokens, response.usage.output_tokens);
      if (response.model !== model) await log(`Answered by fallback model ${response.model}`, 'warn');

      if (response.stop_reason === 'refusal')
        throw new StepError(`The model declined this request${response.stop_details?.category ? ` (${response.stop_details.category})` : ''}`, false);
      if (response.stop_reason === 'max_tokens') throw new StepError(`The answer was cut at maxTokens (${step.maxTokens}); raise it on the step`, false);

      messages.push({ role: 'assistant', content: response.content });
      if (response.stop_reason === 'pause_turn') continue;

      const toolUses = response.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use');
      if (toolUses.length) {
        const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
        for (const t of toolUses) {
          await log(`Tool ${t.name}(${JSON.stringify(t.input).slice(0, 200)})`);
          try {
            results.push({ type: 'tool_result', tool_use_id: t.id, content: await runCatalogTool(t.name, (t.input ?? {}) as Record<string, unknown>) });
          } catch (err) {
            results.push({ type: 'tool_result', tool_use_id: t.id, content: (err as Error).message, is_error: true });
          }
        }
        messages.push({ role: 'user', content: results }); // all results of one turn in a single message
        continue;
      }

      const text = response.content
        .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('\n')
        .trim();
      let output: Record<string, unknown> = { text };
      if (step.output) {
        try {
          output = JSON.parse(text) as Record<string, unknown>;
        } catch {
          throw new StepError('The model did not return valid JSON', true);
        }
        // Constraints the API does not enforce (min/max, patterns) are checked here.
        const v = validator(step.output as ObjectSchema);
        if (!v(output))
          throw new StepError(`The answer does not match the output schema: ${v.errors?.map((e) => `${e.instancePath || '/'} ${e.message}`).join('; ')}`, true);
      }
      const price = PRICES[model];
      usage.costUsd = price ? (usage.inputTokens * price[0] + usage.outputTokens * price[1]) / 1e6 : null;
      await log(
        `Done in ${turn} turn(s): ${usage.inputTokens} input${usage.cacheReadTokens ? ` (${usage.cacheReadTokens} from cache)` : ''} / ${usage.outputTokens} output tokens${usage.costUsd !== null ? ` · ≈ $${usage.costUsd.toFixed(4)}` : ''}`,
      );
      return { output, usage };
    }
    throw new StepError(`No final answer after ${step.maxTurns} turns (maxTurns)`, false);
  } catch (err) {
    throw classify(err);
  }
}
