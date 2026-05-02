// Mobile viewport + touch regression: verifies the widget mounts on a small
// phone-sized viewport, the pill stays inside the screen, and that touch
// drag actually moves the mascot (since pointer events are how we wire it).
import { chromium, devices } from 'playwright';

const URL = 'http://127.0.0.1:5174/';
const results = [];
const ok = (msg) => results.push(['✅', msg]);
const fail = (msg) => { results.push(['❌', msg]); process.exitCode = 1; };

const browser = await chromium.launch();
const ctx = await browser.newContext({ ...devices['iPhone 13'] });
const page = await ctx.newPage();
await page.goto(URL, { waitUntil: 'networkidle' });
await page.waitForTimeout(1200);

// Close the auto-opened greeting balloon so the pill is visible.
await page.evaluate(() => {
  for (const host of document.body.children) {
    const btns = host.shadowRoot?.querySelectorAll('button') ?? [];
    for (const b of btns) {
      const t = (b.textContent || '').trim();
      if (t === '×' || t === '✕') { b.click(); return; }
    }
  }
});
await page.waitForTimeout(300);

// Pill lives in a shadow-rooted host appended to <body>; find it the same
// way the other regression scripts do.
async function shadowRect(sel) {
  return await page.evaluate((sel) => {
    for (const host of document.body.children) {
      const el = host.shadowRoot?.querySelector(sel);
      if (el) {
        const r = el.getBoundingClientRect();
        return { x: r.left, y: r.top, w: r.width, h: r.height, right: r.right, bottom: r.bottom };
      }
    }
    return null;
  }, sel);
}

const vp = page.viewportSize();
const pillBox = await shadowRect('.pill');
if (!pillBox) fail('Pill not found in any shadow root');
else if (pillBox.x >= 0 && pillBox.right <= vp.width) ok(`Pill within viewport (${pillBox.x.toFixed(0)}–${pillBox.right.toFixed(0)} of ${vp.width})`);
else fail(`Pill overflows viewport: ${JSON.stringify(pillBox)}`);

const mascotBox = await page.locator('div.mascot-agent').first().boundingBox();
if (mascotBox && mascotBox.x + mascotBox.width <= vp.width + 1 && mascotBox.y + mascotBox.height <= vp.height + 1) {
  ok(`Mascot within viewport @ (${mascotBox.x.toFixed(0)},${mascotBox.y.toFixed(0)}) ${mascotBox.width.toFixed(0)}×${mascotBox.height.toFixed(0)}`);
} else fail(`Mascot off-screen: ${JSON.stringify(mascotBox)} vp=${JSON.stringify(vp)}`);

// Tap target sizes on the swap zone (coarse pointer media query active).
const swapBox = await shadowRect('.swap');
if (swapBox && swapBox.w >= 32 && swapBox.h >= 32) ok(`Swap tap target ${swapBox.w.toFixed(0)}×${swapBox.h.toFixed(0)} ≥ 32px`);
else fail(`Swap tap target too small: ${JSON.stringify(swapBox)}`);

// Touch drag the mascot via PointerEvent (touch type) — same path real touch uses.
const before = await page.locator('div.mascot-agent').first().boundingBox();
await page.locator('div.mascot-agent').first().evaluate((el, [dx, dy]) => {
  const r = el.getBoundingClientRect();
  const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
  const fire = (type, x, y) => el.dispatchEvent(new PointerEvent(type, {
    bubbles: true, cancelable: true, pointerId: 1, pointerType: 'touch',
    isPrimary: true, clientX: x, clientY: y, button: 0,
  }));
  fire('pointerdown', cx, cy);
  fire('pointermove', cx + dx / 3, cy + dy / 3);
  fire('pointermove', cx + dx, cy + dy);
  fire('pointerup', cx + dx, cy + dy);
}, [-80, -80]);
await page.waitForTimeout(200);
const after = await page.locator('div.mascot-agent').first().boundingBox();
if (Math.abs(after.x - before.x) > 30 || Math.abs(after.y - before.y) > 30) {
  ok(`Touch-drag moved mascot — Δ(${(after.x - before.x).toFixed(0)},${(after.y - before.y).toFixed(0)})`);
} else fail(`Touch-drag had no effect: before=${JSON.stringify(before)} after=${JSON.stringify(after)}`);

await browser.close();
console.log('\n=== Summary ===');
for (const [s, m] of results) console.log(`${s} ${m}`);
const failed = results.filter(([s]) => s === '❌').length;
console.log(`${results.length - failed}/${results.length} passed`);
