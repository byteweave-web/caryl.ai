// lib/kernel/handlers/weather.js
// API_NATIVE handler: weather from Open-Meteo (open-meteo.com), rendered into the board card
// (never a browser). Open-Meteo is free and needs NO API key, is global, and geocodes
// place/country names by population rank. Two injected-fetch calls: geocoding (name ->
// lat/lon) then forecast (lat/lon -> data). Every failure maps to a SAFE user-facing string.
//
// The network client is INJECTED (ctx.fetch) so unit tests mock responses and never touch
// the network. Emits payload v2 (the board contract) with FINAL sprite ids and a scene;
// overlay.js only validates them. moonPhase is computed locally (no free API has it).

const GEO_ENDPOINT = 'https://geocoding-api.open-meteo.com/v1/search';
const OM_ENDPOINT = 'https://api.open-meteo.com/v1/forecast';

function unitSymbol(units) { return units === 'imperial' ? '°F' : '°C'; }
function cap(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }
function n(v) { const x = Number(v); return isFinite(x) ? x : null; }             // finite Number or null
function hhmm(iso) { const m = /T(\d\d:\d\d)/.exec(String(iso == null ? '' : iso)); return m ? m[1] : ''; }
function clampPop(v) { const x = Number(v); return isFinite(x) ? Math.max(0, Math.min(100, Math.round(x))) : 0; }

// The router's "after:in|for|at" extractor grabs everything after the keyword, so
// "weather in Lebanon today?" yields "Lebanon today?". Strip trailing punctuation and
// time/politeness filler ("today", "right now", "this evening", "please", ...) so only the
// place name is geocoded. Never strips the last remaining word.
const LOC_FILLER = new Set([
  'today', 'tonight', 'tomorrow', 'now', 'currently', 'please', 'rn', 'right', 'this',
  'morning', 'afternoon', 'evening', 'week', 'weekend', 'outside', 'like'
]);
function cleanLocation(loc) {
  let words = String(loc == null ? '' : loc).trim().replace(/[?!.,;:]+$/g, '').trim().split(/\s+/);
  while (words.length > 1 && LOC_FILLER.has(words[words.length - 1].toLowerCase().replace(/[^a-z]/g, ''))) {
    words.pop();
  }
  return words.join(' ').trim();
}

// --- WMO weather-code mapping (Open-Meteo uses integer WMO codes, not OWM "01d" strings) ---

// WMO code (+ day flag) -> board sprite id (one of the 9 the renderer defines).
function wmoSprite(code, isDay) {
  const c = Number(code);
  if (c === 0 || c === 1) return isDay ? 'sun' : 'moon';
  if (c === 2) return 'partly';
  if (c === 3) return 'cloud';
  if (c === 45 || c === 48) return 'mist';
  if (c >= 51 && c <= 57) return 'drizzle';
  if ((c >= 61 && c <= 67) || (c >= 80 && c <= 82)) return 'rain';
  if ((c >= 71 && c <= 77) || c === 85 || c === 86) return 'snow';
  if (c >= 95 && c <= 99) return 'thunder';
  return 'cloud';
}

// WMO code (+ day flag) -> the board's animated sky scene.
function wmoScene(code, isDay) {
  const c = Number(code);
  if (c === 0 || c === 1) return isDay ? 'clear-day' : 'clear-night';
  if (c === 2 || c === 3) return 'clouds';
  if (c === 45 || c === 48) return 'mist';
  if ((c >= 51 && c <= 67) || (c >= 80 && c <= 82)) return 'rain';
  if ((c >= 71 && c <= 77) || c === 85 || c === 86) return 'snow';
  if (c >= 95 && c <= 99) return 'storm';
  return 'clouds';
}

// WMO code -> a human condition string (Open-Meteo gives only the code).
const WMO_TEXT = {
  0: 'Clear sky', 1: 'Mainly clear', 2: 'Partly cloudy', 3: 'Overcast',
  45: 'Fog', 48: 'Depositing rime fog',
  51: 'Light drizzle', 53: 'Drizzle', 55: 'Dense drizzle', 56: 'Freezing drizzle', 57: 'Freezing drizzle',
  61: 'Slight rain', 63: 'Rain', 65: 'Heavy rain', 66: 'Freezing rain', 67: 'Freezing rain',
  71: 'Slight snow', 73: 'Snow', 75: 'Heavy snow', 77: 'Snow grains',
  80: 'Rain showers', 81: 'Rain showers', 82: 'Violent rain showers', 85: 'Snow showers', 86: 'Snow showers',
  95: 'Thunderstorm', 96: 'Thunderstorm with hail', 99: 'Thunderstorm with hail'
};
function wmoText(code) { return WMO_TEXT[Number(code)] || '—'; }

// Synodic-month moon phase, computed locally (no free API provides it).
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

