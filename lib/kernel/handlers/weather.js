// lib/kernel/handlers/weather.js
// API_NATIVE handler: current weather from OpenWeather, rendered into the overlay card
// (never a browser). The network client is INJECTED (ctx.fetch), so unit tests mock the
// API response and never touch the network; production falls back to the global fetch.
//
// Split into pure pieces (normalize / buildPayload / mapError / summarize) plus one async
// shell (fetchWeather / run). Every failure - bad key, 404, rate limit, network drop,
// malformed body - maps to a SAFE user-facing string; raw API/network text is never leaked.

const ENDPOINT = 'https://api.openweathermap.org/data/2.5/weather';
const FORECAST_ENDPOINT = 'https://api.openweathermap.org/data/2.5/forecast';

function unitSymbol(units) { return units === 'imperial' ? '°F' : '°C'; }
function windUnit(units) { return units === 'imperial' ? 'mph' : 'm/s'; }
function cap(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }

// Raw OpenWeather JSON -> the fields we use, or null if the essential ones are absent.
function normalize(data) {
  if (!data || typeof data !== 'object') return null;
  const main = data.main || {};
  if (typeof main.temp !== 'number') return null; // temperature is the one hard requirement
  const w = (Array.isArray(data.weather) && data.weather[0]) || {};
  return {
    city: data.name || '',
    country: (data.sys && data.sys.country) || '',
    temp: main.temp,
    feelsLike: typeof main.feels_like === 'number' ? main.feels_like : null,
    humidity: typeof main.humidity === 'number' ? main.humidity : null,
    description: w.description || w.main || '',
    icon: (w.icon || ''),
    windSpeed: (data.wind && typeof data.wind.speed === 'number') ? data.wind.speed : null,
    pressure: (typeof main.pressure === 'number') ? main.pressure : null,
    visibilityM: (typeof data.visibility === 'number') ? data.visibility : null,
    windDeg: (data.wind && typeof data.wind.deg === 'number') ? data.wind.deg : null,
    windGust: (data.wind && typeof data.wind.gust === 'number') ? data.wind.gust : null,
    sunrise: (data.sys && typeof data.sys.sunrise === 'number') ? data.sys.sunrise : null,
    sunset: (data.sys && typeof data.sys.sunset === 'number') ? data.sys.sunset : null,
    tz: (typeof data.timezone === 'number') ? data.timezone : 0,
    dt: (typeof data.dt === 'number') ? data.dt : null
  };
}

// normalized -> { title, rows:[{label,value}], accent }. Same overlay schema as systemStats.
function buildPayload(norm, units) {
  norm = norm || {};
  const sym = unitSymbol(units);
  const rows = [];
  rows.push({ label: 'Now', value: Math.round(norm.temp) + sym + (norm.description ? ', ' + cap(norm.description) : '') });
  if (norm.feelsLike != null) rows.push({ label: 'Feels like', value: Math.round(norm.feelsLike) + sym });
  if (norm.humidity != null) rows.push({ label: 'Humidity', value: norm.humidity + '%' });
  if (norm.windSpeed != null) rows.push({ label: 'Wind', value: norm.windSpeed + ' ' + windUnit(units) });
  const title = norm.city ? (norm.city + (norm.country ? ', ' + norm.country : '')) : 'Weather';
  return { title, accent: 'sky', rows };
}

function summarize(norm, units) {
  const where = norm.city ? ' in ' + norm.city : '';
  const desc = norm.description || 'clear';
  return 'It’s ' + Math.round(norm.temp) + unitSymbol(units) + ' and ' + desc + where + '.';
}

// HTTP status -> a safe, friendly message. Never surfaces the raw API body.
function mapError(status) {
  if (status === 401 || status === 403) return 'Your OpenWeather API key looks invalid or isn’t active yet — check it in Settings.';
  if (status === 404) return 'I couldn’t find weather for that location.';
  if (status === 429) return 'The weather service is busy right now (rate limited). Try again in a moment.';
  if (status >= 500) return 'The weather service is temporarily unavailable. Try again shortly.';
  return 'The weather lookup failed (error ' + status + ').';
}

// Unix seconds + tz offset -> local "HH:00" label for a 3-hour forecast step.
function fmtHour(unixSec, tzSec) {
  const h = Math.floor((((Number(unixSec) || 0) + (Number(tzSec) || 0)) % 86400) / 3600);
  return String((h + 24) % 24).padStart(2, '0') + ':00';
}

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

// Magnus formula. Celsius in, raw (unrounded) Celsius out, or null on non-finite temp /
// rh<=0. Callers that need a display value in another unit should round AFTER converting,
// not before (rounding twice can shift the displayed value by 1 degree).
function dewPointRaw(tempC, humidityPct) {
  const t = Number(tempC), rh = Number(humidityPct);
  if (!isFinite(t) || !isFinite(rh) || rh <= 0) return null;
  const a = 17.62, b = 243.12;
  const gamma = (a * t) / (b + t) + Math.log(rh / 100);
  return (b * gamma) / (a - gamma);
}

