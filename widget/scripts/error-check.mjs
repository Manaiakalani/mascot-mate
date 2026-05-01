// Error-state Playwright check.
// Mocks the proxy /api/ask endpoint to return specific error responses
// and asserts that the bubble shows mascot-friendly copy + retry button.

import { chromium } from '@playwright/test';

const URL = process.argv[2] || 'http://127.0.0.1:5174/';
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

async function bubbleState() {
  return await p.evaluate(() => {
    for (const host of document.body.children) {
      const el = host.shadowRoot?.querySelector('.balloon');
      if (!el) continue;
      const text = host.shadowRoot.querySelector('.text')?.textContent ?? '';
      const isError = el.classList.contains('error');
      const retry = host.shadowRoot.querySelector('.retry');
      const retryShown = !!retry && !retry.hidden && getComputedStyle(retry).display !== 'none';
      return { text, isError, retryShown };
    }
    return null;
  });
}

async function ask(question) {
  // Open bubble via "/" shortcut, type, submit.
  await p.keyboard.press('/');
  await p.waitForTimeout(200);
  await p.keyboard.type(question);
  await p.keyboard.press('Enter');
  await p.waitForTimeout(700);
}

async function clearLocalStorage() {
  await p.evaluate(() => {
    localStorage.removeItem('mascot:position');
    localStorage.removeItem('mascot:choice');
  });
}

async function gotoFresh() {
  await p.goto(URL, { waitUntil: 'networkidle' });
  await clearLocalStorage();
  await p.reload({ waitUntil: 'networkidle' });
  await p.waitForTimeout(1000);
}

// --- Case 1: HTTP 429 → friendly rate-limit copy + retry button ---
await ctx.route('**/api/ask', (route) =>
  route.fulfill({
    status: 429,
    headers: { 'content-type': 'application/json', 'retry-after': '7' },
    body: JSON.stringify({ error: 'rate limit exceeded', kind: 'rate_limit' }),
  }),
);
await gotoFresh();
await ask('hello');
const s1 = await bubbleState();
check('429 → bubble in error mode', s1?.isError === true);
check('429 → message mentions waiting/seconds', /sec|moment|try again/i.test(s1?.text ?? ''), s1?.text?.slice(0, 80));
check('429 → retry button shown', s1?.retryShown === true);

// --- Case 2: HTTP 503 missing-key → unauthorized copy, no retry ---
await ctx.unroute('**/api/ask');
await ctx.route('**/api/ask', (route) =>
  route.fulfill({
    status: 503,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      error: 'server is missing OPENAI_API_KEY',
      kind: 'unauthorized',
    }),
  }),
);
await gotoFresh();
await ask('hi');
const s2 = await bubbleState();
check('503 missing-key → bubble in error mode', s2?.isError === true);
check('503 → message mentions configuration / api key', /api key|configur|brain/i.test(s2?.text ?? ''), s2?.text?.slice(0, 80));
check('503 unauthorized → retry hidden', s2?.retryShown === false);

// --- Case 3: Network failure → friendly copy + retry ---
await ctx.unroute('**/api/ask');
await ctx.route('**/api/ask', (route) => route.abort('failed'));
await gotoFresh();
await ask('hi');
const s3 = await bubbleState();
check('network abort → bubble in error mode', s3?.isError === true);
check('network → retry button shown', s3?.retryShown === true);

// --- Case 4: SSE error event mid-stream → classified by kind ---
await ctx.unroute('**/api/ask');
await ctx.route('**/api/ask', (route) =>
  route.fulfill({
    status: 200,
    headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
    body:
      'data: {"delta":"Hi"}\n\n' +
      'data: {"error":"upstream rejected the key","kind":"unauthorized"}\n\n' +
      'data: [DONE]\n\n',
  }),
);
await gotoFresh();
await ask('hi');
const s4 = await bubbleState();
check('SSE error event → bubble switches to error mode', s4?.isError === true);
check('SSE unauthorized error → retry hidden', s4?.retryShown === false);

await ctx.unroute('**/api/ask');
await b.close();

console.log('\n=== Summary ===');
const failed = checks.filter((c) => !c.ok);
console.log(`${checks.length - failed.length}/${checks.length} passed`);
if (issues.length) {
  console.log('\nPage errors / console errors (some expected for error tests):');
  for (const i of issues) console.log('  -', i);
}
process.exit(failed.length === 0 ? 0 : 1);
