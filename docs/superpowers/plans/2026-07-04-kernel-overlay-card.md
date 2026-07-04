# Kernel Overlay Card Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A dedicated, lightweight, always-on-top card window that renders Kernel handler results — an iOS-Weather-style forecast card (narration-synced auto-scroll) and a simple rows card — dismissing itself when the assistant finishes speaking.

**Architecture:** `lib/kernel/overlay.js` (pure helpers + the only Electron-touching module under `lib/kernel/`) owns one reusable frameless `BrowserWindow` loading `renderer/overlay-card.html`. Everything is push-IPC (`card:render` / `card:scrollTo` / `card:dismiss` in, `card:close` out) — the card has **no polling loop**. Narration sync rides the existing TTS queue: main.js sends the summary segment-by-segment (works identically for browser speechSynthesis and Piper, which already synthesizes one WAV per `speak()` call), and the renderer reports `tts:progress` / `tts:idle` back.

**Tech Stack:** Electron (BrowserWindow, ipcMain/ipcRenderer), vanilla JS/CSS (no frameworks), plain-node `assert` tests, OpenWeather current + 5-day/3-hour forecast APIs.

**Spec:** `docs/superpowers/specs/2026-07-04-kernel-overlay-card-design.md`
**Branch:** `kernel-overlay-card` (off `master`).

## Global Constraints

- The pure kernel core (`lib/kernel/index.js`, `router.js`, `registry.js`, `guard.js`, `handlers/*`) must **never** import `lib/kernel/overlay.js` or Electron. `main.js` is the composition point.
- Card window: frameless, transparent, `alwaysOnTop('screen-saver')`, `skipTaskbar`, `fullscreenable:false`, `showInactive()` only (never steal focus), `setContentProtection(true)`, acrylic on Win11 via `shellStyle().blur` / solid CSS via `data-os="win10"`, shared `preload.js` (contextIsolation on, nodeIntegration off).
- No polling in `overlay-card.html`. One-time `bridge.getShellStyle()` + `bridge.status()` at load is allowed; no `setInterval`.
- Payload without `kind` is treated as `'rows'` (systemStats ships unmodified).
- Caps: rows ≤ 12, forecast tiles ≤ 8. The card never renders `undefined`/junk — `normalizePayload` coerces or demotes.
- Never a browser fallback for weather; forecast-API failure with current-weather success demotes to the `rows` card.
- Dev-only dummy triggers gated behind `process.argv.includes('--dev') || process.env.CARYL_DEV === '1'` (same gate as DevTools, main.js ~2830).
- Safety timeout ~30 s force-dismisses the card if no speech-end signal ever arrives; when `cfg.tts_enabled === false` main.js schedules a ~10 s dismissal instead.
- Windows dev environment: run node tests as `node tests/<file>.js`; full `npm test` includes the Python automation suite (needs `.venv`).
- Commit messages: end with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 1: `overlay.js` pure helpers (`normalizePayload`, `resolveAccent`, `mapIcon`)

**Files:**
- Create: `lib/kernel/overlay.js` (pure part only — the window shell is Task 4)
- Create: `tests/test-overlay-card.js`
- Modify: `package.json` (add the test file to `npm test`)

**Interfaces:**
- Consumes: nothing (pure, no Electron).
- Produces (used by Tasks 3, 4):
  - `normalizePayload(p) -> { kind:'rows'|'forecast', title:string, accent:string, rows:[{label,value}], current:{temp,icon,condition}|null, forecast:[{time,temp,icon,condition}], narration:[{text,tile}] }`
  - `resolveAccent(name) -> { accent:string, soft:string } | null`
  - `mapIcon(owmCode) -> 'sun'|'moon'|'partly'|'cloud'|'rain'|'drizzle'|'thunder'|'snow'|'mist'`

- [ ] **Step 1: Write the failing tests**

Create `tests/test-overlay-card.js`:

```js
// tests/test-overlay-card.js
// Pure tests for the overlay card's payload normalization, accent palette, and icon map.
// Plain node + assert, no framework. The Electron window shell is NOT tested here.
const assert = require('assert');
const overlay = require('../lib/kernel/overlay');

// --- resolveAccent: known semantic names -> colors; unknown -> null (theme fallback) ---
const sky = overlay.resolveAccent('sky');
assert.ok(sky && /^#/.test(sky.accent) && /rgba\(/.test(sky.soft), 'sky maps to a color pair');
assert.ok(overlay.resolveAccent('blue'), 'blue is a known accent');
assert.strictEqual(overlay.resolveAccent('hotpink'), null, 'unknown accent -> null');
assert.strictEqual(overlay.resolveAccent(''), null, 'empty accent -> null');
assert.strictEqual(overlay.resolveAccent(undefined), null, 'missing accent -> null');

// --- mapIcon: OpenWeather codes -> sprite ids ---
assert.strictEqual(overlay.mapIcon('01d'), 'sun');
assert.strictEqual(overlay.mapIcon('01n'), 'moon');
assert.strictEqual(overlay.mapIcon('02d'), 'partly');
assert.strictEqual(overlay.mapIcon('02n'), 'partly');
assert.strictEqual(overlay.mapIcon('03d'), 'cloud');
assert.strictEqual(overlay.mapIcon('04n'), 'cloud');
assert.strictEqual(overlay.mapIcon('09d'), 'drizzle');
assert.strictEqual(overlay.mapIcon('10n'), 'rain');
assert.strictEqual(overlay.mapIcon('11d'), 'thunder');
assert.strictEqual(overlay.mapIcon('13d'), 'snow');
assert.strictEqual(overlay.mapIcon('50d'), 'mist');
assert.strictEqual(overlay.mapIcon('99x'), 'cloud', 'unknown code -> cloud default');
assert.strictEqual(overlay.mapIcon(''), 'cloud', 'empty code -> cloud default');

// --- normalizePayload: rows kind ---
let p = overlay.normalizePayload({ title: 'System stats', accent: 'blue', rows: [{ label: 'CPU', value: '8 x Test' }] });
assert.strictEqual(p.kind, 'rows', 'no kind -> rows');
assert.strictEqual(p.title, 'System stats');
assert.deepStrictEqual(p.rows[0], { label: 'CPU', value: '8 x Test' });

// junk coercion: non-string labels/values become strings, junk rows dropped
p = overlay.normalizePayload({ rows: [{ label: 42, value: null }, 'junk', { label: 'ok', value: 'v' }] });
assert.strictEqual(p.kind, 'rows');
assert.strictEqual(typeof p.rows[0].label, 'string');
assert.strictEqual(typeof p.rows[0].value, 'string');
assert.strictEqual(p.rows.length, 2, 'non-object row entries are dropped');
assert.ok(p.title, 'missing title gets a non-empty default');

// caps: rows hard-capped at 12
p = overlay.normalizePayload({ rows: Array.from({ length: 20 }, (_, i) => ({ label: 'L' + i, value: 'v' })) });
assert.strictEqual(p.rows.length, 12, 'rows capped at 12');

// totally junk payloads never throw and always render *something*
assert.strictEqual(overlay.normalizePayload(null).kind, 'rows');
assert.strictEqual(overlay.normalizePayload(undefined).kind, 'rows');
assert.strictEqual(overlay.normalizePayload('weather').kind, 'rows');
assert.ok(Array.isArray(overlay.normalizePayload(null).rows));

// --- normalizePayload: forecast kind ---
const fc = {
  kind: 'forecast', title: 'Tokyo, JP', accent: 'sky',
  current: { temp: 24.4, icon: '01d', condition: 'Clear sky' },
  forecast: Array.from({ length: 8 }, (_, i) => ({ time: (9 + i * 3) % 24 + ':00', temp: 20 + i, icon: '02d', condition: 'Clouds' })),
  narration: [{ text: 'Right now 24.', tile: 0 }, { text: 'Later 27.', tile: 7 }]
};
p = overlay.normalizePayload(fc);
assert.strictEqual(p.kind, 'forecast');
assert.strictEqual(p.forecast.length, 8);
assert.strictEqual(p.current.temp, 24, 'temps rounded to integers');
assert.strictEqual(p.narration.length, 2);
assert.strictEqual(p.narration[1].tile, 7);

// forecast tiles capped at 8
p = overlay.normalizePayload(Object.assign({}, fc, { forecast: Array.from({ length: 12 }, () => ({ time: '09:00', temp: 20, icon: '01d', condition: 'Clear' })) }));
assert.strictEqual(p.forecast.length, 8, 'tiles capped at 8');

// narration tile indices out of range are clamped into [0, tiles-1]
p = overlay.normalizePayload(Object.assign({}, fc, { narration: [{ text: 'x', tile: 99 }, { text: 'y', tile: -3 }] }));
assert.strictEqual(p.narration[0].tile, 7);
assert.strictEqual(p.narration[1].tile, 0);

// forecast kind with an empty/missing forecast[] demotes to rows (never a dead card)
p = overlay.normalizePayload({ kind: 'forecast', title: 'Tokyo', forecast: [] });
assert.strictEqual(p.kind, 'rows', 'empty forecast demotes to rows');
p = overlay.normalizePayload({ kind: 'forecast', title: 'Tokyo' });
assert.strictEqual(p.kind, 'rows', 'missing forecast demotes to rows');

console.log('test-overlay-card: all assertions passed');
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node tests/test-overlay-card.js`
Expected: FAIL with `Cannot find module '../lib/kernel/overlay'`

