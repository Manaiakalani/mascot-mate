import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';
mkdirSync('test-results/pill', { recursive: true });
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 600, height: 480 }, deviceScaleFactor: 2 });
const p = await ctx.newPage();
await p.goto('http://127.0.0.1:5174/', { waitUntil: 'networkidle' });
await p.waitForTimeout(1500);

async function closeBubble() {
  await p.evaluate(() => {
    for (const host of document.body.children) {
      const closeBtn = host.shadowRoot?.querySelector('.close, [aria-label="Close" i], button[title*="close" i]');
      if (closeBtn) { closeBtn.click(); return; }
    }
    // Fallback: find any "×" looking button in shadow roots
    for (const host of document.body.children) {
      const btns = host.shadowRoot?.querySelectorAll('button') ?? [];
      for (const b of btns) {
        if (b.textContent?.trim() === '×' || b.textContent?.trim() === '✕') { b.click(); return; }
      }
    }
  });
}

async function pillCrop(name) {
  await p.waitForTimeout(800);
  const box = await p.evaluate(() => {
    for (const host of document.body.children) {
      const pill = host.shadowRoot?.querySelector('.pill:not(.hidden)');
      if (pill) {
        const r = pill.getBoundingClientRect();
        return { x: Math.max(0, r.left - 24), y: Math.max(0, r.top - 24), w: r.width + 48, h: r.height + 48 };
      }
    }
    return null;
  });
  if (!box) { console.log('no pill found for', name); return; }
  await p.screenshot({ path: `test-results/pill/${name}-zoom.png`, clip: { x: box.x, y: box.y, width: box.w, height: box.h } });
  await p.screenshot({ path: `test-results/pill/${name}-full.png` });
}

await closeBubble();
await pillCrop('clippy');

await p.evaluate(() => window.Mascot.switchTo('ninjacat'));
await p.waitForTimeout(2000);
await closeBubble();
await pillCrop('ninjacat');

await b.close();
console.log('done');
