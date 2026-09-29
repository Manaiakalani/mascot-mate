import { describe, expect, it } from 'vitest';
import { scaleSavedPosition } from '../src/placement.js';

describe('scaleSavedPosition', () => {
  it('keeps the same pixel when the frame is unchanged', () => {
    expect(scaleSavedPosition({ left: 200, top: 160, vw: 1280, vh: 800 }, 1280, 800)).toEqual({
      left: 200,
      top: 160,
    });
  });

  it('preserves the relative position across a smaller frame', () => {
    const next = scaleSavedPosition({ left: 640, top: 400, vw: 1280, vh: 800 }, 640, 400);
    expect(next.left).toBeCloseTo(320);
    expect(next.top).toBeCloseTo(200);
  });
});