- [ ] **Step 3: Implement the pure helpers**

Create `lib/kernel/overlay.js`:

```js
// lib/kernel/overlay.js
// The Kernel Overlay Card: a dedicated, lightweight always-on-top window that renders
// handler results — kind:'forecast' (iOS-style weather strip) or kind:'rows' (label/value
// list). This is the ONLY Electron-touching module under lib/kernel/; the pure kernel core
// never imports it (main.js is the composition point), so kernel suites stay plain-node.
//
// Pure pieces (normalizePayload / resolveAccent / mapIcon) are exported for tests; the
// window shell (open / update / scrollTo / dismiss / isOpen) is added below them.

// Card-local semantic accent palette. A payload accent that isn't listed here returns
// null and the renderer falls back to the user's theme --accent.
const ACCENTS = {
  sky:    { accent: '#6fc3ff', soft: 'rgba(111,195,255,.16)' },
  blue:   { accent: '#4c8dff', soft: 'rgba(76,141,255,.16)' },
  teal:   { accent: '#35d6b0', soft: 'rgba(53,214,176,.16)' },
  amber:  { accent: '#f5b53d', soft: 'rgba(245,181,61,.16)' },
  violet: { accent: '#a98bff', soft: 'rgba(169,139,255,.16)' }
};

function resolveAccent(name) {
  return ACCENTS[String(name || '')] || null;
}

// OpenWeather icon code (01d..50n) -> our inline SVG sprite id. Default: cloud.
function mapIcon(code) {
  const c = String(code || '');
  if (c.startsWith('01')) return c.endsWith('n') ? 'moon' : 'sun';
  if (c.startsWith('02')) return 'partly';
  if (c.startsWith('03') || c.startsWith('04')) return 'cloud';
  if (c.startsWith('09')) return 'drizzle';
  if (c.startsWith('10')) return 'rain';
  if (c.startsWith('11')) return 'thunder';
  if (c.startsWith('13')) return 'snow';
  if (c.startsWith('50')) return 'mist';
  return 'cloud';
}

const MAX_ROWS = 12;
const MAX_TILES = 8;

function str(v, fallback) {
  if (v === null || v === undefined) return fallback;
  const s = String(v).trim();
  return s || fallback;
}

// Any payload -> a safe render model the card can draw without ever seeing undefined.
// kind:'forecast' REQUIRES a non-empty forecast[]; anything else demotes to 'rows'.
function normalizePayload(p) {
  p = (p && typeof p === 'object') ? p : {};
  const title = str(p.title, 'Caryl');
  const accent = str(p.accent, '');

  const rows = (Array.isArray(p.rows) ? p.rows : [])
    .filter((r) => r && typeof r === 'object')
    .slice(0, MAX_ROWS)
    .map((r) => ({ label: str(r.label, ''), value: str(r.value, '') }));

  const tiles = (Array.isArray(p.forecast) ? p.forecast : [])
    .filter((t) => t && typeof t === 'object')
    .slice(0, MAX_TILES)
    .map((t) => ({
      time: str(t.time, '--:--'),
      temp: Math.round(Number(t.temp) || 0),
      icon: mapIcon(t.icon),
      condition: str(t.condition, '')
    }));

  if (p.kind === 'forecast' && tiles.length > 0) {
    const cur = (p.current && typeof p.current === 'object') ? p.current : {};
    const narration = (Array.isArray(p.narration) ? p.narration : [])
      .filter((n) => n && typeof n === 'object' && str(n.text, ''))
      .map((n) => ({
        text: str(n.text, ''),
        tile: Math.min(tiles.length - 1, Math.max(0, Number(n.tile) || 0))
      }));
    return {
      kind: 'forecast', title, accent, rows: [],
      current: {
        temp: Math.round(Number(cur.temp) || 0),
        icon: mapIcon(cur.icon),
        condition: str(cur.condition, '')
      },
      forecast: tiles, narration
    };
  }

  return { kind: 'rows', title, accent, rows, current: null, forecast: [], narration: [] };
}

module.exports = { normalizePayload, resolveAccent, mapIcon, ACCENTS };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node tests/test-overlay-card.js`
Expected: `test-overlay-card: all assertions passed`

- [ ] **Step 5: Add the suite to `npm test`**

In `package.json`, change the `test` script line — insert `node tests/test-overlay-card.js` after `test-integration.js`:

```json
"test": "node tests/test-engines.js && node tests/test-migrate.js && node tests/test-downloads.js && node tests/test-kernel.js && node tests/test-handlers.js && node tests/test-integration.js && node tests/test-overlay-card.js && .venv\\Scripts\\python.exe tests/test_automation.py",
```

- [ ] **Step 6: Run the node suites to confirm nothing broke**

Run: `node tests/test-kernel.js && node tests/test-handlers.js && node tests/test-integration.js && node tests/test-overlay-card.js`
Expected: all four print `... all assertions passed`

- [ ] **Step 7: Commit**

```bash
git add lib/kernel/overlay.js tests/test-overlay-card.js package.json
git commit -m "feat(overlay-card): pure payload normalization, accent palette, icon map

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Weather handler forecast upgrade (24 h tiles + narration)

**Files:**
- Modify: `lib/kernel/handlers/weather.js`
- Modify: `tests/test-handlers.js` (append weather-forecast pure tests)
- Modify: `tests/test-integration.js` (forecast e2e + demotion e2e)

**Interfaces:**
- Consumes: existing `weather.js` internals (`normalize`, `buildPayload`, `summarize`, `mapError`, `fetchWeather`, `run(params, ctx)` with `ctx.config` / `ctx.fetch`).
- Produces (used by Task 6 via the kernel result):
  - `run()` success now returns `overlay` as the `kind:'forecast'` payload (spec shape) with `narration:[{text,tile}]`, and `speak` === narration texts joined with a space. On forecast-fetch failure with current success: the existing `kind`-less rows payload + single-sentence summary (unchanged behavior).
  - New pure exports: `normalizeForecast(data) -> {tiles:[{time,temp,icon,condition}], tz:number}|null`, `buildForecastPayload(norm, tiles, units) -> payload`, `buildNarration(norm, tiles, units) -> [{text,tile}]`, `fmtHour(unixSec, tzSec) -> 'HH:00'`.

- [ ] **Step 1: Write the failing pure tests**

Append to `tests/test-handlers.js` (before the final `console.log` line):

```js
// --- weather: forecast normalization + narration (pure) ---
assert.strictEqual(weather.fmtHour(0, 0), '00:00');
assert.strictEqual(weather.fmtHour(15 * 3600, 0), '15:00');
assert.strictEqual(weather.fmtHour(23 * 3600, 2 * 3600), '01:00', 'tz offset wraps past midnight');

// OpenWeather /forecast shape: { city:{timezone}, list:[{dt, main:{temp}, weather:[{description,icon}]}] }
function owmForecast(n) {
  return {
    city: { timezone: 0 },
    list: Array.from({ length: n }, (_, i) => ({
      dt: (9 + i * 3) * 3600,
      main: { temp: 20 + i },
      weather: [{ description: i === 4 ? 'light rain' : 'few clouds', icon: i === 4 ? '10d' : '02d' }]
    }))
  };
}
let f = weather.normalizeForecast(owmForecast(12));
assert.ok(f && Array.isArray(f.tiles), 'normalizeForecast returns tiles');
assert.strictEqual(f.tiles.length, 8, 'takes the first 8 three-hour steps (~24h)');
assert.strictEqual(f.tiles[0].time, '09:00');
assert.strictEqual(f.tiles[0].temp, 20);
assert.strictEqual(f.tiles[4].icon, '10d', 'raw icon code preserved (mapping happens card-side)');
assert.strictEqual(weather.normalizeForecast({}), null, 'missing list -> null');
assert.strictEqual(weather.normalizeForecast({ list: [] }), null, 'empty list -> null');
assert.strictEqual(weather.normalizeForecast(null), null);

