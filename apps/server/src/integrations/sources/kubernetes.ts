import { kube } from '../../lib/kube.js';
import { str } from '../../actions/types.js';
import { MAX_PAGES, type Source } from '../types.js';

/**
 * Any Kubernetes resource, the kind being `<apiVersion>/<Kind>`: `v1/Namespace`, `apps/v1/Deployment`,
 * `networking.k8s.io/v1/Ingress`, or a CRD (`argoproj.io/v1alpha1/Application`). Needs list RBAC on those resources.
 */
export const kubernetesSource: Source = {
  info: {
    type: 'kubernetes',
    title: 'Kubernetes',
    description: 'Any resource of a cluster (workloads, namespaces, ingresses, CRDs such as Argo CD applications).',
    kinds: ['v1/Namespace', 'apps/v1/Deployment', 'apps/v1/StatefulSet', 'networking.k8s.io/v1/Ingress', 'batch/v1/CronJob'],
    example: {
      type: 'kubernetes',
      config: { cluster: 'prod-weu', namespaces: ['payments', 'checkout'], labelSelector: 'app.kubernetes.io/part-of' },
      mappings: [
        {
          kind: 'apps/v1/Deployment',
          entity: {
            blueprint: 'workload',
            identifier: '$integration.config.cluster & "/" & metadata.namespace & "/" & metadata.name',
            title: 'metadata.name',
            properties: {
              namespace: 'metadata.namespace',
              image: 'spec.template.spec.containers[0].image',
              replicas: 'spec.replicas',
              ready: 'status.readyReplicas = spec.replicas',
            },
            relations: { service: 'metadata.labels."app.kubernetes.io/name"' },
          },
        },
      ],
    },
  },
  validate(c) {
    if (c.namespaces !== undefined && !Array.isArray(c.namespaces)) throw new Error('kubernetes: namespaces is a list');
  },
  async *list(kind, { config, log }) {
    const i = kind.lastIndexOf('/');
    if (i <= 0) throw new Error(`kubernetes: kind must be <apiVersion>/<Kind>, got "${kind}"`);
    const apiVersion = kind.slice(0, i);
    const k = kind.slice(i + 1);
    const api = kube(config.context ? str(config.context) : undefined).objects;
    const namespaces = Array.isArray(config.namespaces) && config.namespaces.length ? config.namespaces.map(str) : [undefined];
    const labelSelector = config.labelSelector ? str(config.labelSelector) : undefined;
    for (const ns of namespaces) {
      let cont: string | undefined;
      for (let page = 0; page < MAX_PAGES; page++) {
        const res = await api.list(apiVersion, k, ns, undefined, undefined, undefined, undefined, labelSelector, 500, cont);
        log(`${kind}${ns ? ` in ${ns}` : ''}: ${res.items.length} items`);
        // managedFields are noise for mappings
        yield res.items.map((o) => ({ ...o, metadata: { ...o.metadata, managedFields: undefined } }));
        cont = res.metadata?._continue;
        if (!cont) break;
      }
    }
  },
};
