/**
 * A small "speech bubble" pill that hovers next to the mascot.
 *
 * Two zones share the bubble shell:
 *   • Glyph chip on the left → swap to the next registered mascot.
 *     Tooltip + aria-label make this discoverable.
 *   • Label + keycap on the right → open the ask bubble.
 *
 * When the bubble is open, the pill hides itself.
 */

import type { MascotTheme } from './types.js';

const DEFAULT_ACCENT = '#f1b84a';
const DEFAULT_ACCENT_TEXT = '#3a2a00';
const DEFAULT_GLYPH = '✨';
const DEFAULT_LABEL = 'Ask me!';

const STYLE = `
  :host { all: initial; }
  .pill {
    --accent: ${DEFAULT_ACCENT};
    --accent-text: ${DEFAULT_ACCENT_TEXT};
    position: fixed;
    z-index: 2147483647;
    display: inline-flex;
    align-items: stretch;
    padding: 0;
    border-radius: 14px;
    background: linear-gradient(180deg, #fffdf3 0%, #fff4c9 100%);
    color: #1f2328;
    font: 600 12.5px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    letter-spacing: 0.01em;
    border: 1px solid rgba(0, 0, 0, 0.08);
    border-top: 2px solid var(--accent);
    box-shadow:
      0 1px 0 rgba(255, 255, 255, 0.9) inset,
      0 0 0 1px rgba(0, 0, 0, 0.02),
      0 8px 22px -6px rgba(20, 20, 20, 0.28),
      0 2px 6px rgba(20, 20, 20, 0.10);
    user-select: none;
    transition: transform 140ms cubic-bezier(.2,.7,.3,1.2), box-shadow 140ms ease;
    animation: wiggle 4.2s ease-in-out infinite;
    transform-origin: var(--tail-x, 50%) var(--tail-y, 100%);
  }
  .pill:hover {
    transform: translateY(-2px);
    box-shadow:
      0 1px 0 rgba(255, 255, 255, 0.9) inset,
      0 0 0 1px rgba(0, 0, 0, 0.04),
      0 14px 28px -8px rgba(20, 20, 20, 0.32),
      0 4px 10px rgba(20, 20, 20, 0.14);
  }

  /* Both interactive zones share these resets. */
  .zone {
    appearance: none;
    background: none;
    border: 0;
    margin: 0;
    color: inherit;
    font: inherit;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    transition: background 120ms ease, transform 120ms ease;
    position: relative;
  }
  .zone:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
    border-radius: 12px;
  }

  .swap {
    padding: 6px 8px 6px 9px;
    border-top-left-radius: 13px;
    border-bottom-left-radius: 13px;
    gap: 4px;
  }
  .swap:hover { background: color-mix(in srgb, var(--accent) 14%, transparent); }
  .swap:active { transform: scale(0.94); }
  .swap .glyph {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 20px;
    height: 20px;
    border-radius: 999px;
    background: color-mix(in srgb, var(--accent) 22%, white);
    box-shadow: 0 0 0 1px color-mix(in srgb, var(--accent) 40%, transparent) inset;
    font-size: 13px;
    line-height: 1;
    transition: transform 200ms cubic-bezier(.2,.7,.3,1.4);
  }
  .swap:hover .glyph { transform: rotate(-12deg); }
  .swap .swap-icon {
    width: 11px;
    height: 11px;
    color: color-mix(in srgb, var(--accent) 70%, #000);
    opacity: 0.55;
    transition: opacity 120ms ease, transform 200ms ease;
  }
  .swap:hover .swap-icon { opacity: 0.95; transform: rotate(180deg); }

  /* Vertical divider between the two zones. */
  .divider {
    width: 1px;
    margin: 6px 0;
    background: linear-gradient(180deg,
      rgba(0,0,0,0) 0%,
      rgba(0,0,0,0.10) 30%,
      rgba(0,0,0,0.10) 70%,
      rgba(0,0,0,0) 100%);
    pointer-events: none;
  }

  .ask {
    padding: 7px 12px 7px 10px;
    gap: 8px;
    border-top-right-radius: 13px;
    border-bottom-right-radius: 13px;
  }
  .ask:hover { background: rgba(0, 0, 0, 0.035); }
  .ask:active { transform: scale(0.98); }
  .ask .label { white-space: nowrap; }
  .ask .kbd {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 16px;
    height: 16px;
    padding: 0 4px;
    margin-left: 2px;
    border-radius: 4px;
    background: linear-gradient(180deg, #ffffff 0%, #f3f3ee 100%);
    color: #4a4a4a;
    font: 700 10px/1 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    border: 1px solid rgba(0, 0, 0, 0.14);
    border-bottom-width: 2px;
    box-shadow: 0 1px 0 rgba(255, 255, 255, 0.7) inset;
  }

  /* Speech-bubble tail. */
  .pill::before,
  .pill::after {
    content: "";
    position: absolute;
    left: var(--tail-x, 50%);
    transform: translateX(-50%);
    width: 0;
    height: 0;
    pointer-events: none;
  }
  .pill[data-tail="down"]::before {
    bottom: -7px;
    border-left: 7px solid transparent;
    border-right: 7px solid transparent;
    border-top: 7px solid rgba(0, 0, 0, 0.10);
  }
  .pill[data-tail="down"]::after {
    bottom: -5px;
    border-left: 6px solid transparent;
    border-right: 6px solid transparent;
    border-top: 6px solid #fff4c9;
  }
  .pill[data-tail="up"]::before {
    top: -7px;
    border-left: 7px solid transparent;
    border-right: 7px solid transparent;
    border-bottom: 7px solid var(--accent);
  }
  .pill[data-tail="up"]::after {
    top: -5px;
    border-left: 6px solid transparent;
    border-right: 6px solid transparent;
    border-bottom: 6px solid #fffdf3;
  }

  .hidden { display: none; }

  @keyframes wiggle {
    0%, 88%, 100% { transform: translateY(0) rotate(0deg); }
    91%           { transform: translateY(-2px) rotate(-1.6deg); }
    94%           { transform: translateY(-1px) rotate(1.4deg); }
    97%           { transform: translateY(-0.5px) rotate(-0.8deg); }
  }
  @media (prefers-reduced-motion: reduce) {
    .pill { animation: none; transition: none; }
    .pill:hover { transform: none; }
    .swap:hover .glyph, .swap:hover .swap-icon { transform: none; }
  }
`;

