import { ActionQueue } from './runtime.js';
import { SpriteRenderer, makeInteractive } from './renderer.js';
import { Balloon } from './balloon.js';
import { AskPill } from './ask-pill.js';
import {
  askStreaming,
  clampMessageChars,
  MascotError,
  MAX_MESSAGE_CHARS,
  trimChatHistory,
  type ChatMessage,
} from './chat-client.js';
import { loadMascot, registerMascot, listMascots, getMascotName, type MascotSource } from './registry.js';
import {
  bottomRightAnchor,
  clampToViewport,
  invalidateSafeArea,
  scaleSavedPosition,
  viewportFrame,
  type SavedPosition,
} from './placement.js';
import type { MascotManifest, MascotMap } from './types.js';

// Discover mascots at build time. Each mascot folder contributes a map.json
// and a map.png; both are optional (a folder is registered only when both
// files exist), so adding/removing a mascot is purely a filesystem change.
//
// Only map.json (small JSON) is bundled eagerly. The sprite PNG is NOT
// imported through Vite's asset pipeline: library-mode builds always
// base64-inline statically-imported assets regardless of size, which used to
// bake all 3 mascots' sprite sheets into the JS bundle even though only one
// is ever displayed at a time (~3MB of dead weight per page load). Instead,
// the build copies raw PNGs next to the emitted JS (see vite.config.ts) and
// this resolves each mascot's sprite as a plain sibling URL, so the browser's
// native lazy image loading fetches only the sheet that's actually rendered.
const mapModules = import.meta.glob<MascotMap>('./mascots/*/map.json', {
  eager: true,
  import: 'default',
});

// Resolve sibling asset URLs relative to *this script's own location* so it
// keeps working regardless of where the built file is hosted: `import.meta.url`
// is the module's URL for ESM/dev, and Rollup shims it to
// `document.currentScript.src` (falling back to the known output filename)
// for the IIFE build, matching how auto-mount already relies on
// `document.currentScript`.
const ASSET_BASE = new URL(/* @vite-ignore */ './mascots/', import.meta.url).href;

for (const path of Object.keys(mapModules)) {
  const id = path.split('/')[2]!;
  registerMascot({
    id,
    name: id.charAt(0).toUpperCase() + id.slice(1),
    map: mapModules[path]!,
    spritesheet: `${ASSET_BASE}${id}/map.png`,
  });
}

export interface MascotInitOptions {
  endpoint: string;
  mascot?: string;
  greeting?: string;
  systemPrompt?: string;
  parent?: HTMLElement;
  /** Shared secret sent as `x-mascot-token` when the proxy sets `ASK_TOKEN`. */
  token?: string;
}

export interface MascotInstance {
  show(): Promise<void>;
  hide(): Promise<void>;
  ask(q: string): Promise<string>;
  switchTo(id: string): Promise<void>;
  current(): string;
  available(): string[];
  destroy(): void;
}

const STORAGE_KEY = 'mascot:choice';
const POSITION_KEY = 'mascot:position';
const SYS_DEFAULT =
  "You are a friendly retro desktop assistant. Keep answers short, helpful, and a touch playful. Plain text only — no markdown.";

function readSavedPosition(): SavedPosition | null {
  try {
    const raw = localStorage.getItem(POSITION_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as Partial<SavedPosition>;
    if (
      typeof p.left !== 'number' ||
      typeof p.top !== 'number' ||
      typeof p.vw !== 'number' ||
      typeof p.vh !== 'number'
    ) {
      return null;
    }
    return p as SavedPosition;
  } catch {
    return null;
  }
}

function writeSavedPosition(p: SavedPosition): void {
  try {
    localStorage.setItem(POSITION_KEY, JSON.stringify(p));
  } catch {
    /* private mode, quota — fail silently */
  }
}

function readStoredMascot(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function writeStoredMascot(id: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, id);
  } catch {
    /* private mode, quota — fail silently */
  }
}

