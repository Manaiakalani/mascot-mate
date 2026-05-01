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

  it('keys are independent', () => {
    const b = new TokenBucket(1, 0);
    expect(b.take('a')).toBe(true);
    expect(b.take('b')).toBe(true);
    expect(b.take('a')).toBe(false);
  });
});
