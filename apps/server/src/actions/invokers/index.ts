import type { PluginInfo } from '@asterius/shared';
import { badRequest } from '../../lib/errors.js';
import { checkTemplate } from '../../lib/expr.js';
import type { Invoker } from '../types.js';
import { webhookInvoker } from './webhook.js';
import { githubInvoker } from './github.js';
import { azurePipelinesInvoker } from './azure-pipelines.js';
import { gitlabInvoker } from './gitlab.js';
import { kubernetesJobInvoker } from './kubernetes-job.js';
import { catalogInvoker } from './catalog.js';
import { emailInvoker, slackInvoker, teamsInvoker } from './notify.js';
import { externalInvoker } from './external.js';
import { argoWorkflowsInvoker, jenkinsInvoker, terraformCloudInvoker } from './orchestrators.js';
import { scaffolderInvoker } from './scaffolder.js';
import { tektonInvoker } from './tekton.js';
import { jiraInvoker, lambdaInvoker, stepFunctionsInvoker } from './services.js';
import { servicePrecheckInvoker, serviceSpecInvoker } from './service-spec.js';

const registry = new Map<string, Invoker>();

/** Extension point: register a custom invoker type (e.g. from a fork or a plugin module imported in index.ts). */
export function registerInvoker(inv: Invoker) {
  registry.set(inv.info.type, inv);
}

for (const inv of [
  webhookInvoker,
  githubInvoker,
  azurePipelinesInvoker,
  gitlabInvoker,
  kubernetesJobInvoker,
  catalogInvoker,
  slackInvoker,
  teamsInvoker,
  emailInvoker,
  externalInvoker,
  jenkinsInvoker,
  argoWorkflowsInvoker,
  terraformCloudInvoker,
  jiraInvoker,
  lambdaInvoker,
  stepFunctionsInvoker,
  tektonInvoker,
  scaffolderInvoker,
  serviceSpecInvoker,
  servicePrecheckInvoker,
])
  registerInvoker(inv);

export function getInvoker(type: string): Invoker {
  const inv = registry.get(type);
  if (!inv) throw badRequest(`Unknown invoker type "${type}" (available: ${[...registry.keys()].join(', ')})`);
  return inv;
}

export function validateInvoker(config: { type: string } & Record<string, unknown>) {
  const inv = getInvoker(config.type);
  try {
    inv.validate(config);
  } catch (err) {
    throw badRequest((err as Error).message);
  }
  checkTemplate(config);
}

export const invokerInfos = (): PluginInfo[] => [...registry.values()].map((i) => i.info);