// buildForecastPayload: spec shape
const wnorm = { city: 'Tokyo', country: 'JP', temp: 24.4, feelsLike: 25, humidity: 40, description: 'clear sky', windSpeed: 3 };
let fp = weather.buildForecastPayload(wnorm, f.tiles, 'metric');
assert.strictEqual(fp.kind, 'forecast');
assert.strictEqual(fp.title, 'Tokyo, JP');
assert.strictEqual(fp.accent, 'sky');
assert.strictEqual(fp.current.temp, 24.4);
assert.strictEqual(fp.forecast.length, 8);
assert.ok(Array.isArray(fp.narration) && fp.narration.length >= 2, 'payload embeds narration');

// buildNarration: ordered segments, tiles in range, first tile is 0, last is the strip end;
// joined text == what run() will speak
const segs = weather.buildNarration(wnorm, f.tiles, 'metric');
assert.ok(segs.length >= 2 && segs.length <= 4, '2-4 segments');
assert.strictEqual(segs[0].tile, 0, 'first segment anchors the current tile');
assert.strictEqual(segs[segs.length - 1].tile, f.tiles.length - 1, 'last segment anchors the strip end');
segs.forEach((s) => {
  assert.ok(s.text && typeof s.text === 'string');
  assert.ok(s.tile >= 0 && s.tile < f.tiles.length, 'tile index in range');
});
assert.ok(/rain/i.test(segs.map((s) => s.text).join(' ')), 'precipitation in the strip is mentioned');
```

- [ ] **Step 2: Run to verify the new tests fail**

Run: `node tests/test-handlers.js`
Expected: FAIL with `weather.fmtHour is not a function`

- [ ] **Step 3: Implement the forecast upgrade in `weather.js`**

In `lib/kernel/handlers/weather.js`:

**(a)** After the `ENDPOINT` const, add:

```js
const FORECAST_ENDPOINT = 'https://api.openweathermap.org/data/2.5/forecast';
```

**(b)** After `mapError`, add the new pure pieces:

```js
// Unix seconds + tz offset -> local "HH:00" label for a 3-hour forecast step.
function fmtHour(unixSec, tzSec) {
  const h = Math.floor((((Number(unixSec) || 0) + (Number(tzSec) || 0)) % 86400) / 3600);
  return String((h + 24) % 24).padStart(2, '0') + ':00';
}

// Raw OpenWeather /forecast JSON -> the next ~24h as 8 three-hour tiles, or null.
// Icon codes stay RAW here (e.g. '10d'); the card maps them to sprite ids.
function normalizeForecast(data) {
  if (!data || typeof data !== 'object' || !Array.isArray(data.list) || !data.list.length) return null;
  const tz = (data.city && Number(data.city.timezone)) || 0;
  const tiles = [];
  for (const e of data.list.slice(0, 8)) {
    if (!e || !e.main || typeof e.main.temp !== 'number') continue;
    const w = (Array.isArray(e.weather) && e.weather[0]) || {};
    tiles.push({
      time: fmtHour(e.dt, tz),
      temp: e.main.temp,
      icon: w.icon || '',
      condition: cap(w.description || w.main || '')
    });
  }
  return tiles.length ? { tiles, tz } : null;
}

// The spoken summary as ordered, tile-anchored segments: now -> later today -> the strip's
// end (~24h out), with any precipitation called out. Joined in order it IS run()'s speak.
function buildNarration(norm, tiles, units) {
  const sym = unitSymbol(units);
  const segs = [];
  const where = norm.city ? ' in ' + norm.city : '';
  segs.push({
    text: 'Right now' + where + ' it’s ' + Math.round(norm.temp) + sym +
      (norm.description ? ' with ' + norm.description : '') + '.',
    tile: 0
  });
  const mid = Math.min(3, tiles.length - 1);
  const wet = tiles.findIndex((t) => /rain|drizzle|thunder|snow|storm|shower/i.test(t.condition));
  if (wet >= 0) {
    segs.push({
      text: 'Around ' + tiles[wet].time + ', expect ' + tiles[wet].condition.toLowerCase() +
        ' at ' + Math.round(tiles[wet].temp) + sym + '.',
      tile: wet
    });
  } else if (mid > 0) {
    segs.push({
      text: 'By ' + tiles[mid].time + ' it’ll be around ' + Math.round(tiles[mid].temp) + sym + '.',
      tile: mid
    });
  }
  const last = tiles.length - 1;
  if (last > 0) {
    segs.push({
      text: 'This time tomorrow, about ' + Math.round(tiles[last].temp) + sym +
        (tiles[last].condition ? ' and ' + tiles[last].condition.toLowerCase() : '') + '.',
      tile: last
    });
  }
  return segs;
}

// normalized current + tiles -> the kind:'forecast' overlay payload (spec shape).
function buildForecastPayload(norm, tiles, units) {
  return {
    kind: 'forecast',
    title: norm.city ? (norm.city + (norm.country ? ', ' + norm.country : '')) : 'Weather',
    accent: 'sky',
    current: { temp: norm.temp, icon: norm.icon || '', condition: cap(norm.description || '') },
    forecast: tiles,
    narration: buildNarration(norm, tiles, units)
  };
}
```

**(c)** In `normalize()`, also carry the current icon code — add one property to the returned object:

```js
    icon: (w.icon || ''),
```

**(d)** After `fetchWeather`, add the forecast fetch (same injected-fetch discipline):

```js
// Async shell for the 5-day/3-hour forecast. Same safe-error mapping as fetchWeather.
async function fetchForecast(opts) {
  opts = opts || {};
  const f = opts.fetchImpl || (typeof fetch === 'function' ? fetch : null);
  if (typeof f !== 'function') return { ok: false, error: 'no network client' };
  const url = FORECAST_ENDPOINT + '?q=' + encodeURIComponent(opts.location) +
    '&units=' + encodeURIComponent(opts.units || 'metric') +
    '&appid=' + encodeURIComponent(opts.apiKey);
  let resp;
  try { resp = await f(url); }
  catch (_e) { return { ok: false, error: 'network' }; }
  if (!resp || resp.status !== 200) return { ok: false, error: 'status ' + (resp && resp.status) };
  let body;
  try { body = await resp.json(); }
  catch (_e) { return { ok: false, error: 'malformed' }; }
  const norm = normalizeForecast(body);
  if (!norm) return { ok: false, error: 'incomplete' };
  return { ok: true, data: norm };
}
```

**(e)** Replace the end of `run()` — the two lines after the `fetchWeather` call — so both endpoints are fetched in parallel and a forecast failure demotes gracefully:

```js
  const [res, fres] = await Promise.all([
    fetchWeather({ location, apiKey, units, fetchImpl: ctx.fetch }),
    fetchForecast({ location, apiKey, units, fetchImpl: ctx.fetch })
  ]);
  if (!res.ok) return { ok: false, error: res.error };
  if (fres.ok) {
    const payload = buildForecastPayload(res.data, fres.data.tiles, units);
    const speak = payload.narration.map((s) => s.text).join(' ');
    return { ok: true, speak, overlay: payload, value: res.data };
  }
  // Forecast unavailable -> today's rows card + the short summary (never a dead card).
  return { ok: true, speak: summarize(res.data, units), overlay: buildPayload(res.data, units), value: res.data };
```

**(f)** Extend `module.exports`:

```js
module.exports = {
  run, fetchWeather, fetchForecast, normalize, normalizeForecast,
  buildPayload, buildForecastPayload, buildNarration, fmtHour, mapError, summarize
};
```

- [ ] **Step 4: Run the pure tests**

Run: `node tests/test-handlers.js`
Expected: `test-handlers: all assertions passed`

- [ ] **Step 5: Write the failing integration tests**

In `tests/test-integration.js`, the existing weather e2e mocks ONE endpoint. Update the mock to dispatch by URL and add the demotion case. Replace the `fetchImpl` line of the existing weather kernel setup with:

```js
    fetchImpl: async (url) => {
      weatherFetchCalls++;
      if (url.indexOf('/forecast') >= 0) return { status: 200, json: async () => OWM_FORECAST };
      return { status: 200, json: async () => OWM };
    }
```

Add the forecast fixture next to the existing `OWM` fixture:

```js
const OWM_FORECAST = {
  city: { timezone: 32400 },
  list: Array.from({ length: 10 }, (_, i) => ({
    dt: 1751600000 + i * 10800,
    main: { temp: 22 + i },
    weather: [{ description: i === 2 ? 'light rain' : 'scattered clouds', icon: i === 2 ? '10d' : '03d' }]
  }))
};
```

Update the existing weather e2e assertions (after `wdecision`) — the overlay is now the forecast card; the fetch-count assertion changes from 1 to 2:

```js
  assert.strictEqual(weatherFetchCalls, 2, 'current + forecast fetched, no real network');
  assert.strictEqual(wdecision.result.overlay.kind, 'forecast', 'overlay is the forecast card');
  assert.strictEqual(wdecision.result.overlay.forecast.length, 8, '8 three-hour tiles');
  assert.ok(wdecision.result.overlay.narration.length >= 2, 'narration segments present');
  assert.strictEqual(
    wdecision.result.speak,
    wdecision.result.overlay.narration.map((s) => s.text).join(' '),
    'speak is exactly the joined narration'
  );
