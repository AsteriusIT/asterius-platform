import { GoneError, typeKey, type Kube, type ResourceType, type WatchEvent } from '../src/kube.ts';
import type { K8sObject } from '../src/state.ts';

/** In-memory stand-in for the API server: list, watch streams fed by the test, a one-shot 410. */
export class FakeKube {
  objects = new Map<string, K8sObject[]>();
  crds: unknown[] = [];
  lists = new Map<string, number>();
  private listeners = new Map<string, (e: WatchEvent) => void>();
  private gone = new Set<string>();
  private rv = 100;

  static crd(group: string, kind: string, plural: string, opts: { categories?: string[]; scope?: string; version?: string } = {}) {
    return {
      metadata: { name: `${plural}.${group}` },
      spec: {
        group,
        scope: opts.scope ?? 'Namespaced',
        names: { plural, kind, categories: opts.categories ?? [] },
        versions: [{ name: opts.version ?? 'v1alpha1', served: true, storage: true }],
      },
    };
  }

  asKube() {
    return this as unknown as Kube;
  }

  set(key: string, items: K8sObject[]) {
    this.objects.set(key, items);
  }

  async list(r: ResourceType) {
    const key = typeKey(r);
    this.lists.set(key, (this.lists.get(key) ?? 0) + 1);
    if (r.plural === 'customresourcedefinitions') return { items: this.crds as K8sObject[], resourceVersion: String(this.rv) };
    return { items: structuredClone(this.objects.get(key) ?? []), resourceVersion: String(this.rv) };
  }

  /** The next watch of this type answers 410 Gone. */
  goneNext(key: string) {
    this.gone.add(key);
  }

  async watch(r: ResourceType, _rv: string, onEvent: (e: WatchEvent) => void, signal: AbortSignal): Promise<string> {
    const key = typeKey(r);
    if (this.gone.delete(key)) throw new GoneError('410');
    this.listeners.set(key, onEvent);
    await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
    return String(this.rv);
  }

  /** Push a watch event (and keep the list in step, as the API server would). */
  emit(key: string, type: WatchEvent['type'], object: K8sObject) {
    this.rv++;
    object.metadata.resourceVersion = String(this.rv);
    const list = (this.objects.get(key) ?? []).filter((o) => !(o.metadata.name === object.metadata.name && o.metadata.namespace === object.metadata.namespace));
    if (type !== 'DELETED') list.push(object);
    this.objects.set(key, list);
    const l = this.listeners.get(key);
    if (!l) throw new Error(`no watch on ${key}`);
    l({ type, object: structuredClone(object) });
  }

  watching(key: string) {
    return this.listeners.has(key);
  }
}

export async function until(fn: () => boolean, ms = 3_000) {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error('until: timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}
