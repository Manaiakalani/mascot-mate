import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';
mkdirSync('test-results/size', { recursive: true });
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 600, height: 400 }, deviceScaleFactor: 2 });
const p = await ctx.newPage();
await p.goto('http://127.0.0.1:5174/', { waitUntil: 'networkidle' });
await p.waitForTimeout(1500);

async function measure(label) {
  await p.waitForTimeout(700);
  const dims = await p.evaluate(() => {
    const root = [...document.body.children].find(el =>
      el.style?.position === 'fixed' && el.querySelector?.('div[style*="background-image"]')
    );
    if (!root) return null;
    const r = root.getBoundingClientRect();
    return { w: r.width, h: r.height, top: r.top, left: r.left };
  });
  console.log(label, JSON.stringify(dims));
  // crop a screenshot around the mascot
  if (dims) {
    await p.screenshot({
      path: `test-results/size/${label}.png`,
      clip: {
        x: Math.max(0, dims.left - 20),
        y: Math.max(0, dims.top - 50),
        width: dims.w + 40,
        height: dims.h + 70,
      },
    });
  }
}

await measure('clippy');
await p.evaluate(() => window.Mascot.switchTo('ninjacat'));
await p.waitForTimeout(2200);
await measure('ninjacat');
await b.close();
