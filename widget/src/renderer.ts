import type { Frame, MascotMap } from './types.js';
import type { RendererPort } from './runtime.js';

/**
 * DOM renderer for ClippyJS-style sprite sheets. Renders one stacked div per
 * overlay (`overlayCount`); each frame sets background-position on each
 * overlay div to reveal the right sprite cell.
 */
export class SpriteRenderer implements RendererPort {
  readonly el: HTMLDivElement;
  private inner: HTMLDivElement;
  private overlays: HTMLDivElement[] = [];
  private scale: number;

  constructor(
    private map: MascotMap,
    spritesheetUrl: string,
    opts: { scale?: number } = {},
  ) {
    const [w, h] = map.framesize;
    // Render scale: small native sprite sheets (e.g. 124x93) feel cramped
    // on modern displays, so we upscale the layout box and the background
    // image together so click hit-testing stays accurate.
    const scale = opts.scale ?? 1.6;
    this.scale = scale;
    const dw = Math.round(w * scale);
    const dh = Math.round(h * scale);
    // Outer root carries the drop-shadow filter and is the interactive
    // / focusable element. We deliberately do NOT clip it so the soft
    // shadow can extend past the sprite bounds.
    const root = document.createElement('div');
    root.className = 'mascot-agent';
    root.setAttribute('role', 'button');
    root.setAttribute('aria-label', 'Open assistant');
    root.tabIndex = 0;
    Object.assign(root.style, {
      position: 'fixed',
      width: `${dw}px`,
      height: `${dh}px`,
      cursor: 'grab',
      userSelect: 'none',
      zIndex: '2147483646',
      bottom: 'max(24px, env(safe-area-inset-bottom, 0px) + 16px)',
      right: 'max(24px, env(safe-area-inset-right, 0px) + 16px)',
      display: 'none',
      filter: 'drop-shadow(0 6px 8px rgba(0, 0, 0, 0.18)) drop-shadow(0 1px 2px rgba(0, 0, 0, 0.12))',
      transition: 'filter 160ms ease-out',
    } satisfies Partial<CSSStyleDeclaration>);

    // Inner wrapper is the same size as the layout box and clips at
    // its bounds. This stops adjacent sprite cells from bleeding past
    // the cell at non-integer scales (sub-pixel rounding leaks
    // neighbouring frame content otherwise) — without clipping the
    // outer drop-shadow.
    const inner = document.createElement('div');
    inner.setAttribute('aria-hidden', 'true');
    Object.assign(inner.style, {
      position: 'absolute',
      inset: '0',
      overflow: 'hidden',
    } satisfies Partial<CSSStyleDeclaration>);
    root.appendChild(inner);
    this.inner = inner;

    for (let i = 0; i < map.overlayCount; i++) {
      const o = document.createElement('div');
      o.setAttribute('aria-hidden', 'true');
      Object.assign(o.style, {
        position: 'absolute',
        top: '0',
        left: '0',
        width: `${w}px`,
        height: `${h}px`,
        backgroundImage: `url("${spritesheetUrl}")`,
        backgroundRepeat: 'no-repeat',
        backgroundPosition: '0 0',
        transform: `scale(${scale})`,
        transformOrigin: 'top left',
      } satisfies Partial<CSSStyleDeclaration>);
      inner.appendChild(o);
      this.overlays.push(o);
    }
    this.el = root;
  }

  mount(parent: ParentNode = document.body): void {
    parent.appendChild(this.el);
  }

  unmount(): void {
    this.el.remove();
  }

  show(): void {
    this.el.style.display = 'block';
  }

  hide(): void {
    this.el.style.display = 'none';
  }

  showFrame(frame: Frame): void {
    const images = frame.images ?? [];
    this.overlays.forEach((overlay, i) => {
      const coord = images[i];
      if (!coord) {
        overlay.style.backgroundPosition = '-9999px -9999px';
        return;
      }
      overlay.style.backgroundPosition = `-${coord[0]}px -${coord[1]}px`;
    });
  }

