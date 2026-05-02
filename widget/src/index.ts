import { ActionQueue } from './runtime.js';
import { SpriteRenderer, makeInteractive } from './renderer.js';
import { Balloon } from './balloon.js';
import { AskPill } from './ask-pill.js';
import { askStreaming, MascotError, type ChatMessage } from './chat-client.js';
import { loadMascot, registerMascot, listMascots, getMascotName, getMascotGlyph, type MascotSource } from './registry.js';
import type { MascotManifest, MascotMap } from './types.js';

// Discover mascots at build time. Each mascot folder contributes a map.json
// and a map.png; both are optional (a folder is registered only when both
// files exist), so adding/removing a mascot is purely a filesystem change.
const mapModules = import.meta.glob<MascotMap>('./mascots/*/map.json', {
  eager: true,
  import: 'default',
});
const sheetModules = import.meta.glob<string>('./mascots/*/map.png', {
  eager: true,
  import: 'default',
  query: '?url',
});

for (const path of Object.keys(mapModules)) {
  const id = path.split('/')[2]!;
  const sheetPath = `./mascots/${id}/map.png`;
  const sheet = sheetModules[sheetPath];
  if (!sheet) {
    console.warn(`[mascot] skipping "${id}": missing map.png`);
    continue;
  }
  registerMascot({
    id,
    name: id.charAt(0).toUpperCase() + id.slice(1),
    map: mapModules[path]!,
    spritesheet: sheet,
  });
}

