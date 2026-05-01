import { describe, it, expect } from 'vitest';
import { validateMap } from '../src/registry.js';

describe('validateMap', () => {
  it('accepts a minimal valid map', () => {
    expect(() =>
      validateMap(
        {
          framesize: [10, 10],
          overlayCount: 1,
          animations: { X: { frames: [{ duration: 10 }] } },
        },
        'x',
      ),
    ).not.toThrow();
  });

  it('rejects bad framesize', () => {
    expect(() =>
      // @ts-expect-error testing invalid input
      validateMap({ framesize: [10], overlayCount: 1, animations: { X: { frames: [{ duration: 1 }] } } }, 'x'),
    ).toThrow(/framesize/);
  });

  it('rejects empty animation', () => {
    expect(() =>
      validateMap({ framesize: [1, 1], overlayCount: 1, animations: { X: { frames: [] } } }, 'x'),
    ).toThrow(/no frames/);
  });

  it('rejects frame with no duration', () => {
    expect(() =>
      validateMap(
        // @ts-expect-error testing invalid input
        { framesize: [1, 1], overlayCount: 1, animations: { X: { frames: [{}] } } },
        'x',
      ),
    ).toThrow(/duration/);
  });
});