class MascotImpl implements MascotInstance {
  private renderer!: SpriteRenderer;
  private queue!: ActionQueue;
  private balloon!: Balloon;
  private pill!: AskPill;
  private manifest!: MascotManifest;
  private history: ChatMessage[] = [];
  private inflight: AbortController | null = null;
  private clickIdx = 0;
  private lastQuestion: string | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  /** Indices of the last few idles played, used to avoid repeats. */
  private idleHistory: number[] = [];
  /** Disable idle activity entirely. Set when destroyed or on prefers-reduced-motion. */
  private idleDisabled = false;
  /** Abort controller for tearing down all global listeners in destroy(). */
  private lifecycleAc = new AbortController();
  /** Cleanup function returned by makeInteractive(). */
  private cleanupInteractive: (() => void) | null = null;
  /** Dragged position, or null when the mascot is still on the default corner. */
  private placed: SavedPosition | null = null;
  private destroyed = false;
  /** Bumped whenever idle work is cancelled so in-flight whenIdle callbacks no-op. */
  private idleGen = 0;
  private pendingText = '';
  private textFlushQueued = false;

  constructor(private opts: MascotInitOptions) {}

  async init(): Promise<void> {
    // Respect the OS-level reduced-motion preference: skip auto-idle
    // animations entirely so they don't surprise users who've opted out.
    if (typeof window !== 'undefined' && window.matchMedia) {
      const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
      this.idleDisabled = mq.matches;
      const onMotionChange = (e: MediaQueryListEvent) => {
        this.idleDisabled = e.matches;
        if (e.matches) this.cancelIdle();
        else this.scheduleIdle();
      };
      mq.addEventListener?.('change', onMotionChange, { signal: this.lifecycleAc.signal });
    }
    this.placed = readSavedPosition();
    await this.mountMascot(this.resolveMascotId(this.opts.mascot));

    this.balloon = new Balloon({
      onAsk: (q) => {
        // The bubble already shows the failure. Swallow the rejection so a
        // later abort (hide, switch, a newer question) is not unhandled.
        void this.ask(q).catch(() => {});
      },
      placeholder: 'Ask me anything…',
      onHide: () => {
        this.pill.show();
        this.pill.setExpanded(false);
        this.setBubbleExpanded(false);
        this.repositionPill();
        // Return focus to the pill's ask button so keyboard users land where
        // they came from rather than at <body>.
        this.pill.focusAsk();
        this.scheduleIdle();
      },
      onRetry: () => {
        if (this.lastQuestion) void this.ask(this.lastQuestion).catch(() => {});
      },
    });
    this.balloon.mount(this.opts.parent);

    this.pill = new AskPill({
      label: 'Ask me anything…',
      onClick: () => this.openBubble(),
      // Cycle through registered mascots one click at a time. The
      // picker popover (passing mascots/onPick) was tried but felt
      // like overkill for ≤4 mascots; a plain rotator is simpler and
      // matches users' expectation of "click the chip to swap".
      onSwap: () => void this.swapToNextMascot(),
      theme: this.manifest.theme,
      swapTooltip: this.computeSwapTooltip(),
    });
    this.pill.mount(this.opts.parent);

    this.history.push({ role: 'system', content: this.opts.systemPrompt ?? SYS_DEFAULT });

    const lsig = { signal: this.lifecycleAc.signal };

    // Keyboard shortcut: "/" focuses the input (unless already typing somewhere).
    window.addEventListener('keydown', (e) => {
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      e.preventDefault();
      this.openBubble();
    }, lsig);

    const onResize = (): void => {
      invalidateSafeArea();
      this.relayout();
    };
    window.addEventListener('resize', onResize, lsig);
    // visualViewport follows the keyboard and mobile browser chrome.
    // Scroll does not change safe-area insets, so don't remeasure those.
    if (typeof visualViewport !== 'undefined' && visualViewport) {
      visualViewport.addEventListener('resize', onResize, lsig);
      visualViewport.addEventListener('scroll', () => this.relayout(), lsig);
    }

    await this.show();

    // Auto-open the bubble with the greeting so users see immediately that
    // they can ask questions.  Do NOT focus the input — stealing focus on
    // page load disrupts keyboard and screen-reader users (GPT-Sol P1).
    const initialGreet = this.opts.greeting ?? this.manifest.greetingText;
    if (initialGreet) {
      this.balloon.setText(initialGreet);
      this.openBubble(/* autoFocus */ false);
    } else {
      this.pill.show();
      this.repositionPill();
    }
  }

