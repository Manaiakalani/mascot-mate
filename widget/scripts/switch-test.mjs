import { chromium } from '@playwright/test';
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 900, height: 600 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();
await page.goto('http://127.0.0.1:5174/', { waitUntil: 'networkidle' });
await page.waitForFunction(() => window.Mascot != null);
await page.waitForTimeout(500);

// close any auto bubble
await page.evaluate(() => {
  for (const h of document.querySelectorAll('div')) {
    const sr = h.shadowRoot; if (!sr) continue;
    const c = sr.querySelector('.close'); if (c) c.click();
  }
});
await page.waitForTimeout(300);

async function checkPill(label) {
  const info = await page.evaluate(() => {
    const hosts = Array.from(document.querySelectorAll('div')).filter(d => d.shadowRoot);
    for (const h of hosts) {
      const pill = h.shadowRoot.querySelector('.pill');
      if (pill && !pill.classList.contains('hidden')) {
        const r = pill.getBoundingClientRect();
        // hit test the center
        const top = document.elementFromPoint(r.x + r.width/2, r.y + r.height/2);
        return { x: r.x, y: r.y, w: r.width, h: r.height, hitOk: top === h || h.contains(top) || top?.getRootNode?.() === h.shadowRoot };
      }
    }
    return null;
  });
  console.log(label, info);
}

await checkPill('clippy:');
await page.evaluate(() => window.Mascot.switchTo('ninjacat'));
await page.waitForTimeout(1200);
// close auto-bubble after switch
await page.evaluate(() => {
  for (const h of document.querySelectorAll('div')) {
    const sr = h.shadowRoot; if (!sr) continue;
    const c = sr.querySelector('.close'); if (c) c.click();
  }
});
await page.waitForTimeout(400);
await checkPill('ninjacat:');

// switch back
await page.evaluate(() => window.Mascot.switchTo('clippy'));
await page.waitForTimeout(1200);
await page.evaluate(() => {
  for (const h of document.querySelectorAll('div')) {
    const sr = h.shadowRoot; if (!sr) continue;
    const c = sr.querySelector('.close'); if (c) c.click();
  }
});
await page.waitForTimeout(400);
await checkPill('back to clippy:');

await b.close();
