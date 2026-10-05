# mascot-mate

**Embeddable mascot widget** — Clippy, Ninja Cat, and Bob + OpenAI streaming.

> Your friendly browser-side desktop assistant. Like Clippy, but
> well-behaved on a 4K display and powered by an LLM you trust.

## What

A tiny vanilla-TS widget that drops a fully animated mascot into the
corner of any page. Visitors ask questions; answers stream from your
own OpenAI-compatible proxy. Three swappable mascots — Clippy, Ninja
Cat, and Bob.

```
┌────────────────────────────────────────────────────┐
│  mascot-mate/                                      │
│   ├─ widget/   ← embeddable JS  (vanilla TS)       │
│   └─ server/   ← tiny SSE OpenAI proxy (Node 20+)  │
└────────────────────────────────────────────────────┘
```

## Why

The API key stays on the server. The mascot is one script tag (or
`init()`). No telemetry, no tracking, no analytics.

- **3 swappable mascots** with sprite-sheet animation (idle, greeting,
  thinking, explain, celebrate, alert).
- **Streaming answers** via Server-Sent Events from a tiny Node proxy.
- **Drag to reposition** with `localStorage` persistence; defaults to
  bottom-right, including iOS notches and Android gesture bars
  (`env(safe-area-inset-*)`).
- **Accessible** — non-modal `role=dialog` bubble (Escape closes it,
  Tab can leave), `aria-live` streaming text, keyboard shortcuts
  (Enter / Space on the mascot, `/` to focus), reduced-motion, axe-core
  clean (no critical/serious violations).
- **Hardened proxy** — CORS allow-list, per-IP token-bucket rate limit,
  payload + message-count caps, typed `{error, kind}` envelopes, no key
  in the browser.

## Try it

