// anchor-check — proves the mascot lands at the bottom-right safe-area
// corner across viewport sizes, rotations, and resize events when the user
// has not explicitly dragged it elsewhere.
import { chromium } from 'playwright';

const URL = 'http://127.0.0.1:5174/';
const log = [];
const ok = (m, c = true, d = '') => log.push({ ok: !!c, m, d });

function getMascotRect(p) {
  return p.evaluate(() => {
    const root = [...document.body.children].find(el =>
      el.style?.position === 'fixed' && el.querySelector?.('div[style*="background-image"]')
    );
    if (!root) return null;
    const r = root.getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height,
             right: r.right, bottom: r.bottom,
             vw: window.innerWidth, vh: window.innerHeight };
  });
}

const sizes = [
  { name: 'desktop 1280x800', w: 1280, h: 800 },
  { name: 'laptop 1024x768',  w: 1024, h: 768 },
  { name: 'tablet 768x1024',  w: 768,  h: 1024 },
  { name: 'mobile 390x844',   w: 390,  h: 844 },
  { name: 'wide 1920x1080',   w: 1920, h: 1080 },
];

const browser = await chromium.launch();

for (const s of sizes) {
  const ctx = await browser.newContext({ viewport: { width: s.w, height: s.h } });
  const p = await ctx.newPage();
  await p.goto(URL, { waitUntil: 'networkidle' });
  await p.evaluate(() => {
    localStorage.removeItem('mascot:choice');
    localStorage.removeItem('mascot:position');
  });
  await p.reload({ waitUntil: 'networkidle' });
  await p.waitForTimeout(900);

  const r = await getMascotRect(p);
  if (!r) { ok(`${s.name}: mascot found`, false); await ctx.close(); continue; }

  // Mascot's right edge should be within ~64px of viewport right (24-40px margin),
  // and its bottom edge should be within ~64px of viewport bottom.
  const dx = r.vw - r.right;
  const dy = r.vh - r.bottom;
  ok(`${s.name}: anchored bottom-right`, dx >= 0 && dx <= 64 && dy >= 0 && dy <= 64,
     `dx=${dx.toFixed(0)} dy=${dy.toFixed(0)}`);

  await ctx.close();
}

// Resize / rotate test: shrink → grow → rotate; the mascot should stay
// snapped to bottom-right when the user hasn't dragged it.
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const p = await ctx.newPage();
  await p.goto(URL, { waitUntil: 'networkidle' });
  await p.evaluate(() => {
    localStorage.removeItem('mascot:choice');
    localStorage.removeItem('mascot:position');
  });
  await p.reload({ waitUntil: 'networkidle' });
  await p.waitForTimeout(800);

  for (const [w, h, name] of [
    [800, 600, 'shrink to 800x600'],
    [1600, 900, 'grow to 1600x900'],
    [600, 900, 'rotate to portrait 600x900'],
  ]) {
    await p.setViewportSize({ width: w, height: h });
    await p.waitForTimeout(400);
    const r = await getMascotRect(p);
    const dx = r.vw - r.right;
    const dy = r.vh - r.bottom;
    ok(`resize → ${name}: still bottom-right`,
       dx >= 0 && dx <= 64 && dy >= 0 && dy <= 64,
       `dx=${dx.toFixed(0)} dy=${dy.toFixed(0)} vw=${r.vw} vh=${r.vh}`);
  }

  await ctx.close();
}

// User drag should be respected — verify saved position survives resize
// (does NOT snap back to bottom-right).
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const p = await ctx.newPage();
  await p.goto(URL, { waitUntil: 'networkidle' });
  await p.evaluate(() => {
    localStorage.removeItem('mascot:choice');
    localStorage.removeItem('mascot:position');
  });
  await p.reload({ waitUntil: 'networkidle' });
  await p.waitForTimeout(800);

  // Drag mascot to top-left area
  const r0 = await getMascotRect(p);
  const cx = r0.x + r0.w / 2;
  const cy = r0.y + r0.h / 2;
  await p.mouse.move(cx, cy);
  await p.mouse.down();
  await p.mouse.move(cx - 600, cy - 400, { steps: 10 });
  await p.mouse.up();
  await p.waitForTimeout(250);
  const rDragged = await getMascotRect(p);
  ok('user drag updates position',
     rDragged.x < r0.x - 100 && rDragged.y < r0.y - 100,
     `from (${r0.x|0},${r0.y|0}) → (${rDragged.x|0},${rDragged.y|0})`);

  // Resize and verify the dragged position is preserved (clamped if needed).
  await p.setViewportSize({ width: 1100, height: 700 });
  await p.waitForTimeout(400);
  const rAfter = await getMascotRect(p);
  const dxBR = rAfter.vw - rAfter.right;
  const dyBR = rAfter.vh - rAfter.bottom;
  ok('drag-position survives resize (NOT snapped to bottom-right)',
     !(dxBR <= 64 && dyBR <= 64),
     `position after resize: (${rAfter.x|0},${rAfter.y|0})  bottom-right offsets=${dxBR|0},${dyBR|0}`);

  await ctx.close();
}

await browser.close();

let pass = 0;
for (const r of log) {
  console.log(`${r.ok ? '✅' : '❌'} ${r.m}${r.d ? ` — ${r.d}` : ''}`);
  if (r.ok) pass++;
}
console.log(`\n=== Summary ===\n${pass}/${log.length} passed`);
process.exit(pass === log.length ? 0 : 1);
