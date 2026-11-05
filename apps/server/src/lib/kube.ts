import * as k8s from '@kubernetes/client-node';
import { config } from '../config.js';

/**
 * Kubernetes access for the Kubernetes Job invoker and the Kubernetes source. In-cluster, the pod's service
 * account is used (see the Helm chart's RBAC); locally, KUBECONFIG_PATH or the default kubeconfig.
 * A config may name a context to target another cluster from the same kubeconfig.
 */
const configs = new Map<string, k8s.KubeConfig>();

export function kubeConfig(context?: string): k8s.KubeConfig {
  const key = context ?? '';
  let kc = configs.get(key);
  if (!kc) {
    kc = new k8s.KubeConfig();
    if (config.KUBECONFIG_PATH) kc.loadFromFile(config.KUBECONFIG_PATH);
    else kc.loadFromDefault();
    if (context) kc.setCurrentContext(context);
    configs.set(key, kc);
  }
  return kc;
}

export const kube = (context?: string) => {
  const kc = kubeConfig(context);
  return {
    core: kc.makeApiClient(k8s.CoreV1Api),
    batch: kc.makeApiClient(k8s.BatchV1Api),
    objects: k8s.KubernetesObjectApi.makeApiClient(kc),
  };
};

export { k8s };
