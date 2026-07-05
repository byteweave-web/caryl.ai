# Open-Meteo Weather Source — Design Spec

**Date:** 2026-07-05
**Sub-project:** Kernel weather handler — swap the data source.
**Status:** Implemented (weather-board branch; verified live against Open-Meteo for
"the Philippines", "Tokyo", "New York").

## Context

The weather handler used OpenWeather, which requires a per-user API key and 404s on
country-name queries ("Philippines", "Lebanon") because its `q=` lookup is city-only. The
user hit both walls. **Open-Meteo** (open-meteo.com) is free, needs **no API key**, is
global, and its geocoding resolves country/place names by population rank. Decisions locked
(2026-07-05): **replace OpenWeather entirely** (drop the key requirement and its Settings
row) and, for a country query, show its **highest-population match** (capital/largest city
region) — which is simply Open-Meteo geocoding's top result.

The **payload v2 contract is unchanged** (renderer/weather-board.html, overlay.js
normalizePayload structure, main.js kernel wiring all stay). Only weather.js's data half and
the icon/scene code mapping change, plus the Settings key row is removed.

## APIs (verified 2026-07-05, no key)

**Geocoding:** `GET https://geocoding-api.open-meteo.com/v1/search?name=<q>&count=5&language=en&format=json`
→ `{ results: [{ name, country, latitude, longitude, timezone, population? }] }` or no
`results`. Pick the entry with the **highest `population`** (missing population sorts last);
ties/all-missing → the first result. Empty/absent results → "I couldn't find that location."

**Forecast:** `GET https://api.open-meteo.com/v1/forecast` with query params:
- `latitude`, `longitude` (from geocoding)
- `current=temperature_2m,relative_humidity_2m,apparent_temperature,is_day,weather_code,surface_pressure,wind_speed_10m,wind_direction_10m,wind_gusts_10m,dew_point_2m,visibility`
- `hourly=temperature_2m,weather_code,precipitation_probability,is_day`
- `daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,sunrise,sunset`
- `timezone=auto`, `forecast_days=6`
- `temperature_unit=celsius|fahrenheit`, `wind_speed_unit=kmh|mph` (from `weatherUnits`)

Response (arrays are parallel, indexed by `time`): `current{...}`, `hourly{time[],
temperature_2m[], weather_code[], precipitation_probability[], is_day[]}` (144 hrs),
`daily{time[], weather_code[], temperature_2m_max[], temperature_2m_min[],
precipitation_probability_max[], sunrise[], sunset[]}` (6 days), `utc_offset_seconds`,
`timezone`. Temp/wind arrive in the requested unit; **visibility is always metres**;
`precipitation_probability` is already 0–100.

## WMO weather-code mapping (new)

Open-Meteo uses WMO codes (integers), not OpenWeather's `01d` strings. Three pure functions
map them:

- `wmoSprite(code, isDay) -> sprite id` (the 9 board sprites): 0/1 → `sun`/`moon` by isDay;
  2 → `partly`; 3 → `cloud`; 45/48 → `mist`; 51/53/55/56/57 → `drizzle`;
  61/63/65/66/67/80/81/82 → `rain`; 71/73/75/77/85/86 → `snow`; 95/96/99 → `thunder`;
  default → `cloud`.
- `wmoScene(code, isDay) -> scene`: 0/1 → `clear-day`/`clear-night` by isDay; 2/3 →
  `clouds`; 45/48 → `mist`; 51..67,80..82 → `rain`; 71..77,85/86 → `snow`; 95/96/99 →
  `storm`; default → `clouds`.
- `wmoText(code) -> condition string`: 0 "Clear sky", 1 "Mainly clear", 2 "Partly cloudy",
  3 "Overcast", 45 "Fog", 48 "Depositing rime fog", 51/53/55 "Light/…/Dense drizzle",
  56/57 "Freezing drizzle", 61/63/65 "Slight/Moderate/Heavy rain", 66/67 "Freezing rain",
  71/73/75 "Slight/Moderate/Heavy snow", 77 "Snow grains", 80/81/82 "Rain showers",
  85/86 "Snow showers", 95 "Thunderstorm", 96/99 "Thunderstorm with hail", default
  "—".

**Icon layering change:** weather.js now emits **final sprite ids** in the payload (it has
`is_day` per entry). `overlay.js` `mapIcon` becomes a **sprite-id validator** —
`SPRITES.has(id) ? id : 'cloud'` — keeping normalizePayload's structure identical (it still
calls mapIcon on every icon; the meaning shifts from "OWM→sprite" to "validate sprite").
The `sceneFor` (OWM-code) function in weather.js is replaced by `wmoScene`.

