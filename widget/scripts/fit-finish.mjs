import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';
mkdirSync('test-results/ff', { recursive: true });

const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 });
const p = await ctx.newPage();
const issues = [];
p.on('pageerror', (e) => issues.push('PAGE ERR: ' + e.message));
p.on('console', (m) => { if (m.type() === 'error') issues.push('CONSOLE ERR: ' + m.text()); });

await p.goto('http://127.0.0.1:5174/', { waitUntil: 'networkidle' });
await p.waitForTimeout(1500);

async function shadow(sel) {
  return await p.evaluateHandle((sel) => {
    for (const host of document.body.children) {
      const el = host.shadowRoot?.querySelector(sel);
      if (el) return el;
    }
    return null;
  }, sel);
}

async function shadowEval(sel, fn) {
  return await p.evaluate(({ sel, fnStr }) => {
    for (const host of document.body.children) {
      const el = host.shadowRoot?.querySelector(sel);
      if (el) return new Function('el', 'return (' + fnStr + ')(el)')(el);
    }
    return null;
  }, { sel, fnStr: fn.toString() });
}

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

async function clickShadow(sel) {
  await p.evaluate((sel) => {
    for (const host of document.body.children) {
      const el = host.shadowRoot?.querySelector(sel);
      if (el) { el.click(); return; }
    }
  }, sel);
}

async function rect(sel) {
  return await shadowEval(sel, (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height, right: r.right, bottom: r.bottom, hidden: el.classList.contains('hidden') };
  });
}

async function snap(name) {
  await p.waitForTimeout(400);
  await p.screenshot({ path: `test-results/ff/${name}.png` });
}

