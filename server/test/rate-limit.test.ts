import { describe, it, expect } from 'vitest';
import { TokenBucket } from '../src/rate-limit.js';

describe('TokenBucket', () => {
  it('allows up to capacity then blocks', () => {
    const b = new TokenBucket(3, 1);
    const t = 1000;
    expect(b.take('a', t)).toBe(true);
    expect(b.take('a', t)).toBe(true);
    expect(b.take('a', t)).toBe(true);
    expect(b.take('a', t)).toBe(false);
  });

  it('refills over time', () => {
    const b = new TokenBucket(2, 2);
    const t0 = 1000;
    expect(b.take('a', t0)).toBe(true);
    expect(b.take('a', t0)).toBe(true);
    expect(b.take('a', t0)).toBe(false);
    expect(b.take('a', t0 + 600)).toBe(true);
  });

  it('retryAfter is the whole seconds until a token is available', () => {
    const b = new TokenBucket(1, 0.5);
    const t = 5_000;
    expect(b.take('a', t)).toBe(true);
    expect(b.take('a', t)).toBe(false);
    expect(b.retryAfter('a', t)).toBe(2);
  });

  it('prune drops idle buckets that have refilled and keeps empty ones', () => {
    const refilled = new TokenBucket(1, 10);
    refilled.take('old', 0);
    refilled.prune(200_000);
    expect(refilled.size()).toBe(0);

    const stuck = new TokenBucket(1, 0);
    stuck.take('old', 0);
    stuck.prune(200_000);
    expect(stuck.size()).toBe(1);
  });

  it('keys are independent', () => {
    const b = new TokenBucket(1, 0);
    expect(b.take('a')).toBe(true);
    expect(b.take('b')).toBe(true);
    expect(b.take('a')).toBe(false);
  });
});