  showEmpty(): void {
    this.overlays.forEach((o) => (o.style.backgroundPosition = '-9999px -9999px'));
  }

  /** Returns the position in viewport coords (top-left of agent box). */
  getRect(): DOMRect {
    return this.el.getBoundingClientRect();
  }

  setPosition(left: number, top: number): void {
    this.el.style.left = `${left}px`;
    this.el.style.top = `${top}px`;
    this.el.style.right = 'auto';
    this.el.style.bottom = 'auto';
  }
}

/**
 * Adds drag-to-move and a click handler that only fires when the pointer
 * didn't move past a small threshold (so dragging never triggers a click).
 *
 * Uses Pointer Events for unified mouse + touch + stylus support, with
 * viewport clamping and an `onDragEnd` callback so callers can persist the
 * final position. Returns a cleanup function.
 */
export function makeInteractive(
  el: HTMLElement,
  handlers: {
    onClick?: () => void;
    onMove?: () => void;
    onDragEnd?: (left: number, top: number) => void;
  },
): () => void {
  const THRESHOLD = 4;
  // Touch dragging would scroll the page without this; pointer-events are
  // already wired so we don't need browser-default touch gestures here.
  el.style.touchAction = 'none';

  let pressed = false;
  let dragging = false;
  let pointerId = -1;
  let startX = 0;
  let startY = 0;
  let dx = 0;
  let dy = 0;

  const clamp = (v: number, lo: number, hi: number): number =>
    v < lo ? lo : v > hi ? hi : v;

  const onPointerDown = (e: PointerEvent): void => {
    // Only primary mouse button; touch/pen always treated as primary.
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    pressed = true;
    dragging = false;
    pointerId = e.pointerId;
    startX = e.clientX;
    startY = e.clientY;
    const r = el.getBoundingClientRect();
    dx = e.clientX - r.left;
    dy = e.clientY - r.top;
    try {
      el.setPointerCapture(e.pointerId);
    } catch {
      /* some environments (jsdom) don't implement capture */
    }
  };

  const onPointerMove = (e: PointerEvent): void => {
    if (!pressed || e.pointerId !== pointerId) return;
    if (!dragging) {
      if (Math.hypot(e.clientX - startX, e.clientY - startY) < THRESHOLD) return;
      dragging = true;
      el.style.cursor = 'grabbing';
    }
    const elW = el.offsetWidth;
    const elH = el.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const left = clamp(e.clientX - dx, 0, Math.max(0, vw - elW));
    const top = clamp(e.clientY - dy, 0, Math.max(0, vh - elH));
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
    el.style.right = 'auto';
    el.style.bottom = 'auto';
    handlers.onMove?.();
  };

  const onPointerUp = (e: PointerEvent): void => {
    if (!pressed || e.pointerId !== pointerId) return;
    const wasDragging = dragging;
    pressed = false;
    dragging = false;
    pointerId = -1;
    el.style.cursor = 'grab';
    try {
      el.releasePointerCapture(e.pointerId);
    } catch {
      /* noop */
    }
    if (wasDragging) {
      const r = el.getBoundingClientRect();
      handlers.onDragEnd?.(r.left, r.top);
    } else {
      handlers.onClick?.();
    }
  };

  el.addEventListener('pointerdown', onPointerDown);
  el.addEventListener('pointermove', onPointerMove);
  el.addEventListener('pointerup', onPointerUp);
  el.addEventListener('pointercancel', onPointerUp);

  return () => {
    el.removeEventListener('pointerdown', onPointerDown);
    el.removeEventListener('pointermove', onPointerMove);
    el.removeEventListener('pointerup', onPointerUp);
    el.removeEventListener('pointercancel', onPointerUp);
  };
}

/** @deprecated kept for backwards compat — prefer makeInteractive. */
export function makeDraggable(el: HTMLElement, onMove?: () => void): void {
  makeInteractive(el, { onMove });
}
