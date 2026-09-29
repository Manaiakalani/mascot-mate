import { describe, it, expect, vi } from 'vitest';
import { ActionQueue } from '../src/runtime.js';
import type { MascotMap } from '../src/types.js';

const map: MascotMap = {
  framesize: [10, 10],
  overlayCount: 1,
  animations: {
    A: { frames: [{ duration: 10, images: [[0, 0]] }, { duration: 10, images: [[10, 0]] }] },
    B: { frames: [{ duration: 10, images: [[0, 10]] }] },
  },
};

function makeRenderer() {
  return { showFrame: vi.fn(), showEmpty: vi.fn() };
}

describe('ActionQueue', () => {
  it('plays animations serially', async () => {
    const r = makeRenderer();
    const q = new ActionQueue(map, r);
    q.play('A').play('B');
    await new Promise((res) => setTimeout(res, 80));
    expect(r.showFrame).toHaveBeenCalledTimes(3);
  });

  it('skips unknown animation names', async () => {
    const r = makeRenderer();
    const q = new ActionQueue(map, r);
    q.play('Nope').play('B');
    await new Promise((res) => setTimeout(res, 50));
    expect(r.showFrame).toHaveBeenCalledTimes(1);
  });

  it('stop() cancels current and clears queue', async () => {
    const r = makeRenderer();
    const q = new ActionQueue(map, r);
    q.play('A').play('A').play('A');
    await new Promise((res) => setTimeout(res, 5));
    q.stop();
    const callsAtStop = r.showFrame.mock.calls.length;
    await new Promise((res) => setTimeout(res, 60));
    expect(r.showFrame.mock.calls.length).toBe(callsAtStop);
  });

  it('isBusy() reflects queue + current animation', async () => {
    const r = makeRenderer();
    const q = new ActionQueue(map, r);
    expect(q.isBusy()).toBe(false);
    q.play('A');
    expect(q.isBusy()).toBe(true);
    await new Promise((res) => setTimeout(res, 80));
    expect(q.isBusy()).toBe(false);
  });

  it('a weight-100 backward branch finishes instead of looping forever', async () => {
    vi.useFakeTimers();
    try {
      const loopMap: MascotMap = {
        framesize: [1, 1],
        overlayCount: 1,
        animations: {
          Loop: {
            frames: [
              { duration: 10 },
              {
                duration: 10,
                exitBranch: 2,
                branching: { branches: [{ frameIndex: 0, weight: 100 }] },
              },
              { duration: 10 },
            ],
          },
        },
      };
      const r = makeRenderer();
      const q = new ActionQueue(loopMap, r);
      q.play('Loop');
      await vi.runAllTimersAsync();
      expect(q.isBusy()).toBe(false);
      expect(r.showFrame.mock.calls.length).toBeGreaterThan(0);
      expect(r.showFrame.mock.calls.length).toBeLessThan(40);
    } finally {
      vi.useRealTimers();
    }
  });

  it('playNow interrupts and whenIdle resolves when the queue drains', async () => {
    vi.useFakeTimers();
    try {
      const r = makeRenderer();
      const q = new ActionQueue(map, r);
      q.play('A');
      q.playNow('B');
      const idle = q.whenIdle();
      await vi.runAllTimersAsync();
      await idle;
      expect(q.isBusy()).toBe(false);
      const last = r.showFrame.mock.calls.at(-1)?.[0] as { images?: number[][] };
      expect(last.images).toEqual([[0, 10]]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('isBusy() false after stop()', async () => {
    const r = makeRenderer();
    const q = new ActionQueue(map, r);
    q.play('A').play('A');
    await new Promise((res) => setTimeout(res, 5));
    expect(q.isBusy()).toBe(true);
    q.stop();
    // Microtask drain so the awaited done resolves.
    await new Promise((res) => setTimeout(res, 5));
    expect(q.isBusy()).toBe(false);
  });
});