```

Then append a demotion e2e after the existing weather block:

```js
  // ---- weather: forecast endpoint fails -> demote to the rows card, never a dead card ----
  const wkernel2 = createKernel({
    registry: registryMod.createRegistry({ builtins: BUILTINS }),
    getConfig: () => ({ openWeatherApiKey: 'test-key', weatherUnits: 'metric' }),
    fetchImpl: async (url) => {
      if (url.indexOf('/forecast') >= 0) return { status: 500, json: async () => ({}) };
      return { status: 200, json: async () => OWM };
    }
  });
  const wd2 = await wkernel2.handle('weather in Tokyo');
  assert.ok(wd2.handled && wd2.result.ok, 'demoted weather still succeeds');
  assert.ok(!wd2.result.overlay.kind, 'demoted overlay is the plain rows payload');
  assert.ok(Array.isArray(wd2.result.overlay.rows) && wd2.result.overlay.rows.length, 'rows present');
```

(`createKernel`, `BUILTINS`, and `registryMod` are already imported at the top of the file: `const { createKernel, BUILTINS } = require('../lib/kernel');` / `const registryMod = require('../lib/kernel/registry');`.)

- [ ] **Step 6: Run integration tests to verify they fail, then pass**

Run: `node tests/test-integration.js`
Expected first: FAIL on the fetch-count or kind assertion if step 3 was incomplete; after fixing: `test-integration: all assertions passed`

- [ ] **Step 7: Run the full node suite**

Run: `node tests/test-kernel.js && node tests/test-handlers.js && node tests/test-integration.js && node tests/test-overlay-card.js`
Expected: all pass

- [ ] **Step 8: Commit**

```bash
git add lib/kernel/handlers/weather.js tests/test-handlers.js tests/test-integration.js
git commit -m "feat(weather): 24h forecast tiles + tile-anchored narration, rows demotion on forecast failure

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: `renderer/overlay-card.html` + preload card methods

**Files:**
- Create: `renderer/overlay-card.html`
- Modify: `preload.js` (card bridge methods)

**Interfaces:**
- Consumes: `bridge.getShellStyle()` (existing), `bridge.status()` (existing, one-time for theme/accent), the render model from Task 1's `normalizePayload` (delivered via `card:render`).
- Produces (used by Task 4): the card listens on `card:render` (payload), `card:scrollTo` (tile index), `card:dismiss` (fade-out); it emits `card:close` when the user dismisses. Preload methods: `onCardRender(cb)`, `onCardScrollTo(cb)`, `onCardDismiss(cb)`, `cardClose()`.

- [ ] **Step 1: Add the card methods to `preload.js`**

After the `// ----- Floating overlay window -----` block:

```js
  // ----- Kernel overlay card (push-based; the card never polls) -----
  onCardRender: (cb) => ipcRenderer.on('card:render', (_e, payload) => cb(payload)),
  onCardScrollTo: (cb) => ipcRenderer.on('card:scrollTo', (_e, index) => cb(index)),
  onCardDismiss: (cb) => ipcRenderer.on('card:dismiss', () => cb()),
  cardClose: () => { try { ipcRenderer.send('card:close'); } catch (_e) {} },
```

- [ ] **Step 2: Create `renderer/overlay-card.html`**