  private async mountMascot(id: string): Promise<void> {
    this.manifest = await loadMascot(id);
    this.clickIdx = 0;
    // Target render heights tuned for visual parity with Ninja Cat
    // (the slimmest mascot). Clippy and Bob are visually wider, so
    // matching their frame heights to Ninja Cat's 128 px makes them
    // feel chunkier; we shave a bit off so all three read at a similar
    // on-screen weight.
    const TARGET_HEIGHTS: Record<string, number> = {
      clippy: 104,
      bob: 110,
    };
    const DEFAULT_TARGET_H = 128;
    const targetH = TARGET_HEIGHTS[id] ?? DEFAULT_TARGET_H;
    const frameH = this.manifest.map.framesize[1];
    const scale = targetH / frameH;
    this.renderer = new SpriteRenderer(this.manifest.map, this.manifest.spritesheetUrl, {
      scale,
    });
    this.renderer.mount(this.opts.parent);
    this.cleanupInteractive?.();
    this.cleanupInteractive = makeInteractive(this.renderer.el, {
      onClick: () => this.onMascotClick(),
      onMove: () => this.repositionAll(),
      onDragEnd: (left, top) => {
        const frame = viewportFrame();
        this.placed = { left, top, vw: frame.width, vh: frame.height };
        writeSavedPosition(this.placed);
      },
    });
    // Keyboard activation: mirrors native <button> semantics so keyboard
    // and screen-reader users get the same affordance as a real button.
    // Enter activates on keydown; Space activates on keyup (preventing the
    // keydown default so it doesn't scroll the page), matching how browsers
    // treat role="button" elements — firing on Space-keydown would let a
    // held/repeating key spam-open the bubble.
    this.renderer.el.addEventListener('keydown', (e) => {
      if (e.key === ' ') {
        e.preventDefault();
        return;
      }
      if (e.key !== 'Enter') return;
      e.preventDefault();
      this.openBubble();
    });
    this.renderer.el.addEventListener('keyup', (e) => {
      if (e.key !== ' ') return;
      e.preventDefault();
      this.openBubble();
    });
    this.queue = new ActionQueue(this.manifest.map, this.renderer);
    // Restore drag-saved position (clamped to current viewport).
    this.restorePosition();
  }

  /** Id the user asked for, else their saved choice, else the first registered mascot. */
  private resolveMascotId(preferred?: string): string {
    const requested = preferred ?? readStoredMascot() ?? 'clippy';
    if (listMascots().includes(requested)) return requested;
    return listMascots()[0] ?? 'clippy';
  }

  /**
   * Apply a persisted drag, scaled into the current frame and clamped to the
   * safe area. With no saved position, snap to the bottom-right corner.
   * One frame of delay so the sprite box has a measurable size.
   */
  private restorePosition(): void {
    requestAnimationFrame(() => {
      if (this.destroyed) return;
      this.relayout();
    });
  }

  private relayout(): void {
    if (this.destroyed) return;
    const r = this.renderer.el.getBoundingClientRect();
    const elW = r.width || this.renderer.el.offsetWidth;
    const elH = r.height || this.renderer.el.offsetHeight;
    const frame = viewportFrame();
    const scaled = this.placed ? scaleSavedPosition(this.placed, frame.width, frame.height) : null;
    const next = scaled ? clampToViewport(scaled.left, scaled.top, elW, elH) : bottomRightAnchor(elW, elH);
    if (Math.abs(r.left - next.left) < 0.5 && Math.abs(r.top - next.top) < 0.5) {
      this.repositionAll();
      return;
    }
    this.renderer.setPosition(next.left, next.top);
    this.repositionAll();
  }

