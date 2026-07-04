# Kernel Overlay Card — Design Spec

**Date:** 2026-07-04
**Sub-project:** Kernel layer, Phase 2 (the card the Kernel's handlers render into).
Phase 1 (router/registry/guard + math/systemStats/weather handlers + weather wiring) is
committed and green; `main.js` carries the integration TODO this spec resolves
(`TODO(kernel-overlay): render r.overlay in the custom overlay card`).
**Status:** Approved design, pre-implementation.

## Context

Kernel handlers already return an `overlay` payload alongside their spoken summary —
weather (`API_NATIVE`) and systemStats (`PURE_LOGIC`) both emit `{title, rows, accent}` —
but nothing renders it: the result is only spoken and logged to the activity feed. This
spec adds the missing surface: a **dedicated, lightweight, always-on-top card window**
(`renderer/overlay-card.html` + `lib/kernel/overlay.js`) that displays Kernel results
without the conversational HUD's overhead, styled after the iOS Weather app's glassmorphic
look, with **narration-synchronized auto-scroll** as its signature interaction.

Decisions locked with the user (2026-07-04):

- **Window model:** its own dedicated card window — not injected into the HUD panel, not
  docked to the bubble. Fully decoupled from the conversation HUD.
- **Position:** centered on the primary display's work area.
- **Dismissal:** auto-dismiss **when the assistant finishes speaking the summary**, plus
  manual close (×, Esc, click-outside) at any time.
- **Speech tie:** wired to the **real** speech-end signal (not estimated timers), with a
  safety timeout when TTS is off/muted.
- **Accent:** use the payload's semantic accent when it maps to a known card color;
  otherwise fall back to the user's theme `--accent`.
- **Scope:** **two card kinds in one overlay** — the iOS-style forecast card for weather
  and a simple rows card for systemStats/any future handler.
- **Timeline shape:** horizontal ~24 h strip in 3-hour segments (8 tiles), iOS-style,
  with a current-conditions header. (OpenWeather free tier: 5-day/3-hour forecast API.)
- **Narration sync:** sentence-anchored — the weather handler emits its summary as ordered
  segments tagged with tile indices; the TTS queue reports when each segment starts.
- **Judgment calls (user-ratified):** (a) this card uses **rounded corners**, a deliberate
  iOS departure from the HUD's sharp-bracket signature — the card is a "result artifact",
  not the instrument panel; (b) the Piper offline-TTS path gets **approximate** sync in v1
  (start-highlight + real speech-end dismissal + estimated per-segment timers); exact
  per-segment sync is browser-`speechSynthesis`-only for now.

## Payload contract

Kernel overlay payloads gain a `kind` discriminator. A payload without `kind` is treated
as `'rows'`, so systemStats and any existing producer ship unmodified.

```js
// kind:'rows' — systemStats, fallbacks, any simple handler
{ kind: 'rows', title: 'System stats', accent: 'blue',
  rows: [ { label: 'CPU', value: '8 × …' }, … ] }

// kind:'forecast' — weather
{ kind: 'forecast', title: 'Tokyo, JP', accent: 'sky',
  current:  { temp: 24, icon: '01d', condition: 'Clear sky' },
  forecast: [ { time: '15:00', temp: 24, icon: '01d', condition: 'Clear' }, … ],  // 8 tiles ≈ 24 h
  narration: [ { text: 'Right now it’s 24° and clear in Tokyo.', tile: 0 },
               { text: 'By this evening it cools to 18° with light rain.', tile: 4 }, … ] }
```

`narration[].text` joined in order **is** the spoken summary (`speak`); each segment is one
utterance unit. `tile` is the timeline index the segment describes.

## Architecture

```
Kernel handler → { ok, speak, overlay }
        │
        ▼
main.js (ui:sendText kernel-intercept branch)
  ├─ speak(say, segments?)            → TTS queue (segment-aware)
  └─ overlay.open(r.overlay)          → card window (push IPC 'card:render')
        │
  main-window renderer TTS queue
  ├─ 'tts:progress' (segment n started) → main.js → overlay.scrollTo(narration[n].tile)
  └─ 'tts:idle'     (queue drained)     → main.js → overlay.dismiss('speech-end')
        │
  card renderer  ── 'card:close' (×/Esc/blur) → main.js → overlay.dismiss('manual')
```

Push-based end to end: the card has **no polling loop**. It idles at zero cost until a
`card:render` / `card:scrollTo` / `card:dismiss` message arrives.

## Components

### 1. `lib/kernel/overlay.js` — the Overlay window manager

A standalone module owning one reusable card `BrowserWindow`.

- **API (impure shell):** `open(payload)`, `update(payload)`, `scrollTo(index)`,
  `dismiss(reason)`, `isOpen()`.
- **Pure helpers (unit-tested, no Electron):**
  - `normalizePayload(p)` → safe render model for **both kinds**: guards missing/junk
    fields, coerces to strings/numbers, caps rows (12) and tiles (8), resolves the kind
    (`forecast` requires a non-empty `forecast[]`, else demotes to `rows`).
  - `resolveAccent(name)` → `{ accent, soft }` colors from a card-local semantic palette
    (`sky`, `blue`, `teal`, `amber`, `violet`, …) or `null` when unknown → renderer falls
    back to the theme's `--accent`.
  - `mapIcon(owmCode)` → sprite id (`sun`, `moon`, `partly`, `cloud`, `rain`, `drizzle`,
    `thunder`, `snow`, `mist`), covering OpenWeather's `01d…50n` set with a `cloud`
    default.
- **Isolation constraint:** `overlay.js` is the **only** Electron-touching file under
  `lib/kernel/`; the pure kernel core (index/router/registry/guard/handlers) never
  imports it. `main.js` is the composition point that connects kernel results to the
  overlay. Kernel suites remain plain-Node testable.
- **Window construction** (mirrors `createOverlay()` conventions in `main.js`): frameless,
  transparent, `alwaysOnTop('screen-saver')`, `skipTaskbar`, `fullscreenable:false`,
  `showInactive()` (never steals focus), `setContentProtection(true)` (excluded from
  automation/vision capture, same rationale as the panel/bubble), `backgroundMaterial:
  'acrylic'` on Win11 22H2+ / solid CSS via `data-os="win10"` otherwise, shared
  `preload.js` (contextIsolation on, nodeIntegration off). Centered on the primary
  display's work area; sized per kind (forecast ≈ 420×250, rows ≈ 340×auto capped).
- **Lifecycle guards:** a monotonic **card id** accompanies every open; `scrollTo`/
  `dismiss` carry the id and are ignored if a newer card replaced the one they targeted.
  A **safety timeout** (~30 s) force-dismisses if no speech-end ever arrives.

### 2. `renderer/overlay-card.html` — the card renderer

- **Aesthetic:** iOS-Weather glassmorphism — frosted background (blur + slight tint;
  solid on Win10), **rounded corners**, generous type for the current temp, inline SVG
  weather sprite (no image fetches). Reuses `theme.css` + `data-theme`/`data-accent`/
  `data-os` (fetched once via `bridge.getShellStyle()`/status, not polled).
- **Forecast layout:** current-conditions header (location, big temp, condition, icon)
  above a horizontal 8-tile strip (time, icon, temp) with CSS `scroll-snap`, momentum
  drag, and edge fade masks.
- **Rows layout:** title bar + clean label/value list — the same glass card, no strip.
- **`api.scrollTo(index)`:** smooth-scrolls the tile into view and pulses its highlight —
  vanilla CSS transitions/animations only, no frameworks.
- **Manual-drag independence:** any user pointer interaction sets an "engaged" flag for
  ~4 s during which `scrollTo` updates **only the highlight**, never the scroll position —
  narration never fights the user's drag. Hovering also defers auto-dismissal until the
  pointer leaves (+2 s grace).
- **Dismissal UI:** × button, `Esc`, and window blur (click-outside) all emit
  `card:close`; exit is a fade-out then hide (window is reused, not destroyed).

### 3. TTS queue changes (`renderer/index.html` + `preload.js` + `main.js`)

- `tts:speak` payload optionally carries the pre-split `segments[]`; when present the
  renderer queues **exactly those chunks** as utterance units (its existing
  one-utterance-at-a-time discipline is unchanged).
- New renderer→main signals: `tts:progress` (segment n started) and `tts:idle` (queue
  drained, including the already-existing watchdog path so a stuck `end` still dismisses).
- **Piper path (v1):** synthesizes one WAV for the whole summary today. It emits real
  `tts:idle` on playback end (exact dismissal) and drives highlights with estimated
  per-segment timers scaled to the audio duration. Exact per-segment sync for Piper is
  future work, out of scope here.
- When TTS is disabled entirely: no signals come; the card lives until the safety timeout
  or manual close.
- Preload additions (guarded like existing methods): `onCardRender`, `onCardScrollTo`,
  `onCardDismiss`, `cardClose`, plus the `tts:progress`/`tts:idle` senders.

### 4. `lib/kernel/handlers/weather.js` — forecast upgrade

- Adds a second call to OpenWeather's **5-day/3-hour forecast** endpoint
  (`/data/2.5/forecast`, same injected `ctx.fetch`, same key/units/location config), in
  parallel with the current-conditions call.
- New pure pieces: `normalizeForecast(json)` → next-24 h tile list (8 × 3 h entries:
  local time label, rounded temp, icon code, condition), `buildForecastPayload(current,
  tiles, units)` → the `kind:'forecast'` payload, and `buildNarration(current, tiles,
  units)` → 2–4 ordered `{text, tile}` segments (now → notable change → tomorrow-ish
  outlook), whose joined text becomes `speak`.
- **Graceful degradation:** forecast call fails but current succeeds → return today's
  `rows` payload (existing `buildPayload`) with the existing single-sentence summary.
  Never a dead card, never a browser fallback.

### 5. `main.js` integration + dummy trigger

- **Phase 2a (dummy):** dev-flag-gated global shortcuts — `Ctrl+Alt+K` cycles fixture
  payloads (forecast ×8 tiles, rows/stats, long values, missing fields, junk),
  `Ctrl+Alt+J` replays a fake narration (`scrollTo` 0→7 on a timer) — so the card is
  perfected with **zero Kernel involvement**.
- **Phase 2b (real):** the `TODO(kernel-overlay)` branch becomes: `overlay.open(r.overlay)`
  + `speak(say, r.overlay.narration)` + the `tts:progress`/`tts:idle` → `scrollTo`/
  `dismiss` wiring. Dummy shortcuts stay behind the dev flag.

## Error handling

| Failure | Behavior |
|---|---|
| Junk/missing payload fields | `normalizePayload` coerces/demotes; card never renders `undefined` |
| Forecast API fails, current OK | Weather demotes to `rows` card + short summary |
| Unknown accent name | Theme `--accent` fallback |
| Unknown icon code | `cloud` sprite default |
| TTS off / no idle signal | Safety timeout (~30 s) dismisses |
| Stale speech events after a new card opened | Card-id guard ignores them |
| Card window destroyed mid-signal | All shell methods no-op on destroyed/missing window |
| Win10 (no acrylic) | Solid glass via `data-os="win10"` CSS, same layout |

## Testing

- **Unit (`tests/test-overlay-card.js`, added to `npm test`):** `normalizePayload` (both
  kinds, junk, demotion, caps), `resolveAccent` (known/unknown), `mapIcon` (full OWM code
  set + default).
- **Unit (weather):** `normalizeForecast` (real-shaped fixture, malformed bodies),
  `buildForecastPayload`, `buildNarration` (segment order, tile indices in range,
  joined text == speak).
- **Integration (`tests/test-integration.js` extension):** weather e2e with **mocked**
  current+forecast fetches → `kind:'forecast'` payload with 8 tiles + narration; forecast
  fetch failing → `rows` demotion.
- **Manual (Phase 2a gate):** dummy triggers verify visuals, scroll-snap, manual-drag
  independence, highlight pulse, dismissal paths, Win10 solid fallback — before any
  Kernel wiring.

## Out of scope

- Growth Loop (separate, final phase of the Kernel sub-project).
- Exact per-segment Piper sync (v1 = estimated timers + real end-dismissal).
- Daily 5-day list / dual-axis iOS clone (hourly strip only for now).
- Any change to the HUD panel/bubble; the card is fully independent.