// The spoken summary as ordered, tile-anchored segments: now -> notable change -> the strip's
// end, with any precipitation called out. Joined in order it IS run()'s speak.
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

// Index of the first hourly slot at/after the 'current' timestamp (Open-Meteo hourly starts
// at 00:00 local for today, so "now" is partway in). Falls back to 0.
function pickHour(hourly, currentTime) {
  const times = (hourly && Array.isArray(hourly.time)) ? hourly.time : [];
  const now = String(currentTime || '');
  for (let i = 0; i < times.length; i++) { if (times[i] >= now) return i; }
  return 0;
}

// geocoded place + Open-Meteo forecast body -> the v2 board payload (spec contract).
// Temps/wind arrive already in the requested unit (no conversion); visibility is metres.
function buildBoardPayload(place, om, units) {
  const cur = om.current || {};
  const daily = om.daily || {};
  const hourly = om.hourly || {};
  const imperial = units === 'imperial';
  const isDay = cur.is_day === 1 || cur.is_day === true;

  const ht = Array.isArray(hourly.time) ? hourly.time : [];
  const start = pickHour(hourly, cur.time);
  const tiles = [];
  for (let i = start; i < ht.length && tiles.length < 8; i++) {
    const hd = Array.isArray(hourly.is_day) ? hourly.is_day[i] : 1;
    const code = hourly.weather_code ? hourly.weather_code[i] : null;
    tiles.push({
      time: hhmm(ht[i]),
      temp: Math.round(n(hourly.temperature_2m && hourly.temperature_2m[i]) || 0),
      icon: wmoSprite(code, hd === 1 || hd === true),
      condition: wmoText(code),
      pop: clampPop(hourly.precipitation_probability && hourly.precipitation_probability[i])
    });
  }

  const dt = Array.isArray(daily.time) ? daily.time : [];
  const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const days = [];
  for (let i = 0; i < dt.length && days.length < 6; i++) {
    days.push({
      day: i === 0 ? 'Today' : WD[new Date(dt[i] + 'T00:00:00Z').getUTCDay()],
      icon: wmoSprite(daily.weather_code ? daily.weather_code[i] : null, true),
      lo: Math.round(n(daily.temperature_2m_min && daily.temperature_2m_min[i]) || 0),
      hi: Math.round(n(daily.temperature_2m_max && daily.temperature_2m_max[i]) || 0),
      pop: clampPop(daily.precipitation_probability_max && daily.precipitation_probability_max[i])
    });
  }

  const temp = n(cur.temperature_2m);
  const today = days[0] || { hi: Math.round(temp || 0), lo: Math.round(temp || 0) };
  const visM = n(cur.visibility);
  const norm = { city: place.name, temp: temp || 0, description: wmoText(cur.weather_code).toLowerCase() };

  return {
    kind: 'forecast',
    title: place.name + (place.country && place.country !== place.name ? ', ' + place.country : ''),
    accent: 'sky',
    scene: wmoScene(cur.weather_code, isDay),
    current: {
      units: imperial ? 'imperial' : 'metric',
      temp: Math.round(temp || 0), hi: today.hi, lo: today.lo,
      icon: wmoSprite(cur.weather_code, isDay), condition: wmoText(cur.weather_code),
      feelsLike: n(cur.apparent_temperature) == null ? null : Math.round(n(cur.apparent_temperature)),
      humidity: n(cur.relative_humidity_2m) == null ? null : Math.round(n(cur.relative_humidity_2m)),
      dewPoint: n(cur.dew_point_2m) == null ? null : Math.round(n(cur.dew_point_2m)),
      pressure: n(cur.surface_pressure) == null ? null : Math.round(n(cur.surface_pressure)),
      visibility: visM == null ? null : Math.round((imperial ? visM / 1609.34 : visM / 1000) * 10) / 10,
      wind: {
        speed: n(cur.wind_speed_10m) == null ? null : Math.round(n(cur.wind_speed_10m)),
        gust: n(cur.wind_gusts_10m) == null ? null : Math.round(n(cur.wind_gusts_10m)),
        deg: n(cur.wind_direction_10m) == null ? null : Math.round(n(cur.wind_direction_10m))
      },
      sunrise: hhmm(daily.sunrise && daily.sunrise[0]),
      sunset: hhmm(daily.sunset && daily.sunset[0]),
      isNight: !isDay,
      moon: moonPhase(Date.now())
    },
    hourly: tiles,
    daily: days,
    narration: buildNarration(norm, tiles, units)
  };
}

// One geocoding search. Returns { results:[...] } on 200, or a flag for a network/parse
// failure so the caller can map it to the right safe message.
async function geoSearch(f, name) {
  const url = GEO_ENDPOINT + '?name=' + encodeURIComponent(name) + '&count=5&language=en&format=json';
  let resp;
  try { resp = await f(url); }
  catch (_e) { return { net: true }; }
  if (!resp || resp.status !== 200) return { results: [] };
  let body;
  try { body = await resp.json(); }
  catch (_e) { return { malformed: true }; }
  return { results: Array.isArray(body && body.results) ? body.results : [] };
}