```html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:;">
<title>Caryl card</title>
<style>
/* ============================================================
   KERNEL OVERLAY CARD — iOS-Weather glassmorphism. Rounded on
   purpose (unlike the sharp HUD panel): this is a result
   artifact, not the instrument panel. Zero polling, zero
   frameworks; everything below is vanilla CSS transitions.
   ============================================================ */
:root{
  --card-accent:var(--accent,#7fd1ff);
  --card-soft:var(--accent-soft,rgba(127,209,255,.14));
  --txt:#f2f6fa; --mut:#9fabb8; --faint:#66727e;
  --glass:rgba(10,14,20,.34);
  --mono:ui-monospace,'SF Mono','Cascadia Code',Consolas,monospace;
  --sans:'Inter',system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;
}
*{box-sizing:border-box}
html,body{height:100%;margin:0;background:transparent;overflow:hidden;
  font-family:var(--sans);-webkit-font-smoothing:antialiased;color:var(--txt)}
html[data-theme="fullLight"]{--txt:#1a1d24;--mut:#5f6672;--faint:#9098a4;--glass:rgba(255,255,255,.55)}

#card{
  position:fixed;inset:8px;display:flex;flex-direction:column;
  background:var(--glass);
  -webkit-backdrop-filter:blur(28px) saturate(160%);backdrop-filter:blur(28px) saturate(160%);
  border-radius:22px;overflow:hidden;
  border:1px solid rgba(255,255,255,.14);
  box-shadow:0 24px 80px -20px rgba(0,0,0,.6), 0 0 0 1px rgba(255,255,255,.04) inset;
  opacity:0;transform:scale(.94) translateY(8px);
  transition:opacity .22s ease,transform .26s cubic-bezier(.2,.9,.3,1.2);
}
#card.show{opacity:1;transform:scale(1) translateY(0)}
#card.leaving{opacity:0;transform:scale(.96) translateY(6px);transition:opacity .2s ease,transform .2s ease}
/* Win10: no DWM acrylic behind us -> fail SOLID, never see-through-tint. */
html[data-os="win10"] #card{background:#10141c;-webkit-backdrop-filter:none;backdrop-filter:none}
html[data-os="win10"][data-theme="fullLight"] #card{background:#f2f4f8}

.head{display:flex;align-items:flex-start;gap:10px;padding:16px 16px 4px}
.head .loc{font-size:14px;font-weight:600;letter-spacing:.02em}
.head .cond{font-size:12px;color:var(--mut);margin-top:2px}
.head .grow{flex:1}
.head .x{border:none;background:rgba(255,255,255,.08);color:var(--mut);width:24px;height:24px;
  border-radius:50%;display:grid;place-items:center;font-size:12px;line-height:1;cursor:pointer;flex:none}
.head .x:hover{background:rgba(255,255,255,.16);color:var(--txt)}
html[data-theme="fullLight"] .head .x{background:rgba(0,0,0,.07)}

.now{display:flex;align-items:center;gap:14px;padding:2px 18px 10px}
.now .temp{font-size:44px;font-weight:250;letter-spacing:-.02em;line-height:1}
.now .icon svg{width:44px;height:44px;display:block}

/* ---------- forecast strip: scroll-snap + momentum, edge fades ---------- */
.strip-wrap{position:relative;padding:2px 0 14px}
.strip{display:flex;gap:8px;overflow-x:auto;scroll-snap-type:x proximity;padding:4px 16px;
  scrollbar-width:none;-webkit-overflow-scrolling:touch;scroll-behavior:smooth}
.strip::-webkit-scrollbar{display:none}
.strip-wrap::before,.strip-wrap::after{content:'';position:absolute;top:0;bottom:0;width:18px;z-index:1;pointer-events:none}
.strip-wrap::before{left:0;background:linear-gradient(90deg,rgba(10,14,20,.5),transparent)}
.strip-wrap::after{right:0;background:linear-gradient(270deg,rgba(10,14,20,.5),transparent)}
html[data-os="win10"] .strip-wrap::before,html[data-os="win10"] .strip-wrap::after{display:none}
.tile{flex:none;scroll-snap-align:center;width:64px;padding:10px 6px;border-radius:16px;text-align:center;
  background:rgba(255,255,255,.05);border:1px solid transparent;
  transition:background .25s ease,border-color .25s ease,transform .25s ease}
html[data-theme="fullLight"] .tile{background:rgba(0,0,0,.05)}
.tile .t{font-family:var(--mono);font-size:10px;color:var(--mut);letter-spacing:.04em}
.tile .icon svg{width:26px;height:26px;margin:6px auto 4px;display:block}
.tile .deg{font-size:14px;font-weight:600}
.tile.hot{background:var(--card-soft);border-color:var(--card-accent);transform:translateY(-2px)}
.tile.hot .t{color:var(--card-accent)}
@keyframes pulse{0%{box-shadow:0 0 0 0 var(--card-soft)}100%{box-shadow:0 0 0 12px rgba(0,0,0,0)}}
.tile.pulse{animation:pulse .7s ease-out 1}

/* ---------- rows mode ---------- */
.rows{padding:2px 16px 16px;display:flex;flex-direction:column;gap:2px;overflow-y:auto}
.row{display:flex;align-items:baseline;gap:12px;padding:8px 4px;border-bottom:1px solid rgba(255,255,255,.06)}
.row:last-child{border-bottom:none}
html[data-theme="fullLight"] .row{border-bottom-color:rgba(0,0,0,.06)}
.row .l{font-family:var(--mono);font-size:10.5px;letter-spacing:.08em;text-transform:uppercase;color:var(--mut);flex:none;width:88px}
.row .v{font-size:13.5px;flex:1;text-align:right;word-break:break-word}
.hidden{display:none !important}
</style>
<link rel="stylesheet" href="theme.css">
</head>
<body>
<!-- Inline SVG sprite: the 9 weather glyphs mapIcon() targets. Stroke-based, accent-tinted. -->
<svg width="0" height="0" style="position:absolute" aria-hidden="true">
  <defs>
    <g id="i-sun"><circle cx="12" cy="12" r="4.2"/><path d="M12 3v2.2M12 18.8V21M3 12h2.2M18.8 12H21M5.4 5.4l1.6 1.6M17 17l1.6 1.6M18.6 5.4L17 7M7 17l-1.6 1.6"/></g>
    <g id="i-moon"><path d="M20 13.2A8 8 0 1 1 10.8 4 6.5 6.5 0 0 0 20 13.2z"/></g>
    <g id="i-partly"><circle cx="8.5" cy="9" r="3.4"/><path d="M8.5 3.4v1.4M3 9h1.4M4.6 5.1l1 1"/><path d="M9 17.5h8.3a3.2 3.2 0 0 0 .4-6.4 4.6 4.6 0 0 0-8.9 1.1A2.7 2.7 0 0 0 9 17.5z"/></g>
    <g id="i-cloud"><path d="M7 18h9.8a3.7 3.7 0 0 0 .5-7.4 5.3 5.3 0 0 0-10.3 1.3A3.1 3.1 0 0 0 7 18z"/></g>
    <g id="i-rain"><path d="M7 14h9.8a3.7 3.7 0 0 0 .5-7.4A5.3 5.3 0 0 0 7 7.9 3.1 3.1 0 0 0 7 14z"/><path d="M8.5 17l-1 2.4M12.5 17l-1 2.4M16.5 17l-1 2.4"/></g>
    <g id="i-drizzle"><path d="M7 14h9.8a3.7 3.7 0 0 0 .5-7.4A5.3 5.3 0 0 0 7 7.9 3.1 3.1 0 0 0 7 14z"/><path d="M9 17.2v1M13 17.2v1M17 17.2v1"/></g>
    <g id="i-thunder"><path d="M7 13h9.8a3.7 3.7 0 0 0 .5-7.4A5.3 5.3 0 0 0 7 6.9 3.1 3.1 0 0 0 7 13z"/><path d="M12.6 14.5l-2.4 3.4h3l-1.8 3.1"/></g>
    <g id="i-snow"><path d="M7 14h9.8a3.7 3.7 0 0 0 .5-7.4A5.3 5.3 0 0 0 7 7.9 3.1 3.1 0 0 0 7 14z"/><path d="M9 17.5h.01M13 19h.01M17 17.5h.01M11 20.5h.01M15 20.5h.01" stroke-linecap="round" stroke-width="2.4"/></g>
    <g id="i-mist"><path d="M4 9h13M6 12.5h13M4 16h11" stroke-linecap="round"/></g>
  </defs>
</svg>

<div id="card">
  <div class="head">
    <div><div class="loc" id="loc"></div><div class="cond" id="cond"></div></div>
    <span class="grow"></span>
    <button class="x" id="btn-x" title="Dismiss">&#10005;</button>
  </div>
  <div class="now" id="now">
    <div class="temp" id="temp"></div>
    <div class="icon" id="cur-icon"></div>
  </div>
  <div class="strip-wrap" id="strip-wrap"><div class="strip" id="strip"></div></div>
  <div class="rows hidden" id="rows"></div>
</div>

<script>
(function(){
  const $ = (id) => document.getElementById(id);
  const bridge = window.bridge || {};

  // OS + theme, fetched ONCE at load (no polling; the card lives for seconds).
  bridge.getShellStyle && bridge.getShellStyle().then(function(s){
    document.documentElement.dataset.os = (s && s.osVariant) || 'win10';
  }).catch(function(){ document.documentElement.dataset.os = 'win10'; });
  bridge.status && bridge.status().then(function(s){
    if (s && s.theme) document.documentElement.dataset.theme = s.theme;
    if (s && s.accent) document.documentElement.dataset.accent = s.accent;
  }).catch(function(){});

  function esc(t){ return String(t==null?'':t).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
  function icon(id, stroke){
    return '<svg viewBox="0 0 24 24" fill="none" stroke="'+(stroke||'currentColor')+'" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><use href="#i-'+esc(id)+'"/></svg>';
  }

  // Manual-drag independence: while the user is touching the strip (and for 4s after),
  // scrollTo() moves ONLY the highlight, never the scroll position.
  let engagedUntil = 0;
  function engaged(){ return Date.now() < engagedUntil; }
  // Hover defers auto-dismissal: main asks us to leave, we wait until the pointer leaves +2s.
  let hovering = false, pendingDismiss = false;

  function applyAccent(p){
    // Payload accent (resolved main-side into concrete colors) wins; unknown -> theme --accent.
    if (p.accentColors && p.accentColors.accent) {
      document.documentElement.style.setProperty('--card-accent', p.accentColors.accent);
      document.documentElement.style.setProperty('--card-soft', p.accentColors.soft);
    } else {
      document.documentElement.style.removeProperty('--card-accent');
      document.documentElement.style.removeProperty('--card-soft');
    }
  }

  function render(p){
    applyAccent(p);
    $('loc').textContent = p.title || '';
    pendingDismiss = false;
    if (p.kind === 'forecast') {
      $('cond').textContent = (p.current && p.current.condition) || '';
      $('temp').textContent = (p.current ? p.current.temp : '--') + '°';
      $('cur-icon').innerHTML = icon(p.current ? p.current.icon : 'cloud', 'var(--card-accent)');
      $('now').classList.remove('hidden');
      $('strip-wrap').classList.remove('hidden');
      $('rows').classList.add('hidden');
      $('strip').innerHTML = (p.forecast || []).map(function(t, i){
        return '<div class="tile" data-i="'+i+'">' +
          '<div class="t">'+esc(t.time)+'</div>' +
          '<div class="icon">'+icon(t.icon)+'</div>' +
          '<div class="deg">'+esc(t.temp)+'°</div></div>';
      }).join('');
    } else {
      $('cond').textContent = '';
      $('now').classList.add('hidden');
      $('strip-wrap').classList.add('hidden');
      $('rows').classList.remove('hidden');
      $('rows').innerHTML = (p.rows || []).map(function(r){
        return '<div class="row"><span class="l">'+esc(r.label)+'</span><span class="v">'+esc(r.value)+'</span></div>';
      }).join('');
    }
    requestAnimationFrame(function(){ $('card').classList.add('show'); $('card').classList.remove('leaving'); });
  }

  // api.scrollTo(index): highlight-pulse the tile; scroll it into view unless the user
  // is (recently) driving the strip themselves.
  function scrollTo(i){
    const tiles = $('strip').children;
    if (!tiles.length) return;
    i = Math.min(tiles.length - 1, Math.max(0, i|0));
    for (let k = 0; k < tiles.length; k++) tiles[k].classList.remove('hot','pulse');
    const el = tiles[i];
    el.classList.add('hot','pulse');
    setTimeout(function(){ el.classList.remove('pulse'); }, 750);
    if (!engaged()) el.scrollIntoView({ behavior:'smooth', inline:'center', block:'nearest' });
  }

  function leave(){
    $('card').classList.add('leaving');
    // main hides the window after the fade (Task 4 waits 260ms) — nothing else to do here.
  }
  function dismissRequested(){
    if (hovering) { pendingDismiss = true; return; } // wait for pointer to leave (+2s)
    leave();
  }
  function close(){ bridge.cardClose && bridge.cardClose(); }

  // --- user interaction wiring ---
  $('btn-x').onclick = close;
  document.addEventListener('keydown', function(e){ if (e.key === 'Escape') close(); });
  window.addEventListener('blur', close); // click-outside
  const strip = $('strip');
  ['pointerdown','wheel','touchstart'].forEach(function(ev){
    strip.addEventListener(ev, function(){ engagedUntil = Date.now() + 4000; }, { passive:true });
  });
  strip.addEventListener('scroll', function(){ if (engaged()) engagedUntil = Date.now() + 4000; }, { passive:true });
  document.addEventListener('pointerenter', function(){ hovering = true; });
  document.addEventListener('pointerleave', function(){
    hovering = false;
    if (pendingDismiss) setTimeout(function(){ if (!hovering && pendingDismiss) { pendingDismiss = false; leave(); } }, 2000);
  });

  // --- push IPC in ---
  bridge.onCardRender && bridge.onCardRender(render);
  bridge.onCardScrollTo && bridge.onCardScrollTo(scrollTo);
  bridge.onCardDismiss && bridge.onCardDismiss(dismissRequested);
})();
</script>
</body>
</html>
```

