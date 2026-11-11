import type { PluginInfo } from '@asterius/shared';
import { badRequest } from '../../lib/errors.js';
import type { Source } from '../types.js';
import { githubSource } from './github.js';
import { azureDevOpsSource } from './azure-devops.js';
import { gitlabSource } from './gitlab.js';
import { kubernetesSource } from './kubernetes.js';
import { sqlSource } from './sql.js';
import { awsResourcesSource, azureResourceGraphSource, gcpAssetsSource } from './cloud.js';
import { descriptorsSource } from './descriptors.js';
import { externalSource } from './external.js';
import { connectorSource, definitionSources, nativeConnector } from '../connectors/source.js';
import { configForValidation } from '../connectors/bindings.js';
import { graphqlSource, httpSource, webhookSource } from './http.js';

const registry = new Map<string, Source>();

/**
 * Extension point: register a custom source type. `validate` is wrapped so that a config naming a `connection` is
 * validated with what the connection provides (see connectors/bindings.ts); other types refuse a connection.
 */
export function registerSource(s: Source) {
  const validate = s.validate.bind(s);
  registry.set(s.info.type, { ...s, validate: (c) => validate(configForValidation('source', s.info.type, c, !!nativeConnector(s.info.type))) });
}

for (const s of [
  githubSource,
  azureDevOpsSource,
  gitlabSource,
  kubernetesSource,
  httpSource,
  graphqlSource,
  sqlSource,
  descriptorsSource,
  awsResourcesSource,
  azureResourceGraphSource,
  gcpAssetsSource,
  externalSource,
  connectorSource,
  webhookSource,
])
  registerSource(s);
// The built-in connector definitions with kinds are integration types too (the former presets: pagerduty, jira…).
for (const s of definitionSources((type) => registry.has(type))) registerSource(s);

export function getSource(type: string): Source {
  const s = registry.get(type);
  if (!s) throw badRequest(`Unknown integration type "${type}" (available: ${[...registry.keys()].join(', ')})`);
  return s;
}

export const sourceInfos = (): PluginInfo[] => [...registry.values()].map((s) => s.info);
