import { deniedPolicies, type ServiceStatus } from './state.ts';

/** Bounded insertion-ordered set (old entries are evicted first). */
export class BoundedSet {
  private items = new Set<string>();
  private max: number;
  constructor(max = 20_000) {
    this.max = max;
  }
  has(k: string) {
    return this.items.has(k);
  }
  add(k: string) {
    if (this.items.has(k)) return;
    this.items.add(k);
    if (this.items.size > this.max) this.items.delete(this.items.values().next().value!);
  }
  get size() {
    return this.items.size;
  }
}

/**
 * Time to Ready per golden path: from the first time a run id is seen on a Service XR to the first time that XR is
 * Ready with that run id. A run already Ready when first seen (watcher restart) is not measured: its start is unknown.
 */
export class ReadyTracker {
  private started = new Map<string, number>();
  private done = new BoundedSet(10_000);

  /** Returns the seconds to Ready when this observation completes a run. */
  observe(s: ServiceStatus, now = Date.now()): number | undefined {
    if (!s.observedRunId || !s.exists) return undefined;
    const key = `${s.identifier}#${s.observedRunId}`;
    if (this.done.has(key)) return undefined;
    const start = this.started.get(key);
    if (start === undefined) {
      if (s.lifecycle === 'Ready') this.done.add(key);
      else this.started.set(key, now);
      return undefined;
    }
    if (s.lifecycle !== 'Ready') return undefined;
    this.started.delete(key);
    this.done.add(key);
    return Math.max(0, (now - start) / 1000);
  }

  get pending() {
    return this.started.size;
  }
}

/** New admission rejections (a rejection is counted once per service and message). */
export class RejectionTracker {
  private seen = new BoundedSet(10_000);
  observe(s: ServiceStatus): string[] {
    if (s.lifecycle !== 'Rejected') return [];
    const c = s.conditions.find((x) => x.type === 'Admission');
    const key = `${s.identifier}#${c?.message ?? ''}`;
    if (this.seen.has(key)) return [];
    this.seen.add(key);
    const policies = deniedPolicies(c?.message ?? '').map((p) => p.policy);
    return policies.length ? policies : ['unknown'];
  }
}