export interface MascotInitOptions {
  endpoint: string;
  mascot?: string;
  greeting?: string;
  systemPrompt?: string;
  parent?: HTMLElement;
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

interface SavedPosition {
  left: number;
  top: number;
  vw: number;
  vh: number;
}

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

/**
 * Read the page's safe-area insets (iOS notch, home indicator, Android
 * gesture nav, foldables). Returns 0 on platforms that don't expose
 * `env(safe-area-inset-*)`. We probe with a hidden element so we always
 * get a real px value rather than parsing CSS strings.
 */
function readSafeAreaInsets(): { top: number; right: number; bottom: number; left: number } {
  if (typeof document === 'undefined') return { top: 0, right: 0, bottom: 0, left: 0 };
  const probe = document.createElement('div');
  Object.assign(probe.style, {
    position: 'fixed',
    top: 'env(safe-area-inset-top, 0px)',
    right: 'env(safe-area-inset-right, 0px)',
    bottom: 'env(safe-area-inset-bottom, 0px)',
    left: 'env(safe-area-inset-left, 0px)',
    width: '0',
    height: '0',
    visibility: 'hidden',
    pointerEvents: 'none',
  } as Partial<CSSStyleDeclaration>);
  document.body.appendChild(probe);
  const cs = getComputedStyle(probe);
  const parse = (s: string): number => {
    const n = parseFloat(s);
    return Number.isFinite(n) ? n : 0;
  };
  const insets = {
    top: parse(cs.top),
    right: parse(cs.right),
    bottom: parse(cs.bottom),
    left: parse(cs.left),
  };
  probe.remove();
  return insets;
}

/** Edge margin used for the resting bottom-right anchor (matches CSS in renderer.ts). */
const EDGE_MARGIN = 24;
const SAFE_AREA_PAD = 16;

/**
 * Compute the bottom-right anchor point in current viewport coordinates,
 * accounting for OS safe-area insets so the mascot never sits under a
 * notch, home indicator, or gesture-nav bar.
 */
function bottomRightAnchor(elW: number, elH: number): { left: number; top: number } {
  const insets = readSafeAreaInsets();
  const padR = Math.max(EDGE_MARGIN, insets.right + SAFE_AREA_PAD);
  const padB = Math.max(EDGE_MARGIN, insets.bottom + SAFE_AREA_PAD);
  const left = Math.max(0, window.innerWidth - elW - padR);
  const top = Math.max(0, window.innerHeight - elH - padB);
  return { left, top };
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
  /** Legacy field kept so the rest of the file's references compile cleanly. */
  private idleLastIdx = -1;
  /** Disable idle activity entirely. Set when destroyed or on prefers-reduced-motion. */
  private idleDisabled = false;

  constructor(private opts: MascotInitOptions) {}

  async init(): Promise<void> {
    // Respect the OS-level reduced-motion preference: skip auto-idle
    // animations entirely so they don't surprise users who've opted out.
    if (typeof window !== 'undefined' && window.matchMedia) {
      const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
      this.idleDisabled = mq.matches;
      mq.addEventListener?.('change', (e) => {
        this.idleDisabled = e.matches;
        if (e.matches) this.cancelIdle();
        else this.scheduleIdle();
      });
    }
    const id =
      this.opts.mascot ?? localStorage.getItem(STORAGE_KEY) ?? 'clippy';
    await this.mountMascot(id);

    this.balloon = new Balloon({
      onAsk: (q) => void this.ask(q),
      placeholder: 'Ask me anything…',
      onHide: () => {
        this.pill.show();
        this.pill.setExpanded(false);
        this.repositionPill();
        // Return focus to the pill's ask button so keyboard users land where
        // they came from rather than at <body>.
        this.pill.focusAsk();
        this.scheduleIdle();
      },
      onRetry: () => {
        if (this.lastQuestion) void this.ask(this.lastQuestion);
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

    // Keyboard shortcut: "/" focuses the input (unless already typing somewhere).
    window.addEventListener('keydown', (e) => {
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      e.preventDefault();
      this.openBubble();
    });

    window.addEventListener('resize', () => {
      if (readSavedPosition()) {
        // User has dragged → re-clamp the saved position into the new
        // viewport (and into the safe area, if it changed e.g. on rotate).
        this.clampToViewport();
      } else {
        // No saved position → keep the mascot snapped to the bottom-right
        // safe-area corner regardless of resize/rotate/keyboard show-hide.
        const r = this.renderer.el.getBoundingClientRect();
        const { left, top } = bottomRightAnchor(r.width, r.height);
        this.renderer.setPosition(left, top);
      }
      this.repositionAll();
    });
    // Mobile rotation / iOS soft-keyboard show-hide doesn't always fire a
    // resize event — listen on visualViewport too so the bottom-right
    // anchor follows the visible area.
    if (typeof visualViewport !== 'undefined' && visualViewport) {
      const onVV = () => {
        if (!readSavedPosition()) {
          const r = this.renderer.el.getBoundingClientRect();
          const { left, top } = bottomRightAnchor(r.width, r.height);
          this.renderer.setPosition(left, top);
          this.repositionAll();
        }
      };
      visualViewport.addEventListener('resize', onVV);
      visualViewport.addEventListener('scroll', onVV);
    }

    await this.show();

    // Auto-open the bubble with the greeting + focus input so users see
    // immediately that they can ask questions.
    const initialGreet = this.opts.greeting ?? this.manifest.greetingText;
    if (initialGreet) {
      this.balloon.setText(initialGreet);
      this.openBubble();
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
    makeInteractive(this.renderer.el, {
      onClick: () => this.onMascotClick(),
      onMove: () => this.repositionAll(),
      onDragEnd: (left, top) => {
        writeSavedPosition({ left, top, vw: window.innerWidth, vh: window.innerHeight });
      },
    });
    // Keyboard activation: Enter / Space on the focused mascot opens the
    // bubble (mirrors clicking the ask pill so keyboard users have parity).
    this.renderer.el.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      this.openBubble();
    });
    this.queue = new ActionQueue(this.manifest.map, this.renderer);
    // Restore drag-saved position (clamped to current viewport).
    this.restorePosition();
  }

  /**
   * Apply any persisted drag position from a previous session, clamping into
   * the current viewport. If the saved position would put the mascot off
   * screen (e.g., user resized down), we re-clamp instead of discarding so
   * the user's intent is preserved. With no saved position, we explicitly
   * snap the mascot to the safe-area-aware bottom-right corner so the
   * default placement is consistent across iOS notches, Android gesture
   * bars, and embedded contexts where CSS env() insets matter.
   */
  private restorePosition(): void {
    const saved = readSavedPosition();
    // Wait one frame so the renderer's box has measurable dimensions.
    requestAnimationFrame(() => {
      const r = this.renderer.el.getBoundingClientRect();
      const elW = r.width || this.renderer.el.offsetWidth;
      const elH = r.height || this.renderer.el.offsetHeight;
      if (!saved) {
        // No saved position → snap to the safe-area-aware bottom-right,
        // overriding the CSS bottom/right anchor with explicit pixel
        // coordinates so subsequent dragging/resizing has consistent math.
        const { left, top } = bottomRightAnchor(elW, elH);
        this.renderer.setPosition(left, top);
        this.repositionAll();
        return;
      }
      const insets = readSafeAreaInsets();
      const minL = Math.max(0, insets.left);
      const minT = Math.max(0, insets.top);
      const maxL = Math.max(minL, window.innerWidth - elW - Math.max(0, insets.right));
      const maxT = Math.max(minT, window.innerHeight - elH - Math.max(0, insets.bottom));
      const left = Math.min(Math.max(minL, saved.left), maxL);
      const top = Math.min(Math.max(minT, saved.top), maxT);
      this.renderer.setPosition(left, top);
      this.repositionAll();
    });
  }

  private clampToViewport(): void {
    const r = this.renderer.el.getBoundingClientRect();
    const insets = readSafeAreaInsets();
    const minL = Math.max(0, insets.left);
    const minT = Math.max(0, insets.top);
    const maxL = Math.max(minL, window.innerWidth - r.width - Math.max(0, insets.right));
    const maxT = Math.max(minT, window.innerHeight - r.height - Math.max(0, insets.bottom));
    const left = Math.min(Math.max(minL, r.left), maxL);
    const top = Math.min(Math.max(minT, r.top), maxT);
    if (left !== r.left || top !== r.top) {
      this.renderer.setPosition(left, top);
      // Persist the clamped value so future sessions don't keep clamping.
      writeSavedPosition({ left, top, vw: window.innerWidth, vh: window.innerHeight });
    }
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
    this.queue.stop();
    const name = fun[this.clickIdx % fun.length]!;
    this.clickIdx++;
    this.queue.play(name);
    this.scheduleIdleAfterCurrent();
  }

  private bubbleSay(text: string): void {
    this.balloon.setText(text);
    this.openBubble();
    if (this.manifest.speaking && this.queue.hasAnimation(this.manifest.speaking)) {
      this.queue.play(this.manifest.speaking);
    }
  }

  private openBubble(): void {
    this.cancelIdle();
    this.pill?.hide();
    this.pill?.setExpanded(true);
    this.balloon.show();
    this.repositionBubble();
    this.balloon.focusInput();
  }

  private repositionBubble(): void {
    this.balloon.positionAbove(this.renderer.getRect());
  }

  private repositionPill(): void {
    this.pill?.positionNear(this.renderer.getRect());
  }

  private repositionAll(): void {
    this.repositionBubble();
    this.repositionPill();
  }

  private toggleBubble(): void {
    if (this.balloon.isVisible()) {
      this.balloon.hide();
      this.pill?.show();
      this.repositionPill();
    } else {
      this.openBubble();
    }
  }

  async show(): Promise<void> {
    this.renderer.show();
    if (this.manifest.greeting && !this.idleDisabled) {
      this.queue.play(this.manifest.greeting);
    }
    this.scheduleIdle();
  }

  async hide(): Promise<void> {
    this.cancelIdle();
    if (this.manifest.goodbye && !this.idleDisabled) {
      this.queue.play(this.manifest.goodbye);
    }
    this.balloon.hide();
    // Wait briefly for goodbye to finish.
    await new Promise((r) => setTimeout(r, this.idleDisabled ? 0 : 600));
    this.renderer.hide();
  }

  async ask(q: string): Promise<string> {
    this.cancelIdle();
    this.inflight?.abort();
    this.inflight = new AbortController();
    this.lastQuestion = q;

    this.balloon.show();
    this.balloon.setText('');
    this.repositionBubble();
    if (this.manifest.thinking && this.queue.hasAnimation(this.manifest.thinking)) {
      this.queue.play(this.manifest.thinking);
    }
    this.history.push({ role: 'user', content: q });

    let firstToken = true;
    try {
      const reply = await askStreaming({
        endpoint: this.opts.endpoint,
        messages: this.history,
        signal: this.inflight.signal,
        onToken: (delta) => {
          if (firstToken) {
            firstToken = false;
            if (this.manifest.speaking && this.queue.hasAnimation(this.manifest.speaking)) {
              this.queue.stop();
              this.queue.play(this.manifest.speaking);
            }
          }
          this.balloon.appendText(delta);
          this.repositionBubble();
        },
      });
      this.history.push({ role: 'assistant', content: reply });
      return reply;
    } catch (e) {
      this.handleAskError(e);
      throw e;
    } finally {
      this.inflight = null;
      this.scheduleIdleAfterCurrent();
    }
  }

  /**
   * Translate a thrown ask error into bubble UX: aborts pop a fresh state,
   * everything else picks a friendly mascot-flavored message and (when
   * recoverable) a Try-again button. Plays an Alert/Oops anim if the mascot
   * has one defined.
   */
  private handleAskError(e: unknown): void {
    const err = e instanceof MascotError ? e : null;
    if (err && err.kind === 'aborted') {
      // User-initiated abort (e.g., a new ask) — drop the stale message we
      // pushed onto history so the conversation stays clean.
      if (this.history.length && this.history[this.history.length - 1]!.role === 'user') {
        this.history.pop();
      }
      return;
    }
    // Drop the user message we optimistically pushed; the assistant never
    // produced a reply, so leaving it would corrupt the next turn.
    if (this.history.length && this.history[this.history.length - 1]!.role === 'user') {
      this.history.pop();
    }
    const { text, retryable } = this.formatAskError(err, e);
    this.balloon.showError(text, { retryable });
    this.repositionBubble();
    // Play an Alert anim if the mascot defines one.
    for (const name of ['Alert', 'GetAttention', 'OOPS', 'Oops']) {
      if (this.queue.hasAnimation(name)) {
        this.queue.stop();
        this.queue.play(name);
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
            "I can't reach my brain — the assistant isn't configured. Check that the proxy has an API key set.",
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
    if (this.manifest.goodbye && !this.idleDisabled) {
      this.queue.play(this.manifest.goodbye);
      await new Promise((r) => setTimeout(r, 800));
    }
    this.queue.stop();
    this.renderer.unmount();
    await this.mountMascot(id);
    localStorage.setItem(STORAGE_KEY, id);
    this.renderer.show();
    // Re-theme the ask-me pill to match the new mascot.
    this.pill?.setTheme(this.manifest.theme);
    this.pill?.setSwapTooltip(this.computeSwapTooltip());
    this.pill?.setCurrent(this.manifest.id);
    if (this.manifest.greeting && !this.idleDisabled) this.queue.play(this.manifest.greeting);
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

  /** Build the ordered option list shown in the pill's picker popover. */
  private buildMascotOptions(): { id: string; name: string; glyph?: string }[] {
    return listMascots().map((id) => ({
      id,
      name: getMascotName(id),
      glyph: getMascotGlyph(id),
    }));
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

  /** Schedule the next idle to start once any in-flight queued anim finishes. */
  private scheduleIdleAfterCurrent(): void {
    if (this.idleDisabled) return;
    this.cancelIdle();
    // Wait for queue to drain (cheaply: poll a couple of times) then schedule.
    const tryArm = (): void => {
      if (this.idleDisabled) return;
      if (this.queue.isBusy()) {
        this.idleTimer = setTimeout(tryArm, 400);
        return;
      }
      this.scheduleIdle();
    };
    this.idleTimer = setTimeout(tryArm, 400);
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
    this.idleLastIdx = next;
    this.queue.play(candidates[next]!);
    // Re-arm after this idle finishes.
    this.scheduleIdleAfterCurrent();
  }

  available(): string[] {
    return listMascots();
  }

  destroy(): void {
    this.idleDisabled = true;
    this.cancelIdle();
    this.inflight?.abort();
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
  void init({ endpoint, mascot, greeting, systemPrompt }).then((inst) => {
    // expose for console / programmatic use
    (window as unknown as { Mascot: MascotInstance }).Mascot = inst;
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
