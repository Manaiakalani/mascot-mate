import type { MascotManifest, MascotMap } from './types.js';

export interface MascotSource {
  id: string;
  name: string;
  /** URL or path to map.json (or inline map). */
  map: string | MascotMap;
  /** URL or path to the sprite sheet PNG. */
  spritesheet: string;
  greeting?: string;
  goodbye?: string;
  thinking?: string;
  speaking?: string;
  idle?: string[];
}

const REGISTRY = new Map<string, MascotSource>();

export function registerMascot(src: MascotSource): void {
  REGISTRY.set(src.id, src);
}

export function listMascots(): string[] {
  return [...REGISTRY.keys()];
}

/** Best-effort display name for a registered mascot, falling back to id. */
export function getMascotName(id: string): string {
  const src = REGISTRY.get(id);
  if (!src) return id;
  if (typeof src.map !== 'string' && src.map.displayName) return src.map.displayName;
  return src.name;
}

/** Best-effort theme glyph for a registered mascot. Available synchronously
 *  when the map was registered inline (the build-time glob does this). */
export function getMascotGlyph(id: string): string | undefined {
  const src = REGISTRY.get(id);
  if (!src) return undefined;
  if (typeof src.map !== 'string') return src.map.theme?.glyph;
  return undefined;
}

export async function loadMascot(id: string): Promise<MascotManifest> {
  const src = REGISTRY.get(id);
  if (!src) throw new Error(`Unknown mascot "${id}". Registered: ${[...REGISTRY.keys()].join(', ')}`);
  const map: MascotMap =
    typeof src.map === 'string' ? await fetchJson<MascotMap>(src.map) : src.map;
  validateMap(map, id);
  return {
    id: src.id,
    name: map.displayName ?? src.name,
    spritesheetUrl: src.spritesheet,
    map,
    greeting: src.greeting ?? pickFirst(map, ['Greeting', 'Wave', 'Show']),
    goodbye: src.goodbye ?? pickFirst(map, ['GoodBye', 'Goodbye', 'Hide']),
    thinking: src.thinking ?? pickFirst(map, ['Thinking', 'Processing', 'GetAttention']),
    speaking: src.speaking ?? pickFirst(map, ['Explain', 'Greet', 'Pleased']),
    idle: src.idle ?? pickIdles(map),
    funAnimations: pickFun(map),
    greetingText: map.greetingText,
    theme: map.theme,
  };
}

async function fetchJson<T>(url: string): Promise<T> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Failed to load ${url}: HTTP ${r.status}`);
  return (await r.json()) as T;
}

function pickFirst(map: MascotMap, names: string[]): string | undefined {
  return names.find((n) => map.animations[n]);
}

function pickIdles(map: MascotMap): string[] {
  return Object.keys(map.animations).filter((n) => /^Idle/.test(n));
}

/**
 * Curated list of fun animations the widget cycles through on each click of
 * the mascot. Excludes system-controlled animations (Greeting/GoodBye/Hide/
 * Show/Thinking/Explain are reserved for show/hide/ask/streaming) and the
 * Idle* set (those run automatically during quiet moments). The result is
 * shuffled deterministically per session so each mascot feels different.
 */
function pickFun(map: MascotMap): string[] {
  const reserved = new Set([
    'Greeting',
    'GoodBye',
    'Goodbye',
    'Hide',
    'Show',
    'Thinking',
    'Explain',
    'RestPose',
  ]);
  const list = Object.keys(map.animations).filter(
    (n) => !reserved.has(n) && !/^Idle/.test(n),
  );
  // Shuffle deterministically using a simple xorshift seed off the name set so
  // the cycle isn't alphabetical but is stable within a session.
  let seed = list.length;
  for (const n of list) for (let i = 0; i < n.length; i++) seed = (seed * 31 + n.charCodeAt(i)) | 0;
  for (let i = list.length - 1; i > 0; i--) {
    seed = (seed * 1103515245 + 12345) | 0;
    const j = Math.abs(seed) % (i + 1);
    [list[i], list[j]] = [list[j]!, list[i]!];
  }
  return list;
}

export function validateMap(map: MascotMap, id: string): void {
  if (!Array.isArray(map.framesize) || map.framesize.length !== 2) {
    throw new Error(`[${id}] map.framesize must be [w, h]`);
  }
  if (typeof map.overlayCount !== 'number' || map.overlayCount < 1) {
    throw new Error(`[${id}] map.overlayCount must be >= 1`);
  }
  if (!map.animations || typeof map.animations !== 'object') {
    throw new Error(`[${id}] map.animations missing`);
  }
  for (const [name, anim] of Object.entries(map.animations)) {
    if (!Array.isArray(anim.frames) || !anim.frames.length) {
      throw new Error(`[${id}] animation "${name}" has no frames`);
    }
    for (let i = 0; i < anim.frames.length; i++) {
      const f = anim.frames[i]!;
      if (typeof f.duration !== 'number') {
        throw new Error(`[${id}] "${name}" frame ${i} missing duration`);
      }
    }
  }
}
