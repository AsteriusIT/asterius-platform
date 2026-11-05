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
}

export interface Source {
  info: PluginInfo;
  /** Push-only sources (inbound webhooks) have no `list`. */
  push?: boolean;
  validate(config: Record<string, unknown>): void;
  /** Yield pages of items of one kind. */
  list?(kind: string, env: SourceEnv): AsyncIterable<unknown[]>;
}

export const MAX_PAGES = 200;
