# iOS-Style Weather Board — Design Spec

**Date:** 2026-07-04
**Sub-project:** Kernel layer, Phase 2c — the weather card grows into a full board.
Phase 2a/2b (small overlay card + kernel wiring + narration sync) shipped in PR #1;
the Settings Weather section in PR #2; the app-quit aux-window fix in PR #3.
**Status:** Approved design, pre-implementation.

## Context

The small forecast card shipped in Phase 2b renders 8 three-hour tiles and auto-dismisses
when narration ends. The user wants the real thing: a **full iOS-Weather-style board**
(reference: iPhone Weather app screenshots, 2026-07-04) at **65–100% of the screen**,
with animated condition-driven sky backgrounds ("stormy animated background or sunny
animated if it is sunny outside — make it insane").

Decisions locked with the user (2026-07-04):

- **Replace, don't expand:** weather always opens the board; the small glass card becomes
  **rows-only** (systemStats, degraded weather, future handlers).
- **Two renderer files:** `renderer/overlay-card.html` (rows card, forecast branch removed)
  and a new `renderer/weather-board.html` (the board). One manager module drives both.
- **Sizing:** Settings slider 65–100% of the primary work area (`weatherCardScale`,
  default 0.65) **plus** drag/resize with bounds persisted across sessions
  (`weatherBoardBounds`, validated with the existing `isOnScreen` pattern).
- **Daily forecast:** 5–6 rows aggregated from the free 5-day/3-hour API. One Call 3.0
  (8-day, UV) rejected — requires a card-verified account.
- **Dismissal:** the board **stays until closed** (× / Esc / click-outside blur). No
  speech-end auto-dismiss, no safety timeout. Narration still highlight-scrolls the
  hourly strip. The rows card keeps its existing auto-dismiss lifecycle untouched.
- **Info tiles:** all eight (Feels Like, Wind, Humidity+dew point, Sunrise/Sunset,
  Precipitation, Visibility, Pressure, Moon phase). Not user-toggleable.
- **Background:** dynamic animated sky per condition + day/night, pure CSS, no images;
  storm and clear-day scenes are the showpieces.

## Payload contract v2 (`kind:'forecast'`)

`lib/kernel/handlers/weather.js` already fetches both endpoints; v2 uses everything:

```js
{ kind: 'forecast', title: 'Beirut, LB', accent: 'sky',
  scene: 'storm',                     // clear-day|clear-night|clouds|rain|storm|snow|mist
  current: {
    temp: 28, hi: 30, lo: 22,         // hi/lo from today's aggregated daily row
    icon: '11d', condition: 'Thunderstorm',
    feelsLike: 29, humidity: 67, dewPoint: 21,
    pressure: 1007,                   // hPa
    visibility: 21,                   // km (m/1000, 1 decimal, null when absent)
    wind: { speed: 23, gust: 37, deg: 241 },  // km/h for metric (m/s * 3.6), mph imperial
    sunrise: '05:30', sunset: '19:52',        // local HH:MM via city tz offset
    isNight: false,
    moon: { phase: 'waning-gibbous', illumination: 82 }  // computed locally, no API
  },
  hourly:  [ { time:'15:00', temp:24, icon:'01d', condition:'Clear', pop:20 } × 8 ],
  daily:   [ { day:'Today', icon:'01d', lo:22, hi:28, pop:0 } × 5..6 ],
  narration: [ { text, tile } ... ]   // unchanged; joined === speak
}
```

Rows payloads are unchanged. A forecast payload that fails to build (no daily/hourly)
demotes to rows exactly as today.

### New pure functions (all unit-tested, no I/O)

- `aggregateDaily(list40, tz)` → 5–6 rows: group the FULL forecast list by local calendar
  day; `lo`/`hi` = min/max over the day's steps, `icon` = the step nearest local noon
  (fallback: most frequent), `pop` = max probability-of-precipitation that day (0–100),
  `day` = 'Today' for the first row, else short weekday ('Sun'). Skips a leading day with
  < 2 steps remaining unless it is today.
- `dewPoint(tempC, humidityPct)` → Magnus formula, returns rounded °C. Takes Celsius
  only; when `units === 'imperial'` the caller converts °F→°C before, and the result
  back to °F for display.
- `moonPhase(dateMs)` → `{ phase, illumination }`; phase ∈ new-moon | waxing-crescent |
  first-quarter | waxing-gibbous | full-moon | waning-gibbous | last-quarter |
  waning-crescent, from the synodic-month calculation (epoch 2000-01-06 18:14 UTC,
  29.530588853 days); illumination = rounded `(1 - cos(2π·age/synodic))/2 × 100`.
- `sceneFor(iconCode, isNight)` → `'11'`→storm, `'09'|'10'`→rain, `'13'`→snow,
  `'50'`→mist, `'03'|'04'`→clouds, `'01'|'02'`→clear-day / clear-night by `isNight`;
  unknown→clouds.
- `isNightAt(nowUtcSec, sunriseUtcSec, sunsetUtcSec)` → boolean.
- `fmtClock(unixSec, tzSec)` → 'HH:MM' (generalizes the existing `fmtHour`).

`normalizeForecast` keeps returning the 8-tile strip (now with `pop`) and additionally
exposes the full normalized list for `aggregateDaily`. The current-weather `normalize`
gains feelsLike/humidity already present plus pressure, visibility, wind deg/gust,
sunrise/sunset, dt (all straight field reads, null-safe).

## Window management (`lib/kernel/overlay.js`)

One module, **two windows**:

- `cardWin` — the small rows card (unchanged behavior: sizeFor rows, showInactive,
  speech-end/no-tts dismissal, 30 s safety, fade-ack hide).
- `boardWin` — the weather board. Created lazily, reused, hidden on close (destroyed by
  the existing app-quit `destroy()`, which now tears down both).
  - **Bounds:** saved `weatherBoardBounds` if `isOnScreen`, else centered at
    `weatherCardScale` (0.65–1.0, clamped) × primary work area. `resizable: true`,
    frameless; `moved`/`resized` events debounce-persist bounds via an injected
    `saveConfig` dep (mirrors `overlayPanelBounds`). `init()` deps gain
    `getConfig`/`saveConfig`.
  - **Lifecycle:** `open()` routes by `model.kind` — forecast → board, rows → card —
    and returns `{ cardId, kind }` (BREAKING: previously returned a number; main.js is
    the only caller). Board gets **no safety timer**. `dismiss(reason, cardId)`:
    `'speech-end'`/`'no-tts'` are **ignored for the board**; manual reasons fade-ack
    and hide as the card does. `scrollTo` routes to whichever window owns the live id.
  - Same conventions: `alwaysOnTop('screen-saver')`, `skipTaskbar`, `showInactive()`,
    `setContentProtection(true)`, acrylic/Win10-solid, shared preload, push IPC on the
    same channels (`card:render`/`card:scrollTo`/`card:dismiss`/`card:close`/`card:faded`
    — each window only ever receives its own card's events because ids are global and
    routing is by live id).

## `renderer/weather-board.html`

Layout (scrollable column, glass tiles over the sky):

1. **Header** (drag region): location, huge thin temp (~96px, weight 200), condition,
   `H:30° L:22°`; × button top-right.
2. **Hourly strip**: the 8 tiles + rain % under the icon when `pop ≥ 20`; same
   scroll-snap/momentum/engaged-flag/highlight-pulse behavior as the small card
   (`api.scrollTo` contract unchanged).
3. **5-day list**: rows `day | icon | lo° [gradient bar] hi°` — the bar is positioned/
   scaled within the week's min→max range like iOS; rain % chip when `pop ≥ 20`.
4. **Tile grid** (2-per-row on narrow, 4 on wide; CSS grid auto-fit): Feels Like (+"similar
   to actual" / "feels warmer" hint), Wind (SVG compass needle at `deg`, speed center,
   gusts subtext), Humidity (+ dew point line), Sunrise/Sunset (SVG sun-arc with the sun
   dot positioned by current time between the two), Precipitation (today's `pop` max +
   "none expected" copy), Visibility (km/mi), Pressure (SVG gauge needle, hPa),
   Moon (phase name, illumination %, CSS sphere shaded per phase).

**Sky scenes** — full-bleed fixed layer behind content, driven by `data-scene`:

- `clear-day`: warm blue gradient, radial sun with slow-rotating ray cone, 2–3 drifting
  translucent cloud wisps, faint pulsing lens flare.
- `clear-night`: deep navy gradient, ~80 twinkling stars (two box-shadow particle layers,
  opposing twinkle phases), soft moon glow.
- `clouds`: grey-blue gradient, 4–5 large blurred cloud blobs drifting at parallax speeds.
- `rain`: darker gradient, two layers of falling streaks (repeating-linear-gradient
  translateY loops at different speeds/angles), drifting clouds.
- `storm`: near-black churning gradient, heavy diagonal rain, **periodic lightning**: a
  keyframed full-screen flash (opacity spike ~120 ms, irregular 6–11 s cycle via two
  offset animations) + a jagged SVG bolt that flashes with it.
- `snow`: slate gradient, drifting/falling flakes (box-shadow particles, sway animation).
- `mist`: pale gradient, 3 large blurred fog banks sliding horizontally.

All animation is transform/opacity only (GPU-composited); `@media (prefers-reduced-motion:
reduce)` freezes scenes to their static gradients. Tile glass: `rgba` fills +
backdrop-blur, readable on every scene (text always on a scrim). Win10 (`data-os`):
scenes keep their gradients (they're opaque), only backdrop-blur on tiles degrades to
solid fills.

Dismissal UI: × always; Esc/blur after click (showInactive focus caveat); `card:dismiss`
with a manual reason fades immediately (reason plumbing from PR #3's fix is reused);
no hover-defer complexity — the board has no auto-dismiss to defer.

## `renderer/overlay-card.html` (rows card)

Becomes rows-only: the `#now`/`#strip-wrap` markup, strip CSS, forecast render path,
SVG sprite `<defs>` (only the forecast layout ever used icons), and the `scrollTo`
handler body are removed (`onCardScrollTo` stays registered as a no-op so a stray event
is harmless). Rows rendering, dismissal, fade-ack, and hover-defer are untouched.

## `main.js`

- `cardCtl()` init passes `getConfig: () => config.get()` and a `saveConfig` patch fn.
- Kernel branch: `const opened = cardCtl().open(r.overlay)` → `{cardId, kind}`.
  Narration wiring unchanged (segments still speak; `tts:progress` → `scrollTo`).
  `tts:idle` → `dismiss('speech-end', id)` still fires — overlay.js ignores it for the
  board. The 10 s no-TTS dismissal applies **only when `kind === 'rows'`**.
- Dev fixtures: `Ctrl+Alt+K` cycle gains a **storm fixture** (scene:'storm', gusty wind,
  high pop) and routes forecast fixtures to the board; rows fixtures to the card.
- `destroy()` already tears down both windows via PR #3's handler.

## Settings (`renderer/index.html`, Weather section)

Add a **Card size** slider: `<input type="range" min="65" max="100" step="5">` bound to
`weatherCardScale` (percent → stored as 0.65–1.0), live value label ("75% of screen"),
saved with the existing Save button, populated in `populateWeather()`. Hint: dragging or
resizing the board also remembers its exact position.

## Config (`lib/config.js`)

`weatherCardScale: 0.65`, `weatherBoardBounds: null` added to DEFAULTS.

## Error handling

| Failure | Behavior |
|---|---|
| Forecast fetch fails, current OK | rows demotion (unchanged) |
| Daily aggregation yields < 2 rows | demote to rows (never a half-board) |
| Missing optional fields (visibility, gust, pop…) | tile shows '—' or omits the subtext; never `undefined` |
| Saved bounds off-screen | recentre at `weatherCardScale` |
| Scale out of range in config | clamp 0.65–1.0 |
| Unknown scene | `clouds` |
| Reduced-motion OS setting | static gradient skies |

## Testing

- **Unit (`tests/test-handlers.js`):** `aggregateDaily` (day grouping across a tz
  boundary, lo/hi, noon icon, max pop, 'Today' label, skip-thin-leading-day),
  `dewPoint` (known values ±1°), `moonPhase` (documented ephemeris dates — e.g. 2000-01-21 full moon,
  2000-01-06 new moon — asserting phase name and illumination band, not exact percent), `sceneFor` (full code table + night),
  `isNightAt`, `fmtClock`.
- **Unit (`tests/test-overlay-card.js`):** normalizePayload v2 (hourly/daily/current
  extras coerced, junk-safe; forecast without daily demotes), routing model (`kind`).
- **Integration:** weather e2e asserts v2 payload (8 hourly + ≥2 daily + scene + moon).
- **Manual (fixtures):** storm scene lightning, clear-day sun, night stars; slider
  resize; drag-persist across restart; stay-until-closed; narration strip sync.

## Out of scope

- UV index / 10-day forecast (One Call 3.0), per-tile visibility toggles, radar/wind
  maps, "Averages" tile (no API), severe-weather alerts, multiple saved locations,
  Growth Loop (still the Kernel's final phase).
