/** Small bounded LRU map with an optional per-entry TTL. Evicts the least recently used entry, never clears wholesale. */
export class LRU<K, V> {
  private readonly map = new Map<K, { v: V; at: number }>();

  constructor(
    private readonly max: number,
    private readonly ttlMs = Infinity,
  ) {}

  get(key: K): V | undefined {
    const e = this.map.get(key);
    if (!e) return undefined;
    if (Date.now() - e.at > this.ttlMs) {
      this.map.delete(key);
      return undefined;
    }
    this.map.delete(key); // refresh recency
    this.map.set(key, e);
    return e.v;
  }

  set(key: K, v: V) {
    this.map.delete(key);
    this.map.set(key, { v, at: Date.now() });
    if (this.map.size > this.max) this.map.delete(this.map.keys().next().value as K);
  }

  delete(key: K) {
    this.map.delete(key);
  }

  clear() {
    this.map.clear();
  }

  get size() {
    return this.map.size;
  }
}