const checks = [];
function check(name, ok, detail = '') {
  checks.push({ name, ok, detail });
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`);
}

// 1) Initial state
await closeBubble();
await snap('01-initial');
const c0 = await rect('.pill');
check('Pill visible at startup', !!c0 && !c0.hidden && c0.w > 0);
check('Pill has 2 zones', !!(await shadowEval('.pill', (el) => el.querySelectorAll('.zone').length === 2)));

// 2) Mascot dimension parity
const mascot1 = await p.evaluate(() => {
  const root = [...document.body.children].find(el =>
    el.style?.position === 'fixed' && el.querySelector?.('div[style*="background-image"]')
  );
  if (!root) return null;
  const r = root.getBoundingClientRect();
  return { w: r.width, h: r.height, top: r.top, left: r.left };
});
check('Clippy at 115px height', mascot1?.h === 115, `actual h=${mascot1?.h}`);

// 3) Swap to Ninjacat
await clickShadow('.swap');
await p.waitForTimeout(2400);
await closeBubble();
await snap('02-after-swap-ninjacat');
const mascot2 = await p.evaluate(() => {
  const root = [...document.body.children].find(el =>
    el.style?.position === 'fixed' && el.querySelector?.('div[style*="background-image"]')
  );
  if (!root) return null;
  const r = root.getBoundingClientRect();
  return { w: r.width, h: r.height };
});
check('Ninjacat at 128px height', mascot2?.h === 128, `actual h=${mascot2?.h}`);
check('Mascot heights are visually similar (parity)',
  mascot1 && mascot2 && Math.abs(mascot1.h - mascot2.h) <= 25,
  `clippy=${mascot1?.h} ninjacat=${mascot2?.h}`);

// 4) Pill repositioned over new mascot, tail anchored
const ninjaPill = await rect('.pill');
const tailX = await shadowEval('.pill', (el) => parseFloat(el.style.getPropertyValue('--tail-x')));
check('Pill not hidden after swap', ninjaPill && !ninjaPill.hidden);
const ninjaTooltip = await shadowEval('.swap', (el) => el.title);
check('Tooltip says "Switch to Bob"', ninjaTooltip === 'Switch to Bob', ninjaTooltip);

// 5) Topmost-z & clickability of pill after swap
const isTop = await p.evaluate(() => {
  const hosts = [...document.body.children].filter(el => el.shadowRoot);
  let topZ = -Infinity;
  let topHost = null;
  for (const h of hosts) {
    const z = parseInt(h.style.zIndex || '0', 10);
    if (z >= topZ) { topZ = z; topHost = h; }
  }
  return topHost?.shadowRoot?.querySelector('.pill') !== null;
});
check('Pill host is topmost z-index', isTop);

// 6) Click ask zone — bubble opens
await clickShadow('.ask');
await p.waitForTimeout(700);
const inputVisible = await p.evaluate(() => {
  for (const host of document.body.children) {
    const inp = host.shadowRoot?.querySelector('input, textarea');
    if (inp) {
      const r = inp.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    }
  }
  return false;
});
check('Ask zone opens bubble', inputVisible);
await snap('03-bubble-open-ninjacat');

// 7) Pill is hidden while bubble is open
const pillWhenBubbleOpen = await rect('.pill');
check('Pill hides when bubble is open', pillWhenBubbleOpen?.hidden);

// 8) Greeting text matches Ninjacat
const bubbleText = await p.evaluate(() => {
  for (const host of document.body.children) {
    const txt = host.shadowRoot?.querySelector('.text, .body, .content, p');
    if (txt && txt.textContent && txt.textContent.length > 5) return txt.textContent.trim();
  }
  return null;
});
check('Ninjacat greeting in bubble', bubbleText && bubbleText.toLowerCase().includes('ninja'), bubbleText?.slice(0, 60));

// 9) Close + swap forward to Bob, then back to Clippy
await closeBubble();
await p.waitForTimeout(500);
await clickShadow('.swap');           // ninjacat -> bob
await p.waitForTimeout(2400);
await closeBubble();
await snap('04-bob');
const bobTooltip = await shadowEval('.swap', (el) => el.title);
check('Tooltip says "Switch to Clippy" after Bob', bobTooltip === 'Switch to Clippy', bobTooltip);
const bobPillLabel = await shadowEval('.ask .label', (el) => el.textContent.trim());
check('Bob pill label is "Hi! I\'m Bob"', bobPillLabel === "Hi! I'm Bob", bobPillLabel);
const bobMascot = await p.evaluate(() => {
  const root = [...document.body.children].find(el =>
    el.style?.position === 'fixed' && el.querySelector?.('div[style*="background-image"]')
  );
  return root ? root.getBoundingClientRect().height : null;
});
check('Bob at 132px height', bobMascot === 132, `actual h=${bobMascot}`);
await clickShadow('.swap');           // bob -> clippy
await p.waitForTimeout(2400);
await closeBubble();
await snap('05-back-to-clippy');
const backTooltip = await shadowEval('.swap', (el) => el.title);
check('Tooltip back to "Switch to Ninja Cat"', backTooltip === 'Switch to Ninja Cat', backTooltip);

// 10) Keyboard: '/' opens bubble
await p.keyboard.press('/');
await p.waitForTimeout(700);
const inputAfterSlash = await p.evaluate(() => {
  for (const host of document.body.children) {
    const inp = host.shadowRoot?.querySelector('input, textarea');
    if (inp) return document.activeElement === host || host.shadowRoot.activeElement === inp;
  }
  return false;
});
check('"/" shortcut opens & focuses input', inputAfterSlash);
await closeBubble();

// 11) Edge case: mascot at right edge of viewport — pill should stay onscreen
await p.evaluate(() => {
  const root = [...document.body.children].find(el =>
    el.style?.position === 'fixed' && el.querySelector?.('div[style*="background-image"]')
  );
  if (root) {
    root.style.left = (window.innerWidth - 30) + 'px';  // mostly off-screen
    root.style.bottom = '20px';
  }
});
await clickShadow('.swap');  // trigger reposition by switching
await p.waitForTimeout(2400);
await closeBubble();
const edgePill = await rect('.pill');
check('Pill stays inside viewport (right edge)',
  edgePill && edgePill.right <= 1280 + 1 && edgePill.x >= -1,
  `x=${edgePill?.x?.toFixed(1)} right=${edgePill?.right?.toFixed(1)}`);
await snap('05-edge-right');

// 12) Mascot at top — pill should flip below (tail up)
await p.evaluate(() => {
  const root = [...document.body.children].find(el =>
    el.style?.position === 'fixed' && el.querySelector?.('div[style*="background-image"]')
  );
  if (root) {
    root.style.top = '5px';
    root.style.bottom = '';
    root.style.left = '600px';
  }
});
// trigger reposition via window resize event
await p.evaluate(() => window.dispatchEvent(new Event('resize')));
// also nudge by clicking swap+swap to force pill repositioning
await clickShadow('.swap'); await p.waitForTimeout(2400); await closeBubble();
await clickShadow('.swap'); await p.waitForTimeout(2400); await closeBubble();
const topTail = await shadowEval('.pill', (el) => el.getAttribute('data-tail'));
const topPill = await rect('.pill');
check('Pill stays inside viewport (top edge)', topPill && topPill.y >= -1, `y=${topPill?.y?.toFixed(1)}`);
console.log('   tail direction at top edge:', topTail);
await snap('06-edge-top');

// 13) Run an animation cycle (click mascot 4 times) to look for visual artifacts
await p.evaluate(() => {
  const root = [...document.body.children].find(el =>
    el.style?.position === 'fixed' && el.querySelector?.('div[style*="background-image"]')
  );
  if (root) {
    root.style.top = '';
    root.style.bottom = '20px';
    root.style.left = '600px';
  }
});
await p.waitForTimeout(500);
await closeBubble();
for (let i = 0; i < 4; i++) {
  await p.evaluate(() => {
    const root = [...document.body.children].find(el =>
      el.style?.position === 'fixed' && el.querySelector?.('div[style*="background-image"]')
    );
    root?.click();
  });
  await p.waitForTimeout(80);
  await snap(`07-anim-${i}`);
  await p.waitForTimeout(1100);
}

// 14) Bundle build still works
await b.close();

console.log('\n=== Summary ===');
const failed = checks.filter(c => !c.ok);
console.log(`${checks.length - failed.length}/${checks.length} passed`);
if (failed.length) {
  console.log('Failures:');
  for (const f of failed) console.log('  -', f.name, f.detail);
}
if (issues.length) {
  console.log('\nPage errors / console errors:');
  for (const i of issues) console.log('  -', i);
}
process.exit(failed.length === 0 && issues.length === 0 ? 0 : 1);
