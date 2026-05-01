import { chromium } from '@playwright/test';
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 900, height: 600 } });
const page = await ctx.newPage();
await page.goto('http://127.0.0.1:5174/', { waitUntil: 'networkidle' });
await page.waitForFunction(() => window.Mascot != null);
await page.waitForTimeout(800);
async function bubbleText() {
  return page.evaluate(() => {
    for (const h of document.querySelectorAll('div')) {
      const sr = h.shadowRoot; if (!sr) continue;
      const t = sr.querySelector('.text');
      if (t) return t.textContent;
    }
    return null;
  });
}
console.log('clippy bubble:', JSON.stringify(await bubbleText()));
await page.evaluate(() => window.Mascot.switchTo('ninjacat'));
await page.waitForTimeout(1500);
console.log('ninjacat bubble:', JSON.stringify(await bubbleText()));
await b.close();
