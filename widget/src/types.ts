export interface Frame {
  duration: number;
  images?: Array<[number, number]>;
  exitBranch?: number;
  branching?: { branches: Array<{ frameIndex: number; weight: number }> };
  sound?: string;
}

export interface Animation {
  frames: Frame[];
}

export interface MascotTheme {
  /** Primary accent color (CSS), used for the pill border + glyph + keycap tint. */
  accent?: string;
  /** Readable text color on `accent` (used by the keycap badge). */
  accentText?: string;
  /** A short glyph (emoji or single char) shown to the left of the pill label. */
  glyph?: string;
  /** Override the pill's label text. Defaults to "Ask me!". */
  pillLabel?: string;
}

export interface MascotMap {
  framesize: [number, number];
  overlayCount: number;
  sounds?: string[];
  animations: Record<string, Animation>;
  /** Optional display name + greeting text override (used by the bubble). */
  displayName?: string;
  greetingText?: string;
  /** Optional brand theme used by the ask-me pill. */
  theme?: MascotTheme;
}

export interface MascotManifest {
  id: string;
  name: string;
  spritesheetUrl: string;
  map: MascotMap;
  /** Animation name for greetings, goodbyes, thinking, speaking. */
  greeting?: string;
  goodbye?: string;
  thinking?: string;
  speaking?: string;
  idle?: string[];
  /** Curated list cycled through on each mascot click. */
  funAnimations?: string[];
  /** Greeting text shown in the speech bubble (e.g. "Hi! I'm Clippy."). */
  greetingText?: string;
  /** Optional brand theme used by the ask-me pill. */
  theme?: MascotTheme;
}
