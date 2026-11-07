import fs from 'node:fs';
import { config } from '../config.js';
import { httpJson, type SecretProvider } from './types.js';

/**
 * Azure Key Vault (REST). Authentication: Azure workload identity (AZURE_FEDERATED_TOKEN_FILE + AZURE_CLIENT_ID +
 * AZURE_TENANT_ID, federated client assertion), else the managed identity endpoint (IMDS). No client secret.
 */
let token: { value: string; until: number } | undefined;

async function accessToken(): Promise<string> {
  if (token && token.until > Date.now()) return token.value;
  const scope = 'https://vault.azure.net/.default';
  let r: { access_token: string; expires_in: number | string };
  if (config.AZURE_FEDERATED_TOKEN_FILE) {
    const host = config.AZURE_AUTHORITY_HOST ?? 'https://login.microsoftonline.com';
    r = await httpJson(`${host.replace(/\/$/, '')}/${config.AZURE_TENANT_ID}/oauth2/v2.0/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: config.AZURE_CLIENT_ID!,
        grant_type: 'client_credentials',
        scope,
        client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
        client_assertion: fs.readFileSync(config.AZURE_FEDERATED_TOKEN_FILE, 'utf8').trim(),
      }),
    });
  } else {
    const imds = config.AZURE_IMDS_ENDPOINT ?? 'http://169.254.169.254/metadata/identity/oauth2/token';
    r = await httpJson(
      `${imds}?${new URLSearchParams({ 'api-version': '2018-02-01', resource: 'https://vault.azure.net', ...(config.AZURE_CLIENT_ID ? { client_id: config.AZURE_CLIENT_ID } : {}) })}`,
      { headers: { metadata: 'true' } },
    );
  }
  token = { value: r.access_token, until: Date.now() + Math.max(60, Number(r.expires_in) - 120) * 1000 };
  return token.value;
}

/** `vault-name/secret-name[/version]`. */
export const azkv: SecretProvider = {
  kind: 'azkv',
  title: 'Azure Key Vault',
  example: 'my-vault/db-password',
  enabled: () => !!config.AZURE_KEYVAULT_ENABLED,
  async get(ref) {
    const [vaultName, name, version] = ref.split('/');
    if (!vaultName || !name || !/^[A-Za-z0-9-]{3,24}$/.test(vaultName) || !/^[A-Za-z0-9-]{1,127}$/.test(name))
      throw new Error('expected vault-name/secret-name');
    const base = config.AZURE_KEYVAULT_URL_TEMPLATE.replace('{vault}', vaultName);
    const r = await httpJson<{ value?: string }>(`${base}/secrets/${name}${version ? `/${encodeURIComponent(version)}` : ''}?api-version=7.4`, {
      headers: { authorization: `Bearer ${await accessToken()}` },
    });
    if (r.value === undefined) throw new Error('secret has no value');
    return r.value;
  },
};
