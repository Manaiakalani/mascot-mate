// Playwright fit-and-finish snapshots: load the demo, capture each mascot
// in idle + with the ask bubble open + a couple of fun animations, then
// also do a side-by-side composite with rulers so we can visually compare
// rendered sizes.
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const URL = process.env.DEMO_URL ?? 'http://127.0.0.1:5174/';
const OUT = resolve('test-results/visual');
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: 900, height: 600 },
  deviceScaleFactor: 2,
});
const page = await ctx.newPage();

page.on('console', (m) => console.log('[browser]', m.type(), m.text()));

await page.goto(URL, { waitUntil: 'networkidle' });
// Give the widget a moment to mount + auto-greeting to start
await page.waitForFunction(() => window.Mascot != null, { timeout: 10_000 });
await page.waitForTimeout(800);

async function shoot(name) {
  const file = `${OUT}/${name}.png`;
  await page.screenshot({ path: file, fullPage: false });
  console.log('saved', file);
}

async function rect(selector) {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  }, selector);
}

async function closeBubble() {
  await page.evaluate(() => {
    // The bubble lives in a shadow DOM hosted on a top-level div.
    for (const host of document.querySelectorAll('div')) {
      const sr = host.shadowRoot;
      if (!sr) continue;
      const btn = sr.querySelector('.close');
      if (btn) btn.click();
    }
  });
  await page.waitForTimeout(300);
}

// Close the auto-opened bubble so the first shots are clean
await closeBubble();

// 1) Clippy idle
await shoot('01-clippy-idle');
const clippyBox = await rect('.mascot-agent');
console.log('clippy box:', clippyBox);

// 2) Clippy with bubble open
await page.keyboard.press('/');
await page.waitForTimeout(500);
await shoot('02-clippy-bubble');

// 3) Switch to ninjacat
await page.evaluate(() => window.Mascot.switchTo('ninjacat'));
await page.waitForTimeout(800);
// hide any auto-opened bubble
await closeBubble();
await page.waitForTimeout(300);
await shoot('03-ninjacat-idle');
const ncBox = await rect('.mascot-agent');
console.log('ninjacat box:', ncBox);

// 4) Ninjacat fun animations - click a few times
for (let i = 1; i <= 4; i++) {
  await page.locator('.mascot-agent').click();
  await page.waitForTimeout(700);
  await shoot(`04-ninjacat-anim-${i}`);
}

// 5) Ninjacat with bubble open
await page.keyboard.press('/');
await page.waitForTimeout(500);
await shoot('05-ninjacat-bubble');

console.log('\n=== SIZE COMPARISON ===');
console.log(`Clippy   rendered: ${clippyBox.w} x ${clippyBox.h} (CSS px)`);
console.log(`Ninjacat rendered: ${ncBox.w} x ${ncBox.h} (CSS px)`);
console.log(`Height ratio: ${(ncBox.h / clippyBox.h).toFixed(2)}x`);

await browser.close();
console.log('\nScreenshots in', OUT);
