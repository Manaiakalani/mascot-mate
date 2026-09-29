/**
 * Viewport placement for the mascot. Safe-area insets are measured once
 * and reused until the next resize — visualViewport scroll used to rebuild
 * a probe element and force layout on every frame.
 */

export interface Insets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface ViewportFrame {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface SavedPosition {
  left: number;
  top: number;
  vw: number;
  vh: number;
}

const ZERO_INSETS: Insets = { top: 0, right: 0, bottom: 0, left: 0 };

/** Matches the resting margin in renderer.ts. */
export const EDGE_MARGIN = 24;
export const SAFE_AREA_PAD = 16;

let insetCache: Insets | null = null;
let probe: HTMLDivElement | null = null;

export function invalidateSafeArea(): void {
  insetCache = null;
}

export function readSafeAreaInsets(): Insets {
  if (insetCache) return insetCache;
  if (typeof document === 'undefined' || !document.body) return ZERO_INSETS;
  if (!probe || !probe.isConnected) {
    probe = document.createElement('div');
    probe.setAttribute('aria-hidden', 'true');
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
    } satisfies Partial<CSSStyleDeclaration>);
    document.body.appendChild(probe);
  }
  const cs = getComputedStyle(probe);
  const parse = (value: string): number => {
    const n = parseFloat(value);
    return Number.isFinite(n) ? n : 0;
  };
  insetCache = {
    top: parse(cs.top),
    right: parse(cs.right),
    bottom: parse(cs.bottom),
    left: parse(cs.left),
  };
  return insetCache;
}

/** Visible viewport. `position: fixed` tracks this once offset is applied. */
export function viewportFrame(): ViewportFrame {
  const vv = typeof visualViewport !== 'undefined' ? visualViewport : null;
  if (vv) {
    return { left: vv.offsetLeft, top: vv.offsetTop, width: vv.width, height: vv.height };
  }
  if (typeof window === 'undefined') return { left: 0, top: 0, width: 0, height: 0 };
  return { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
}

export function clampToViewport(
  left: number,
  top: number,
  elW: number,
  elH: number,
): { left: number; top: number } {
  const frame = viewportFrame();
  const insets = readSafeAreaInsets();
  const minL = frame.left + Math.max(0, insets.left);
  const minT = frame.top + Math.max(0, insets.top);
  const maxL = Math.max(minL, frame.left + frame.width - elW - Math.max(0, insets.right));
  const maxT = Math.max(minT, frame.top + frame.height - elH - Math.max(0, insets.bottom));
  return {
    left: Math.min(Math.max(minL, left), maxL),
    top: Math.min(Math.max(minT, top), maxT),
  };
}

export function bottomRightAnchor(elW: number, elH: number): { left: number; top: number } {
  const frame = viewportFrame();
  const insets = readSafeAreaInsets();
  const padR = Math.max(EDGE_MARGIN, insets.right + SAFE_AREA_PAD);
  const padB = Math.max(EDGE_MARGIN, insets.bottom + SAFE_AREA_PAD);
  return clampToViewport(frame.left + frame.width - elW - padR, frame.top + frame.height - elH - padB, elW, elH);
}

/**
 * Map a dragged point onto a new viewport. `vw` / `vh` are the frame the
 * point was saved in, so a mascot parked at 30% stays at 30% after resize
 * and across sessions. Same frame in, same pixels out.
 */
export function scaleSavedPosition(
  saved: SavedPosition,
  width: number,
  height: number,
): { left: number; top: number } {
  const left = saved.vw > 0 ? (saved.left / saved.vw) * width : saved.left;
  const top = saved.vh > 0 ? (saved.top / saved.vh) * height : saved.top;
  return { left, top };
}
