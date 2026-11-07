import type { ObjectSchema } from '@asterius/shared';
import type { Principal } from '../auth/users.js';
import { converse, makeClient, type Logger, type McpServerConfig } from '../ai/model.js';
import { agentToolSet } from '../ai/tools.js';
import type { WorkflowStepDef } from '../schemas.js';

/**
 * Agent steps: a Claude call whose answer becomes the step output.
 *  - prompt and system prompt are templates (rendered by the engine with inputs, entity and earlier step outputs;
 *    interpolated values are fenced as untrusted data and secrets can never be referenced);
 *  - `output` (a JSON Schema built in the UI) turns on structured outputs: the answer is validated JSON;
 *  - `tools` lets the model look things up in the catalog and, inside the step's guardrails, act (upsert, trigger, HTTP);
 *  - `mcpServers` connect remote MCP servers (called by the Claude API).
 * The model loop, metering and budgets live in ai/model.ts. Retryable failures (rate limit, overload, network)
 * are retried by the step's retry policy.
 */

export type AgentStepDef = Extract<WorkflowStepDef, { type: 'agent' }>;

export { StepError, outputJsonSchema, wrapUntrusted, truncate, MAX_TOOL_RESULT_CHARS, UNTRUSTED_NOTICE } from '../ai/model.js';

export interface AgentRun {
  output: Record<string, unknown>;
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; costUsd: number | null; turns: number; model: string };
}

export interface AgentRunContext {
  runId: string;
  stepId: string;
  action: string;
  team: string | null;
  principal: Principal;
  signal?: AbortSignal;
}

export type RenderedAgentStep = AgentStepDef & { prompt: string; system?: string; apiKey?: string; mcpTokens?: string[] };

/**
 * Run an agent step whose templates are already rendered.
 * @param log step logger (redacts secrets)
 */
export async function runAgent(step: RenderedAgentStep, log: Logger, ctx: AgentRunContext): Promise<AgentRun> {
  const { client, provider } = await makeClient({ provider: step.provider, apiKey: step.apiKey });
  const mcpServers: McpServerConfig[] = step.mcpServers.map((s, i) => ({
    name: s.name,
    url: s.url,
    token: step.mcpTokens?.[i] || undefined,
    allowedTools: s.allowedTools,
  }));
  const tools = agentToolSet(step.tools, step.guardrails, { runId: ctx.runId, stepId: ctx.stepId, actionId: ctx.action, principal: ctx.principal });
  const r = await converse({
    client,
    provider,
    model: step.model,
    system: step.system,
    prompt: step.prompt,
    effort: step.effort,
    maxTokens: step.maxTokens,
    maxTurns: step.maxTurns,
    output: step.output as ObjectSchema | undefined,
    tools,
    mcpServers,
    scope: {
      kind: 'agent',
      runId: ctx.runId,
      stepId: ctx.stepId,
      action: ctx.action,
      team: ctx.team ?? ctx.principal.teams[0] ?? null,
      userId: ctx.principal.id,
    },
    runBudgetUsd: step.maxCostUsd,
    signal: ctx.signal,
    log,
  });
  return { output: r.output, usage: r.usage };
}
