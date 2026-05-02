/**
 * A speech-bubble UI built inside a Shadow DOM so host-page CSS cannot bleed
 * in. Positions itself relative to a target element (the mascot agent).
 */

const STYLE = `
  :host { all: initial; }
  .balloon {
    position: fixed;
    z-index: 2147483647;
    max-width: 280px;
    min-width: 180px;
    background: #ffffcc;
    color: #111;
    border: 1px solid #444;
    border-radius: 8px;
    padding: 10px 12px;
    font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    box-shadow: 0 6px 20px rgba(0,0,0,0.18);
    display: none;
  }
  .balloon.show { display: block; }
  .balloon.error {
    background: #fff5f5;
    border-color: #c53030;
    box-shadow: 0 6px 20px rgba(197, 48, 48, 0.18);
  }
  .balloon.error .text { color: #742a2a; }
  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }
  .text { white-space: pre-wrap; word-wrap: break-word; }
  form { display: flex; gap: 6px; margin-top: 8px; }
  input {
    flex: 1; min-width: 0;
    padding: 6px 8px;
    border: 1px solid #999; border-radius: 4px;
    font: inherit; background: #fff; color: #111;
  }
  button {
    padding: 6px 10px; border: 1px solid #444; border-radius: 4px;
    background: #f0f0f0; color: #111; font: inherit; cursor: pointer;
  }
  button:hover { background: #e6e6e6; }
  .retry {
    margin-top: 8px;
    background: #c53030; color: #fff; border-color: #9b2c2c;
  }
  .retry:hover { background: #9b2c2c; }
  .retry[hidden] { display: none; }
  /* Speech-bubble tail. The balloon places itself either above the mascot
     (tail pointing down) or below it (tail pointing up); data-tail picks
     which CSS variant is active. */
  .tail {
    position: absolute;
    width: 0; height: 0;
    border-left: 8px solid transparent;
    border-right: 8px solid transparent;
  }
  .balloon[data-tail="down"] .tail {
    border-top: 10px solid #ffffcc;
    bottom: -10px;
    filter: drop-shadow(0 1px 0 #444);
  }
  .balloon[data-tail="up"] .tail {
    border-bottom: 10px solid #ffffcc;
    top: -10px;
    filter: drop-shadow(0 -1px 0 #444);
  }
  .balloon.error[data-tail="down"] .tail {
    border-top-color: #fff5f5;
    filter: drop-shadow(0 1px 0 #c53030);
  }
  .balloon.error[data-tail="up"] .tail {
    border-bottom-color: #fff5f5;
    filter: drop-shadow(0 -1px 0 #c53030);
  }
  .row { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
  .close {
    background: transparent; border: none; cursor: pointer;
    color: #555; font-size: 16px; line-height: 1; padding: 0 4px;
  }
`;

export interface BalloonOptions {
  onAsk: (q: string) => void;
  placeholder?: string;
  onHide?: () => void;
  onRetry?: () => void;
}

export class Balloon {
  readonly host: HTMLDivElement;
  private root: ShadowRoot;
  private box!: HTMLDivElement;
  private textEl!: HTMLDivElement;
  private input!: HTMLInputElement;
  private retryBtn!: HTMLButtonElement;