  /**
   * Click rotates through the curated fun-animation list, so repeated clicks
   * play different animations (Clippy-style "delight on click"). The speech
   * bubble has its own affordances — the floating "Ask me!" pill and the
   * `/` shortcut — so click is reserved purely for play.
   */
  private onMascotClick(): void {
    this.cancelIdle();
    const fun = this.manifest.funAnimations;
    if (!fun || !fun.length) {
      // Fallback: if a mascot has no fun animations, fall back to opening the bubble.
      this.openBubble();
      return;
    }
    const name = fun[this.clickIdx % fun.length]!;
    this.clickIdx++;
    this.queue.playNow(name);
    this.scheduleIdleAfterCurrent();
  }

  private openBubble(autoFocus = true): void {
    this.cancelIdle();
    this.pill?.hide();
    this.pill?.setExpanded(true);
    this.balloon.show();
    this.setBubbleExpanded(true);
    this.repositionBubble();
    if (autoFocus) this.balloon.focusInput();
  }

  /** Keeps aria-expanded on the mascot button in sync with the bubble. */
  private setBubbleExpanded(expanded: boolean): void {
    this.renderer.el.setAttribute('aria-expanded', String(expanded));
  }

  private repositionBubble(): void {
    if (!this.balloon.isVisible()) return;
    this.balloon.positionAbove(this.renderer.getRect());
  }

  private repositionPill(): void {
    if (!this.pill?.isVisible()) return;
    this.pill.positionNear(this.renderer.getRect());
  }

  private repositionAll(): void {
    this.repositionBubble();
    this.repositionPill();
  }

  async show(): Promise<void> {
    this.renderer.show();
    if (this.manifest.greeting && !this.idleDisabled) {
      this.queue.playNow(this.manifest.greeting);
    }
    this.scheduleIdle();
  }

  async hide(): Promise<void> {
    this.cancelIdle();
    // Abort first and drop the handle so a late error cannot reopen the bubble.
    this.inflight?.abort();
    this.inflight = null;
    this.balloon.hide();
    this.setBubbleExpanded(false);
    this.pill?.hide();
    if (this.manifest.goodbye && !this.idleDisabled && !this.destroyed) {
      this.queue.playNow(this.manifest.goodbye);
      await Promise.race([
        this.queue.whenIdle(),
        new Promise((resolve) => setTimeout(resolve, 2000)),
      ]);
    }
    this.queue.stop();
    if (this.destroyed) return;
    this.renderer.hide();
  }

