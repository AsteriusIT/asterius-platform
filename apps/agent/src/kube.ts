import fs from 'node:fs';
import type { K8sObject } from './state.ts';

/**
 * A small Kubernetes API client on fetch: list (paged), watch (streamed, resumed from resourceVersion, re-listed on
 * 410 Gone) and CRD discovery. In the cluster it uses the ServiceAccount token (re-read: projected tokens rotate)
 * and the cluster CA through NODE_EXTRA_CA_CERTS (set in the Deployment; fetch has no per-request CA option).
 * Outside a cluster: KUBE_API_URL (e.g. `kubectl proxy` on http://127.0.0.1:8001) and optionally KUBE_TOKEN.
 */

const SA_DIR = '/var/run/secrets/kubernetes.io/serviceaccount';

export interface KubeConfig {
  server: string;
  token: () => string | undefined;
}

export function kubeConfig(env: Record<string, string | undefined> = process.env): KubeConfig {
  const server =
    env.KUBE_API_URL ??
    (env.KUBERNETES_SERVICE_HOST
      ? `https://${env.KUBERNETES_SERVICE_HOST.includes(':') ? `[${env.KUBERNETES_SERVICE_HOST}]` : env.KUBERNETES_SERVICE_HOST}:${env.KUBERNETES_SERVICE_PORT ?? 443}`
      : undefined);
  if (!server) throw new Error('no Kubernetes API: run in a cluster or set KUBE_API_URL');
  const file = env.KUBE_TOKEN_FILE ?? `${SA_DIR}/token`;
  let cached: { at: number; value: string | undefined } | undefined;
  return {
    server: server.replace(/\/$/, ''),
    token: () => {
      if (env.KUBE_TOKEN) return env.KUBE_TOKEN;
      if (!cached || Date.now() - cached.at > 60_000) {
        let value: string | undefined;
        try {
          value = fs.readFileSync(file, 'utf8').trim();
        } catch {
          value = undefined;
        }
        cached = { at: Date.now(), value };
      }
      return cached.value;
    },
  };
}

/** A listable / watchable resource type. */
export interface ResourceType {
  group: string;
  version: string;
  plural: string;
  kind: string;
  namespaced?: boolean;
}

export const apiVersionOf = (r: ResourceType) => (r.group ? `${r.group}/${r.version}` : r.version);
export const pathOf = (r: ResourceType) => (r.group ? `/apis/${r.group}/${r.version}/${r.plural}` : `/api/${r.version}/${r.plural}`);
export const typeKey = (r: Pick<ResourceType, 'group' | 'kind'>) => `${r.group}/${r.kind}`;

export class GoneError extends Error {}

export interface WatchEvent {
  type: 'ADDED' | 'MODIFIED' | 'DELETED' | 'BOOKMARK' | 'ERROR';
  object: K8sObject & { code?: number; message?: string };
}

export class Kube {
  private cfg: KubeConfig;
  private f: typeof fetch;
  constructor(cfg: KubeConfig, f: typeof fetch = fetch) {
    this.cfg = cfg;
    this.f = f;
  }

  private headers(): Record<string, string> {
    const t = this.cfg.token();
    return { accept: 'application/json', ...(t ? { authorization: `Bearer ${t}` } : {}) };
  }

  async get<T>(path: string, signal?: AbortSignal): Promise<T> {
    const res = await this.f(`${this.cfg.server}${path}`, { headers: this.headers(), signal: signal ?? AbortSignal.timeout(30_000) });
    if (res.status === 410) throw new GoneError(`${path}: 410 Gone`);
    if (!res.ok) throw Object.assign(new Error(`GET ${path}: ${res.status} ${(await res.text().catch(() => '')).slice(0, 200)}`), { status: res.status });
    return (await res.json()) as T;
  }

  /** Every object of a type (all namespaces), with the list's resourceVersion to watch from. */
  async list(r: ResourceType, signal?: AbortSignal): Promise<{ items: K8sObject[]; resourceVersion: string }> {
    const items: K8sObject[] = [];
    let cont: string | undefined;
    let rv = '';
    for (let page = 0; page < 1000; page++) {
      const q = new URLSearchParams({ limit: '500', ...(cont ? { continue: cont } : {}) });
      const res = await this.get<{ items?: K8sObject[]; metadata?: { resourceVersion?: string; continue?: string } }>(`${pathOf(r)}?${q}`, signal);
      for (const o of res.items ?? []) items.push({ ...o, apiVersion: o.apiVersion ?? apiVersionOf(r), kind: o.kind ?? r.kind });
      rv = res.metadata?.resourceVersion ?? rv;
      cont = res.metadata?.continue || undefined;
      if (!cont) break;
    }
    return { items, resourceVersion: rv };
  }