- [ ] **Step 3: Sanity-check the file loads standalone**

Run: `node -e "const s=require('fs').readFileSync('renderer/overlay-card.html','utf8'); if(!/onCardRender/.test(s)||!/i-thunder/.test(s)) throw new Error('missing pieces'); console.log('overlay-card.html ok, bytes:', s.length)"`
Expected: `overlay-card.html ok, bytes: <n>`

(Real visual verification happens in Task 4 via the dummy triggers — that's the point of the phasing.)

- [ ] **Step 4: Commit**

```bash
git add renderer/overlay-card.html preload.js
git commit -m "feat(overlay-card): iOS-glass card renderer (forecast strip + rows), push-IPC bridge methods

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Window shell in `overlay.js` + dev dummy triggers in `main.js` (Phase 2a gate)

**Files:**
- Modify: `lib/kernel/overlay.js` (append the window shell)
- Modify: `main.js` (require, `card:close` handler, dev shortcuts, re-registration hook)

**Interfaces:**
- Consumes: Task 1 `normalizePayload`/`resolveAccent`; Task 3's `card:*` channels; main.js's existing `shellStyle()` helper and dev gate.
- Produces (used by Tasks 5–6): `overlay.open(payload) -> cardId:number`, `overlay.scrollTo(index, cardId?)`, `overlay.dismiss(reason, cardId?)`, `overlay.isOpen() -> boolean`. All no-op safely when the window is gone or the cardId is stale.

- [ ] **Step 1: Append the window shell to `lib/kernel/overlay.js`**

Add below the pure section (before `module.exports`), and extend the exports:

```js
// ============================================================================
// Window shell. Everything below touches Electron; nothing above does.
// The window is created once, reused, and hidden (not destroyed) between cards.
// ============================================================================
let _electron = null;
function electron() { return _electron || (_electron = require('electron')); }

let win = null;             // the one card BrowserWindow
let cardSeq = 0;            // monotonic id; stale scrollTo/dismiss calls are ignored
let currentId = 0;          // id of the card currently showing (0 = none)
let safetyTimer = null;
const SAFETY_MS = 30000;    // force-dismiss if no speech-end ever arrives
const FADE_MS = 260;        // matches the renderer's leaving transition

// deps injected by main.js at first use: { preloadPath, shellStyle }
let deps = null;
function init(d) { deps = d; }

function sizeFor(model) {
  if (model.kind === 'forecast') return { width: 440, height: 268 };
  return { width: 340, height: Math.min(420, 128 + 38 * Math.max(1, model.rows.length)) };
}

function createWin(w, h) {
  const { BrowserWindow, screen } = electron();
  const wa = screen.getPrimaryDisplay().workArea;
  win = new BrowserWindow({
    x: wa.x + Math.round((wa.width - w) / 2),
    y: wa.y + Math.round((wa.height - h) / 2),
    width: w, height: h,
    frame: false, transparent: true, hasShadow: false, resizable: false, roundedCorners: false,
    skipTaskbar: true, alwaysOnTop: true, show: false, fullscreenable: false,
    backgroundColor: '#00000000',
    backgroundMaterial: (process.platform === 'win32' && deps.shellStyle().blur) ? 'acrylic' : undefined,
    webPreferences: {
      preload: deps.preloadPath,
      contextIsolation: true, nodeIntegration: false, sandbox: false,
      backgroundThrottling: false
    }
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  // Same capture exclusion as the HUD panel/bubble: the automation vision loop must never
  // see our own card sitting over the desktop (see createOverlay() in main.js).
  try { win.setContentProtection(true); } catch (_e) {}
  win.loadFile(require('path').join(__dirname, '..', '..', 'renderer', 'overlay-card.html'));
  win.on('closed', () => { win = null; currentId = 0; });
  return win;
}

function send(channel, arg) {
  if (win && !win.isDestroyed()) { try { win.webContents.send(channel, arg); } catch (_e) {} }
}

// Show a card. Returns its id (pass it to scrollTo/dismiss to guard against staleness).
function open(payload) {
  if (!deps) return 0;
  const model = normalizePayload(payload);
  model.accentColors = resolveAccent(model.accent); // concrete colors ride the payload
  const id = ++cardSeq;
  currentId = id;
  const { width, height } = sizeFor(model);

  const show = () => {
    if (currentId !== id) return; // a newer card replaced us while loading
    const { screen } = electron();
    const wa = screen.getPrimaryDisplay().workArea;
    win.setBounds({ x: wa.x + Math.round((wa.width - width) / 2), y: wa.y + Math.round((wa.height - height) / 2), width, height });
    send('card:render', model);
    win.showInactive();
  };

  if (!win || win.isDestroyed()) {
    createWin(width, height);
    win.webContents.once('did-finish-load', show);
  } else {
    show();
  }

  if (safetyTimer) clearTimeout(safetyTimer);
  safetyTimer = setTimeout(() => dismiss('safety-timeout', id), SAFETY_MS);
  return id;
}

function scrollTo(index, cardId) {
  if (cardId && cardId !== currentId) return; // stale narration event
  send('card:scrollTo', index);
}

function dismiss(reason, cardId) {
  if (cardId && cardId !== currentId) return; // stale (a newer card is up)
  if (!win || win.isDestroyed() || currentId === 0) return;
  currentId = 0;
  if (safetyTimer) { clearTimeout(safetyTimer); safetyTimer = null; }
  send('card:dismiss');
  setTimeout(() => { if (win && !win.isDestroyed() && currentId === 0) win.hide(); }, FADE_MS + 2200);
  // +2200: the renderer may hold the fade while hovered (pointer-leave grace). Hiding a bit
  // late is invisible (the card is already transparent); hiding early cuts the animation.
}

function isOpen() { return currentId !== 0 && !!win && !win.isDestroyed() && win.isVisible(); }
```

Change the exports line to:

```js
module.exports = { normalizePayload, resolveAccent, mapIcon, ACCENTS, init, open, scrollTo, dismiss, isOpen };
```

- [ ] **Step 2: Run the pure tests again (shell must not break plain-node loading)**

Run: `node tests/test-overlay-card.js`
Expected: `test-overlay-card: all assertions passed` — the `require('electron')` is lazy (inside `electron()`), so loading the module under plain node stays safe. If this fails with `Cannot find module 'electron'`, a require leaked to the top level — fix that, don't skip the test.

- [ ] **Step 3: Wire main.js — init, `card:close`, dev triggers**

**(a)** Near the kernel section (`function caryKernel()`, main.js ~3444), add:

```js
// ---- Kernel overlay card: the window that renders handler results ----
const cardOverlay = require('./lib/kernel/overlay');
let cardOverlayInited = false;
function cardCtl() {
  if (!cardOverlayInited) {
    cardOverlay.init({ preloadPath: path.join(__dirname, 'preload.js'), shellStyle });
    cardOverlayInited = true;
  }
  return cardOverlay;
}
ipcMain.on('card:close', () => { cardCtl().dismiss('manual'); });
```

**(b)** Add the dev dummy triggers (same file, right after):

```js
// Dev-only card fixtures: perfect the card with ZERO kernel involvement.
//   Ctrl+Alt+K -> cycle fixture payloads    Ctrl+Alt+J -> fake narration sweep
// Gated like DevTools (--dev / CARYL_DEV=1). Voice-hotkey code calls
// globalShortcut.unregisterAll(), so registerDevCardShortcuts() must be re-run after it.
const CARD_FIXTURES = [
  { kind: 'forecast', title: 'Tokyo, JP', accent: 'sky',
    current: { temp: 24, icon: '01d', condition: 'Clear sky' },
    forecast: [
      { time: '15:00', temp: 24, icon: '01d', condition: 'Clear' },
      { time: '18:00', temp: 22, icon: '02d', condition: 'Few clouds' },
      { time: '21:00', temp: 19, icon: '10n', condition: 'Light rain' },
      { time: '00:00', temp: 17, icon: '10n', condition: 'Rain' },
      { time: '03:00', temp: 16, icon: '11n', condition: 'Thunderstorm' },
      { time: '06:00', temp: 16, icon: '13d', condition: 'Snow' },
      { time: '09:00', temp: 18, icon: '50d', condition: 'Mist' },
      { time: '12:00', temp: 21, icon: '03d', condition: 'Clouds' }
    ],
    narration: [{ text: 'now', tile: 0 }, { text: 'tonight', tile: 3 }, { text: 'tomorrow', tile: 7 }] },
  { kind: 'rows', title: 'System stats', accent: 'blue',
    rows: [
      { label: 'CPU', value: '8 × Intel Core Test' },
      { label: 'Memory', value: '7.9 GB / 16.0 GB (49%)' },
      { label: 'Disk', value: '412.3 GB / 931.5 GB (44%)' },
      { label: 'Uptime', value: '1d 7h' },
      { label: 'System', value: 'win32 10.0.26200' }
    ] },
  { kind: 'rows', title: 'Long values', accent: 'nonsense-accent',
    rows: [{ label: 'A very long label indeed', value: 'An extremely long value that should wrap or clip gracefully without breaking the layout of the card at all' }] },
  { kind: 'forecast', title: 'Junk forecast (should demote to rows)', forecast: [] },
  null // junk payload: must still render an empty-ish rows card, never crash
];
let cardFixtureIdx = 0;
function registerDevCardShortcuts() {
  if (!(process.argv.includes('--dev') || process.env.CARYL_DEV === '1')) return;
  try {
    globalShortcut.register('Control+Alt+K', () => {
      cardCtl().open(CARD_FIXTURES[cardFixtureIdx++ % CARD_FIXTURES.length]);
    });
    globalShortcut.register('Control+Alt+J', () => {
      let i = 0;
      const t = setInterval(() => {
        if (i >= 8 || !cardCtl().isOpen()) { clearInterval(t); return; }
        cardCtl().scrollTo(i++);
      }, 1200);
    });
    console.log('[card-dev] Ctrl+Alt+K = cycle fixtures, Ctrl+Alt+J = fake narration');
  } catch (_e) {}
}
```

**(c)** Re-registration hook — `registerVoiceHotkey()` (main.js ~3009) starts with `globalShortcut.unregisterAll()`, which wipes the dev shortcuts. Add `registerDevCardShortcuts();` immediately before its `return activeVoiceHotkey;` line, **and** in `applyVoiceHotkeyMode()` (~3037) add the same call right after `console.log('[ptt] system-wide hold-to-talk active on: ' + combo);` (the PTT-success path that never reaches `registerVoiceHotkey`).

- [ ] **Step 4: MANUAL VERIFICATION GATE (Phase 2a) — run the app**

Run: `set CARYL_DEV=1 && npm start` (or `npm start -- --dev`)

Walk this checklist with the human partner — do not proceed to Task 5 until the card is *visually right*:

- `Ctrl+Alt+K` #1: forecast card, centered, frosted glass (Win11) with rounded corners; header shows "Tokyo, JP / Clear sky / 24°" + sun icon; 8 tiles with correct times/icons/temps; entrance animation (scale+fade).
- `Ctrl+Alt+J` while open: tiles highlight-pulse 0→7 in order, strip auto-scrolls the hot tile to center.
- Drag the strip manually, then hit `Ctrl+Alt+J`: while dragging (and ~4 s after), highlights move but the strip does NOT fight your scroll position.
- × fades the card out. After **clicking the card once** (a `showInactive` window only gets key events/blur once focused), `Esc` and clicking outside also fade it out.
- `Ctrl+Alt+K` #2: rows card (System stats), 5 clean label/value rows, sized to content.
- `Ctrl+Alt+K` #3: long label/value wraps or clips without breaking layout; unknown accent falls back to the theme accent color.
- `Ctrl+Alt+K` #4 and #5: junk payloads render a rows card (no crash, no `undefined` text).
- Leave a card open untouched ~30 s: it dismisses itself (safety timeout).
- The card never steals focus from the app you're typing in.
- Voice hotkey still works AFTER toggling push-to-talk mode in Settings (dev shortcuts must survive `unregisterAll` — that's the re-registration hook).

Iterate on `overlay-card.html` CSS until the human partner signs off on the look.

- [ ] **Step 5: Run all node suites**

Run: `node tests/test-kernel.js && node tests/test-handlers.js && node tests/test-integration.js && node tests/test-overlay-card.js`
Expected: all pass

- [ ] **Step 6: Commit**

```bash
git add lib/kernel/overlay.js main.js
git commit -m "feat(overlay-card): window shell (open/scrollTo/dismiss, card-id guards, safety timeout) + dev fixture triggers

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: TTS segment plumbing (`tts:progress` / `tts:idle`)

**Files:**
- Modify: `main.js` (`speak(text, meta)` — ~line 424)
- Modify: `preload.js` (meta pass-through + progress/idle senders)
- Modify: `renderer/index.html` (TTS queue meta support — ~lines 1160–1256)

**Interfaces:**
- Consumes: existing `speak()` / `piperChain` / renderer `_q`/`_pump`/audio-queue machinery.
- Produces (used by Task 6): calling `speak(text, { cardId, seg, last })` per narration segment causes the renderer to emit `ipcRenderer.send('tts:progress', { cardId, seg })` when that segment *starts* and `ipcRenderer.send('tts:idle', { cardId })` when the `last:true` segment *ends* (or speech is stopped). Works identically for browser speechSynthesis and Piper (each `speak()` call already synthesizes its own WAV).

- [ ] **Step 1: main.js — thread `meta` through `speak()`**

Change the `speak` function signature and its three send sites (main.js ~424–444):

```js
function speak(text, meta) {
  if (!text || !mainWindow || mainWindow.isDestroyed()) return;
  const cfg = config.get();
  if (cfg.tts_enabled === false) return;
  const spoken = cleanForSpeech(text);
  if (!spoken) return;
  if (enginesLib.resolveEngine(cfg, 'tts') === 'offline' && cfg.piperPath && cfg.piperModel) {
    piperChain = piperChain
      .then(() => piperSynth(spoken, cfg))
      .then((wav) => {
        if (wav && mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('tts:audio', wav.buffer.slice(wav.byteOffset, wav.byteOffset + wav.byteLength), meta || null);
        else if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('tts:speak', spoken, meta || null);
      })
      .catch(() => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('tts:speak', spoken, meta || null); });
    return;
  }
  mainWindow.webContents.send('tts:speak', spoken, meta || null);
}
```

(Existing `speak(text)` callers are untouched — `meta` is simply `undefined` → `null`.)

- [ ] **Step 2: preload.js — meta pass-through + senders**

Update the two TTS receivers and add the two senders:

```js
  // text-to-speech: main asks the renderer to speak a finished reply.
  // meta ({cardId, seg, last}) tags kernel-card narration segments; null for normal speech.
  onSpeak: (cb) => {
    const handler = (_e, text, meta) => cb(text, meta || null);
    ipcRenderer.on('tts:speak', handler);
    return () => ipcRenderer.removeListener('tts:speak', handler);
  },

  // Piper TTS: main sends finished WAV audio (ArrayBuffer) for the renderer to play
  onTtsAudio: (cb) => ipcRenderer.on('tts:audio', (_e, buf, meta) => cb(buf, meta || null)),

  // narration progress back to main (fire-and-forget)
  ttsProgress: (info) => { try { ipcRenderer.send('tts:progress', info); } catch (_e) {} },
  ttsIdle: (info) => { try { ipcRenderer.send('tts:idle', info); } catch (_e) {} },
```

- [ ] **Step 3: renderer/index.html — queue items carry meta**

**(a)** `speak` + `_pump` (browser path, ~1171–1202) — queue objects instead of strings; report starts/ends:

```js
function speak(text, meta){
  if(!ttsEnabled) return;
  const s = String(text||'').trim();
  if(!s) return;
  _q.push({ text: s, meta: meta || null });
  _pump();
}
function _reportStart(meta){
  if(meta && meta.cardId && window.bridge && window.bridge.ttsProgress) window.bridge.ttsProgress({ cardId: meta.cardId, seg: meta.seg });
}
function _reportEnd(meta){
  if(meta && meta.cardId && meta.last && window.bridge && window.bridge.ttsIdle) window.bridge.ttsIdle({ cardId: meta.cardId });
}
function _pump(){
  if(_speaking) return;
  if(!_q.length) return;
  const item = _q.shift();
  _speaking = true;
  _idle = 0;
  const gen = _gen;
  let advanced = false;
  const advance = function(){
    if(advanced || gen !== _gen) return;  // already moved on, or we were stopped
    advanced = true;
    _cur = null; _curAdvance = null; _speaking = false;
    _reportEnd(item.meta);
    setTimeout(function(){ if(gen === _gen) _pump(); }, _breathMs); // breath, then next chunk
  };
  _curAdvance = advance;
  try{
    const u = new SpeechSynthesisUtterance(item.text);
    u.rate = 1.03; u.pitch = 1.0;
    u.onend = advance;
    u.onerror = advance;
    _cur = u;                              // keep alive until it ends
    _reportStart(item.meta);
    window.speechSynthesis.speak(u);
    try{ window.speechSynthesis.resume(); }catch(e){} // unstick a paused engine (no-op otherwise)
  }catch(e){ advance(); }
}
```

**(b)** Piper audio queue (~1216–1235) — same meta treatment:

```js
let _audioQueue = [];
function _enqueueAudio(buf, meta){
  _audioQueue.push({ buf: buf, meta: meta || null });
  _drainAudioQueue();
}
function _drainAudioQueue(){
  if(_ttsAudio && !_ttsAudio.ended && !_ttsAudio.paused) return; // still playing one
  const item = _audioQueue.shift();
  if(!item) return;
  try{
    const blob = new Blob([item.buf], { type:'audio/wav' });
    const url = URL.createObjectURL(blob);
    const a = new Audio(url);
    _ttsAudio = a;             // strong ref
    const next = function(){ try{ URL.revokeObjectURL(url); }catch(e){} if(_ttsAudio===a) _ttsAudio = null; _reportEnd(item.meta); _drainAudioQueue(); };
    a.onended = next;
    a.onerror = next;
    _reportStart(item.meta);
    a.play().catch(next);
  }catch(e){ _ttsAudio = null; _reportEnd(item.meta); _drainAudioQueue(); }
}
```

**(c)** `stopSpeaking` (~1237) — a manual stop must still release any card waiting on `last`. Track the newest card meta seen and idle it. Add one module-level var next to `_q` and use it:

```js
let _lastCardId = 0;    // newest kernel-card id whose narration entered the queues
```

In `speak()` and `_enqueueAudio()`, after pushing: `if(meta && meta.cardId) _lastCardId = meta.cardId;`
In `stopSpeaking()`, before the final `try` lines, add:

```js
  if(_lastCardId && window.bridge && window.bridge.ttsIdle){ window.bridge.ttsIdle({ cardId: _lastCardId }); _lastCardId = 0; }
```

**(d)** Wire the meta through the bridge callbacks (~1251–1256):

```js
if(window.bridge && window.bridge.onSpeak){ window.bridge.onSpeak(function(text, meta){ speak(text, meta); }); }
// Piper voice: queue the WAV that main synthesized so clips play in order.
if(window.bridge && window.bridge.onTtsAudio){ window.bridge.onTtsAudio(function(buf, meta){
  if(!ttsEnabled) return;
  _enqueueAudio(buf, meta);
}); }
```

- [ ] **Step 4: Verify — suites + app smoke test**

Run: `node tests/test-kernel.js && node tests/test-handlers.js && node tests/test-integration.js && node tests/test-overlay-card.js`
Expected: all pass.

Then `npm start`, send any chat message, confirm the reply is still spoken normally (regression check: meta-less speech must be byte-for-byte the old behavior).

- [ ] **Step 5: Commit**

```bash
git add main.js preload.js renderer/index.html
git commit -m "feat(tts): narration segments carry {cardId,seg,last} meta; renderer reports tts:progress / tts:idle

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Kernel integration (Phase 2b) — the card goes live

**Files:**
- Modify: `main.js` (the kernel-intercept branch — the `TODO(kernel-overlay)` at ~3484 — plus `tts:progress`/`tts:idle` listeners)

**Interfaces:**
- Consumes: `cardCtl()` (Task 4), `speak(text, meta)` (Task 5), kernel results `{ ok, speak, overlay }` where `overlay.narration` may exist (Task 2).
- Produces: the user-visible feature. Weather → forecast card + synced narration; stats → rows card dismissed at speech end; TTS-off → 10 s timed dismissal.

- [ ] **Step 1: Add the narration listeners near `ipcMain.on('card:close', ...)`**

```js
// Narration events from the main window's TTS queue drive the card:
// segment start -> scroll its tile into view; last segment done -> fade the card.
let cardNarration = null; // { cardId, tiles: number[] } for the card currently narrating
ipcMain.on('tts:progress', (_e, info) => {
  if (!info || !cardNarration || info.cardId !== cardNarration.cardId) return;
  const tile = cardNarration.tiles[info.seg];
  if (tile !== undefined) cardCtl().scrollTo(tile, info.cardId);
});
ipcMain.on('tts:idle', (_e, info) => {
  if (!info || !info.cardId) return;
  cardCtl().dismiss('speech-end', info.cardId);
  if (cardNarration && cardNarration.cardId === info.cardId) cardNarration = null;
});
```

- [ ] **Step 2: Replace the TODO branch in `ui:sendText`**

Find (main.js ~3479–3484):

```js
      if (r.ok) {
        const say = String(r.speak || '').trim() || 'Done.';
        activity.push({ kind: 'said', text: say, time: clockTime() });
        mem().add('assistant', say);
        speak(say);
        // TODO(kernel-overlay): render r.overlay in the custom overlay card (next task).
      } else {
```

Replace with:

```js
      if (r.ok) {
        const say = String(r.speak || '').trim() || 'Done.';
        activity.push({ kind: 'said', text: say, time: clockTime() });
        mem().add('assistant', say);
        if (r.overlay) {
          const cardId = cardCtl().open(r.overlay);
          const segs = Array.isArray(r.overlay.narration) ? r.overlay.narration : null;
          if (cfg.tts_enabled === false) {
            // No speech -> no tts:idle will ever come; give the card a readable lifetime.
            setTimeout(() => cardCtl().dismiss('no-tts', cardId), 10000);
          } else if (segs && segs.length) {
            cardNarration = { cardId, tiles: segs.map((s) => s.tile) };
            segs.forEach((s, i) => speak(s.text, { cardId, seg: i, last: i === segs.length - 1 }));
          } else {
            speak(say, { cardId, seg: 0, last: true }); // rows card: fade when the summary ends
          }
        } else {
          speak(say);
        }
      } else {
```

(`cfg` is already in scope at the top of the `ui:sendText` handler.)

- [ ] **Step 3: Run all node suites**

Run: `node tests/test-kernel.js && node tests/test-handlers.js && node tests/test-integration.js && node tests/test-overlay-card.js && node tests/test-engines.js && node tests/test-migrate.js && node tests/test-downloads.js`
Expected: all pass

- [ ] **Step 4: MANUAL VERIFICATION GATE (Phase 2b) — the real thing**

Run: `npm start` (with an OpenWeather key configured in Settings):

- Type "weather in Tokyo": forecast card opens centered showing 8 tiles; the voice narrates 2–3 segments; **as each segment starts, its tile highlights and scrolls into view**; when the voice finishes, the card fades out on its own.
- Type "system stats": rows card opens; card fades when the spoken summary ends.
- During weather narration, drag the strip: highlights keep moving, your scroll position is respected.
- Close mid-narration (click the card, then `Esc`, or just hit ×): card fades immediately; speech continues harmlessly.
- Ask "weather in Tokyo" twice fast: the second card replaces the first; no stale dismissal kills the new card (card-id guard).
- Toggle TTS off in Settings, ask for stats: card appears, dismisses itself after ~10 s.
- Break the API key (Settings): spoken error, **no card**, no browser.
- With Piper voice selected (if installed): narration sync still works segment-by-segment.

- [ ] **Step 5: Commit**

```bash
git add main.js
git commit -m "feat(kernel): render handler results in the overlay card with narration-synced scroll + speech-end dismissal

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: Full-suite verification + docs touch-up

**Files:**
- Modify: `docs/superpowers/specs/2026-07-04-kernel-overlay-card-design.md` (status line only)

- [ ] **Step 1: Run the complete test suite**

Run: `npm test`
Expected: every node suite prints `... all assertions passed`, then the Python automation suite passes. If `.venv` is missing on this machine, run the node suites individually (they must ALL pass) and note the Python skip in the commit message.

- [ ] **Step 2: Update the spec status**

In the spec header, change `**Status:** Approved design, pre-implementation.` to `**Status:** Implemented (see docs/superpowers/plans/2026-07-04-kernel-overlay-card.md).`

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/specs/2026-07-04-kernel-overlay-card-design.md
git commit -m "docs: mark Kernel Overlay Card spec implemented

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Plan deviations from spec (intentional, simpler)

- **Piper sync is exact, not estimated.** The spec allowed estimated timers for Piper because it "synthesizes one WAV". But main.js already synthesizes one WAV **per `speak()` call** — sending narration segment-by-segment gives Piper real per-segment WAV boundaries through the existing `piperChain`, so both engines get exact sync and the estimated-timer code is never written.
- **Accent resolution happens main-side.** `open()` attaches `accentColors` (from `resolveAccent`) to the render model, so the card renderer needs no palette copy — unknown accents simply leave the CSS variables pointing at the theme's `--accent`.
- **`update(payload)` folded into `open()`.** The spec listed a separate `update()`; every kernel result is a fresh card, and calling `open()` while a card is showing already re-renders the same window under a new card-id. No caller needs incremental updates, so the method is not built (YAGNI).
