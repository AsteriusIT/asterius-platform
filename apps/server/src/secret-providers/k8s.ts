import fs from 'node:fs';
import { config } from '../config.js';
import { kube } from '../lib/kube.js';
import type { SecretProvider } from './types.js';

const NS_FILE = '/var/run/secrets/kubernetes.io/serviceaccount/namespace';
const ownNamespace = () => (fs.existsSync(NS_FILE) ? fs.readFileSync(NS_FILE, 'utf8').trim() : undefined);

/** Namespaces whose Secrets may be referenced: K8S_SECRET_NAMESPACES, else only the namespace the platform runs in. */
const allowedNamespaces = () => (config.K8S_SECRET_NAMESPACES.length ? config.K8S_SECRET_NAMESPACES : [ownNamespace()].filter((n): n is string => !!n));

/** `namespace/secret/key`, read with the pod's service account (grant it `get` on those Secrets only). */
export const k8sSecret: SecretProvider = {
  kind: 'k8s',
  title: 'Kubernetes Secret',
  example: 'payments/db-credentials/password',
  enabled: () => allowedNamespaces().length > 0,
  async get(ref) {
    const [ns, name, key] = ref.split('/');
    if (!ns || !name || !key) throw new Error('expected namespace/secret/key');
    if (!allowedNamespaces().includes(ns)) throw new Error(`namespace "${ns}" is not allowed (K8S_SECRET_NAMESPACES)`);
    const s = await kube().core.readNamespacedSecret({ name, namespace: ns });
    const v = s.data?.[key];
    if (v === undefined) throw new Error(`key "${key}" not found`);
    return Buffer.from(v, 'base64').toString('utf8');
  },
};
