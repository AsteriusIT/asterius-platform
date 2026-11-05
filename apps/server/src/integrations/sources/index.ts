import type { PluginInfo } from '@asterius/shared';
import { badRequest } from '../../lib/errors.js';
import type { Source } from '../types.js';
import { githubSource } from './github.js';
import { azureDevOpsSource } from './azure-devops.js';
import { gitlabSource } from './gitlab.js';
import { kubernetesSource } from './kubernetes.js';
import { httpSource, webhookSource } from './http.js';

const registry = new Map<string, Source>();

/** Extension point: register a custom source type. */
export function registerSource(s: Source) {
  registry.set(s.info.type, s);
}

for (const s of [githubSource, azureDevOpsSource, gitlabSource, kubernetesSource, httpSource, webhookSource]) registerSource(s);

export function getSource(type: string): Source {
  const s = registry.get(type);
  if (!s) throw badRequest(`Unknown integration type "${type}" (available: ${[...registry.keys()].join(', ')})`);
  return s;
}

export const sourceInfos = (): PluginInfo[] => [...registry.values()].map((s) => s.info);
