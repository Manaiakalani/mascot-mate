import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';
mkdirSync('test-results/swap', { recursive: true });
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 600, height: 400 }, deviceScaleFactor: 2 });
const p = await ctx.newPage();
await p.goto('http://127.0.0.1:5174/', { waitUntil: 'networkidle' });
await p.waitForTimeout(1500);

async function closeBubble() {
  await p.evaluate(() => {
    for (const host of document.body.children) {
      const btns = host.shadowRoot?.querySelectorAll('button') ?? [];
      for (const b of btns) {
        const t = (b.textContent || '').trim();
        if (t === '×' || t === '✕') { b.click(); return; }
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
        return { x: Math.max(0, r.left - 24), y: Math.max(0, r.top - 24), w: r.width + 48, h: r.height + 48, swap: !!pill.querySelector('.swap'), tooltip: pill.querySelector('.swap')?.title };
      }
    }
    return null;
  });
  console.log(name, JSON.stringify(box));
  if (box) {
    await p.screenshot({ path: `test-results/swap/${name}.png`, clip: { x: box.x, y: box.y, width: box.w, height: box.h } });
  }
}

async function clickSwap() {
  await p.evaluate(() => {
    for (const host of document.body.children) {
      const swap = host.shadowRoot?.querySelector('.swap');
      if (swap) { swap.click(); return; }
    }
  });
}

await closeBubble();
await pillCrop('1-clippy-initial');

// Click the swap glyph
await clickSwap();
await p.waitForTimeout(2200);
await closeBubble();
await pillCrop('2-after-swap');

// Click swap again to go back
await clickSwap();
await p.waitForTimeout(2200);
await closeBubble();
await pillCrop('3-back-to-clippy');

// Now click the "Ask me!" zone — should open bubble (no swap)
await p.evaluate(() => {
  for (const host of document.body.children) {
    const ask = host.shadowRoot?.querySelector('.ask');
    if (ask) { ask.click(); return; }
  }
});
await p.waitForTimeout(800);
const isOpen = await p.evaluate(() => {
  for (const host of document.body.children) {
    const inp = host.shadowRoot?.querySelector('input, textarea');
    if (inp) return true;
  }
  return false;
});
console.log('ask-zone opens bubble?', isOpen);

await b.close();