// Magnus formula. Celsius in, rounded Celsius out (callers convert for imperial display).
function dewPoint(tempC, humidityPct) {
  const r = dewPointRaw(tempC, humidityPct);
  return r == null ? null : Math.round(r);
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

// Raw OpenWeather /forecast JSON -> the next ~24h as 8 three-hour tiles, or null.
// Icon codes stay RAW here (e.g. '10d'); the card maps them to sprite ids.
function normalizeForecast(data) {
  if (!data || typeof data !== 'object' || !Array.isArray(data.list) || !data.list.length) return null;
  const tz = (data.city && Number(data.city.timezone)) || 0;
  const tiles = [];
  const full = [];
  for (const e of data.list) {
    if (!e || !e.main || typeof e.main.temp !== 'number') continue;
    const w = (Array.isArray(e.weather) && e.weather[0]) || {};
    const pop = Math.round((Number(e.pop) || 0) * 100);
    const icon = w.icon || '';
    const condition = cap(w.description || w.main || '');
    if (tiles.length < 8) {
      tiles.push({
        time: fmtHour(e.dt, tz),
        temp: e.main.temp,
        icon,
        condition,
        pop
      });
    }
    full.push({ dt: e.dt, temp: e.main.temp, icon, condition, pop });
  }
  return tiles.length ? { tiles, full, tz } : null;
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

// normalized current + normalized forecast -> the v2 board payload (spec contract).
function buildBoardPayload(norm, fnorm, units) {
  const imperial = units === 'imperial';
  const daily = aggregateDaily(fnorm.full, fnorm.tz);
  const today = daily[0] || { hi: Math.round(norm.temp), lo: Math.round(norm.temp) };
  const night = (norm.dt != null && norm.sunrise != null && norm.sunset != null)
    ? isNightAt(norm.dt, norm.sunrise, norm.sunset) : false;
  const tempC = imperial ? (norm.temp - 32) * 5 / 9 : norm.temp;
  const dewC = (norm.humidity != null) ? dewPointRaw(tempC, norm.humidity) : null;
  return {
    kind: 'forecast',
    title: norm.city ? (norm.city + (norm.country ? ', ' + norm.country : '')) : 'Weather',
    accent: 'sky',
    scene: sceneFor(norm.icon, night),
    current: {
      units: imperial ? 'imperial' : 'metric', // the board picks wind/visibility labels from this
      temp: Math.round(norm.temp), hi: today.hi, lo: today.lo,
      icon: norm.icon || '', condition: cap(norm.description || ''),
      feelsLike: norm.feelsLike != null ? Math.round(norm.feelsLike) : null,
      humidity: norm.humidity != null ? norm.humidity : null,
      dewPoint: dewC == null ? null : Math.round(imperial ? dewC * 9 / 5 + 32 : dewC),
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

// Async shell: call the API via the injected fetch, normalize, or return a safe error.
async function fetchWeather(opts) {
  opts = opts || {};
  const f = opts.fetchImpl || (typeof fetch === 'function' ? fetch : null);
  if (typeof f !== 'function') return { ok: false, error: 'Weather is unavailable — no network client.' };
  const url = ENDPOINT + '?q=' + encodeURIComponent(opts.location) +
    '&units=' + encodeURIComponent(opts.units || 'metric') +
    '&appid=' + encodeURIComponent(opts.apiKey);

  let resp;
  try { resp = await f(url); }
  catch (_e) { return { ok: false, error: 'Could not reach the weather service — check your connection.' }; }
  if (!resp || typeof resp.status !== 'number') return { ok: false, error: 'The weather service returned an unexpected response.' };
  if (resp.status !== 200) return { ok: false, error: mapError(resp.status) };

  let body;
  try { body = await resp.json(); }
  catch (_e) { return { ok: false, error: 'The weather service returned malformed data.' }; }
  const norm = normalize(body);
  if (!norm) return { ok: false, error: 'The weather service returned incomplete data.' };
  return { ok: true, data: norm };
}

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

// Kernel handler entrypoint. Reads key/units/default-location from ctx.config; the API key
// and a location are required, and both are checked BEFORE any network call is attempted.
async function run(params, ctx) {
  ctx = ctx || {};
  const cfg = ctx.config || {};
  const apiKey = cfg.openWeatherApiKey || ctx.apiKey || '';
  const units = cfg.weatherUnits || ctx.units || 'metric';
  const location = ((params && params.location) || cfg.weatherDefaultLocation || '').trim();

  if (!apiKey) return { ok: false, error: 'Add your OpenWeather API key in Settings to get weather.' };
  if (!location) return { ok: false, error: 'Which city’s weather would you like?', needs: ['location'] };

  const [res, fres] = await Promise.all([
    fetchWeather({ location, apiKey, units, fetchImpl: ctx.fetch }),
    fetchForecast({ location, apiKey, units, fetchImpl: ctx.fetch })
  ]);
  if (!res.ok) return { ok: false, error: res.error };
  if (fres.ok) {
    const payload = buildBoardPayload(res.data, fres.data, units);
    if (payload.daily.length >= 2 && payload.hourly.length) {
      const speak = payload.narration.map((s) => s.text).join(' ');
      return { ok: true, speak, overlay: payload, value: res.data };
    }
  }
  // Forecast unavailable or too thin -> today's rows card (never a half-board).
  return { ok: true, speak: summarize(res.data, units), overlay: buildPayload(res.data, units), value: res.data };
}

module.exports = {
  run, fetchWeather, fetchForecast, normalize, normalizeForecast,
  buildPayload, buildNarration, fmtHour, fmtClock,
  isNightAt, sceneFor, dewPoint, dewPointRaw, moonPhase, mapError, summarize,
  aggregateDaily, buildBoardPayload
};
