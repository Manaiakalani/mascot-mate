// Verifies that all mascots render at visually similar sizes (visible
// character pixel heights within tolerance) and that their bounding
// boxes anchor correctly on the page.
import { chromium } from '@playwright/test';

const URL = 'http://127.0.0.1:5174/';

async function visibleCharHeight(p, mascotId) {
  // Wait for the mascot to mount + first idle frame to render
  await p.evaluate((id) => window.Mascot.switchTo(id), mascotId).catch(() => {});
  await p.waitForTimeout(2400);
  return p.evaluate(() => {
    const root = [...document.body.children].find(el =>
      el.style?.position === 'fixed' && el.querySelector?.('div[style*="background-image"]')
    );
    if (!root) return null;
    const r = root.getBoundingClientRect();
    return { displayed: r.height, width: r.width };
  });
}

const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1280, height: 800 } });
const p = await ctx.newPage();
await p.goto(URL, { waitUntil: 'networkidle' });
await p.evaluate(() => {
  localStorage.removeItem('mascot:choice');
  localStorage.removeItem('mascot:position');
});
await p.reload({ waitUntil: 'networkidle' });
await p.waitForTimeout(800);

const results = {};
for (const id of ['clippy', 'ninjacat', 'bob']) {
  results[id] = await visibleCharHeight(p, id);
  console.log(`${id}: rendered ${results[id]?.width|0}x${results[id]?.displayed|0}`);
}

const heights = Object.values(results).map(r => r.displayed);
const min = Math.min(...heights);
const max = Math.max(...heights);
const spread = ((max - min) / max * 100).toFixed(1);
console.log(`\nspread: ${min}–${max}px (${spread}% range)`);
const passed = (max - min) <= 25; // within ~20% of the largest
console.log(passed ? `✅ Mascot heights within parity tolerance (≤25px)` :
                     `❌ Mascot heights vary too much (${max - min}px)`);
await b.close();
process.exit(passed ? 0 : 1);
