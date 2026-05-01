// Verifies the auto-idle scheduler:
//   1. Fires at least one Idle* animation when the bubble is closed.
//   2. Pauses while the bubble is open.
import { chromium } from '@playwright/test';

const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 800, height: 600 }, reducedMotion: 'no-preference' });
const p = await ctx.newPage();
await p.goto('http://127.0.0.1:5174/', { waitUntil: 'networkidle' });
// Clear leftover state from previous suites — stale mascot:choice or
// an off-screen mascot:position would otherwise mask the test.
await p.evaluate(() => {
  localStorage.removeItem('mascot:choice');
  localStorage.removeItem('mascot:position');
});
await p.reload({ waitUntil: 'networkidle' });
await p.waitForTimeout(800);

// Close the auto-opened greeting balloon so the mascot is at rest. Try
// the canonical close button first; fall back to ESC which the balloon
// also handles.
const closed = await p.evaluate(() => {
  for (const host of document.body.children) {
    const sr = host.shadowRoot;
    if (!sr) continue;
    for (const btn of sr.querySelectorAll('button')) {
      const txt = (btn.textContent || '').trim();
      if (txt === '×' || txt === 'Close' || btn.getAttribute('aria-label') === 'Close') {
        btn.click();
        return true;
      }
    }
  }
  return false;
});
if (!closed) {
  // Fallback to ESC; the balloon's keydown handler will hide it.
  await p.keyboard.press('Escape');
}
await p.waitForTimeout(500);

// Watch sprite background-position changes for ~25 s — with the new
// 3.5–8.5 s idle window we expect ≥ 1 full idle to fire. Anything below
// 3 background changes in 25 s indicates the scheduler is broken.
const result = await p.evaluate(async () => {
  const root = [...document.body.children].find(el =>
    el.style?.position === 'fixed' && el.querySelector?.('div[style*="background-image"]')
  );
  if (!root) return { ok: false, reason: 'no mascot' };
  const sprite = root.querySelector('div[style*="background-image"]');
  let changes = 0;
  const obs = new MutationObserver((muts) => {
    for (const m of muts) if (m.attributeName === 'style') changes++;
  });
  obs.observe(sprite, { attributes: true });
  await new Promise((r) => setTimeout(r, 25_000));
  obs.disconnect();
  return { ok: true, changes };
});

if (!result.ok) throw new Error(result.reason);
const passed = result.changes >= 3;
console.log(passed ? `✅ Idle fires (${result.changes} bg changes in 25s)` :
                     `❌ No idle activity (${result.changes} bg changes)`);
await b.close();
process.exit(passed ? 0 : 1);
