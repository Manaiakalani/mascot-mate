import { chromium } from '@playwright/test';
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 800, height: 600 }, reducedMotion: 'no-preference' });
const p = await ctx.newPage();
await p.goto('http://127.0.0.1:5174/', { waitUntil: 'networkidle' });
await p.waitForTimeout(800);
await p.evaluate(() => window.Mascot.switchTo('bob'));
await p.waitForTimeout(2200);
// Close bubble
await p.evaluate(() => {
  for (const host of document.body.children) {
    const sr = host.shadowRoot; if (!sr) continue;
    for (const btn of sr.querySelectorAll('button')) if ((btn.textContent||'').trim() === '×') { btn.click(); return; }
  }
});
await p.waitForTimeout(300);
const result = await p.evaluate(async () => {
  const root = [...document.body.children].find(el => el.style?.position === 'fixed' && el.querySelector?.('div[style*="background-image"]'));
  const sprite = root.querySelector('div[style*="background-image"]');
  let changes = 0;
  const obs = new MutationObserver((muts) => { for (const m of muts) if (m.attributeName === 'style') changes++; });
  obs.observe(sprite, { attributes: true });
  await new Promise((r) => setTimeout(r, 20_000));
  obs.disconnect();
  return { changes };
});
const ok = result.changes >= 4;
console.log(ok ? `✅ Bob idle fires (${result.changes} bg changes in 20s)` : `❌ No idle (${result.changes})`);
await b.close();
process.exit(ok ? 0 : 1);