  /**
   * Stream changes from `resourceVersion` until the server closes the watch (timeoutSeconds) or `signal` aborts.
   * Returns the last resourceVersion seen (bookmarks included); throws GoneError when it is too old (re-list).
   */
  async watch(r: ResourceType, resourceVersion: string, onEvent: (e: WatchEvent) => void, signal: AbortSignal, timeoutSeconds = 300): Promise<string> {
    const q = new URLSearchParams({ watch: '1', resourceVersion, allowWatchBookmarks: 'true', timeoutSeconds: String(timeoutSeconds) });
    const res = await this.f(`${this.cfg.server}${pathOf(r)}?${q}`, { headers: this.headers(), signal });
    if (res.status === 410) throw new GoneError(`${pathOf(r)}: 410 Gone`);
    if (!res.ok || !res.body) throw new Error(`WATCH ${pathOf(r)}: ${res.status} ${(await res.text().catch(() => '')).slice(0, 200)}`);
    let rv = resourceVersion;
    const handle = (line: string) => {
      if (!line.trim()) return;
      const e = JSON.parse(line) as WatchEvent;
      if (e.type === 'ERROR') {
        if (e.object?.code === 410) throw new GoneError(e.object.message ?? 'watch: 410 Gone');
        throw new Error(`watch ${pathOf(r)}: ${e.object?.message ?? 'error event'}`);
      }
      rv = e.object?.metadata?.resourceVersion ?? rv;
      if (e.type === 'BOOKMARK') return;
      e.object.apiVersion ??= apiVersionOf(r);
      e.object.kind ??= r.kind;
      onEvent(e);
    };
    const decoder = new TextDecoder();
    let buf = '';
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      buf += decoder.decode(chunk, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        handle(line);
      }
    }
    handle(buf);
    return rv;
  }
}

interface Crd {
  metadata: { name: string };
  spec: {
    group: string;
    scope: string;
    names: { plural: string; kind: string; categories?: string[] };
    versions: { name: string; served: boolean; storage: boolean }[];
  };
}

/** The served storage version of a CRD (the preferred one to read). */
function preferredVersion(c: Crd) {
  const served = c.spec.versions.filter((v) => v.served);
  return (served.find((v) => v.storage) ?? served[0])?.name;
}

export const toResourceType = (c: Crd): ResourceType | undefined => {
  const version = preferredVersion(c);
  return version
    ? { group: c.spec.group, version, plural: c.spec.names.plural, kind: c.spec.names.kind, namespaced: c.spec.scope === 'Namespaced' }
    : undefined;
};

export interface Discovered {
  /** Crossplane managed resources: CRDs whose categories include `managed`. */
  managed: ResourceType[];
  /** Gatekeeper constraints: every kind of the constraints.gatekeeper.sh group. */
  constraints: ResourceType[];
  /** The Service XR CRD (platform.asterius.io), when installed. */
  xr?: ResourceType;
  compositions?: ResourceType;
  applications?: ResourceType;
}

export function classify(crds: Crd[]): Discovered {
  const out: Discovered = { managed: [], constraints: [] };
  for (const c of crds) {
    const t = toResourceType(c);
    if (!t) continue;
    if (c.spec.group === 'constraints.gatekeeper.sh') out.constraints.push(t);
    else if (c.spec.names.categories?.includes('managed')) out.managed.push(t);
    else if (c.spec.group === 'platform.asterius.io' && c.spec.names.kind === 'Service') out.xr = t;
    else if (c.spec.group === 'apiextensions.crossplane.io' && c.spec.names.kind === 'Composition') out.compositions = t;
    else if (c.spec.group === 'argoproj.io' && c.spec.names.kind === 'Application') out.applications = t;
  }
  return out;
}

export async function discover(kube: Kube): Promise<Discovered> {
  const { items } = await kube.list({ group: 'apiextensions.k8s.io', version: 'v1', plural: 'customresourcedefinitions', kind: 'CustomResourceDefinition' });
  return classify(items as unknown as Crd[]);
}