| Path | What you get |
|------|----------------|
| **[Live demo](https://manaiakalani.github.io/mascot-mate)** | Clippy, Ninja Cat, and Bob — drag, swap, greet. Sprite demo only: that build does not call a chat proxy. |
| **[Quick start](#quick-start)** | Local widget + proxy. Click the mascot and ask anything. |
| **[Embed](#embedding-on-any-site)** | One `<script>` tag on any site, pointed at your `/api/ask` proxy. |

---

## Quick start

```bash
git clone https://github.com/Manaiakalani/mascot-mate.git
cd mascot-mate
cp .env.example .env             # add your OPENAI_API_KEY
npm install
npm run dev:server               # proxy on :8787
npm run dev:widget               # demo page on :5174
```

Open <http://localhost:5174>, click the mascot, ask anything. The
sprite demo (no proxy) is at
<https://manaiakalani.github.io/mascot-mate>.

## Embedding on any site

Build the widget:

```bash
cd widget && npm run build
```

Host the entire `widget/dist/` folder on any CDN (the sprite sheets live
alongside the JS as `dist/mascots/{id}/map.png` and are fetched lazily at
runtime — only the active mascot's sheet is downloaded), then drop one tag:

```html
<script src="https://your-cdn.example/mascot.iife.js"
        data-endpoint="https://your-proxy.example/api/ask"
        data-mascot="clippy"
        data-greeting="Hi! Ask me anything."
        defer></script>
```

The widget auto-mounts, persists the user's mascot choice in
`localStorage`, and exposes a programmatic API on `window.Mascot`:

```js
window.Mascot.switchTo('ninjacat');     // or 'clippy' | 'bob'
window.Mascot.ask('Explain CSS box-sizing in one sentence.');
window.Mascot.hide();
window.Mascot.show();
```

ESM hosts can import `init` from `mascot.js` instead of using the IIFE
tag. Same options, same instance methods:

```js
import { init } from './mascot.js';

const mascot = await init({
  endpoint: 'https://your-proxy.example/api/ask',
  mascot: 'clippy',
  greeting: 'Hi! Ask me anything.',
});
```

## Configuration

### Server (env vars)

| Var                  | Default        | Notes                                                                 |
|----------------------|----------------|-----------------------------------------------------------------------|
| `OPENAI_API_KEY`     |                | OpenAI key. Stays server-side. Required unless `XAI_API_KEY` is set. |
| `XAI_API_KEY`        |                | xAI key. Used when `OPENAI_API_KEY` is unset, or with an xAI base URL. |
| `OPENAI_BASE_URL`    | OpenAI or xAI  | Chat-completions origin. `https://api.x.ai/v1` selects xAI.          |
| `OPENAI_MODEL`       | `gpt-4o-mini`  | `grok-4.7` when the upstream is xAI and this is unset.               |
| `OPENAI_MAX_TOKENS`  | `512`          | Completion cap. `0` omits the limit.                                 |
| `OPENAI_MAX_TOKEN_FIELD` |            | `max_tokens` or `max_completion_tokens`. Unset uses `max_completion_tokens` for `o`-series and `gpt-5` models, and `max_tokens` otherwise (including xAI). |
| `OPENAI_TIMEOUT_MS`  | `45000`        | Abort if the upstream sends no bytes for this long.                  |
| `ASK_TOKEN`          |                | When set, `POST /api/ask` must send header `x-mascot-token`.         |
| `SYSTEM_PROMPT`      |                | When set, replaces any system turn from the browser.                 |
| `ALLOWED_ORIGINS`    | `*`            | Comma-separated CORS allow-list, or `*`.                             |
| `RATE_LIMIT_RPM`     | `20`           | Requests per minute, per IP (token bucket).                          |
| `PORT`               | `8787`         |                                                                       |

### Widget (`<script>` data-attrs)

| Attribute         | Notes                                          |
|-------------------|------------------------------------------------|
| `data-endpoint`   | URL of `/api/ask`. Required for auto-mount.    |
| `data-mascot`     | `clippy` (default) / `ninjacat` / `bob`.       |
| `data-greeting`   | Initial speech-bubble text.                    |
| `data-system`     | System prompt sent to the model. Ignored when the proxy sets `SYSTEM_PROMPT`. |
| `data-token`      | Shared secret for `ASK_TOKEN`. Anyone who can load the page can read it. |

`init({ endpoint, mascot, greeting, systemPrompt, token })` accepts the
same values as those attributes.

## Adding a mascot

A mascot is a folder following the **ClippyJS sprite-sheet format**:

```
widget/src/mascots/<id>/
  ├─ map.json    # framesize, overlayCount, animations
  └─ map.png     # horizontal sprite strip
```

Validate before shipping:

```bash
cd widget && npm run validate-mascot -- src/mascots/<id>
```

Animation names the widget looks for (with sensible fallbacks):
`Greeting`, `GoodBye`, `Thinking`, `Explain`, plus any `^Idle*` for the
auto-rotation pool.

## Testing

```bash
cd widget
npm test                         # unit tests (vitest)

# Playwright fit-and-finish suites:
node scripts/fit-finish.mjs      # mascot swap, pill, bubble, edges
node scripts/drag-check.mjs      # pointer drag + persistence
node scripts/error-check.mjs     # 429 / 401 / network / SSE-error
node scripts/a11y-check.mjs      # axe-core + keyboard flow
node scripts/anchor-check.mjs    # bottom-right across viewports
node scripts/idle-check.mjs      # idle scheduler fires
node scripts/size-parity-check.mjs  # all 3 mascots ≈ same size
```

The proxy has its own unit tests in `server/`:

```bash
cd server && npm test
```

`npm test` from the repo root runs both suites. GitHub Actions runs that
before the Pages deploy.

## Why a proxy?

Putting your OpenAI key in the browser is a one-way ticket to a six-figure
bill. The included `server/` is a small Node 20+ service (`dotenv` is its
only runtime dependency) that:

- streams chat completions as SSE tokens,
- enforces a CORS allow-list and an optional shared token,
- rate-limits per IP via token bucket,
- caps payload, message count, and completion length,
- times out a stalled upstream and does not forward provider error bodies,
- emits typed JSON envelopes (`{ error, kind }`) so the widget can render
  per-error-kind UI (`rate_limit` / `unauthorized` / `network` /
  `timeout` / `server` / `aborted`) with an inline retry button.

Deploy it anywhere Node 20+ runs (Vercel, Fly, Render, Railway, etc.).

## About me

Built by [@Manaiakalani](https://github.com/Manaiakalani) over a few
evenings as a love letter to the late-90s desktop assistants — the kind
that once asked if you were writing a letter, except this one actually
helps. No telemetry, no tracking, no analytics; just a smile in the
corner of your page.

## License

[MIT](./LICENSE) for the code in this repository. Mascot-mate is an
unofficial fan/homage project and is not affiliated with, endorsed by, or
sponsored by Microsoft. Clippy, Ninja Cat, Microsoft Bob, and all related
characters and imagery are trademarks and copyrights of their respective
owners.

---

_It looks like you're reading a README. Would you like help with that?_ 📎
