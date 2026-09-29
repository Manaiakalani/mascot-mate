import type { Animation, Frame, MascotMap } from './types.js';

type EndReason = 'finished' | 'cancelled';

export interface RunningAnimation {
  cancel(): void;
  done: Promise<EndReason>;
  name: string;
}

export interface RendererPort {
  showFrame(frame: Frame): void;
  showEmpty(): void;
}

/**
 * Plays a single sprite-sheet animation, honoring duration, branching, and
 * exitBranch (per ClippyJS map format). Returns a controller with a `done`
 * promise that resolves when the animation reaches its natural end or is
 * cancelled.
 */
/** Safety cap so a broken map cannot pin the queue forever. */
const MAX_STEPS = 480;
/**
 * Clippy's Thinking / GetTechy sheets branch backward with weight 100,
 * which never rolls an exit. After a handful of loops, take the forward
 * edge so the queue can drain. Probabilistic fidgets (weight < 100) are
 * left alone — they already terminate.
 */
const MAX_TRAPPED_LOOPS = 8;

export function playAnimation(
  anim: Animation,
  renderer: RendererPort,
  name: string,
): RunningAnimation {
  let cancelled = false;
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let resolveDone!: (r: EndReason) => void;
  const done = new Promise<EndReason>((res) => (resolveDone = res));
  let steps = 0;
  let trapped = 0;

  const finish = (reason: EndReason): void => {
    if (settled) return;
    settled = true;
    if (timer) clearTimeout(timer);
    timer = null;
    resolveDone(reason);
  };

  const step = (idx: number) => {
    if (cancelled) {
      finish('cancelled');
      return;
    }
    if (steps >= MAX_STEPS) {
      finish('finished');
      return;
    }
    steps += 1;
    const frame = anim.frames[idx];
    if (!frame) {
      finish('finished');
      return;
    }
    renderer.showFrame(frame);

    let nextIdx = idx + 1;
    if (frame.exitBranch !== undefined) {
      // exitBranch is a jump. Past-the-end means the animation is over.
      nextIdx = frame.exitBranch;
    }
    const branches = frame.branching?.branches;
    if (branches && branches.length) {
      const roll = Math.random() * 100;
      let acc = 0;
      for (const b of branches) {
        acc += b.weight;
        if (roll <= acc) {
          nextIdx = b.frameIndex;
          break;
        }
      }
      const weight = branches.reduce((sum, b) => sum + b.weight, 0);
      const trap = weight >= 100 && branches.every((b) => b.frameIndex <= idx);
      if (trap && nextIdx <= idx) {
        trapped += 1;
        if (trapped > MAX_TRAPPED_LOOPS) nextIdx = idx + 1;
      } else if (nextIdx > idx) {
        trapped = 0;
      }
    }
    if (nextIdx >= anim.frames.length || nextIdx < 0) {
      finish('finished');
      return;
    }
    timer = setTimeout(() => step(nextIdx), Math.max(10, frame.duration));
  };

  step(0);

  return {
    name,
    done,
    cancel() {
      cancelled = true;
      finish('cancelled');
    },
  };
}

type Action =
  | { kind: 'play'; name: string }
  | { kind: 'wait'; ms: number }
  | { kind: 'fn'; run: () => void | Promise<void> };

/**
 * Serial action queue. Animations and waits run one-at-a-time. New actions
 * appended to the queue are picked up automatically.
 */
export class ActionQueue {
  private q: Action[] = [];
  private running = false;
  private current: RunningAnimation | null = null;
  private drainWaiters: Array<() => void> = [];

  constructor(
    private map: MascotMap,
    private renderer: RendererPort,
  ) {}

  play(name: string): this {
    this.q.push({ kind: 'play', name });
    this.tick();
    return this;
  }

  /** Drop whatever is playing and start `name` now. */
  playNow(name: string): this {
    this.stop();
    return this.play(name);
  }

  /** Resolves when the queue is empty and nothing is playing. */
  whenIdle(): Promise<void> {
    if (!this.isBusy()) return Promise.resolve();
    return new Promise((resolve) => {
      this.drainWaiters.push(resolve);
    });
  }

  wait(ms: number): this {
    this.q.push({ kind: 'wait', ms });
    this.tick();
    return this;
  }

  do(fn: () => void | Promise<void>): this {
    this.q.push({ kind: 'fn', run: fn });
    this.tick();
    return this;
  }

  /** Cancel current animation and clear the queue. */
  stop(): void {
    this.q = [];
    this.current?.cancel();
    if (!this.running) this.flushDrain();
  }

  hasAnimation(name: string): boolean {
    return Boolean(this.map.animations[name]);
  }

  /** True when an animation is currently playing or queued. */
  isBusy(): boolean {
    return this.running || this.q.length > 0 || this.current !== null;
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.q.length) {
        const a = this.q.shift()!;
        if (a.kind === 'play') {
          const anim = this.map.animations[a.name];
          if (!anim) continue;
          this.current = playAnimation(anim, this.renderer, a.name);
          await this.current.done;
          this.current = null;
        } else if (a.kind === 'wait') {
          await new Promise<void>((r) => setTimeout(r, a.ms));
        } else {
          await a.run();
        }
      }
    } finally {
      this.running = false;
      if (this.q.length) {
        void this.tick();
      } else {
        this.flushDrain();
      }
    }
  }

  private flushDrain(): void {
    if (this.running || this.q.length || this.current) return;
    const waiters = this.drainWaiters.splice(0);
    for (const waiter of waiters) waiter();
  }
}
