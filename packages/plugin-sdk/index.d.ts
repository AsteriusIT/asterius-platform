/**
 * Types for Asterius Platform plugins. A plugin is an ES module whose default export receives a `PluginApi`:
 *
 *   // plugins/jira.mjs  (PLUGIN_DIR) — or an npm package listed in PLUGINS
 *   // @ts-check with JSDoc: @param {import('@asterius/plugin-sdk').PluginApi} api
 *   export default function register(api) {
 *     api.registerSource({ info: {...}, validate(c) {...}, async *list(kind, env) { yield [...]; } });
 *   }
 *
 * Plugins run inside the server with its privileges; for isolation use the HTTP contract of the `external`
 * source / invoker instead (see docs/EXTENDING.md).
 */
import type { PluginInfo } from '@asterius/shared';

export type { PluginInfo };

export interface SourceEnv {
  /** Rendered configuration (secret references resolved). */
  config: Record<string, unknown>;
  log: (line: string) => void;
  /** ISO time the sync started: a safe `since` value for the next incremental run. */
  startedAt: string;
  /** State stored by the previous run for this kind; undefined means "list everything". */
  state?: unknown;
  setState(state: unknown): void;
  /** Report a non-exhaustive listing: nothing is deleted for that kind and the state does not advance. */
  incomplete(reason: string): void;
}

export interface Source {
  info: PluginInfo;
  /** Push-only sources (inbound webhooks) have no `list`. */
  push?: boolean;
  /** Supports `env.state` (since timestamps, ETags…). */
  incremental?: boolean;
  validate(config: Record<string, unknown>): void;
  list?(kind: string, env: SourceEnv): AsyncIterable<unknown[]>;
}

export interface RunContext {
  run: { id: string; url: string; callback: { url: string; token: string } };
  action: { identifier: string; title: string; blueprint: string | null };
  inputs: Record<string, unknown>;
  entity: unknown;
  trigger: { user: { id: string; email: string; name: string }; at: string };
  steps: Record<string, { status: string; output: unknown; link: string | null }>;
}

export type InvokeStatus = 'IN_PROGRESS' | 'SUCCESS' | 'FAILURE';

export interface InvokeResult {
  status: InvokeStatus;
  state?: Record<string, unknown>;
  link?: string;
  statusLabel?: string;
  result?: unknown;
}

export interface InvokeEnv {
  ctx: RunContext;
  config: Record<string, unknown>;
  log: (message: string, level?: 'info' | 'warn' | 'error') => Promise<void>;
}

export interface Invoker {
  info: PluginInfo;
  validate(config: Record<string, unknown>): void;
  start(env: InvokeEnv): Promise<InvokeResult>;
  poll?(env: InvokeEnv, state: Record<string, unknown>): Promise<InvokeResult>;
  cancel?(env: InvokeEnv, state: Record<string, unknown>): Promise<void>;
}

export interface PluginApi {
  apiVersion: 1;
  registerSource(source: Source): void;
  registerInvoker(invoker: Invoker): void;
  log: { info(msg: string): void; warn(msg: string): void; error(msg: string): void };
}

export type PluginRegister = (api: PluginApi) => void | Promise<void>;