  async ask(q: string): Promise<string> {
    if (q.length > MAX_MESSAGE_CHARS) {
      const err = new MascotError(
        'bad_request',
        `That question is too long (max ${MAX_MESSAGE_CHARS} characters).`,
      );
      this.balloon.show();
      this.setBubbleExpanded(true);
      this.balloon.showError(err.message, { retryable: false });
      this.repositionBubble();
      throw err;
    }

    this.cancelIdle();
    this.inflight?.abort();
    const controller = new AbortController();
    this.inflight = controller;
    this.lastQuestion = q;

    this.balloon.show();
    this.setBubbleExpanded(true);
    this.balloon.setBusy(true);
    this.balloon.setText('Thinking…');
    this.repositionBubble();
    if (this.manifest.thinking && this.queue.hasAnimation(this.manifest.thinking)) {
      this.queue.playNow(this.manifest.thinking);
    }
    this.scheduleIdleAfterCurrent();
    // Keep a direct reference to the turn *this* call pushed so cleanup can
    // remove exactly this entry later, even if a newer overlapping ask() has
    // since pushed its own turn onto the same history array.
    const turn: ChatMessage = { role: 'user', content: q };
    this.history.push(turn);
    this.history = trimChatHistory(this.history);
    const outgoing = clampMessageChars(this.history);

    let firstToken = true;
    // Streamed tokens can arrive many times per frame. Hold the text and the
    // bubble measurement until the next frame so a fast stream doesn't write
    // the DOM once per delta.
    const flushText = (): void => {
      this.textFlushQueued = false;
      // Drop buffered tokens once this turn is no longer the visible one,
      // so a late frame can't append them onto an error or a newer answer.
      if (this.inflight !== controller) {
        this.pendingText = '';
        return;
      }
      if (!this.pendingText) return;
      const chunk = this.pendingText;
      this.pendingText = '';
      this.balloon.appendText(chunk);
      this.repositionBubble();
    };
    const scheduleText = (delta: string): void => {
      this.pendingText += delta;
      if (this.textFlushQueued) return;
      this.textFlushQueued = true;
      requestAnimationFrame(flushText);
    };
    try {
      const reply = await askStreaming({
        endpoint: this.opts.endpoint,
        messages: outgoing,
        token: this.opts.token,
        signal: controller.signal,
        onToken: (delta) => {
          if (firstToken) {
            firstToken = false;
            this.balloon.setBusy(false);
            this.balloon.setText('');
            this.pendingText = '';
            if (this.manifest.speaking && this.queue.hasAnimation(this.manifest.speaking)) {
              this.queue.playNow(this.manifest.speaking);
            } else {
              this.queue.stop();
            }
          }
          scheduleText(delta);
        },
      });
      flushText();
      this.history.push({ role: 'assistant', content: reply });
      this.balloon.announceComplete(reply);
      return reply;
    } catch (e) {
      // A newer overlapping ask() reassigns this.inflight before this one's
      // catch/finally runs, so comparing against the locally-captured
      // controller tells us whether we're still the active request — an
      // aborted/failed *older* request must not clobber the newer one's
      // bubble state (busy flag, inflight handle, error text).
      this.handleAskError(e, turn, this.inflight === controller);
      throw e;
    } finally {
      if (this.inflight === controller) {
        this.balloon.setBusy(false);
        this.inflight = null;
        this.scheduleIdleAfterCurrent();
      }
    }
  }

  /**
   * Translate a thrown ask error into bubble UX: aborts pop a fresh state,
   * everything else picks a friendly mascot-flavored message and (when
   * recoverable) a Try-again button. Plays an Alert/Oops anim if the mascot
   * has one defined.
   *
   * `turn` is the exact history entry this ask() call pushed; it's removed
   * by reference (not "pop the last entry") so this can't delete a newer
   * overlapping request's just-pushed message. `isCurrent` is false once a
   * newer ask() has superseded this one — in that case the newer request
   * owns the bubble, so only history cleanup happens here.
   */
  private handleAskError(e: unknown, turn: ChatMessage, isCurrent: boolean): void {
    const idx = this.history.indexOf(turn);
    if (idx !== -1) this.history.splice(idx, 1);
    if (!isCurrent) return;
    const err = e instanceof MascotError ? e : null;
    if (err && err.kind === 'aborted') {
      // User-initiated abort (e.g., a new ask or a mascot switch) — no error
      // UI needed, whatever superseded this owns the bubble now.
      return;
    }
    const { text, retryable } = this.formatAskError(err, e);
    this.balloon.showError(text, { retryable });
    this.repositionBubble();
    // Play an Alert anim if the mascot defines one.
    for (const name of ['Alert', 'GetAttention', 'OOPS', 'Oops']) {
      if (this.queue.hasAnimation(name)) {
        this.queue.playNow(name);
        break;
      }
    }
  }

  private formatAskError(err: MascotError | null, raw: unknown): { text: string; retryable: boolean } {
    if (!err) {
      const msg = raw instanceof Error ? raw.message : String(raw);
      return { text: `Hmm, something went sideways: ${msg}`, retryable: true };
    }
    switch (err.kind) {
      case 'rate_limit': {
        const secs = err.retryAfterMs ? Math.max(1, Math.round(err.retryAfterMs / 1000)) : null;
        const wait = secs ? ` Try again in ${secs}s.` : ' Give me a moment, then try again.';
        return { text: `Whew — give me a sec to catch my breath.${wait}`, retryable: true };
      }
      case 'unauthorized':
        return {
          text:
            "I can't reach my brain — the assistant isn't configured, or it refused this request. Check the proxy's API key.",
          retryable: false,
        };
      case 'network':
        return { text: "I can't reach the network right now. Check your connection?", retryable: true };
      case 'timeout':
        return { text: "That took too long — let's try again.", retryable: true };
      case 'bad_request':
        return { text: `That message couldn't be sent: ${err.message}`, retryable: false };
      case 'server':
        return { text: 'My brain hiccuped. Try once more?', retryable: true };
      default:
        return { text: `Hmm, something went sideways: ${err.message}`, retryable: true };
    }
  }