// Tiny SVG ↻ icon, inlined so it inherits currentColor.
const SWAP_ICON_SVG = `
<svg class="swap-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor"
     stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <path d="M2.5 8a5.5 5.5 0 0 1 9.4-3.9L13.5 5.7"/>
  <path d="M13.5 2.5v3.2h-3.2"/>
  <path d="M13.5 8a5.5 5.5 0 0 1-9.4 3.9L2.5 10.3"/>
  <path d="M2.5 13.5v-3.2h3.2"/>
</svg>`;

export interface AskPillOptions {
  label?: string;
  /** Called when the ask zone is clicked. */
  onClick: () => void;
  /** Called when the swap-mascot glyph is clicked. */
  onSwap?: () => void;
  theme?: MascotTheme;
  /** Tooltip shown on the glyph (e.g. "Switch to Ninjacat"). */
  swapTooltip?: string;
}

export class AskPill {
  readonly host: HTMLDivElement;
  private root: ShadowRoot;
  private pill!: HTMLDivElement;
  private swapBtn!: HTMLButtonElement;
  private askBtn!: HTMLButtonElement;
  private glyphEl!: HTMLSpanElement;
  private labelEl!: HTMLSpanElement;
  private theme: MascotTheme;
  private baseLabel: string;

  constructor(opts: AskPillOptions) {
    this.theme = opts.theme ?? {};
    this.baseLabel = opts.label ?? DEFAULT_LABEL;

    this.host = document.createElement('div');
    Object.assign(this.host.style, {
      position: 'fixed',
      top: '0',
      left: '0',
      zIndex: '2147483647',
    } satisfies Partial<CSSStyleDeclaration>);
    this.root = this.host.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = STYLE;
    this.root.appendChild(style);

    this.pill = document.createElement('div');
    this.pill.className = 'pill hidden';
    this.pill.setAttribute('data-tail', 'down');

    // ---- swap zone ----
    this.swapBtn = document.createElement('button');
    this.swapBtn.type = 'button';
    this.swapBtn.className = 'zone swap';
    this.swapBtn.title = opts.swapTooltip ?? 'Switch mascot';
    this.swapBtn.setAttribute('aria-label', opts.swapTooltip ?? 'Switch mascot');
    this.glyphEl = document.createElement('span');
    this.glyphEl.className = 'glyph';
    this.glyphEl.setAttribute('aria-hidden', 'true');
    const swapIcon = document.createElement('span');
    swapIcon.innerHTML = SWAP_ICON_SVG;
    this.swapBtn.append(this.glyphEl, swapIcon.firstElementChild!);
    if (opts.onSwap) {
      this.swapBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        opts.onSwap!();
      });
    } else {
      // No swap handler → hide the swap zone + divider entirely.
      this.swapBtn.style.display = 'none';
    }

    const divider = document.createElement('div');
    divider.className = 'divider';
    if (!opts.onSwap) divider.style.display = 'none';

    // ---- ask zone ----
    this.askBtn = document.createElement('button');
    this.askBtn.type = 'button';
    this.askBtn.className = 'zone ask';
    this.askBtn.setAttribute('aria-label', 'Ask the mascot a question (press /)');
    this.askBtn.setAttribute('aria-haspopup', 'dialog');
    this.askBtn.setAttribute('aria-expanded', 'false');
    this.askBtn.addEventListener('click', opts.onClick);
    this.labelEl = document.createElement('span');
    this.labelEl.className = 'label';
    const kbd = document.createElement('span');
    kbd.className = 'kbd';
    kbd.textContent = '/';
    this.askBtn.append(this.labelEl, kbd);

    this.pill.append(this.swapBtn, divider, this.askBtn);
    this.root.appendChild(this.pill);
    this.applyTheme();
  }

  setTheme(theme: MascotTheme | undefined): void {
    this.theme = theme ?? {};
    this.applyTheme();
  }

  /** Reflect dialog open/closed state for assistive tech. */
  setExpanded(expanded: boolean): void {
    this.askBtn.setAttribute('aria-expanded', String(expanded));
  }

  /** Move keyboard focus back to the ask button (used after the bubble closes). */
  focusAsk(): void {
    this.askBtn.focus();
  }

  /** Update the swap-zone tooltip, e.g. "Switch to Ninjacat". */
  setSwapTooltip(text: string): void {
    this.swapBtn.title = text;
    this.swapBtn.setAttribute('aria-label', text);
  }

  private applyTheme(): void {
    const accent = this.theme.accent ?? DEFAULT_ACCENT;
    const accentText = this.theme.accentText ?? DEFAULT_ACCENT_TEXT;
    const glyph = this.theme.glyph ?? DEFAULT_GLYPH;
    const label = this.theme.pillLabel ?? this.baseLabel;
    this.pill.style.setProperty('--accent', accent);
    this.pill.style.setProperty('--accent-text', accentText);
    this.glyphEl.textContent = glyph;
    this.labelEl.textContent = label;
  }

  mount(parent: ParentNode = document.body): void {
    parent.appendChild(this.host);
  }

  unmount(): void {
    this.host.remove();
  }

  show(): void {
    this.pill.classList.remove('hidden');
  }

  hide(): void {
    this.pill.classList.add('hidden');
  }

  /** Position to the upper-left of the mascot's anchor rect. */
  positionNear(anchor: DOMRect): void {
    const wasHidden = this.pill.classList.contains('hidden');
    if (wasHidden) {
      this.pill.style.visibility = 'hidden';
      this.pill.classList.remove('hidden');
    }
    const r = this.pill.getBoundingClientRect();
    let top = anchor.top - r.height - 10;
    let left = anchor.left + anchor.width / 2 - r.width / 2;
    let tail: 'up' | 'down' = 'down';
    if (top < 8) {
      top = anchor.bottom + 10;
      tail = 'up';
    }
    if (left < 8) left = 8;
    if (left + r.width > window.innerWidth - 8) {
      left = window.innerWidth - r.width - 8;
    }
    const mascotCenterX = anchor.left + anchor.width / 2;
    const tailX = Math.max(14, Math.min(r.width - 14, mascotCenterX - left));
    this.pill.style.setProperty('--tail-x', `${tailX}px`);
    this.pill.style.setProperty('--tail-y', tail === 'down' ? '100%' : '0%');
    this.pill.setAttribute('data-tail', tail);
    this.pill.style.top = `${top}px`;
    this.pill.style.left = `${left}px`;
    this.pill.style.position = 'fixed';
    if (wasHidden) {
      this.pill.classList.add('hidden');
      this.pill.style.visibility = '';
    }
  }
}
