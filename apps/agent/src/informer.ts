import { GoneError, typeKey, type Kube, type ResourceType, type WatchEvent } from './kube.ts';
import { keyOf, type K8sObject } from './state.ts';

export type ChangeType = 'ADDED' | 'MODIFIED' | 'DELETED';
export type OnChange = (type: ChangeType, obj: K8sObject, informer: Informer, initial: boolean) => void;

/**
 * Keeps an in-memory copy of one resource type: list, then watch from the list's resourceVersion; a 410 Gone (or the
 * periodic resync) re-lists and emits the differences, so no change is lost across watch restarts.
 */
export class Informer {
  readonly type: ResourceType;
  readonly store = new Map<string, K8sObject>();
  synced = false;
  private kube: Kube;
  private onChange: OnChange;
  private onRestart: (reason: string) => void;
  private resourceVersion: string | undefined;
  private abort = new AbortController();
  private stopped = false;
  private log: (msg: string, extra?: Record<string, unknown>) => void;

  constructor(kube: Kube, type: ResourceType, onChange: OnChange, opts: { log?: Informer['log']; onRestart?: (reason: string) => void } = {}) {
    this.kube = kube;
    this.type = type;
    this.onChange = onChange;
    this.log = opts.log ?? (() => undefined);
    this.onRestart = opts.onRestart ?? (() => undefined);
  }

  get key() {
    return typeKey(this.type);
  }
  items() {
    return [...this.store.values()];
  }

  /** List and replace the store, emitting what changed since the previous copy. */
  async relist() {
    const { items, resourceVersion } = await this.kube.list(this.type, AbortSignal.timeout(60_000));
    const initial = !this.synced;
    const seen = new Set<string>();
    for (const o of items) {
      const k = keyOf(o);
      seen.add(k);
      const old = this.store.get(k);
      this.store.set(k, o);
      if (!old) this.onChange('ADDED', o, this, initial);
      else if (old.metadata.resourceVersion !== o.metadata.resourceVersion) this.onChange('MODIFIED', o, this, initial);
    }
    for (const [k, o] of this.store)
      if (!seen.has(k)) {
        this.store.delete(k);
        this.onChange('DELETED', o, this, initial);
      }
    this.resourceVersion = resourceVersion;
    this.synced = true;
  }

  /** Force a re-list at the next opportunity (periodic resync backstop). */
  resync() {
    this.resourceVersion = undefined;
    this.abort.abort();
  }

  stop() {
    this.stopped = true;
    this.abort.abort();
  }

  private apply(e: WatchEvent) {
    if (e.type === 'BOOKMARK' || e.type === 'ERROR') return;
    const k = keyOf(e.object);
    if (e.type === 'DELETED') this.store.delete(k);
    else this.store.set(k, e.object);
    this.onChange(e.type, e.object, this, false);
  }

  async run() {
    let failures = 0;
    while (!this.stopped) {
      try {
        if (!this.resourceVersion) await this.relist();
        this.abort = new AbortController();
        this.resourceVersion = await this.kube.watch(this.type, this.resourceVersion!, (e) => this.apply(e), this.abort.signal);
        failures = 0;
      } catch (err) {
        if (this.stopped) return;
        if (err instanceof GoneError) {
          this.onRestart('gone');
          this.resourceVersion = undefined; // too old: re-list
          continue;
        }
        if (this.abort.signal.aborted) {
          this.onRestart('resync');
          continue; // resync() asked for a re-list
        }
        failures++;
        this.onRestart('error');
        const status = (err as { status?: number }).status;
        if (status === 404) {
          // The CRD went away: stop until the next discovery adds it again.
          this.log('resource type no longer served, stopping its watch', { type: this.key });
          this.stopped = true;
          return;
        }
        const delay = Math.min(30_000, 500 * 2 ** failures);
        this.log('watch failed, retrying', { type: this.key, error: (err as Error).message, delayMs: delay });
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
}