  async switchTo(id: string): Promise<void> {
    if (id === this.manifest.id) return;
    if (!listMascots().includes(id)) {
      throw new Error(`Unknown mascot "${id}".`);
    }
    this.cancelIdle();
    // Cancel any in-flight ask so a late-arriving stream can't keep
    // appending the old mascot's reply into the new mascot's bubble/greeting.
    this.inflight?.abort();
    this.inflight = null;
    if (this.manifest.goodbye && !this.idleDisabled) {
      this.queue.playNow(this.manifest.goodbye);
      await Promise.race([
        this.queue.whenIdle(),
        new Promise((resolve) => setTimeout(resolve, 2000)),
      ]);
    }
    this.queue.stop();
    this.renderer.unmount();
    await this.mountMascot(id);
    writeStoredMascot(id);
    this.renderer.show();
    // Re-theme the ask-me pill to match the new mascot.
    this.pill?.setTheme(this.manifest.theme);
    this.pill?.setSwapTooltip(this.computeSwapTooltip());
    this.pill?.setCurrent(this.manifest.id);
    if (this.manifest.greeting && !this.idleDisabled) this.queue.playNow(this.manifest.greeting);
    // Update bubble greeting text to the new mascot's voice.
    const greet = this.manifest.greetingText ?? `Hi! I'm ${this.manifest.name}. Click me and ask a question.`;
    this.balloon.setText(greet);
    this.openBubble();
    // Reposition pill + bubble against the new mascot's box (sizes differ).
    this.repositionAll();
    this.scheduleIdleAfterCurrent();
  }

  current(): string {
    return this.manifest.id;
  }

  /** Cycle to the next registered mascot. Used by the pill's swap glyph
   *  when no picker popover is available (≤1 mascot or test setups). */
  private async swapToNextMascot(): Promise<void> {
    const all = listMascots();
    if (all.length < 2) return;
    const idx = all.indexOf(this.manifest.id);
    const nextId = all[(idx + 1) % all.length]!;
    await this.switchTo(nextId);
  }

  /** Tooltip for the swap glyph. With ≥2 mascots it always names the
   *  next one in the cycle ("Switch to Ninja Cat"). */
  private computeSwapTooltip(): string {
    const all = listMascots();
    if (all.length < 2) return 'Switch mascot';
    const idx = all.indexOf(this.manifest.id);
    const nextId = all[(idx + 1) % all.length]!;
    return `Switch to ${getMascotName(nextId)}`;
  }

  // ---------- Idle scheduler ----------
  // After a quiet stretch, the mascot plays a short Idle* animation so it
  // feels alive instead of frozen. The timer is reset on any meaningful user
  // activity (click, swap, ask, open-bubble) and pauses while the bubble is
  // open or the queue is busy.
  // Window of "doing nothing" between idle micro-animations. We want
  // the mascot to feel alive without being distracting — short enough
  // that a user lingering on the page sees movement within a few
  // seconds, long enough that it doesn't fight with their typing.
  // Combined with multi-history variety this keeps repeats rare even
  // when an idle pool is small.
  private static readonly IDLE_MIN_MS = 2_500;
  private static readonly IDLE_MAX_MS = 6_000;
  /** How many recent idle indices to remember when picking the next one. */
  private static readonly IDLE_HISTORY = 3;

