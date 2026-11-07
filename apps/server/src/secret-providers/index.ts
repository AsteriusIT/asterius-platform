import { config } from '../config.js';

/**
 * External secret managers. References in configuration resolve at execution time through a provider chosen by the
 * kind of the reference:
 *   ${vault:mount/path#key}            HashiCorp Vault KV v2
 *   ${awssm:name[#jsonKey]}            AWS Secrets Manager
 *   ${azkv:vault/name}                 Azure Key Vault
 *   ${gcpsm:project/name[/version]}    GCP Secret Manager
 *   ${k8s:namespace/secret/key}        Kubernetes Secret
 * Providers authenticate with workload identity when available (Vault Kubernetes auth, IRSA, Azure workload
 * identity / managed identity, GKE metadata server, the pod's service account) so no static credential is required.
 * Values are cached briefly in memory (SECRET_CACHE_SECONDS) and never logged.
 */

import { assertSafeRef, type SecretProvider } from './types.js';

import { vault } from './vault.js';
import { awssm } from './aws.js';
import { azkv } from './azure.js';
import { gcpsm } from './gcp.js';
import { k8sSecret } from './k8s.js';

export { assertSafeRef, httpJson, SAFE_REF, type SecretProvider } from './types.js';

export const providers: SecretProvider[] = [vault, awssm, azkv, gcpsm, k8sSecret];
export const PROVIDER_KINDS = providers.map((p) => p.kind);
export const providerOf = (kind: string) => providers.find((p) => p.kind === kind);

const cache = new Map<string, { at: number; value: string }>();

export async function resolveExternal(kind: string, ref: string): Promise<string> {
  const p = providerOf(kind);
  if (!p) throw new Error(`Unknown secret provider "${kind}"`);
  if (!p.enabled()) throw new Error(`Secret provider "${kind}" is not configured on this platform`);
  assertSafeRef(ref, kind);
  const key = `${kind}:${ref}`;
  const hit = cache.get(key);
  const ttl = config.SECRET_CACHE_SECONDS * 1000;
  if (hit && Date.now() - hit.at < ttl) return hit.value;
  let value: string;
  try {
    value = await p.get(ref);
  } catch (err) {
    // Reference text is admin-written configuration, not a secret; the provider error never carries the value.
    throw new Error(`${kind} reference "${ref}" could not be resolved: ${(err as Error).message}`, { cause: err });
  }
  if (cache.size > 500) cache.clear();
  if (ttl > 0) cache.set(key, { at: Date.now(), value });
  return value;
}

export const clearSecretCache = () => cache.clear();

export interface ProviderInfo {
  kind: string;
  title: string;
  enabled: boolean;
  example: string;
}
export const providerInfos = (): ProviderInfo[] =>
  providers.map((p) => ({ kind: p.kind, title: p.title, enabled: p.enabled(), example: `\${${p.kind}:${p.example}}` }));
