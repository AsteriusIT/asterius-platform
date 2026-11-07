import { config } from '../config.js';
import { httpJson, type SecretProvider } from './types.js';

/** GCP Secret Manager (REST) using the metadata server's service account (GKE workload identity / GCE): no key file. */
let token: { value: string; until: number } | undefined;

async function accessToken(): Promise<string> {
  if (token && token.until > Date.now()) return token.value;
  const r = await httpJson<{ access_token: string; expires_in: number }>(
    `${config.GCP_METADATA_URL}/computeMetadata/v1/instance/service-accounts/default/token`,
    {
      headers: { 'metadata-flavor': 'Google' },
    },
  );
  token = { value: r.access_token, until: Date.now() + Math.max(60, r.expires_in - 120) * 1000 };
  return token.value;
}

/** `project/secret[/version]` (version defaults to latest). */
export const gcpsm: SecretProvider = {
  kind: 'gcpsm',
  title: 'GCP Secret Manager',
  example: 'my-project/db-password',
  enabled: () => !!config.GCP_SECRETMANAGER_ENABLED,
  async get(ref) {
    const [project, name, version = 'latest'] = ref.split('/');
    if (!project || !name || !/^[a-z][a-z0-9-]{4,60}$/.test(project) || !/^[A-Za-z0-9_-]{1,255}$/.test(name) || !/^(latest|\d{1,6})$/.test(version))
      throw new Error('expected project/secret[/version]');
    const r = await httpJson<{ payload?: { data?: string } }>(
      `${config.GCP_SECRETMANAGER_URL}/v1/projects/${project}/secrets/${name}/versions/${version}:access`,
      { headers: { authorization: `Bearer ${await accessToken()}` } },
    );
    if (r.payload?.data === undefined) throw new Error('secret has no payload');
    return Buffer.from(r.payload.data, 'base64').toString('utf8');
  },
};
