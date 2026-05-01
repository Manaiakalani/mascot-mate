/**
 * CLI: validate a mascot folder against the manifest schema and print a
 * summary of all animations. Usage:
 *   tsx scripts/validate-mascot.ts <path-to-mascot-folder>
 *
 * The folder must contain map.json and a sprite sheet (map.png by default).
 */
import { readFileSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { validateMap } from '../src/registry.js';
import type { MascotMap } from '../src/types.js';

const arg = process.argv[2];
if (!arg) {
  console.error('Usage: tsx scripts/validate-mascot.ts <folder>');
  process.exit(1);
}

const mapPath = join(arg, 'map.json');
const sheetPath = join(arg, 'map.png');

if (!existsSync(mapPath)) {
  console.error(`Missing ${mapPath}`);
  process.exit(2);
}
if (!existsSync(sheetPath)) {
  console.warn(`Warning: ${sheetPath} not found (will fail at runtime).`);
}

const map = JSON.parse(readFileSync(mapPath, 'utf8')) as MascotMap;
try {
  validateMap(map, basename(arg));
} catch (e) {
  console.error('VALIDATION FAILED:', (e as Error).message);
  process.exit(3);
}

const [w, h] = map.framesize;
console.log(`✓ ${basename(arg)}: ${w}x${h}, overlays=${map.overlayCount}`);
console.log(`  Animations (${Object.keys(map.animations).length}):`);
for (const [name, anim] of Object.entries(map.animations)) {
  const totalMs = anim.frames.reduce((s, f) => s + f.duration, 0);
  console.log(`    - ${name}: ${anim.frames.length} frames, ~${totalMs}ms`);
}