  constructor(private opts: BalloonOptions) {
    this.host = document.createElement('div');
    this.host.style.position = 'fixed';
    this.host.style.zIndex = '2147483647';
    this.host.style.top = '0';
    this.host.style.left = '0';
    this.root = this.host.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = STYLE;
    this.root.appendChild(style);

    this.box = document.createElement('div');
    this.box.className = 'balloon';
    this.box.setAttribute('role', 'dialog');
    this.box.setAttribute('aria-modal', 'false');
    this.box.setAttribute('aria-label', 'Mascot assistant');
    this.box.setAttribute('data-tail', 'down');
    this.box.innerHTML = `
      <div class="row">
        <div class="text" role="status" aria-live="polite" aria-atomic="false"></div>
        <button class="close" title="Close" aria-label="Close assistant" type="button">×</button>
      </div>
      <button class="retry" type="button" hidden>Try again</button>
      <form>
        <label for="mascot-ask-input" class="sr-only">Question for the assistant</label>
        <input id="mascot-ask-input" type="text" autocomplete="off" />
        <button type="submit">Ask</button>
      </form>
      <div class="tail" aria-hidden="true"></div>
    `;
    this.root.appendChild(this.box);

    this.textEl = this.box.querySelector('.text') as HTMLDivElement;
    this.input = this.box.querySelector('input') as HTMLInputElement;
    this.retryBtn = this.box.querySelector('.retry') as HTMLButtonElement;
    this.input.placeholder = opts.placeholder ?? 'Ask me anything…';

    this.box.querySelector('form')!.addEventListener('submit', (e) => {
      e.preventDefault();
      const q = this.input.value.trim();
      if (!q) return;
      this.input.value = '';
      this.clearError();
      this.opts.onAsk(q);
    });
    this.box.querySelector('.close')!.addEventListener('click', () => {
      this.hide();
      this.opts.onHide?.();
    });
    this.retryBtn.addEventListener('click', () => {
      this.clearError();
      this.opts.onRetry?.();
    });

    // Keyboard handling: ESC closes, Tab/Shift+Tab cycle within the bubble
    // so keyboard focus doesn't escape into the host page while it's open.
    this.box.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        this.hide();
        this.opts.onHide?.();
        return;
      }
      if (e.key !== 'Tab') return;
      const focusables = this.focusables();
      if (!focusables.length) return;
      const first = focusables[0]!;
      const last = focusables[focusables.length - 1]!;
      const active = this.root.activeElement as HTMLElement | null;
      if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    });
  }

  private focusables(): HTMLElement[] {
    const sel = 'button:not([hidden]):not([disabled]), input:not([disabled])';
    return Array.from(this.box.querySelectorAll<HTMLElement>(sel)).filter(
      (el) => el.offsetParent !== null || el.getClientRects().length > 0,
    );
  }

  mount(parent: ParentNode = document.body): void {
    parent.appendChild(this.host);
  }

  unmount(): void {
    this.host.remove();
  }

  show(): void {
    this.box.classList.add('show');
  }

  hide(): void {
    this.box.classList.remove('show');
  }

  isVisible(): boolean {
    return this.box.classList.contains('show');
  }

  setText(s: string): void {
    this.clearError();
    this.textEl.textContent = s;
  }

  appendText(s: string): void {
    this.textEl.textContent = (this.textEl.textContent ?? '') + s;
  }

  /** Show a typed error: red accent + optional Try-again button. */
  showError(message: string, opts: { retryable?: boolean } = {}): void {
    this.box.classList.add('error');
    this.textEl.textContent = message;
    this.retryBtn.hidden = !opts.retryable;
    this.show();
  }

  clearError(): void {
    this.box.classList.remove('error');
    this.retryBtn.hidden = true;
  }

  focusInput(): void {
    this.input.focus();
  }

  /** Position bubble above-and-to-the-left of the given anchor rect.
   *  Falls back to placing it below the mascot when there's not enough
   *  headroom; the tail flips accordingly so it always points at the
   *  mascot. The bubble shifts horizontally so its tail can reach the
   *  mascot's centre, keeping the visual link between the two clear. */
  positionAbove(anchor: DOMRect): void {
    const wasHidden = !this.isVisible();
    if (wasHidden) {
      this.box.style.visibility = 'hidden';
      this.box.classList.add('show');
    }
    const r = this.box.getBoundingClientRect();
    const anchorCenterX = anchor.left + anchor.width / 2;
    // Default placement: bubble's right edge ~30px past the mascot's
    // centre so the tail naturally points down-right at the mascot.
    let left = anchorCenterX - (r.width - 30);
    let top = anchor.top - r.height - 14;
    let tail: 'up' | 'down' = 'down';
    if (top < 8) {
      top = anchor.bottom + 14;
      tail = 'up';
    }
    // Viewport clamp.
    if (left < 8) left = 8;
    if (left + r.width > window.innerWidth - 8) {
      left = window.innerWidth - r.width - 8;
    }
    this.box.style.top = `${top}px`;
    this.box.style.left = `${left}px`;
    this.box.setAttribute('data-tail', tail);
    // Aim the tail at the mascot's horizontal centre, clamped to the
    // bubble's interior so it never floats off the edge.
    const tailX = Math.max(14, Math.min(r.width - 22, anchorCenterX - left - 8));
    const tailEl = this.box.querySelector<HTMLElement>('.tail');
    if (tailEl) tailEl.style.left = `${tailX}px`;
    if (wasHidden) {
      this.box.classList.remove('show');
      this.box.style.visibility = '';
    }
  }
}
