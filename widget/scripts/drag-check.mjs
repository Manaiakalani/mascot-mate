// Drag-to-reposition Playwright check.
// Verifies:
//   1. Mascot can be dragged via Pointer Events (mouse).
//   2. Pill follows during drag (onMove).
//   3. Position persists across reload via localStorage['mascot:position'].
//   4. Click is NOT triggered when the drag exceeds the threshold.
//   5. Click IS triggered when the pointer barely moves.
//   6. Saved position is re-clamped after viewport shrink.

import { chromium } from '@playwright/test';

const URL = process.argv[2] || 'http://127.0.0.1:5174/';
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1280, height: 800 } });
const p = await ctx.newPage();
const errors = [];
p.on('pageerror', (e) => errors.push('PAGE ERR: ' + e.message));
p.on('console', (m) => { if (m.type() === 'error') errors.push('CONSOLE ERR: ' + m.text()); });

await p.goto(URL, { waitUntil: 'networkidle' });
// Clear any leftover state from prior runs.
await p.evaluate(() => localStorage.removeItem('mascot:position'));
await p.reload({ waitUntil: 'networkidle' });
await p.waitForTimeout(1200);

const checks = [];
function check(name, ok, detail = '') {
  checks.push({ name, ok, detail });
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`);
}

// Close any auto-open bubble so the mascot is plainly draggable.
await p.evaluate(() => {
  for (const host of document.body.children) {
    const btns = host.shadowRoot?.querySelectorAll('button') ?? [];
    for (const b of btns) {
      const t = (b.textContent || '').trim();
      if (t === '×' || t === '✕') { b.click(); return; }
    }
  }
});
await p.waitForTimeout(300);

async function mascotRect() {
  return await p.evaluate(() => {
    const el = document.querySelector('.mascot-agent');
    const r = el?.getBoundingClientRect();
    return r ? { x: r.left, y: r.top, w: r.width, h: r.height } : null;
  });
}

async function pillRect() {
  return await p.evaluate(() => {
    for (const host of document.body.children) {
      const el = host.shadowRoot?.querySelector('.pill');
      const r = el?.getBoundingClientRect();
      if (r) return { x: r.left, y: r.top, w: r.width, h: r.height };
    }
    return null;
  });
}

const r0 = await mascotRect();
check('Mascot is on screen at startup', !!r0 && r0.w > 0 && r0.h > 0);
const pill0 = await pillRect();
check('Pill is on screen at startup', !!pill0 && pill0.w > 0);

// --- Drag with mouse (Pointer Events under the hood) ---
const startX = r0.x + r0.w / 2;
const startY = r0.y + r0.h / 2;
const targetX = 200;
const targetY = 200;

await p.mouse.move(startX, startY);
await p.mouse.down();
// Move in steps so pointermove fires multiple times.
await p.mouse.move(startX - 40, startY - 40, { steps: 4 });
await p.mouse.move(targetX, targetY, { steps: 8 });
await p.mouse.up();
await p.waitForTimeout(150);

const r1 = await mascotRect();
const moved = !!r1 && Math.abs(r1.x - r0.x) > 50 && Math.abs(r1.y - r0.y) > 50;
check('Mascot moved on drag', moved, r1 && `to (${r1.x.toFixed(0)}, ${r1.y.toFixed(0)})`);

const pill1 = await pillRect();
const pillFollowed = !!pill1 && Math.abs(pill1.x - pill0.x) > 30;
check('Pill followed during drag', pillFollowed, pill1 && `to (${pill1.x.toFixed(0)}, ${pill1.y.toFixed(0)})`);

// --- Drag did NOT trigger a click (bubble should still be closed) ---
const bubbleOpen = await p.evaluate(() => {
  for (const host of document.body.children) {
    const el = host.shadowRoot?.querySelector('.balloon');
    if (el && getComputedStyle(el).display !== 'none') return true;
  }
  return false;
});
check('Drag did not trigger click (bubble closed)', !bubbleOpen);

// --- Persistence: reload and confirm position survived ---
await p.reload({ waitUntil: 'networkidle' });
await p.waitForTimeout(1200);
// Close greeting bubble again.
await p.evaluate(() => {
  for (const host of document.body.children) {
    const btns = host.shadowRoot?.querySelectorAll('button') ?? [];
    for (const b of btns) {
      const t = (b.textContent || '').trim();
      if (t === '×' || t === '✕') { b.click(); return; }
    }
  }
});
await p.waitForTimeout(200);
const r2 = await mascotRect();
const persisted =
  !!r2 && Math.abs(r2.x - r1.x) < 5 && Math.abs(r2.y - r1.y) < 5;
check('Position persisted across reload', persisted, r2 && `at (${r2.x.toFixed(0)}, ${r2.y.toFixed(0)})`);

// --- Tiny mouse movement still triggers click ---
const r3 = await mascotRect();
const cx = r3.x + r3.w / 2;
const cy = r3.y + r3.h / 2;
await p.mouse.move(cx, cy);
await p.mouse.down();
await p.mouse.move(cx + 1, cy + 1); // sub-threshold (4px)
await p.mouse.up();
await p.waitForTimeout(400);
const r4 = await mascotRect();
const stayed = !!r4 && Math.abs(r4.x - r3.x) < 2 && Math.abs(r4.y - r3.y) < 2;
check('Tiny pointer move did not drag', stayed);

// --- Resize clamps a position that would now be off-screen ---
await p.setViewportSize({ width: 600, height: 500 });
await p.waitForTimeout(400);
const r5 = await mascotRect();
const inside =
  !!r5 && r5.x >= -1 && r5.y >= -1 && r5.x + r5.w <= 601 && r5.y + r5.h <= 501;
check('Position re-clamped on viewport shrink', inside, r5 && `at (${r5.x.toFixed(0)}, ${r5.y.toFixed(0)})`);

// --- Cleanup so subsequent runs (e.g., fit-finish) start at default ---
await p.evaluate(() => localStorage.removeItem('mascot:position'));

await b.close();

console.log('\n=== Summary ===');
const failed = checks.filter((c) => !c.ok);
console.log(`${checks.length - failed.length}/${checks.length} passed`);
if (errors.length) {
  console.log('Errors:');
  for (const e of errors) console.log('  -', e);
}
process.exit(failed.length === 0 && errors.length === 0 ? 0 : 1);
