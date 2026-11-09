import type { Entity, PluginInfo } from '@asterius/shared';

/**
 * Invokers execute self-service actions: they call an external system (webhook, CI pipeline, Kubernetes Job…)
 * and report the outcome. Add one by implementing `Invoker` and registering it in `invokers/index.ts`
 * (or call `registerInvoker` from a plugin module). Configuration is validated with `validate` when the action
 * is saved and rendered (`{{ }}` templates, `${secret:…}` references) before each call.
 */

/** Data available to `{{ }}` templates of the invoker configuration. */
export interface RunContext {
  /** `idempotencyKey` is stable per run and step (same across retries): receivers can deduplicate repeated starts. */
  run: { id: string; url: string; idempotencyKey: string; callback: { url: string; token: string } };
  action: { identifier: string; title: string; blueprint: string | null };
  inputs: Record<string, unknown>;
  entity: (Entity & { scorecards?: Record<string, { level: string | null; rank: number; passed: number; total: number }> }) | null;
  trigger: { user: { id: string; email: string; name: string }; at: string };
  /** Earlier workflow steps: `{{ steps.review.output.risk }}`. */
  steps: Record<
    string,
    {
      status: string;
      output: unknown;
      link: string | null;
      events?: { url: string; token: string };
      /** Files attached to the step: metadata and download URL (`GET` with an API token that may read the run). */
      artifacts?: { id: string; name: string; contentType: string; size: number; sha256: string; url: string }[];
    }
  >;
}

export type InvokeStatus = 'IN_PROGRESS' | 'SUCCESS' | 'FAILURE';

export interface InvokeResult {
  status: InvokeStatus;
  /** Persisted between `start` and `poll` (e.g. the external run id). */
  state?: Record<string, unknown>;
  link?: string;
  statusLabel?: string;
  result?: unknown;
  /** Files to attach to the step (base64 content): stored as run artifacts. */
  artifacts?: { name: string; contentType?: string; content: string }[];
}

export interface InvokeEnv {
  ctx: RunContext;
  /** Rendered configuration. */
  config: Record<string, unknown>;
  log: (message: string, level?: 'info' | 'warn' | 'error') => Promise<void>;
}

export interface Invoker {
  info: PluginInfo;
  /** Static validation of the (unrendered) configuration; throw an Error with a helpful message. */
  validate(config: Record<string, unknown>): void;
  start(env: InvokeEnv): Promise<InvokeResult>;
  /** Called every RUN_POLL_SECONDS while IN_PROGRESS. Omit when the external system reports through the callback API. */
  poll?(env: InvokeEnv, state: Record<string, unknown>): Promise<InvokeResult>;
  cancel?(env: InvokeEnv, state: Record<string, unknown>): Promise<void>;
}

export const str = (v: unknown) => (typeof v === 'string' ? v : v == null ? '' : String(v));

export function requireFields(config: Record<string, unknown>, fields: string[], type: string) {
  const missing = fields.filter((f) => config[f] === undefined || config[f] === '');
  if (missing.length) throw new Error(`${type} invoker: missing ${missing.join(', ')}`);
}

/** Pipelines take string parameters: stringify objects/arrays. */
export const stringValues = (o: unknown): Record<string, string> =>
  Object.fromEntries(Object.entries((o as Record<string, unknown>) ?? {}).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)]));
