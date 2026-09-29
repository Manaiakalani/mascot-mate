/**
 * Tiny in-memory token-bucket rate limiter, keyed by IP. One bucket per key,
 * refilled continuously based on elapsed time. Not for multi-instance prod —
 * swap for Redis if you need that.
 */
const PRUNE_IDLE_MS = 120_000;

export class TokenBucket {
  private buckets = new Map<string, { tokens: number; updated: number }>();
  private lastPrune = 0;

  constructor(
    private capacity: number,
    private refillPerSec: number,
  ) {}

  size(): number {
    return this.buckets.size;
  }

  /** Returns true if the request is allowed and consumes one token. */
  take(key: string, now = Date.now()): boolean {
    this.maybePrune(now);
    const b = this.buckets.get(key) ?? { tokens: this.capacity, updated: now };
    const elapsed = (now - b.updated) / 1000;
    b.tokens = Math.min(this.capacity, b.tokens + elapsed * this.refillPerSec);
    b.updated = now;
    if (b.tokens < 1) {
      this.buckets.set(key, b);
      return false;
    }
    b.tokens -= 1;
    this.buckets.set(key, b);
    return true;
  }

  /** Whole seconds until this key has a token. 0 when a request would succeed. */
  retryAfter(key: string, now = Date.now()): number {
    const b = this.buckets.get(key);
    if (!b) return 0;
    const elapsed = (now - b.updated) / 1000;
    const tokens = Math.min(this.capacity, b.tokens + elapsed * this.refillPerSec);
    if (tokens >= 1) return 0;
    if (this.refillPerSec <= 0) return 60;
    return Math.max(1, Math.ceil((1 - tokens) / this.refillPerSec));
  }

  /**
   * Drop keys that have sat at full capacity. The map is keyed by IP and
   * otherwise grows for the life of the process.
   */
  prune(now = Date.now()): void {
    for (const [key, bucket] of this.buckets) {
      if (now - bucket.updated < PRUNE_IDLE_MS) continue;
      const elapsed = (now - bucket.updated) / 1000;
      const tokens = Math.min(this.capacity, bucket.tokens + elapsed * this.refillPerSec);
      if (tokens >= this.capacity) this.buckets.delete(key);
    }
  }

  private maybePrune(now: number): void {
    if (this.buckets.size < 64) return;
    if (now - this.lastPrune < 30_000) return;
    this.lastPrune = now;
    this.prune(now);
  }
}