## weather.js rewrite (data half)

Removed (OpenWeather-specific): `fetchWeather`, `fetchForecast`, `normalize`,
`normalizeForecast`, `aggregateDaily`, `sceneFor`, `dewPoint`/`dewPointRaw` (Open-Meteo
provides `dew_point_2m` directly), `fmtHour`, the `ENDPOINT`/`FORECAST_ENDPOINT` consts, and
their tests. Kept: `moonPhase` (no API has it), `buildNarration`, `fmtClock`, `cleanLocation`,
`cap`, `unitSymbol`, `mapError`, `summarize`.

Added:
- `geocode(location, {fetchImpl}) -> { ok, place:{name,country,lat,lon} } | { ok:false, error }`.
- `fetchForecastOM({lat, lon, units, fetchImpl}) -> { ok, data } | { ok:false, error }`.
- `pickHour(hourly, currentTime) -> startIndex` (first hourly `time >= current.time`; else 0).
- `buildBoardPayload(place, om, units) -> payload v2` — assembles current/hourly(8 from
  startIndex)/daily(≤6) directly, **no unit conversion** for temp/wind (already in units),
  visibility m→km/mi, `dewPoint` straight from `current.dew_point_2m` rounded, `isNight =
  !current.is_day`, `moon = moonPhase(Date.now())`, `scene = wmoScene(current.weather_code,
  is_day)`, icons via `wmoSprite`, `condition = wmoText`, sunrise/sunset from
  `daily.sunrise[0]`/`sunset[0]` (already local ISO → take the `HH:MM`). Title = `name` +
  (`, country` when `country && country !== name`).

`run(params, ctx)`: no API-key check (dropped). `location = cleanLocation(params.location ||
cfg.weatherDefaultLocation)`. If no location → `needs:['location']`. `geocode` → on failure
return the safe error. `fetchForecastOM` → on success build the v2 payload + narration
(`speak` = joined narration); on failure return the safe error. **No rows demotion** (the OM
forecast always carries hourly+daily together — either the whole call succeeds or it errors;
there is no "current-ok-forecast-failed" split like OpenWeather had).

## Settings, config, main.js

- `renderer/index.html`: remove the **OpenWeather API Key** row and its badge from the
  Weather section; keep **Units** and **Default location**. `populateWeather`/`saveWeather`
  drop `openWeatherApiKey`. Update the section subtitle to "No API key needed — powered by
  Open-Meteo." Keep the size slider (unrelated).
- `lib/config.js`: `openWeatherApiKey` default may remain (ignored) to avoid a migration
  churn, but is no longer read; `weatherUnits`/`weatherDefaultLocation`/`weatherCardScale`/
  `weatherBoardBounds` unchanged.
- `main.js`: kernel wiring unchanged — the handler still returns `{ok, speak, overlay}` with
  the same v2 payload. `getConfig` already threads `weatherUnits`/`weatherDefaultLocation`.

## Error handling

| Failure | Behavior |
|---|---|
| No location and no default | `needs:['location']`, "Which city's weather would you like?" |
| Geocoding no results / network / bad body | "I couldn't find weather for that location." (safe, no raw leak) |
| Forecast network / non-200 / malformed | "The weather service is unavailable right now. Try again shortly." |
| Missing optional current field (visibility, gust…) | tile shows '—'; never `undefined` |
| Unknown WMO code | sprite `cloud`, scene `clouds`, text '—' |

## Testing

- **Unit (`tests/test-handlers.js`):** `wmoSprite`/`wmoScene`/`wmoText` full code tables +
  day/night + default; `pickHour`; `buildBoardPayload` from a mocked Open-Meteo body
  (metric + imperial: assert no double-conversion — wind stays the requested number,
  dewPoint straight from body, 8 hourly, ≤6 daily, scene, moon, title dedupe); `geocode`
  highest-population pick (mocked); `cleanLocation` unchanged.
- **Unit (`tests/test-overlay-card.js`):** `mapIcon` now a sprite-id validator (known id →
  itself, junk → 'cloud'); board model tests unchanged (they already feed sprite ids).
- **Integration (`tests/test-integration.js`):** weather e2e with a **mocked fetch that
  dispatches by URL** (geocoding vs forecast) → `kind:'forecast'` payload, 8 hourly, ≥2
  daily, scene, `speak` === joined narration, and **zero real network**.
- **Manual gate:** "weather in the Philippines", "weather in Tokyo", a country + a city,
  imperial toggle, board renders + narrates + persists.

## Out of scope

- Caching geocoding results; multiple saved locations; UV index; the small rows card
  (systemStats still uses it, untouched); Growth Loop.
