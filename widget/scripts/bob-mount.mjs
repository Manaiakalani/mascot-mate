import { chromium } from '@playwright/test';
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 });
const p = await ctx.newPage();
const errs = [];
p.on('pageerror', (e) => errs.push('PAGE: ' + e.message));
p.on('console', (m) => { if (m.type() === 'error') errs.push('CON: ' + m.text()); });
await p.goto('http://127.0.0.1:5174/', { waitUntil: 'networkidle' });
await p.waitForTimeout(1500);
// Switch to bob via the public API (demo passes mascot:'clippy' explicitly)
await p.evaluate(() => window.Mascot.switchTo('bob'));
await p.waitForTimeout(2200);
// Close bubble
await p.evaluate(() => {
  for (const host of document.body.children) {
    const sr = host.shadowRoot; if (!sr) continue;
    for (const btn of sr.querySelectorAll('button')) if ((btn.textContent||'').trim() === '×') { btn.click(); return; }
  }
});
await p.waitForTimeout(500);
await p.screenshot({ path: 'test-results/bob-mounted.png' });
const dims = await p.evaluate(() => {
  const root = [...document.body.children].find(el => el.style?.position === 'fixed' && el.querySelector?.('div[style*="background-image"]'));
  const r = root.getBoundingClientRect();
  return { w: r.width, h: r.height };
});
console.log('bob mounted:', dims, 'errors:', errs.length);
if (errs.length) console.log(errs);

// 3-mascot full cycle test for console errors
await p.evaluate(() => localStorage.setItem('mascot:choice', 'clippy'));
await p.reload({ waitUntil: 'networkidle' });
await p.waitForTimeout(1500);
const cycleErrs = [];
p.on('pageerror', (e) => cycleErrs.push('PAGE: ' + e.message));
p.on('console', (m) => { if (m.type() === 'error') cycleErrs.push('CON: ' + m.text()); });
async function clickSwap() {
  await p.evaluate(() => {
    for (const host of document.body.children) {
      const el = host.shadowRoot?.querySelector('.swap');
      if (el) { el.click(); return; }
    }
  });
  await p.waitForTimeout(2400);
}
await clickSwap(); await clickSwap(); await clickSwap(); // back to clippy
console.log('cycle errors:', cycleErrs.length);
if (cycleErrs.length) console.log(cycleErrs);
await b.close();
process.exit(errs.length === 0 && cycleErrs.length === 0 ? 0 : 1);
