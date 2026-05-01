# mascot-mate

> Your friendly browser-side desktop assistant. Like Clippy, but
> well-behaved on a 4K display and powered by an LLM you trust.

`mascot-mate` is a tiny embeddable web widget that drops a fully animated
mascot into the corner of any page, lets the visitor ask questions, and
streams answers back from your own OpenAI-compatible proxy. Three swappable
mascots — Clippy, Ninja Cat, and Bob — meet your OpenAI proxy.

```
┌────────────────────────────────────────────────────┐
│  mascot-mate/                                      │
│   ├─ widget/   ← embeddable JS  (vanilla TS)       │
│   └─ server/   ← tiny SSE OpenAI proxy (Node 20+)  │
└────────────────────────────────────────────────────┘
```

---

## ✨ Features

- **3 swappable mascots** with full sprite-sheet animation engines (idle
  rotation, greeting, thinking, explain, celebrate, alert).
- **Streaming answers** — Server-Sent Events from a tiny Node proxy that
  keeps your OpenAI key server-side.
- **Drag to reposition** with localStorage persistence.
- **Defaults to bottom-right** across desktop, tablet, mobile, iOS notches,
  and Android gesture bars (uses `env(safe-area-inset-*)`).
- **Accessible** — `role=dialog` bubble with focus trap + ESC, `aria-live`
  streaming text, keyboard shortcuts (Enter / Space on the mascot, `/` to
  focus), reduced-motion support, axe-core clean (no critical/serious
  violations).
- **Robust error handling** — typed errors (`rate_limit` / `unauthorized`
  / `network` / `timeout` / `server` / `aborted`), inline retry button,
  per-kind friendly copy, structured `{error, kind}` envelopes from the
  proxy.
- **Hardened proxy** — CORS allow-list, per-IP token-bucket rate limit,
  payload + message-count caps, no key in browser, ever.

## 🚀 Quick start

```bash
git clone https://github.com/Manaiakalani/mascot-mate.git
cd mascot-mate
cp .env.example .env             # add your OPENAI_API_KEY
npm install
npm run dev:server               # proxy on :8787
npm run dev:widget               # demo page on :5174
```

Open <http://localhost:5174>, click the mascot, ask anything.

## 📦 Embedding on any site

Build the widget:

```bash
cd widget && npm run build
```

Host `widget/dist/mascot.iife.js` on any CDN, then drop one tag:

```html
<script src="https://your-cdn.example/mascot.iife.js"
        data-endpoint="https://your-proxy.example/api/ask"
        data-mascot="clippy"
        data-greeting="Hi! Ask me anything."
        defer></script>
```

The widget auto-mounts, persists the user's mascot choice in
`localStorage`, and exposes a programmatic API:

```js
window.Mascot.switchTo('ninjacat');     // or 'clippy' | 'bob'
window.Mascot.ask('Explain CSS box-sizing in one sentence.');
window.Mascot.hide();
window.Mascot.show();
```

## 🔌 Configuration

### Server (env vars)

| Var                 | Default        | Notes                                        |
|---------------------|----------------|----------------------------------------------|
| `OPENAI_API_KEY`    | (required)     | Your OpenAI key. Stays server-side.          |
| `OPENAI_MODEL`      | `gpt-4o-mini`  | Any chat-completions model id.               |
| `ALLOWED_ORIGINS`   | `*`            | Comma-separated CORS allow-list, or `*`.     |
| `RATE_LIMIT_RPM`    | `20`           | Requests per minute, per IP (token bucket).  |
| `PORT`              | `8787`         |                                              |

### Widget (`<script>` data-attrs)

| Attribute         | Notes                                          |
|-------------------|------------------------------------------------|
| `data-endpoint`   | URL of `/api/ask`. Required for auto-mount.    |
| `data-mascot`     | `clippy` (default) / `ninjacat` / `bob`.       |
| `data-greeting`   | Initial speech-bubble text.                    |
| `data-system`     | System prompt sent to the model.               |

## 🎨 Adding a mascot

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

## 🧪 Testing

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

## 🤔 Why a proxy?

Putting your OpenAI key in the browser is a one-way ticket to a six-figure
bill. The included `server/` is a tiny Node 20+ service (~150 lines, zero
runtime deps) that:

- streams chat completions from OpenAI as SSE tokens,
- enforces a CORS allow-list,
- rate-limits per IP via token bucket,
- caps payload + message count,
- emits typed JSON envelopes (`{ error, kind }`) so the widget can render
  per-error-kind UI.

Deploy it anywhere Node 20+ runs (Vercel, Fly, Render, Railway, etc.).

## 🙋 About me

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
