// A11y Playwright check.
// 1. Keyboard-only flow: focus mascot → activate with Enter → bubble opens
//    → Tab cycles within bubble → Escape closes → focus returns to pill.
// 2. axe-core scan of the page (includes shadow DOM): no critical violations.
// 3. prefers-reduced-motion: greeting/goodbye/swap anims are skipped.

import { chromium } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const URL_ARG = process.argv[2] || 'http://127.0.0.1:5174/';
const here = dirname(fileURLToPath(import.meta.url));
const AXE = readFileSync(resolve(here, '../../node_modules/axe-core/axe.min.js'), 'utf8');

const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1280, height: 800 } });
const p = await ctx.newPage();
const issues = [];
p.on('pageerror', (e) => issues.push('PAGE ERR: ' + e.message));
p.on('console', (m) => { if (m.type() === 'error') issues.push('CONSOLE ERR: ' + m.text()); });

const checks = [];
function check(name, ok, detail = '') {
  checks.push({ name, ok, detail });
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`);
}

await p.goto(URL_ARG, { waitUntil: 'networkidle' });
await p.evaluate(() => {
  localStorage.removeItem('mascot:position');
  localStorage.removeItem('mascot:choice');
});
await p.reload({ waitUntil: 'networkidle' });
await p.waitForTimeout(1000);

// Close auto-greeting bubble so we start from pill state.
await p.evaluate(() => {
  for (const host of document.body.children) {
    const btns = host.shadowRoot?.querySelectorAll('button') ?? [];
    for (const btn of btns) {
      if ((btn.textContent || '').trim() === '×') { btn.click(); return; }
    }
  }
});
await p.waitForTimeout(300);

// --- Mascot root attributes ---
const rootAttrs = await p.evaluate(() => {
  const el = document.querySelector('.mascot-agent');
  if (!el) return null;
  return {
    role: el.getAttribute('role'),
    label: el.getAttribute('aria-label'),
    tabindex: el.getAttribute('tabindex'),
    overlayHidden: Array.from(el.children).every((c) => c.getAttribute('aria-hidden') === 'true'),
  };
});
check('Mascot root has role=button', rootAttrs?.role === 'button');
check('Mascot root has aria-label', !!rootAttrs?.label, rootAttrs?.label);
check('Mascot root is focusable (tabindex=0)', rootAttrs?.tabindex === '0');
check('Mascot inner overlays are aria-hidden', rootAttrs?.overlayHidden === true);

// --- Keyboard activation: focus mascot, press Enter → bubble opens ---
await p.evaluate(() => {
  const el = document.querySelector('.mascot-agent');
  el?.focus();
});
await p.keyboard.press('Enter');
await p.waitForTimeout(300);
const bubbleAfterEnter = await p.evaluate(() => {
  for (const host of document.body.children) {
    const el = host.shadowRoot?.querySelector('.balloon');
    if (el && getComputedStyle(el).display !== 'none') {
      return {
        role: el.getAttribute('role'),
        label: el.getAttribute('aria-label'),
        focusedTag: host.shadowRoot.activeElement?.tagName,
      };
    }
  }
  return null;
});
check('Enter on focused mascot opens bubble', !!bubbleAfterEnter);
check('Bubble has role=dialog', bubbleAfterEnter?.role === 'dialog');
check('Bubble has aria-label', !!bubbleAfterEnter?.label);
check('Bubble auto-focuses input on open', bubbleAfterEnter?.focusedTag === 'INPUT');

// --- aria-live region present on text container ---
const textRegion = await p.evaluate(() => {
  for (const host of document.body.children) {
    const el = host.shadowRoot?.querySelector('.balloon .text');
    if (el) return { live: el.getAttribute('aria-live'), role: el.getAttribute('role') };
  }
  return null;
});
check('Streaming text has aria-live=polite', textRegion?.live === 'polite');

// --- Hidden input label ---
const labelOk = await p.evaluate(() => {
  for (const host of document.body.children) {
    const lbl = host.shadowRoot?.querySelector('label[for="mascot-ask-input"]');
    if (lbl) return !!lbl.textContent && lbl.textContent.trim().length > 0;
  }
  return false;
});
check('Input has visually-hidden label', labelOk);

// --- Tab focus trap inside bubble ---
async function focusedInBubble() {
  return await p.evaluate(() => {
    for (const host of document.body.children) {
      const r = host.shadowRoot;
      if (!r || !r.querySelector('.balloon')) continue;
      const a = r.activeElement;
      return a ? { tag: a.tagName, type: a.getAttribute('type'), cls: a.className } : null;
    }
    return null;
  });
}
// Starting on input, Tab → submit button, Tab → close, Tab → wraps to input.
const seq = [];
for (let i = 0; i < 4; i++) {
  seq.push(await focusedInBubble());
  await p.keyboard.press('Tab');
  await p.waitForTimeout(80);
}
const tagSeq = seq.map((s) => s?.tag).join(',');
check(
  'Tab cycles within bubble (input → button → button → ... wraps)',
  seq.every((s) => s !== null) && tagSeq.split(',').every((t) => t === 'INPUT' || t === 'BUTTON'),
  tagSeq,
);

// --- Escape closes bubble and returns focus to pill ask button ---
await p.keyboard.press('Escape');
await p.waitForTimeout(250);
const afterEsc = await p.evaluate(() => {
  // Walk all shadow hosts and query each independently — pill and balloon
  // live in separate hosts.
  let visible = null;
  let expanded = null;
  let focusedAsk = false;
  let pillBtn = null;
  for (const host of document.body.children) {
    const r = host.shadowRoot;
    if (!r) continue;
    const bal = r.querySelector('.balloon');
    if (bal) visible = getComputedStyle(bal).display !== 'none';
    const askEl = r.querySelector('.zone.ask');
    if (askEl) {
      pillBtn = askEl;
      expanded = askEl.getAttribute('aria-expanded');
      if (r.activeElement === askEl) focusedAsk = true;
    }
  }
  return { visible, expanded, focusedAsk, foundPill: !!pillBtn };
});
check('Escape closes bubble', afterEsc?.visible === false);
check('aria-expanded on pill returns to false', afterEsc?.expanded === 'false');
check('Focus returns to pill ask button after Escape', afterEsc?.focusedAsk === true);

// --- Pill ask button has aria-haspopup=dialog ---
const pillAttrs = await p.evaluate(() => {
  for (const host of document.body.children) {
    const el = host.shadowRoot?.querySelector('.zone.ask');
    if (el) return {
      haspopup: el.getAttribute('aria-haspopup'),
      label: el.getAttribute('aria-label'),
    };
  }
  return null;
});
check('Pill ask has aria-haspopup=dialog', pillAttrs?.haspopup === 'dialog');
check('Pill ask has aria-label', !!pillAttrs?.label, pillAttrs?.label);

// --- axe-core scan ---
await p.addScriptTag({ content: AXE });
const axeResult = await p.evaluate(async () => {
  // Scan the host page; axe traverses open shadow DOMs by default in v4+.
  // eslint-disable-next-line no-undef
  const r = await window.axe.run(document, {
    runOnly: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'],
    resultTypes: ['violations'],
  });
  return r.violations.map((v) => ({
    id: v.id,
    impact: v.impact,
    nodes: v.nodes.length,
    help: v.help,
  }));
});
const critical = axeResult.filter((v) => v.impact === 'critical' || v.impact === 'serious');
check(
  `axe-core: no critical/serious violations`,
  critical.length === 0,
  critical.map((v) => `${v.id}(${v.impact}, ${v.nodes})`).join('; '),
);
if (axeResult.length) {
  console.log('   axe findings (incl. minor/moderate):');
  for (const v of axeResult) console.log(`     - ${v.id} [${v.impact}] ${v.help} (${v.nodes} nodes)`);
}

// --- prefers-reduced-motion: greeting should NOT auto-play on swap ---
await p.emulateMedia({ reducedMotion: 'reduce' });
await p.evaluate(() => {
  localStorage.removeItem('mascot:position');
  localStorage.removeItem('mascot:choice');
});
await p.reload({ waitUntil: 'networkidle' });
await p.waitForTimeout(1200);
// Trigger a swap; observe that NO long greeting/goodbye blocks. We approximate
// by checking that a swap completes nearly immediately rather than waiting
// for the 800ms goodbye delay.
const t0 = Date.now();
await p.evaluate(async () => { await window.Mascot?.switchTo('ninjacat'); });
const dur = Date.now() - t0;
check('Reduced-motion swap returns quickly (skips goodbye delay)', dur < 600, `took ${dur}ms`);

await b.close();

console.log('\n=== Summary ===');
const failed = checks.filter((c) => !c.ok);
console.log(`${checks.length - failed.length}/${checks.length} passed`);
if (issues.length) {
  console.log('\nPage / console errors:');
  for (const i of issues) console.log('  -', i);
}
process.exit(failed.length === 0 ? 0 : 1);
