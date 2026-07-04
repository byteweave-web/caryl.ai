// lib/kernel/handlers/weather.js
// API_NATIVE handler: current weather from OpenWeather, rendered into the overlay card
// (never a browser). The network client is INJECTED (ctx.fetch), so unit tests mock the
// API response and never touch the network; production falls back to the global fetch.
//
// Split into pure pieces (normalize / buildPayload / mapError / summarize) plus one async
// shell (fetchWeather / run). Every failure - bad key, 404, rate limit, network drop,
// malformed body - maps to a SAFE user-facing string; raw API/network text is never leaked.

const ENDPOINT = 'https://api.openweathermap.org/data/2.5/weather';

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
    windSpeed: (data.wind && typeof data.wind.speed === 'number') ? data.wind.speed : null
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

  const res = await fetchWeather({ location, apiKey, units, fetchImpl: ctx.fetch });
  if (!res.ok) return { ok: false, error: res.error };
  return { ok: true, speak: summarize(res.data, units), overlay: buildPayload(res.data, units), value: res.data };
}

module.exports = { run, fetchWeather, normalize, buildPayload, mapError, summarize };
