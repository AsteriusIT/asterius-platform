import type { PluginInfo } from '@asterius/shared';

/**
 * Sources list items from a third-party system for an integration. Add one by implementing `Source` and
 * registering it in `sources/index.ts` (or `registerSource`). Items are raw JSON; mappings turn them into
 * entities, so a source never needs to know the catalog model.
 */
export interface SourceEnv {
  /** Rendered configuration (secret references resolved). */
  config: Record<string, unknown>;
  log: (line: string) => void;
  /** ISO time the sync run started: a safe `since` value to store as the next state (nothing before it is missed). */
  startedAt: string;
  /**
   * Incremental sources: the state stored by the previous run for this kind. `undefined` means "list everything"
   * (first run, periodic full reconcile, or the state was reset).
   */
  state?: unknown;
  /** Store the state to hand to the next run. Only kept when the listing completed without `incomplete()`. */
  setState(state: unknown): void;
  /**
   * Report that the listing is not exhaustive (page cap, API result cap…). The sync then never deletes entities
   * of that kind and does not advance the incremental state.
   */
  incomplete(reason: string): void;
  /** Set for a targeted run (e.g. one repository after a push webhook): list only what matches. */
  scope?: string;
}

export interface Source {
  info: PluginInfo;
  /** Push-only sources (inbound webhooks) have no `list`. */
  push?: boolean;
  validate(config: Record<string, unknown>): void;
  /** Supports `env.state` (since timestamps, ETags…): the sync then runs incrementally between full reconciles. */
  incremental?: boolean;
  /**
   * Pull sources that can be refreshed by the provider's webhook: turn a received event into a scope (see
   * `SourceEnv.scope`), or undefined to ignore the event. The integration config needs `pushSecret`.
   */
  pushScope?(payload: unknown, headers: Record<string, unknown>): string | undefined;
  /** Yield pages of items of one kind. */
  list?(kind: string, env: SourceEnv): AsyncIterable<unknown[]>;
}

export const MAX_PAGES = 200;
