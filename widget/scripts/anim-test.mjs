import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';
mkdirSync('test-results/anim-new', { recursive: true });

const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 600, height: 480 }, deviceScaleFactor: 2 });
const p = await ctx.newPage();
await p.goto('http://127.0.0.1:5174/', { waitUntil: 'networkidle' });
await p.waitForTimeout(1500);

// Force ninjacat
await p.evaluate(() => window.Mascot.switchTo('ninjacat'));
await p.waitForTimeout(2200);
// Close greeting bubble
await p.evaluate(() => {
  for (const host of document.body.children) {
    const btns = host.shadowRoot?.querySelectorAll('button') ?? [];
    for (const btn of btns) {
      if ((btn.textContent||'').trim() === '×') { btn.click(); return; }
    }
  }
});
await p.waitForTimeout(500);

const anims = ['Thinking', 'DontUnderstand', 'Congratulate', 'GetAttention', 'Hide', 'Save'];
for (const a of anims) {
  await p.evaluate((name) => window.Mascot.play(name), a);
  // Capture 4 frames spread across the animation playback
  for (let i = 0; i < 4; i++) {
    await p.waitForTimeout(200);
    await p.screenshot({ path: `test-results/anim-new/${a}-f${i}.png` });
  }
  await p.waitForTimeout(800);
}
await b.close();
console.log('done');
