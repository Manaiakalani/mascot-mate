/**
 * Tiny in-memory token-bucket rate limiter, keyed by IP. One bucket per key,
 * refilled continuously based on elapsed time. Not for multi-instance prod —
 * swap for Redis if you need that.
 */
export class TokenBucket {
  private buckets = new Map<string, { tokens: number; updated: number }>();

  constructor(
    private capacity: number,
    private refillPerSec: number,
  ) {}

  /** Returns true if the request is allowed and consumes one token. */
  take(key: string, now = Date.now()): boolean {
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
}