  private cancelIdle(): void {
    this.idleGen += 1;
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  private scheduleIdle(): void {
    if (this.idleDisabled) return;
    this.cancelIdle();
    const min = MascotImpl.IDLE_MIN_MS;
    const max = MascotImpl.IDLE_MAX_MS;
    const wait = min + Math.floor(Math.random() * (max - min));
    this.idleTimer = setTimeout(() => this.runIdle(), wait);
  }

  /**
   * Arm the next idle once the queue drains. While a request is in flight,
   * a finished Thinking loop is restarted so the mascot keeps fidgeting
   * instead of freezing on the last frame.
   */
  private scheduleIdleAfterCurrent(): void {
    if (this.idleDisabled) return;
    this.cancelIdle();
    const gen = this.idleGen;
    void this.queue.whenIdle().then(() => {
      if (gen !== this.idleGen || this.idleDisabled || this.destroyed) return;
      if (this.inflight && this.manifest.thinking && this.queue.hasAnimation(this.manifest.thinking)) {
        this.queue.play(this.manifest.thinking);
        this.scheduleIdleAfterCurrent();
        return;
      }
      this.scheduleIdle();
    });
  }

  private runIdle(): void {
    this.idleTimer = null;
    if (this.idleDisabled) return;
    // Skip when the user is actively engaging with the bubble or the queue
    // is busy with a higher-priority animation. Try again shortly.
    if (this.balloon.isVisible() || this.queue.isBusy() || this.inflight) {
      this.scheduleIdle();
      return;
    }
    const candidates = (this.manifest.idle ?? []).filter((n) => this.queue.hasAnimation(n));
    if (!candidates.length) {
      // No idles defined for this mascot — try again later in case the
      // manifest changes (e.g., after switchTo).
      this.scheduleIdle();
      return;
    }
    // Variety: prefer an index not in our recent history. Falls back to a
    // random pick if every candidate has been played recently (small pool).
    const histSize = Math.min(MascotImpl.IDLE_HISTORY, Math.max(0, candidates.length - 1));
    const recent = new Set(this.idleHistory.slice(-histSize));
    const fresh: number[] = [];
    for (let i = 0; i < candidates.length; i++) {
      if (!recent.has(i)) fresh.push(i);
    }
    const pool = fresh.length ? fresh : candidates.map((_, i) => i);
    const next = pool[Math.floor(Math.random() * pool.length)]!;
    this.idleHistory.push(next);
    if (this.idleHistory.length > MascotImpl.IDLE_HISTORY) this.idleHistory.shift();
    this.queue.play(candidates[next]!);
    // Re-arm after this idle finishes.
    this.scheduleIdleAfterCurrent();
  }

  available(): string[] {
    return listMascots();
  }

  destroy(): void {
    this.destroyed = true;
    this.idleDisabled = true;
    this.cancelIdle();
    this.inflight?.abort();
    this.lifecycleAc.abort();
    this.cleanupInteractive?.();
    this.cleanupInteractive = null;
    this.queue.stop();
    this.renderer.unmount();
    this.balloon.unmount();
    this.pill?.unmount();
  }
}

export async function init(opts: MascotInitOptions): Promise<MascotInstance> {
  const m = new MascotImpl(opts);
  await m.init();
  return m;
}

// ---------- Auto-mount from <script data-*> attributes ----------

function autoMount(): void {
  const script = document.currentScript as HTMLScriptElement | null;
  if (!script) return;
  const endpoint = script.dataset.endpoint;
  if (!endpoint) return; // explicit opt-in: no endpoint, no auto-mount
  const mascot = script.dataset.mascot;
  const greeting = script.dataset.greeting;
  const systemPrompt = script.dataset.system;
  const token = script.dataset.token;
  void init({ endpoint, mascot, greeting, systemPrompt, token })
    .then((inst) => {
      // expose for console / programmatic use
      (window as unknown as { Mascot: MascotInstance }).Mascot = inst;
    })
    .catch((err) => {
      // Auto-mount has no caller to report failures to; log instead of
      // letting init() rejections become a silent unhandled rejection.
      console.error('[mascot] auto-mount failed:', err);
    });
}

// In IIFE builds, document.currentScript exists at parse time.
if (typeof document !== 'undefined' && document.currentScript) {
  autoMount();
}

// Public namespace for ESM users.
export const Mascot = { init, registerMascot, listMascots };
export { registerMascot, listMascots };
export type { MascotSource };
