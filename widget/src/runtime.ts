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
export function playAnimation(
  anim: Animation,
  renderer: RendererPort,
  name: string,
): RunningAnimation {
  let cancelled = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let resolveDone!: (r: EndReason) => void;
  const done = new Promise<EndReason>((res) => (resolveDone = res));

  const step = (idx: number) => {
    if (cancelled) {
      resolveDone('cancelled');
      return;
    }
    const frame = anim.frames[idx];
    if (!frame) {
      resolveDone('finished');
      return;
    }
    renderer.showFrame(frame);

    let nextIdx = idx + 1;
    if (frame.exitBranch !== undefined) {
      // exitBranch is used as the natural end-of-animation index.
      // We treat reaching it as "finished" by default unless branching tells
      // us to jump elsewhere.
      nextIdx = frame.exitBranch;
    }
    if (frame.branching) {
      const roll = Math.random() * 100;
      let acc = 0;
      for (const b of frame.branching.branches) {
        acc += b.weight;
        if (roll <= acc) {
          nextIdx = b.frameIndex;
          break;
        }
      }
    }
    if (nextIdx >= anim.frames.length || nextIdx < 0) {
      resolveDone('finished');
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
      if (timer) clearTimeout(timer);
      resolveDone('cancelled');
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

  constructor(
    private map: MascotMap,
    private renderer: RendererPort,
  ) {}

  play(name: string): this {
    this.q.push({ kind: 'play', name });
    this.tick();
    return this;
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
    }
  }
}
