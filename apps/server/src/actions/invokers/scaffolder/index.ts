import { githubPublisher } from './github.js';
import { gitlabPublisher } from './gitlab.js';
import { unsupportedMode } from './render.js';
import type { ScaffoldConfig } from './config.js';
import type { ScaffoldPublisher } from './types.js';

/**
 * Provider registry. To add a provider (e.g. azure-devops): create `<provider>.ts` exporting a `ScaffoldPublisher`
 * and add it here; its name is already allowed by `SCAFFOLD_PROVIDERS` (config.ts).
 */
const publishers: Partial<Record<ScaffoldConfig['provider'], ScaffoldPublisher>> = {
  github: githubPublisher,
  gitlab: gitlabPublisher,
};

export function getPublisher(config: ScaffoldConfig): ScaffoldPublisher {
  const p = publishers[config.provider];
  if (!p) throw unsupportedMode(config.provider, config.mode);
  return p;
}

export * from './types.js';
export * from './config.js';
export { renderFiles, renderText, unsupportedMode } from './render.js';
