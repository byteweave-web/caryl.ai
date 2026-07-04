# Weather Board Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the small forecast card with a full iOS-Weather-style board — animated condition-driven skies, hourly strip, 5-day list, eight info tiles — at 65–100% of the screen, draggable/resizable and persistent, staying open until closed.

**Architecture:** `weather.js` grows a v2 forecast payload (pure, unit-tested helpers for daily aggregation, dew point, moon phase, scene classification). `lib/kernel/overlay.js` manages **two** windows — the existing small rows card (unchanged lifecycle) and the new board (`renderer/weather-board.html`) — routing by payload kind, with scale/bounds persistence injected from main.js. The rows card renderer is slimmed to rows-only.

**Tech Stack:** Electron, vanilla JS/CSS (transform/opacity-only animations), plain-node assert tests, OpenWeather current + 5-day/3-hour APIs.

**Spec:** `docs/superpowers/specs/2026-07-04-weather-board-design.md` (payload v2 shape, scene list, tile list, lifecycle rules — read it before any task).
**Branch:** `weather-board` (off master, already checked out in this worktree).

## Global Constraints

- Payload v2 keys exactly as the spec's contract block: `scene`, `current{temp,hi,lo,icon,condition,feelsLike,humidity,dewPoint,pressure,visibility,wind{speed,gust,deg},sunrise,sunset,isNight,moon{phase,illumination}}`, `hourly[{time,temp,icon,condition,pop}]` (≤8), `daily[{day,icon,lo,hi,pop}]` (2–6), `narration` unchanged (joined texts === `speak`).
- Scenes: `clear-day | clear-night | clouds | rain | storm | snow | mist`; unknown → `clouds`. Animations are transform/opacity only; `prefers-reduced-motion: reduce` freezes to static gradients.
- Board lifecycle: **no** speech-end/no-tts dismissal, **no** safety timeout; × / Esc / blur close it (manual reasons fade immediately — the PR #3 reason plumbing). Rows card lifecycle untouched.
- One live card at a time (single `currentId` across both windows); opening a new result supersedes the previous surface (plan simplification, consistent with existing supersede behavior).
- Sizing: `weatherCardScale` (0.65–1.0, clamp, default 0.65) × primary work area, centered — unless saved `weatherBoardBounds` pass the `isOnScreen` check. Drag/resize persists bounds (debounced ~400 ms).
- `lib/kernel/overlay.js` stays plain-node loadable (electron require stays lazy). Handlers stay Electron-free.
- Weather demotion: forecast fetch failure OR `daily.length < 2` OR empty hourly → the existing rows payload + single-sentence summary. Never a browser.
- Icons stay RAW OpenWeather codes in payloads; sprite mapping is renderer-side (`mapIcon` for the board too).
- Wind display: metric = m/s × 3.6 → km/h rounded; imperial = mph as returned. Visibility: metric = km (1 decimal), imperial = miles (1 decimal); `null` when the field is absent.
- Dev gate for fixtures: `process.argv.includes('--dev') || process.env.CARYL_DEV === '1'`.
- Commits end with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`. Never commit `.claude/settings.local.json`.
- Full node suite = `node tests/test-engines.js && node tests/test-migrate.js && node tests/test-downloads.js && node tests/test-kernel.js && node tests/test-handlers.js && node tests/test-integration.js && node tests/test-overlay-card.js`.

**Plan deviation from spec (intentional):** `aggregateDaily` keeps every day it sees and labels the first row `Today` — the forecast list always starts "now", so a thin leading day IS today; the spec's skip-rule collapses to this simpler behavior.

---

### Task 1: weather.js pure helpers — clock/night/scene/dew-point/moon + config defaults

**Files:**
- Modify: `lib/kernel/handlers/weather.js`
- Modify: `lib/config.js` (two DEFAULTS keys)
- Test: `tests/test-handlers.js` (append before the final `console.log`)

**Interfaces:**
- Consumes: existing `weather.js` (`fmtHour`, `cap`, exports object at the bottom).
- Produces (Tasks 2, 4 rely on): `fmtClock(unixSec, tzSec) -> 'HH:MM'`, `isNightAt(nowSec, sunriseSec, sunsetSec) -> boolean`, `sceneFor(iconCode, isNight) -> string`, `dewPoint(tempC, humidityPct) -> number|null`, `moonPhase(dateMs) -> {phase, illumination}`. Config keys `weatherCardScale` (0.65) and `weatherBoardBounds` (null).

- [ ] **Step 1: Write the failing tests** — append to `tests/test-handlers.js`:

```js
// --- weather board: pure helpers (clock, night, scene, dew point, moon) ---
assert.strictEqual(weather.fmtClock(0, 0), '00:00');
assert.strictEqual(weather.fmtClock(19 * 3600 + 52 * 60, 0), '19:52');
assert.strictEqual(weather.fmtClock(23 * 3600, 2 * 3600), '01:00', 'tz wraps past midnight');

assert.strictEqual(weather.isNightAt(100, 200, 300), true, 'before sunrise = night');
assert.strictEqual(weather.isNightAt(250, 200, 300), false, 'between = day');
assert.strictEqual(weather.isNightAt(300, 200, 300), true, 'at/after sunset = night');

assert.strictEqual(weather.sceneFor('11d', false), 'storm');
assert.strictEqual(weather.sceneFor('09n', true), 'rain');
assert.strictEqual(weather.sceneFor('10d', false), 'rain');
assert.strictEqual(weather.sceneFor('13d', false), 'snow');
assert.strictEqual(weather.sceneFor('50d', false), 'mist');
assert.strictEqual(weather.sceneFor('03d', false), 'clouds');
assert.strictEqual(weather.sceneFor('04n', true), 'clouds');
assert.strictEqual(weather.sceneFor('01d', false), 'clear-day');
assert.strictEqual(weather.sceneFor('02n', true), 'clear-night');
assert.strictEqual(weather.sceneFor('01n', true), 'clear-night');
assert.strictEqual(weather.sceneFor('', false), 'clouds', 'unknown -> clouds');

assert.strictEqual(weather.dewPoint(28, 67), 21, 'Magnus: 28C/67% ~ 21C');
assert.strictEqual(weather.dewPoint(0, 100), 0, 'saturated at 0C');
assert.strictEqual(weather.dewPoint(NaN, 50), null);
assert.strictEqual(weather.dewPoint(20, 0), null, 'rh<=0 -> null');

// Documented ephemeris: 2000-01-06 ~18:14 UTC new moon; 2000-01-21 full moon.
let mp = weather.moonPhase(Date.UTC(2000, 0, 6, 19, 0));
assert.strictEqual(mp.phase, 'new-moon');
assert.ok(mp.illumination <= 5, 'new moon ~0% lit');
mp = weather.moonPhase(Date.UTC(2000, 0, 21, 12, 0));
assert.strictEqual(mp.phase, 'full-moon');
assert.ok(mp.illumination >= 95, 'full moon ~100% lit');
mp = weather.moonPhase(Date.UTC(2000, 0, 14, 12, 0));
assert.strictEqual(mp.phase, 'first-quarter');
```

- [ ] **Step 2: Run to verify failure** — `node tests/test-handlers.js` → FAIL `weather.fmtClock is not a function`.

- [ ] **Step 3: Implement** — in `lib/kernel/handlers/weather.js`, after `fmtHour`:

```js
// Unix seconds + tz offset -> local "HH:MM" (generalizes fmtHour to minutes).
function fmtClock(unixSec, tzSec) {
  const t = ((((Number(unixSec) || 0) + (Number(tzSec) || 0)) % 86400) + 86400) % 86400;
  return String(Math.floor(t / 3600)).padStart(2, '0') + ':' +
         String(Math.floor((t % 3600) / 60)).padStart(2, '0');
}

function isNightAt(nowSec, sunriseSec, sunsetSec) {
  return nowSec < sunriseSec || nowSec >= sunsetSec;
}

// OpenWeather icon family -> the board's animated sky scene.
function sceneFor(code, isNight) {
  const c = String(code || '');
  if (c.startsWith('11')) return 'storm';
  if (c.startsWith('09') || c.startsWith('10')) return 'rain';
  if (c.startsWith('13')) return 'snow';
  if (c.startsWith('50')) return 'mist';
  if (c.startsWith('03') || c.startsWith('04')) return 'clouds';
  if (c.startsWith('01') || c.startsWith('02')) return isNight ? 'clear-night' : 'clear-day';
  return 'clouds';
}

// Magnus formula. Celsius in, rounded Celsius out (callers convert for imperial display).
function dewPoint(tempC, humidityPct) {
  const t = Number(tempC), rh = Number(humidityPct);
  if (!isFinite(t) || !isFinite(rh) || rh <= 0) return null;
  const a = 17.62, b = 243.12;
  const gamma = (a * t) / (b + t) + Math.log(rh / 100);
  return Math.round((b * gamma) / (a - gamma));
}

// Synodic-month moon phase, computed locally (no API has this on the free tier).
const SYNODIC_DAYS = 29.530588853;
const NEW_MOON_EPOCH_MS = Date.UTC(2000, 0, 6, 18, 14); // documented new moon
function moonPhase(dateMs) {
  const days = (Number(dateMs) - NEW_MOON_EPOCH_MS) / 86400000;
  const age = ((days % SYNODIC_DAYS) + SYNODIC_DAYS) % SYNODIC_DAYS;
  const illumination = Math.round((1 - Math.cos((2 * Math.PI * age) / SYNODIC_DAYS)) / 2 * 100);
  const names = ['new-moon', 'waxing-crescent', 'first-quarter', 'waxing-gibbous',
                 'full-moon', 'waning-gibbous', 'last-quarter', 'waning-crescent'];
  return { phase: names[Math.round(age / (SYNODIC_DAYS / 8)) % 8], illumination };
}
```

Extend `module.exports` with `fmtClock, isNightAt, sceneFor, dewPoint, moonPhase`.

- [ ] **Step 4: Config defaults** — in `lib/config.js`, directly under the `weatherDefaultLocation` line:

```js
  weatherCardScale: 0.65,                  // weather board size: 0.65..1.0 of the work area
  weatherBoardBounds: null,                // last dragged/resized board bounds (validated on use)
```

- [ ] **Step 5: Run to verify pass** — `node tests/test-handlers.js` → `test-handlers: all assertions passed`; also `node tests/test-migrate.js` (config defaults regression).

- [ ] **Step 6: Commit**

```bash
git add lib/kernel/handlers/weather.js lib/config.js tests/test-handlers.js
git commit -m "feat(weather): pure board helpers - local clock, night check, sky scene, dew point, moon phase + board config defaults"
```

---

### Task 2: weather.js payload v2 — richer normalize, pop, aggregateDaily, board payload, run() demotion

**Files:**
- Modify: `lib/kernel/handlers/weather.js`
- Test: `tests/test-handlers.js` (append), `tests/test-integration.js` (update weather e2e)

**Interfaces:**
- Consumes: Task 1 helpers; existing `normalize`, `normalizeForecast`, `buildNarration`, `buildPayload`, `summarize`, `fetchWeather`, `fetchForecast`, `run`.
- Produces (Tasks 3–5 rely on): `normalize()` result gains `pressure, visibilityM, windDeg, windGust, sunrise, sunset, tz, dt` (all `null` when absent, `tz` 0). `normalizeForecast(data) -> { tiles:[≤8 {time,temp,icon,condition,pop}], full:[{dt,temp,icon,condition,pop}], tz } | null`. `aggregateDaily(full, tz) -> [{day,icon,lo,hi,pop}]`. `buildBoardPayload(norm, fnorm, units) -> payload v2` (embeds `narration` from the existing `buildNarration(norm, fnorm.tiles, units)`). `run()` returns the v2 payload on full success, rows demotion otherwise.

- [ ] **Step 1: Failing tests** — append to `tests/test-handlers.js`:

```js
// --- weather board: normalize v2 + aggregateDaily + board payload ---
const OWM_CUR = {
  name: 'Beirut', sys: { country: 'LB', sunrise: 1000, sunset: 52000 }, dt: 30000, timezone: 10800,
  main: { temp: 28.4, feels_like: 29.2, humidity: 67, pressure: 1007 }, visibility: 21000,
  weather: [{ description: 'thunderstorm', icon: '11d' }], wind: { speed: 6.4, deg: 241, gust: 10.3 }
};
const wn2 = weather.normalize(OWM_CUR);
assert.strictEqual(wn2.pressure, 1007);
assert.strictEqual(wn2.visibilityM, 21000);
assert.strictEqual(wn2.windDeg, 241);
assert.ok(Math.abs(wn2.windGust - 10.3) < 1e-9);
assert.strictEqual(wn2.sunrise, 1000);
assert.strictEqual(wn2.sunset, 52000);
assert.strictEqual(wn2.tz, 10800);
assert.strictEqual(wn2.dt, 30000);
assert.strictEqual(weather.normalize({ main: { temp: 5 } }).pressure, null, 'absent fields -> null');

// forecast steps now carry pop (0..1 -> 0..100) and the FULL list rides along
function owmStep(dayIdx, hour, temp, icon, pop) {
  return { dt: (dayIdx * 24 + hour) * 3600, main: { temp }, pop,
           weather: [{ description: 'x', icon }] };
}
const OWM_F2 = { city: { timezone: 0 }, list: [] };
for (let d = 0; d < 5; d++) for (let h = 0; h < 24; h += 3)
  OWM_F2.list.push(owmStep(d, h, 20 + d + (h === 12 ? 5 : 0), h === 12 ? '01d' : '03d', d === 1 && h === 12 ? 0.8 : 0.1));
const fn2 = weather.normalizeForecast(OWM_F2);
assert.strictEqual(fn2.tiles.length, 8, 'strip still 8');
assert.strictEqual(fn2.tiles[0].pop, 10, 'pop as 0..100');
assert.strictEqual(fn2.full.length, 40, 'full list rides along');
assert.strictEqual(typeof fn2.full[0].dt, 'number');

const daily = weather.aggregateDaily(fn2.full, fn2.tz);
assert.strictEqual(daily.length, 5);
assert.strictEqual(daily[0].day, 'Today');
assert.strictEqual(daily[1].icon, '01d', 'noon step icon wins');
assert.strictEqual(daily[1].hi, 26, 'hi = max of the day');
assert.strictEqual(daily[1].lo, 21, 'lo = min of the day');
assert.strictEqual(daily[1].pop, 80, 'max pop of the day');
assert.deepStrictEqual(weather.aggregateDaily([], 0), []);

// buildBoardPayload: full v2 shape
const bp = weather.buildBoardPayload(wn2, fn2, 'metric');
assert.strictEqual(bp.kind, 'forecast');
assert.strictEqual(bp.scene, 'storm');
assert.strictEqual(bp.current.hi, daily[0].hi);
assert.strictEqual(bp.current.lo, daily[0].lo);
assert.strictEqual(bp.current.dewPoint, weather.dewPoint(28.4, 67));
assert.strictEqual(bp.current.wind.speed, 23, 'm/s*3.6 rounded');
assert.strictEqual(bp.current.wind.gust, 37);
assert.strictEqual(bp.current.wind.deg, 241);
assert.strictEqual(bp.current.visibility, 21, 'km');
assert.strictEqual(bp.current.sunrise, weather.fmtClock(1000, 10800));
assert.strictEqual(bp.current.sunset, weather.fmtClock(52000, 10800));
assert.strictEqual(bp.current.isNight, false, 'dt 30000 between sunrise/sunset');
assert.ok(bp.current.moon && typeof bp.current.moon.illumination === 'number');
assert.strictEqual(bp.hourly.length, 8);
assert.strictEqual(bp.daily.length, 5);
assert.ok(Array.isArray(bp.narration) && bp.narration.length >= 2);
assert.strictEqual(bp.narration.map((s) => s.text).join(' ').length > 0, true);
```

- [ ] **Step 2: Verify failure** — `node tests/test-handlers.js` → FAIL on `wn2.pressure`.

- [ ] **Step 3: Implement.**

**(a)** `normalize()` — add to the returned object:

```js
    pressure: (typeof main.pressure === 'number') ? main.pressure : null,
    visibilityM: (typeof data.visibility === 'number') ? data.visibility : null,
    windDeg: (data.wind && typeof data.wind.deg === 'number') ? data.wind.deg : null,
    windGust: (data.wind && typeof data.wind.gust === 'number') ? data.wind.gust : null,
    sunrise: (data.sys && typeof data.sys.sunrise === 'number') ? data.sys.sunrise : null,
    sunset: (data.sys && typeof data.sys.sunset === 'number') ? data.sys.sunset : null,
    tz: (typeof data.timezone === 'number') ? data.timezone : 0,
    dt: (typeof data.dt === 'number') ? data.dt : null
```

**(b)** `normalizeForecast()` — each parsed step gains `pop: Math.round((Number(e.pop) || 0) * 100)` and is ALSO pushed (as `{dt: e.dt, temp, icon, condition, pop}`) to a `full` array built over `data.list` (not just the first 8); tiles stay the first-8 slice. Return `{ tiles, full, tz }`.

**(c)** `aggregateDaily`:

```js
// Fold the full 3-hourly list into daily rows: lo/hi over the day, icon nearest local
// noon, max precipitation probability. First row is by definition today ("now" onward).
function aggregateDaily(full, tz) {
  if (!Array.isArray(full) || !full.length) return [];
  const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const byDay = [];
  const seen = new Map();
  for (const s of full) {
    if (!s || typeof s.temp !== 'number' || typeof s.dt !== 'number') continue;
    const local = new Date((s.dt + (Number(tz) || 0)) * 1000);
    const key = local.getUTCFullYear() + '-' + local.getUTCMonth() + '-' + local.getUTCDate();
    let day = seen.get(key);
    if (!day) { day = { weekday: WD[local.getUTCDay()], steps: [] }; seen.set(key, day); byDay.push(day); }
    day.steps.push({ temp: s.temp, icon: s.icon, pop: Number(s.pop) || 0, hour: local.getUTCHours() });
  }
  return byDay.slice(0, 6).map((day, i) => {
    let lo = Infinity, hi = -Infinity, pop = 0, icon = '', best = 99;
    for (const st of day.steps) {
      lo = Math.min(lo, st.temp); hi = Math.max(hi, st.temp);
      pop = Math.max(pop, st.pop);
      const d = Math.abs(st.hour - 12);
      if (d < best) { best = d; icon = st.icon; }
    }
    return { day: i === 0 ? 'Today' : day.weekday, icon, lo: Math.round(lo), hi: Math.round(hi), pop: Math.round(pop) };
  });
}
```

**(d)** `buildBoardPayload`:

```js
// normalized current + normalized forecast -> the v2 board payload (spec contract).
function buildBoardPayload(norm, fnorm, units) {
  const imperial = units === 'imperial';
  const daily = aggregateDaily(fnorm.full, fnorm.tz);
  const today = daily[0] || { hi: Math.round(norm.temp), lo: Math.round(norm.temp) };
  const night = (norm.dt != null && norm.sunrise != null && norm.sunset != null)
    ? isNightAt(norm.dt, norm.sunrise, norm.sunset) : false;
  const tempC = imperial ? (norm.temp - 32) * 5 / 9 : norm.temp;
  const dewC = (norm.humidity != null) ? dewPoint(tempC, norm.humidity) : null;
  return {
    kind: 'forecast',
    title: norm.city ? (norm.city + (norm.country ? ', ' + norm.country : '')) : 'Weather',
    accent: 'sky',
    scene: sceneFor(norm.icon, night),
    current: {
      temp: Math.round(norm.temp), hi: today.hi, lo: today.lo,
      icon: norm.icon || '', condition: cap(norm.description || ''),
      feelsLike: norm.feelsLike != null ? Math.round(norm.feelsLike) : null,
      humidity: norm.humidity != null ? norm.humidity : null,
      dewPoint: dewC == null ? null : (imperial ? Math.round(dewC * 9 / 5 + 32) : dewC),
      pressure: norm.pressure,
      visibility: norm.visibilityM == null ? null
        : Math.round((imperial ? norm.visibilityM / 1609.34 : norm.visibilityM / 1000) * 10) / 10,
      wind: {
        speed: norm.windSpeed == null ? null : (imperial ? Math.round(norm.windSpeed) : Math.round(norm.windSpeed * 3.6)),
        gust: norm.windGust == null ? null : (imperial ? Math.round(norm.windGust) : Math.round(norm.windGust * 3.6)),
        deg: norm.windDeg
      },
      sunrise: norm.sunrise != null ? fmtClock(norm.sunrise, norm.tz) : null,
      sunset: norm.sunset != null ? fmtClock(norm.sunset, norm.tz) : null,
      isNight: night,
      moon: moonPhase(Date.now())
    },
    hourly: fnorm.tiles,
    daily,
    narration: buildNarration(norm, fnorm.tiles, units)
  };
}
```

**(e)** `run()` — the success branch becomes:

```js
  if (fres.ok) {
    const payload = buildBoardPayload(res.data, fres.data, units);
    if (payload.daily.length >= 2 && payload.hourly.length) {
      const speak = payload.narration.map((s) => s.text).join(' ');
      return { ok: true, speak, overlay: payload, value: res.data };
    }
  }
  // Forecast unavailable or too thin -> today's rows card (never a half-board).
  return { ok: true, speak: summarize(res.data, units), overlay: buildPayload(res.data, units), value: res.data };
```

**(f)** Exports gain `aggregateDaily, buildBoardPayload` (keep `buildForecastPayload` exported for now if other tests reference it; delete it and its tests in this task if nothing else uses it — check with grep and prefer deletion).

- [ ] **Step 4: Verify pure tests pass** — `node tests/test-handlers.js`.

- [ ] **Step 5: Update the integration e2e** — in `tests/test-integration.js`, the existing weather-success assertions change: fixture `OWM_FORECAST.list` should be extended to 2+ local days (16 steps, 3-hourly, with `pop` fields), the `OWM` current fixture gains `sys.sunrise/sunset`, `dt`, `timezone`, `main.pressure`, `visibility`, `wind.deg`. Assert `wdecision.result.overlay.kind === 'forecast'`, `overlay.scene` is a non-empty string, `overlay.hourly.length === 8`, `overlay.daily.length >= 2`, `overlay.current.moon` present, and `speak` === joined narration. The demotion e2e (forecast 500) stays as-is.

- [ ] **Step 6: Full node suite** — all pass.

- [ ] **Step 7: Commit**

```bash
git add lib/kernel/handlers/weather.js tests/test-handlers.js tests/test-integration.js
git commit -m "feat(weather): payload v2 - daily aggregation, scene, dew point, moon, wind compass data; thin-forecast demotion"
```

---

### Task 3: overlay.js — normalizePayload v2 (board model) + routing model

**Files:**
- Modify: `lib/kernel/overlay.js` (pure section only)
- Test: `tests/test-overlay-card.js` (append)

**Interfaces:**
- Consumes: existing `normalizePayload`, `mapIcon`, `resolveAccent`, `str` helper.
- Produces (Tasks 4, 5 rely on): `normalizePayload(p)` for `kind:'forecast'` now returns
  `{ kind:'forecast', title, accent, scene, current:{...spec fields, icon mapped via mapIcon, moon:{phase,illumination}}, hourly:[≤8 {time,temp,icon(sprite id),condition,pop}], daily:[2..6 {day,icon(sprite id),lo,hi,pop}], narration }` — demoting to rows when `hourly` is empty OR `daily` has < 2 rows. `SCENES` exported: the seven-name whitelist (unknown → `'clouds'`).

- [ ] **Step 1: Failing tests** — append to `tests/test-overlay-card.js`:

```js
// --- board model: normalizePayload v2 ---
function boardFixture() {
  return {
    kind: 'forecast', title: 'Beirut, LB', accent: 'sky', scene: 'storm',
    current: { temp: 28.4, hi: 30, lo: 22, icon: '11d', condition: 'Thunderstorm',
      feelsLike: 29, humidity: 67, dewPoint: 21, pressure: 1007, visibility: 21,
      wind: { speed: 23, gust: 37, deg: 241 }, sunrise: '05:30', sunset: '19:52',
      isNight: false, moon: { phase: 'waning-gibbous', illumination: 82 } },
    hourly: Array.from({ length: 8 }, (_, i) => ({ time: i + ':00', temp: 20 + i, icon: '10d', condition: 'Rain', pop: 40 })),
    daily: Array.from({ length: 5 }, (_, i) => ({ day: i ? 'Sun' : 'Today', icon: '01d', lo: 20, hi: 30, pop: 10 })),
    narration: [{ text: 'a', tile: 0 }, { text: 'b', tile: 7 }]
  };
}
let bm = overlay.normalizePayload(boardFixture());
assert.strictEqual(bm.kind, 'forecast');
assert.strictEqual(bm.scene, 'storm');
assert.strictEqual(bm.current.temp, 28, 'temps rounded');
assert.strictEqual(bm.current.icon, 'thunder', 'icons mapped to sprite ids');
assert.strictEqual(bm.hourly[0].icon, 'rain');
assert.strictEqual(bm.daily[0].icon, 'sun');
assert.strictEqual(bm.current.wind.deg, 241);
assert.strictEqual(bm.current.moon.phase, 'waning-gibbous');
assert.strictEqual(bm.daily.length, 5);

bm = overlay.normalizePayload(Object.assign(boardFixture(), { scene: 'volcano' }));
assert.strictEqual(bm.scene, 'clouds', 'unknown scene -> clouds');

bm = overlay.normalizePayload(Object.assign(boardFixture(), { daily: [{ day: 'Today', icon: '01d', lo: 1, hi: 2, pop: 0 }] }));
assert.strictEqual(bm.kind, 'rows', '<2 daily rows demotes');

bm = overlay.normalizePayload(Object.assign(boardFixture(), { hourly: [] }));
assert.strictEqual(bm.kind, 'rows', 'empty hourly demotes');

bm = overlay.normalizePayload(Object.assign(boardFixture(), { current: null }));
assert.strictEqual(bm.kind, 'forecast', 'missing current tolerated (renderer shows dashes)');
assert.ok(bm.current && typeof bm.current === 'object');

bm = overlay.normalizePayload(Object.assign(boardFixture(), {
  daily: Array.from({ length: 9 }, () => ({ day: 'X', icon: '01d', lo: 1, hi: 2, pop: 0 }))
}));
assert.strictEqual(bm.daily.length, 6, 'daily capped at 6');
```

Note: the legacy small-card forecast test in this file (`forecast:[...] 8 tiles` etc., from Phase 2a) asserts the OLD v1 shape — replace those v1 forecast assertions with the block above (the v1 `forecast:[...]` key no longer exists; rows tests stay).

- [ ] **Step 2: Verify failure**, **Step 3: Implement** — rewrite the forecast branch of `normalizePayload`:

```js
const SCENES = ['clear-day', 'clear-night', 'clouds', 'rain', 'storm', 'snow', 'mist'];
const MAX_HOURLY = 8, MAX_DAILY = 6;

function num(v) { const n = Number(v); return isFinite(n) ? n : null; }
function rnd(v) { const n = num(v); return n == null ? null : Math.round(n); }

// forecast branch (replaces the v1 tiles/narration handling):
  const hourly = (Array.isArray(p.hourly) ? p.hourly : [])
    .filter((t) => t && typeof t === 'object')
    .slice(0, MAX_HOURLY)
    .map((t) => ({ time: str(t.time, '--:--'), temp: rnd(t.temp) || 0,
                   icon: mapIcon(t.icon), condition: str(t.condition, ''),
                   pop: Math.max(0, Math.min(100, rnd(t.pop) || 0)) }));
  const daily = (Array.isArray(p.daily) ? p.daily : [])
    .filter((d) => d && typeof d === 'object')
    .slice(0, MAX_DAILY)
    .map((d) => ({ day: str(d.day, ''), icon: mapIcon(d.icon),
                   lo: rnd(d.lo) || 0, hi: rnd(d.hi) || 0,
                   pop: Math.max(0, Math.min(100, rnd(d.pop) || 0)) }));
  if (p.kind === 'forecast' && hourly.length > 0 && daily.length >= 2) {
    const cur = (p.current && typeof p.current === 'object') ? p.current : {};
    const wind = (cur.wind && typeof cur.wind === 'object') ? cur.wind : {};
    const moon = (cur.moon && typeof cur.moon === 'object') ? cur.moon : {};
    const narration = (Array.isArray(p.narration) ? p.narration : [])
      .filter((n) => n && typeof n === 'object' && str(n.text, ''))
      .map((n) => ({ text: str(n.text, ''),
                     tile: Math.min(hourly.length - 1, Math.max(0, Number(n.tile) || 0)) }));
    return {
      kind: 'forecast', title, accent,
      scene: SCENES.indexOf(p.scene) >= 0 ? p.scene : 'clouds',
      current: {
        temp: rnd(cur.temp), hi: rnd(cur.hi), lo: rnd(cur.lo),
        icon: mapIcon(cur.icon), condition: str(cur.condition, ''),
        feelsLike: rnd(cur.feelsLike), humidity: rnd(cur.humidity), dewPoint: rnd(cur.dewPoint),
        pressure: rnd(cur.pressure), visibility: num(cur.visibility),
        wind: { speed: rnd(wind.speed), gust: rnd(wind.gust), deg: rnd(wind.deg) },
        sunrise: str(cur.sunrise, ''), sunset: str(cur.sunset, ''),
        isNight: !!cur.isNight,
        moon: { phase: str(moon.phase, ''), illumination: Math.max(0, Math.min(100, rnd(moon.illumination) || 0)) }
      },
      hourly, daily, narration, rows: []
    };
  }
  // fall through to the rows return (existing code), which stays unchanged
```

Export `SCENES` too.

- [ ] **Step 4: Verify pass** — `node tests/test-overlay-card.js`; also full node suite (integration references overlay indirectly).

- [ ] **Step 5: Commit**

```bash
git add lib/kernel/overlay.js tests/test-overlay-card.js
git commit -m "feat(overlay-card): board render model - payload v2 normalization, scene whitelist, hourly/daily caps, thin-data demotion"
```

---

### Task 4: overlay.js two-window shell + main.js routing, deps, fixtures

**Files:**
- Modify: `lib/kernel/overlay.js` (window shell section)
- Modify: `main.js` (`cardCtl` init deps, kernel branch, fixtures)

**Interfaces:**
- Consumes: Task 3 model; existing shell (`win`, `pending`, `renderPending`, `createWin`, `dismiss`, `notifyFaded`, `destroy`, `HIDE_FALLBACK_MS`, `SAFETY_MS`); main.js `cardCtl()`/kernel branch/fixture blocks; `config.get()`/`config.set()`.
- Produces: `init({ preloadPath, shellStyle, getConfig, saveConfig })`. `open(payload) -> { cardId:number, kind:'rows'|'forecast' }` (BREAKING — main.js is the only caller and is updated here). Board window: loads `renderer/weather-board.html`, `resizable:true`, bounds = saved-if-onscreen else `weatherCardScale` clamped 0.65–1.0 × work area centered; `moved`/`resize` debounce-persist (400 ms) `weatherBoardBounds` via `saveConfig`. `dismiss(reason, cardId)` IGNORES `'speech-end'`/`'no-tts'` while the live surface is the board; no safety timer for board opens. `scrollTo`/`notifyFaded`/`destroy` operate on whichever window is live (destroy tears down both).

- [ ] **Step 1: Extend the shell.** Key mechanics (complete code for the tricky parts — keep existing card behavior byte-identical):

```js
let boardWin = null;                 // the weather board window (second surface)
let liveKind = 'rows';               // which surface owns currentId
let boundsSaveTimer = null;

function isOnScreenRect(b) {         // same rule as main.js isOnScreen (module-local copy)
  try {
    const { screen } = electron();
    return screen.getAllDisplays().some((d) => {
      const wa = d.workArea;
      return b.x + b.width > wa.x + 20 && b.x < wa.x + wa.width - 20 &&
             b.y + b.height > wa.y + 20 && b.y < wa.y + wa.height - 20;
    });
  } catch (_e) { return false; }
}

function boardBounds() {
  const cfg = (deps.getConfig && deps.getConfig()) || {};
  const saved = cfg.weatherBoardBounds;
  if (saved && saved.width > 200 && isOnScreenRect(saved)) return saved;
  const { screen } = electron();
  const wa = screen.getPrimaryDisplay().workArea;
  const scale = Math.max(0.65, Math.min(1, Number(cfg.weatherCardScale) || 0.65));
  const width = Math.round(wa.width * scale), height = Math.round(wa.height * scale);
  return { x: wa.x + Math.round((wa.width - width) / 2), y: wa.y + Math.round((wa.height - height) / 2), width, height };
}

function createBoardWin(b) {
  const { BrowserWindow } = electron();
  boardWin = new BrowserWindow({
    x: b.x, y: b.y, width: b.width, height: b.height,
    frame: false, transparent: true, hasShadow: false, resizable: true, roundedCorners: false,
    skipTaskbar: true, alwaysOnTop: true, show: false, fullscreenable: false,
    backgroundColor: '#00000000',
    backgroundMaterial: (process.platform === 'win32' && deps.shellStyle().blur) ? 'acrylic' : undefined,
    webPreferences: { preload: deps.preloadPath, contextIsolation: true, nodeIntegration: false, sandbox: false, backgroundThrottling: false }
  });
  boardWin.setAlwaysOnTop(true, 'screen-saver');
  try { boardWin.setContentProtection(true); } catch (_e) {}
  boardWin.loadFile(require('path').join(__dirname, '..', '..', 'renderer', 'weather-board.html'));
  const persist = () => {
    if (boundsSaveTimer) clearTimeout(boundsSaveTimer);
    boundsSaveTimer = setTimeout(() => {
      if (boardWin && !boardWin.isDestroyed() && deps.saveConfig) deps.saveConfig({ weatherBoardBounds: boardWin.getBounds() });
    }, 400);
  };
  boardWin.on('moved', persist);
  boardWin.on('resize', persist);
  boardWin.on('closed', () => { boardWin = null; if (liveKind === 'forecast') currentId = 0; });
  return boardWin;
}
```

`open()` routes: after normalize + accent + `const id = ++cardSeq; currentId = id;` set `liveKind = model.kind`; forecast → the board path (same `pending`/`renderPending` machinery generalized with a `target` field: `pending = { model, id, target: 'board' }`, `renderPending()` picks `boardWin` and uses `boardBounds()` for a fresh window / keeps current bounds for a reused visible one; **no safety timer**); rows → the existing card path verbatim (safety timer intact). Return `{ cardId: id, kind: model.kind }`. `send()` gains a target param; `dismiss(reason, cardId)` adds at the top:

```js
  if (liveKind === 'forecast' && (reason === 'speech-end' || reason === 'no-tts')) return; // board persists
```

and otherwise dismisses whichever surface is live (fade → ack → hide, both windows use the same `card:*` channels). `notifyFaded()` hides the live-at-dismissal window (track `fadingWin` when dismiss fires). `destroy()` also clears `boundsSaveTimer` and destroys `boardWin`.

- [ ] **Step 2: Plain-node regression** — `node tests/test-overlay-card.js` must still pass (lazy electron intact).

- [ ] **Step 3: main.js.** (a) `cardCtl()` init gains `getConfig: () => config.get(), saveConfig: (patch) => config.set(patch)`. (b) Kernel branch: `const opened = cardCtl().open(r.overlay);` — narration/no-narration branches use `opened.cardId`; the 10 s no-TTS timer only fires `if (opened.kind === 'rows' && opened.cardId)`. (c) Fixtures: replace the v1 forecast fixture with two v2 fixtures — a `scene:'clear-day'` Beirut board and a `scene:'storm'` board (full `current` per the spec contract incl. `moon`, 8 `hourly` with `pop`, 5 `daily`), keep the three rows/junk fixtures; the junk `{kind:'forecast', forecast:[]}` fixture becomes `{kind:'forecast', hourly:[], daily:[]}` (still demotes).

- [ ] **Step 4: Verify** — `node --check main.js`, full node suite.

- [ ] **Step 5: Commit**

```bash
git add lib/kernel/overlay.js main.js
git commit -m "feat(overlay-card): two-window shell - weather board window with scale/bounds persistence, stay-until-closed; open() returns {cardId,kind}"
```

---

### Task 5: `renderer/weather-board.html` — the board (layout, tiles, animated skies)

**Files:**
- Create: `renderer/weather-board.html`

**Interfaces:**
- Consumes: the Task 3 render model via `bridge.onCardRender(cb)`; `bridge.onCardScrollTo(cb)`, `bridge.onCardDismiss(cb(reason))`, `bridge.cardClose()`, `bridge.cardFaded()`, one-time `bridge.getShellStyle()` + `bridge.status()` (theme/accent). All preload methods already exist.
- Produces: the user-facing board. `card:render` → full re-render incl. `data-scene`; `card:scrollTo(i)` → hourly-strip highlight/scroll (same engaged-flag contract as the old card); `card:dismiss(reason)` → immediate fade for ANY reason (board has no auto-dismiss, so every dismiss is manual/supersede) then `cardFaded()` ack once.

This file is authored fresh (sonnet-grade implementer with design latitude on polish); the following are BINDING contracts plus complete implementations for the hard parts. Reuse the sprite `<defs>` block and `esc()`/`icon()` helpers exactly as they exist in `renderer/overlay-card.html` (copy them — the card loses them in Task 6).

**Structure (ids binding):** `#sky` (fixed full-bleed scene layer, `data-scene` on `<html>`), `#board` (scrollable glass column), header (`#loc`, `#temp`, `#cond`, `#hilo`, `#btn-x`; header is `-webkit-app-region: drag`, buttons `no-drag`), `#strip` (hourly, scroll-snap, tiles show time / icon / `pop≥20`% chip / temp), `#days` (5-day rows: day, icon, lo, range bar, hi, pop chip), `#tiles` (CSS grid `repeat(auto-fit, minmax(240px, 1fr))`): `#t-feels`, `#t-wind`, `#t-humidity`, `#t-sun`, `#t-precip`, `#t-visibility`, `#t-pressure`, `#t-moon`. Null field → '—'.

**Daily range bar** (iOS-style): per row, bar left/width positioned within the WEEK's min..max:

```js
const wkLo = Math.min(...daily.map(d => d.lo)), wkHi = Math.max(...daily.map(d => d.hi));
const span = Math.max(1, wkHi - wkLo);
const left = ((d.lo - wkLo) / span) * 100, width = ((d.hi - d.lo) / span) * 100;
// bar: <div class="range"><div class="fill" style="left:L%;width:W%"></div></div>
// .fill background: linear-gradient(90deg,#5ad19a,#f5b53d,#e9637b) sized to the full range
```

**Wind compass** (SVG): circle + N/E/S/W ticks + needle `transform="rotate(deg 50 50)"`; center text = speed, subtext `Gusts: G km/h` and compass point from `deg` (`['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'][Math.round(deg/22.5)%16]`).

**Sun arc** (SVG): semicircle path `M 10 60 A 50 50 0 0 1 110 60`; sun-dot position from current time between sunrise/sunset parsed as minutes:

```js
function mins(hhmm){ const m=/^(\d+):(\d+)$/.exec(hhmm||''); return m? (+m[1])*60+(+m[2]) : null; }
const sr=mins(cur.sunrise), ss=mins(cur.sunset), now=(new Date()).getHours()*60+(new Date()).getMinutes();
let f=(sr!=null&&ss!=null&&ss>sr)? (now-sr)/(ss-sr) : 0.5; f=Math.max(0,Math.min(1,f));
const ang=Math.PI*(1-f), cx=60+50*Math.cos(ang), cy=60-50*Math.sin(ang); // dot at (cx,cy)
```

**Moon tile:** CSS sphere — a circle with an inner shadow layer whose `translateX` maps illumination and waxing/waning: `const dir = /waxing|first/.test(phase) ? 1 : -1; shadowX = dir * (illumination - 50) ...` — implementer latitude; must visibly differ between new/quarter/full and show `phase.replace(/-/g,' ')` + `illumination%`.

**Scenes** (on `#sky` via `html[data-scene="..."]`; all layers `position:absolute; inset:0`; transform/opacity animations ONLY; `@media (prefers-reduced-motion: reduce){ #sky *{animation:none !important} }`). Complete reference for the two showpieces — the rest follow the same techniques with the stated parameters:

```css
/* storm: near-black churning sky, heavy diagonal rain, periodic lightning */
html[data-scene="storm"] #sky{background:linear-gradient(180deg,#0b0f1a,#1a2030 55%,#232a3a)}
.rain-layer{background-image:repeating-linear-gradient(115deg,transparent 0 7px,rgba(180,200,230,.28) 7px 8px,transparent 8px 14px);
  background-size:200% 200%;animation:rainfall .5s linear infinite}
.rain-layer.back{opacity:.4;animation-duration:.8s;filter:blur(1px)}
@keyframes rainfall{to{background-position:-40% 100%}}
.flash{background:radial-gradient(ellipse at 30% 0%,rgba(220,230,255,.9),transparent 60%);opacity:0;
  animation:lightning 9s infinite}
.flash.two{animation:lightning 13s infinite 4.6s}
@keyframes lightning{0%,96.5%,100%{opacity:0}97%{opacity:.85}97.6%{opacity:.1}98.2%{opacity:.6}98.8%{opacity:0}}
.bolt{position:absolute;top:4%;left:26%;width:120px;opacity:0;animation:boltflash 9s infinite}
@keyframes boltflash{0%,96.8%,98.4%,100%{opacity:0}97.2%{opacity:1}97.8%{opacity:.3}}
/* .bolt contains an inline SVG jagged polyline, stroke #dfe8ff, glow via drop-shadow */

/* clear-day: radiant sun, rotating rays, drifting wisps */
html[data-scene="clear-day"] #sky{background:linear-gradient(180deg,#2f7bd9,#5da4ec 55%,#8ec7f2)}
.sun{position:absolute;top:6%;right:10%;width:220px;height:220px;border-radius:50%;
  background:radial-gradient(circle,rgba(255,236,170,.95) 0 28%,rgba(255,220,120,.35) 45%,transparent 70%);
  animation:sunpulse 6s ease-in-out infinite}
@keyframes sunpulse{50%{transform:scale(1.06)}}
.rays{position:absolute;top:6%;right:10%;width:220px;height:220px;
  background:conic-gradient(from 0deg,transparent 0 8deg,rgba(255,240,180,.12) 8deg 14deg,transparent 14deg 24deg,
    rgba(255,240,180,.12) 24deg 30deg,transparent 30deg 45deg);border-radius:50%;
  animation:rayspin 40s linear infinite}
@keyframes rayspin{to{transform:rotate(360deg)}}
.wisp{position:absolute;height:60px;border-radius:60px;background:rgba(255,255,255,.35);filter:blur(18px);
  animation:drift linear infinite}
@keyframes drift{from{transform:translateX(-30vw)}to{transform:translateX(130vw)}}
```

- `clear-night`: gradient `#050914→#0c1630`; two star layers = 1×1 px divs with 40 `box-shadow` points each, `@keyframes twinkle{50%{opacity:.3}}` at 3 s/4.7 s offsets; soft moon glow radial top-left.
- `rain`: storm's rain layers (lighter opacity .18/.3), gradient `#232a38→#3a4556`, no flash/bolt, 2 slow wisp clouds.
- `clouds`: gradient `#3a4250→#5a6474`; 5 `.wisp`-style blobs, larger (blur 28 px), speeds 55–110 s.
- `snow`: gradient `#2e3644→#4a5568`; two flake layers = box-shadow particle divs animated `translateY(100vh)` 11 s/17 s linear with a `translateX` sway wrapper.
- `mist`: gradient `#4a5260→#6a7280`; 3 fog banks (`height:30%`, blur 30 px, `rgba(220,228,238,.16)`) sliding ±20 vw over 26–40 s.

**Glass/readability:** every content tile `background:rgba(12,18,28,.38); backdrop-filter:blur(14px)`; on `data-os="win10"` solid `rgba(16,20,28,.92)` (scenes stay — they're opaque gradients); all text on the sky sits above a subtle scrim. Include the same CSP meta as overlay-card.html, `<link rel="stylesheet" href="theme.css">`, one-time getShellStyle/status fetch, **no `setInterval`** (the sun-dot position is computed at render).

**Behavior JS:** copy the card's engaged-flag `scrollTo`, `dismissRequested`→`leave()`→`transitionend`+300 ms fallback→`cardFaded()` once (no hover-defer — every dismiss is immediate here), `btn-x`/Esc/blur→`cardClose()`.

- [ ] **Step 2: Static verification**

```
node -e "const s=require('fs').readFileSync('renderer/weather-board.html','utf8');['#sky','data-scene','t-moon','t-pressure','onCardRender','cardFaded','prefers-reduced-motion','lightning'].forEach(k=>{if(s.indexOf(k)<0)throw new Error('missing '+k)});const b=[...s.matchAll(/<script>([\s\S]*?)<\/script>/g)];b.forEach((m,i)=>new Function(m[1]));console.log('weather-board ok,',b.length,'script blocks,',s.length,'bytes')"
```

- [ ] **Step 3: Commit**

```bash
git add renderer/weather-board.html
git commit -m "feat(weather-board): iOS-style board renderer - animated sky scenes, hourly strip, 5-day bars, eight info tiles"
```

---

### Task 6: Slim `renderer/overlay-card.html` to rows-only

**Files:**
- Modify: `renderer/overlay-card.html`

**Interfaces:** rows rendering, manual/auto dismissal, fade-ack, hover-defer all byte-identical. Removed: `#now`/`#strip-wrap` markup + strip/tile CSS + sprite `<defs>` + `icon()` + the forecast branch of `render()`; `scrollTo(i)` body becomes a no-op (listener stays registered).

- [ ] **Step 1: Edit.** `render(p)` keeps only the rows path (`p.kind` is always `'rows'` for this window now — keep the `else` branch content as the unconditional body, delete the forecast branch and the `applyAccent` forecast-specific bits only if unused).
- [ ] **Step 2: Verify** — `node -e` extraction/`new Function` parse check (as Task 5's pattern) + confirm `i-sun` etc. absent and `onCardScrollTo` still registered; `node tests/test-overlay-card.js` (pure suite unaffected).
- [ ] **Step 3: Commit** — `git commit -m "refactor(overlay-card): rows-only renderer - forecast layout moved to the weather board"`.

---

### Task 7: Settings — Weather card size slider

**Files:**
- Modify: `renderer/index.html` (Weather sec + `populateWeather`/`saveWeather`)

**Interfaces:** Consumes `weatherCardScale` (Task 1 default). Slider `#weather-scale` (range 65–100 step 5) + live label `#weather-scale-label` ("75% of screen"); `populateWeather()` sets it from `Math.round((c.weatherCardScale||0.65)*100)`; `saveWeather()` adds `weatherCardScale: Number(document.getElementById('weather-scale').value)/100`. Hint text: "Dragging or resizing the weather board also remembers its exact spot."

- [ ] **Step 1: Edit** (markup after the Default location row):

```html
      <div class="row" style="display:block">
        <div class="l" style="margin-bottom:7px">Card size <span class="d" style="display:inline" id="weather-scale-label">65% of screen</span></div>
        <input id="weather-scale" type="range" min="65" max="100" step="5" style="width:100%"
               oninput="document.getElementById('weather-scale-label').textContent=this.value+'% of screen'">
        <div class="statusline">Dragging or resizing the weather board also remembers its exact spot.</div>
      </div>
```

plus the two JS lines in populate/save described above (populate also updates the label).

- [ ] **Step 2: Verify** — inline-script parse check + `node tests/test-engines.js` regression.
- [ ] **Step 3: Commit** — `git commit -m "feat(settings): weather board size slider (65-100% of screen)"`.

---

### Task 8: Full verification + docs

**Files:** spec status line; ledger.

- [ ] **Step 1:** Full node suite + `D:/brain-ai/brain-ai/.venv/Scripts/python.exe tests/test_automation.py`.
- [ ] **Step 2:** Manual gate (controller/human): `set CARYL_DEV=1 && npm start` from a checkout WITH node_modules (the root repo after merge — worktrees have none): `Ctrl+Alt+K` → clear-day board (sun/rays/wisps), again → storm board (rain + lightning), rows fixtures → small card unchanged; resize/drag the board, restart, position remembered; slider changes fresh-open size; board stays open through narration end; × closes; "weather in <city>" end-to-end.
- [ ] **Step 3:** Spec `**Status:**` → `Implemented (see docs/superpowers/plans/2026-07-04-weather-board.md).` Commit `docs: mark Weather Board spec implemented`.

---

## Self-review notes (done)

- Spec coverage: payload v2 → T2/T3; two windows/sizing/persistence → T4; board UI + scenes + tiles → T5; rows-only card → T6; slider → T7; config → T1; demotion rules → T2/T3; fixtures incl. storm → T4; tests → T1–T3 + integration; manual gate → T8. No gaps.
- Type consistency: `open() -> {cardId, kind}` consumed in T4 main.js; model field names in T3 match T5's renderer contract and T2's payload keys; `SCENES` list matches `sceneFor` outputs (T1).
- Deviation noted in header (aggregateDaily 'Today' rule). T5 is contract+reference rather than full verbatim HTML — deliberate: the hard math/CSS is complete above, layout assembly is delegated to a design-capable implementer and gated by T8's visual checklist.
