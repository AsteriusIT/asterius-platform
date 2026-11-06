import fs from 'node:fs';
import { config } from '../config.js';
import { httpJson, type SecretProvider } from './types.js';

const SA_TOKEN = '/var/run/secrets/kubernetes.io/serviceaccount/token';

let login: { token: string; until: number } | undefined;

/** Static token (VAULT_TOKEN) or Kubernetes auth with the pod's service account (VAULT_K8S_ROLE): no stored credential. */
async function vaultToken(): Promise<string> {
  if (config.VAULT_TOKEN) return config.VAULT_TOKEN;
  if (login && login.until > Date.now()) return login.token;
  const jwt = fs.readFileSync(config.VAULT_K8S_JWT_PATH ?? SA_TOKEN, 'utf8').trim();
  const r = await httpJson<{ auth: { client_token: string; lease_duration: number } }>(`${config.VAULT_ADDR}/v1/auth/${config.VAULT_K8S_MOUNT}/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(config.VAULT_NAMESPACE ? { 'x-vault-namespace': config.VAULT_NAMESPACE } : {}) },
    body: JSON.stringify({ role: config.VAULT_K8S_ROLE, jwt }),
  });
  login = { token: r.auth.client_token, until: Date.now() + Math.max(30, r.auth.lease_duration - 60) * 1000 };
  return login.token;
}

/** `mount/path/to/secret#key` on a KV v2 engine. */
export const vault: SecretProvider = {
  kind: 'vault',
  title: 'HashiCorp Vault (KV v2)',
  example: 'secret/payments/db#password',
  enabled: () => !!config.VAULT_ADDR && !!(config.VAULT_TOKEN || config.VAULT_K8S_ROLE),
  async get(ref) {
    const [path, key] = ref.split('#') as [string, string | undefined];
    const [mount, ...rest] = path.split('/');
    if (!mount || !rest.length || !key) throw new Error('expected mount/path#key');
    const r = await httpJson<{ data: { data: Record<string, unknown> } }>(`${config.VAULT_ADDR}/v1/${mount}/data/${rest.map(encodeURIComponent).join('/')}`, {
      headers: { 'x-vault-token': await vaultToken(), ...(config.VAULT_NAMESPACE ? { 'x-vault-namespace': config.VAULT_NAMESPACE } : {}) },
    });
    const v = r.data.data[key];
    if (typeof v !== 'string') throw new Error(`key "${key}" not found or not a string`);
    return v;
  },
};