// Async shell: resolve a place name to coordinates via Open-Meteo geocoding. Picks the
// highest-population match (capital/largest city for a country query); missing population
// sorts last, ties fall to Open-Meteo's own relevance order. If a name with a leading
// article ("the Philippines") returns nothing, retry once without it — but only then, so
// names where the article is real ("the Hague", "the Netherlands") still resolve as typed.
async function geocode(location, opts) {
  opts = opts || {};
  const f = opts.fetchImpl || (typeof fetch === 'function' ? fetch : null);
  if (typeof f !== 'function') return { ok: false, error: 'Weather is unavailable — no network client.' };

  let s = await geoSearch(f, location);
  if (s.net) return { ok: false, error: 'Could not reach the weather service — check your connection.' };
  if (s.malformed) return { ok: false, error: 'The weather service returned malformed data.' };
  if (!s.results.length && /^the\s+/i.test(location)) {
    const s2 = await geoSearch(f, location.replace(/^the\s+/i, ''));
    if (s2 && Array.isArray(s2.results)) s = s2;
  }

  const results = s.results || [];
  if (!results.length) return { ok: false, error: 'I couldn’t find weather for that location.' };
  let best = results[0];
  for (const r of results) { if ((Number(r.population) || 0) > (Number(best.population) || 0)) best = r; }
  if (typeof best.latitude !== 'number' || typeof best.longitude !== 'number') {
    return { ok: false, error: 'I couldn’t find weather for that location.' };
  }
  return { ok: true, place: { name: best.name || location, country: best.country || '', lat: best.latitude, lon: best.longitude } };
}

// Async shell: fetch the current+hourly+daily forecast for a coordinate, in the user's units.
async function fetchForecastOM(opts) {
  opts = opts || {};
  const f = opts.fetchImpl || (typeof fetch === 'function' ? fetch : null);
  if (typeof f !== 'function') return { ok: false, error: 'Weather is unavailable — no network client.' };
  const tempUnit = opts.units === 'imperial' ? 'fahrenheit' : 'celsius';
  const windUnitParam = opts.units === 'imperial' ? 'mph' : 'kmh';
  const url = OM_ENDPOINT +
    '?latitude=' + encodeURIComponent(opts.lat) + '&longitude=' + encodeURIComponent(opts.lon) +
    '&current=temperature_2m,relative_humidity_2m,apparent_temperature,is_day,weather_code,surface_pressure,wind_speed_10m,wind_direction_10m,wind_gusts_10m,dew_point_2m,visibility' +
    '&hourly=temperature_2m,weather_code,precipitation_probability,is_day' +
    '&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,sunrise,sunset' +
    '&timezone=auto&forecast_days=6' +
    '&temperature_unit=' + tempUnit + '&wind_speed_unit=' + windUnitParam;
  let resp;
  try { resp = await f(url); }
  catch (_e) { return { ok: false, error: 'Could not reach the weather service — check your connection.' }; }
  if (!resp || resp.status !== 200) return { ok: false, error: 'The weather service is unavailable right now. Try again shortly.' };
  let body;
  try { body = await resp.json(); }
  catch (_e) { return { ok: false, error: 'The weather service returned malformed data.' }; }
  if (!body || !body.current || !body.hourly || !body.daily) return { ok: false, error: 'The weather service returned incomplete data.' };
  return { ok: true, data: body };
}

// Kernel handler entrypoint. No API key needed. Reads units/default-location from ctx.config;
// a location is required (asked once if absent). Geocode, then forecast, then build the board.
async function run(params, ctx) {
  ctx = ctx || {};
  const cfg = ctx.config || {};
  const units = cfg.weatherUnits || ctx.units || 'metric';
  const location = cleanLocation((params && params.location) || cfg.weatherDefaultLocation || '');

  if (!location) return { ok: false, error: 'Which city’s weather would you like?', needs: ['location'] };

  const geo = await geocode(location, { fetchImpl: ctx.fetch });
  if (!geo.ok) return { ok: false, error: geo.error };

  const fc = await fetchForecastOM({ lat: geo.place.lat, lon: geo.place.lon, units, fetchImpl: ctx.fetch });
  if (!fc.ok) return { ok: false, error: fc.error };

  const payload = buildBoardPayload(geo.place, fc.data, units);
  const speak = payload.narration.map((s) => s.text).join(' ');
  return { ok: true, speak, overlay: payload, value: geo.place };
}

module.exports = {
  run, geocode, fetchForecastOM, pickHour, buildBoardPayload, buildNarration,
  wmoSprite, wmoScene, wmoText, moonPhase, cleanLocation, unitSymbol
};
