// tests/test-handlers.js
// Pure-logic tests for the Kernel's PURE_LOGIC handlers (math, systemStats).
// Plain node + assert, no framework.
const assert = require('assert');
const math = require('../lib/kernel/handlers/math');
const sys = require('../lib/kernel/handlers/systemStats');
const weather = require('../lib/kernel/handlers/weather');

// --- math: arithmetic, precedence, parens ---
assert.strictEqual(math.evaluate('2 + 3').value, 5);
assert.strictEqual(math.evaluate('2 + 3 * 4').value, 14, 'multiplication binds tighter');
assert.strictEqual(math.evaluate('(2 + 3) * 4').value, 20, 'parentheses override precedence');
assert.strictEqual(math.evaluate('10 / 4').value, 2.5);
assert.strictEqual(math.evaluate('2 - 3 - 4').value, -5, 'subtraction is left-associative');

// modulo (the % operator between two numbers)
assert.strictEqual(math.evaluate('10 % 3').value, 1);

// unary minus
assert.strictEqual(math.evaluate('-5 + 2').value, -3);
assert.strictEqual(math.evaluate('2 * -3').value, -6);
assert.strictEqual(math.evaluate('-(3 + 4)').value, -7);

// decimals (float-tolerant)
assert.ok(Math.abs(math.evaluate('0.1 + 0.2').value - 0.3) < 1e-9);

// percentages: "X% of Y" and standalone "X%"
assert.strictEqual(math.evaluate('12.5% of 340').value, 42.5);
assert.strictEqual(math.evaluate('50%').value, 0.5);

// ok flag + clean formatting
let r = math.evaluate('2 + 2');
assert.strictEqual(r.ok, true);
assert.strictEqual(r.formatted, '4', 'integer results have no decimal point');
assert.strictEqual(math.evaluate('1 / 3').formatted, '0.333333', 'repeating decimals are trimmed');

// errors: malformed / empty / divide-by-zero / anything that looks like code
assert.strictEqual(math.evaluate('2 +').ok, false, 'dangling operator');
assert.strictEqual(math.evaluate('').ok, false, 'empty input');
assert.strictEqual(math.evaluate('2 / 0').ok, false, 'division by zero is an error, not Infinity');
assert.strictEqual(math.evaluate('process.exit(1)').ok, false, 'no code execution');
assert.strictEqual(math.evaluate('alert(1)').ok, false, 'no code execution');
assert.strictEqual(math.evaluate('2; 3').ok, false, 'no statement separators');

// run() wrapper -> spoken result
r = math.run({ expression: '12.5% of 340' });
assert.strictEqual(r.ok, true);
assert.ok(/42\.5/.test(r.speak), 'spoken answer includes the result');
assert.strictEqual(math.run({}).ok, false, 'missing expression -> error, never throws');

// --- systemStats: pure formatters ---
assert.strictEqual(sys.formatBytes(0), '0 B');
assert.strictEqual(sys.formatBytes(512), '512 B');
assert.strictEqual(sys.formatBytes(1023), '1023 B');
assert.strictEqual(sys.formatBytes(1024), '1.0 KB');
assert.strictEqual(sys.formatBytes(1536), '1.5 KB');
assert.strictEqual(sys.formatBytes(8 * 1024 * 1024 * 1024), '8.0 GB');

assert.strictEqual(sys.formatUptime(45), '45s');
assert.strictEqual(sys.formatUptime(90), '1m 30s');
assert.strictEqual(sys.formatUptime(3661), '1h 1m');
assert.strictEqual(sys.formatUptime(90000), '1d 1h');

// --- systemStats: buildPayload is a pure function of raw readings ---
function rowVal(payload, label) {
  const row = payload.rows.find((x) => x.label === label);
  return row ? row.value : null;
}
const raw = {
  totalMem: 16 * 1024 * 1024 * 1024,
  freeMem: 8 * 1024 * 1024 * 1024,
  cpuCount: 8,
  cpuModel: 'Test CPU',
  uptimeSec: 3661,
  platform: 'win32',
  release: '10.0.26200'
};
let p = sys.buildPayload(raw);
assert.ok(p && typeof p.title === 'string' && p.title, 'payload has a title');
assert.ok(Array.isArray(p.rows) && p.rows.length > 0, 'payload has rows');
assert.ok(typeof p.accent === 'string', 'payload has an accent for the overlay');
assert.strictEqual(rowVal(p, 'Memory'), '8.0 GB / 16.0 GB (50%)');
assert.ok(/8/.test(rowVal(p, 'CPU')) && /Test CPU/.test(rowVal(p, 'CPU')));
assert.strictEqual(rowVal(p, 'Uptime'), '1h 1m');

// a Disk row appears only when disk readings are provided
assert.strictEqual(rowVal(p, 'Disk'), null, 'no Disk row without disk data');
p = sys.buildPayload(Object.assign({}, raw, { disk: { total: 500 * 1024 * 1024 * 1024, free: 100 * 1024 * 1024 * 1024 } }));
assert.ok(/80%/.test(rowVal(p, 'Disk')), 'Disk row shows used percentage');

// --- systemStats: collect()/run() smoke test on the real machine (shape only) ---
const live = sys.collect();
assert.ok(live && typeof live.title === 'string');
assert.ok(Array.isArray(live.rows) && live.rows.length > 0, 'collect() returns real rows');
const rr = sys.run({});
assert.strictEqual(rr.ok, true);
assert.ok(typeof rr.speak === 'string' && rr.speak.length > 0);
assert.ok(rr.overlay && Array.isArray(rr.overlay.rows), 'run() carries the overlay payload');

// --- weather (Open-Meteo, no key): WMO code mapping ---
// wmoSprite: code (+ day flag) -> board sprite id
assert.strictEqual(weather.wmoSprite(0, true), 'sun');
assert.strictEqual(weather.wmoSprite(0, false), 'moon');
assert.strictEqual(weather.wmoSprite(1, true), 'sun');
assert.strictEqual(weather.wmoSprite(1, false), 'moon');
assert.strictEqual(weather.wmoSprite(2, true), 'partly');
assert.strictEqual(weather.wmoSprite(3, true), 'cloud');
assert.strictEqual(weather.wmoSprite(45, true), 'mist');
assert.strictEqual(weather.wmoSprite(48, false), 'mist');
assert.strictEqual(weather.wmoSprite(51, true), 'drizzle');
assert.strictEqual(weather.wmoSprite(57, true), 'drizzle');
assert.strictEqual(weather.wmoSprite(61, true), 'rain');
assert.strictEqual(weather.wmoSprite(65, true), 'rain');
assert.strictEqual(weather.wmoSprite(82, true), 'rain');
assert.strictEqual(weather.wmoSprite(71, true), 'snow');
assert.strictEqual(weather.wmoSprite(77, true), 'snow');
assert.strictEqual(weather.wmoSprite(86, true), 'snow');
assert.strictEqual(weather.wmoSprite(95, true), 'thunder');
assert.strictEqual(weather.wmoSprite(99, false), 'thunder');
assert.strictEqual(weather.wmoSprite(999, true), 'cloud', 'unknown code -> cloud');

// wmoScene: code (+ day flag) -> sky scene
assert.strictEqual(weather.wmoScene(0, true), 'clear-day');
assert.strictEqual(weather.wmoScene(0, false), 'clear-night');
assert.strictEqual(weather.wmoScene(1, false), 'clear-night');
assert.strictEqual(weather.wmoScene(2, true), 'clouds');
assert.strictEqual(weather.wmoScene(3, false), 'clouds');
assert.strictEqual(weather.wmoScene(45, true), 'mist');
assert.strictEqual(weather.wmoScene(55, true), 'rain');
assert.strictEqual(weather.wmoScene(65, true), 'rain');
assert.strictEqual(weather.wmoScene(82, true), 'rain');
assert.strictEqual(weather.wmoScene(75, true), 'snow');
assert.strictEqual(weather.wmoScene(86, true), 'snow');
assert.strictEqual(weather.wmoScene(95, true), 'storm');
assert.strictEqual(weather.wmoScene(99, true), 'storm');
assert.strictEqual(weather.wmoScene(999, true), 'clouds', 'unknown -> clouds');

// wmoText: code -> human condition; unknown -> em dash
assert.strictEqual(weather.wmoText(0), 'Clear sky');
assert.strictEqual(weather.wmoText(3), 'Overcast');
assert.strictEqual(weather.wmoText(95), 'Thunderstorm');
assert.strictEqual(weather.wmoText(999), '—', 'unknown code -> em dash');

// --- weather: cleanLocation strips the trailing filler the "after:in" extractor drags in ---
assert.strictEqual(weather.cleanLocation('Lebanon today?'), 'Lebanon');
assert.strictEqual(weather.cleanLocation('New York today?'), 'New York');
assert.strictEqual(weather.cleanLocation('Tokyo right now'), 'Tokyo');
assert.strictEqual(weather.cleanLocation('Paris this evening'), 'Paris');
assert.strictEqual(weather.cleanLocation('London tomorrow.'), 'London');
assert.strictEqual(weather.cleanLocation('San Francisco'), 'San Francisco', 'clean input unchanged');
assert.strictEqual(weather.cleanLocation('Rome please'), 'Rome');
assert.strictEqual(weather.cleanLocation('  Berlin  '), 'Berlin');
assert.strictEqual(weather.cleanLocation('today'), 'today', 'a lone word is never stripped away');
assert.strictEqual(weather.cleanLocation(''), '');

// --- weather: pickHour finds the first hourly slot at/after "now" ---
const HRS = ['2026-07-05T07:00', '2026-07-05T08:00', '2026-07-05T09:00', '2026-07-05T10:00'];
assert.strictEqual(weather.pickHour({ time: HRS }, '2026-07-05T09:00'), 2, 'matches the current hour');
assert.strictEqual(weather.pickHour({ time: HRS }, '2026-07-05T08:30'), 2, 'rounds up to the next slot');
assert.strictEqual(weather.pickHour({ time: HRS }, '2026-07-04T00:00'), 0, 'before the range -> 0');
assert.strictEqual(weather.pickHour({}, 'x'), 0, 'no times -> 0');

// --- weather: moonPhase (documented ephemeris, computed locally) ---
let mp = weather.moonPhase(Date.UTC(2000, 0, 6, 19, 0));
assert.strictEqual(mp.phase, 'new-moon');
assert.ok(mp.illumination <= 5, 'new moon ~0% lit');
mp = weather.moonPhase(Date.UTC(2000, 0, 21, 12, 0));
assert.strictEqual(mp.phase, 'full-moon');
assert.ok(mp.illumination >= 95, 'full moon ~100% lit');
mp = weather.moonPhase(Date.UTC(2000, 0, 14, 12, 0));
assert.strictEqual(mp.phase, 'first-quarter');

// --- Open-Meteo fixtures + a URL-dispatching fetch stub (geocoding vs forecast) ---
// Geocoding: two matches; the higher-population one must win (capital/largest city intent).
const OM_GEO = {
  results: [
    { name: 'Manila', country: 'Philippines', latitude: 14.6, longitude: 120.98, timezone: 'Asia/Manila', population: 1600000 },
    { name: 'Metro Manila', country: 'Philippines', latitude: 14.6, longitude: 121.0, timezone: 'Asia/Manila', population: 13000000 }
  ]
};
// Forecast: 24 hourly slots for the day (so "now" at 09:00 leaves 8 tiles), 6 daily rows.
const OM_FC = (function () {
  const hours = [], temp = [], code = [], pop = [], isday = [];
  for (let h = 0; h < 24; h++) {
    hours.push('2026-07-05T' + String(h).padStart(2, '0') + ':00');
    temp.push(28 + (h === 12 ? 5 : 0));
    code.push(h === 15 ? 61 : 1);          // a rain hour in the strip so narration mentions it
    pop.push(h === 15 ? 80 : 10);
    isday.push(h >= 6 && h < 18 ? 1 : 0);
  }
  return {
    utc_offset_seconds: 28800, timezone: 'Asia/Manila',
    current: {
      time: '2026-07-05T09:00', temperature_2m: 30.7, relative_humidity_2m: 67,
      apparent_temperature: 36.7, is_day: 1, weather_code: 95, surface_pressure: 1011.4,
      wind_speed_10m: 12, wind_direction_10m: 162, wind_gusts_10m: 18, dew_point_2m: 23.9, visibility: 26800
    },
    hourly: { time: hours, temperature_2m: temp, weather_code: code, precipitation_probability: pop, is_day: isday },
    daily: {
      time: ['2026-07-05', '2026-07-06', '2026-07-07', '2026-07-08', '2026-07-09', '2026-07-10'],
      weather_code: [95, 80, 3, 1, 61, 0],
      temperature_2m_max: [33.3, 33.2, 32.9, 32.4, 30, 28.3],
      temperature_2m_min: [26.5, 25.8, 25.9, 26.2, 27.3, 25.4],
      precipitation_probability_max: [100, 97, 40, 10, 73, 0],
      sunrise: ['2026-07-05T05:31', '2026-07-06T05:31', '2026-07-07T05:32', '2026-07-08T05:32', '2026-07-09T05:32', '2026-07-10T05:33'],
      sunset: ['2026-07-05T18:29', '2026-07-06T18:29', '2026-07-07T18:29', '2026-07-08T18:29', '2026-07-09T18:29', '2026-07-10T18:29']
    }
  };
})();
function omFetch(status, body) { return async (_url) => ({ status, json: async () => body }); }
function omDispatch(geo, fc) {
  return async (url) => (String(url).indexOf('geocoding-api') >= 0
    ? { status: 200, json: async () => geo }
    : { status: 200, json: async () => fc });
}

(async () => {
  // --- geocode: picks the highest-population match ---
  let g = await weather.geocode('Manila', { fetchImpl: omFetch(200, OM_GEO) });
  assert.strictEqual(g.ok, true);
  assert.strictEqual(g.place.name, 'Metro Manila', 'highest population wins');
  assert.strictEqual(g.place.lat, 14.6);
  assert.strictEqual(g.place.country, 'Philippines');

  g = await weather.geocode('Zzzznowhere', { fetchImpl: omFetch(200, { results: [] }) });
  assert.strictEqual(g.ok, false);
  assert.ok(/find weather/i.test(g.error), 'no results -> friendly not-found');

  // leading-article fallback: "the Philippines" is empty, retry drops "the" -> resolves.
  // A name where the article is real ("the Hague") resolves on the FIRST try (no retry).
  let geoNames = [];
  const articleFetch = async (url) => {
    const name = decodeURIComponent((String(url).match(/name=([^&]*)/) || [])[1] || '');
    geoNames.push(name);
    const found = { results: [{ name: 'Manila', country: 'Philippines', latitude: 14.6, longitude: 121, population: 1600000 }] };
    return { status: 200, json: async () => (name.toLowerCase() === 'philippines' ? found : { results: [] }) };
  };
  g = await weather.geocode('the Philippines', { fetchImpl: articleFetch });
  assert.strictEqual(g.ok, true, 'the Philippines resolves via the article-stripped retry');
  assert.deepStrictEqual(geoNames, ['the Philippines', 'Philippines'], 'tried as-typed first, then without "the"');

  geoNames = [];
  const hagueFetch = async (url) => {
    const name = decodeURIComponent((String(url).match(/name=([^&]*)/) || [])[1] || '');
    geoNames.push(name);
    return { status: 200, json: async () => ({ results: [{ name: 'The Hague', country: 'Netherlands', latitude: 52.08, longitude: 4.31, population: 500000 }] }) };
  };
  g = await weather.geocode('the Hague', { fetchImpl: hagueFetch });
  assert.strictEqual(g.ok, true);
  assert.deepStrictEqual(geoNames, ['the Hague'], 'a real-article name resolves on the first try, no retry');

  g = await weather.geocode('X', { fetchImpl: async () => { throw new Error('ENOTFOUND boom'); } });
  assert.strictEqual(g.ok, false);
  assert.ok(!/ENOTFOUND/.test(g.error), 'raw network error is not leaked');

  // --- buildBoardPayload: v2 shape straight from an Open-Meteo body (no unit conversion) ---
  const place = { name: 'Manila', country: 'Philippines', lat: 14.6, lon: 120.98 };
  const bp = weather.buildBoardPayload(place, OM_FC, 'metric');
  assert.strictEqual(bp.kind, 'forecast');
  assert.strictEqual(bp.scene, 'storm', 'WMO 95 by day -> storm');
  assert.strictEqual(bp.title, 'Manila, Philippines');
  assert.strictEqual(bp.current.icon, 'thunder', 'WMO 95 -> thunder sprite');
  assert.strictEqual(bp.current.condition, 'Thunderstorm');
  assert.strictEqual(bp.current.temp, 31);
  assert.strictEqual(bp.current.feelsLike, 37);
  assert.strictEqual(bp.current.humidity, 67);
  assert.strictEqual(bp.current.dewPoint, 24, 'dew point straight from the body, rounded once');
  assert.strictEqual(bp.current.pressure, 1011);
  assert.strictEqual(bp.current.wind.speed, 12, 'wind used as-is (already km/h) - NOT multiplied by 3.6');
  assert.strictEqual(bp.current.wind.gust, 18);
  assert.strictEqual(bp.current.wind.deg, 162);
  assert.strictEqual(bp.current.visibility, 26.8, 'metres -> km, one decimal');
  assert.strictEqual(bp.current.units, 'metric');
  assert.strictEqual(bp.current.isNight, false, 'is_day 1 -> day');
  assert.strictEqual(bp.current.sunrise, '05:31');
  assert.strictEqual(bp.current.sunset, '18:29');
  assert.ok(bp.current.moon && typeof bp.current.moon.illumination === 'number');
  assert.strictEqual(bp.hourly.length, 8, '8 tiles starting at "now" (09:00)');
  assert.strictEqual(bp.hourly[0].time, '09:00');
  assert.strictEqual(bp.hourly[0].icon, 'sun', 'WMO 1 by day -> sun');
  assert.strictEqual(bp.daily.length, 6);
  assert.strictEqual(bp.daily[0].day, 'Today');
  assert.strictEqual(bp.daily[0].icon, 'thunder');
  assert.strictEqual(bp.daily[0].hi, 33);
  assert.strictEqual(bp.daily[0].lo, 27);        // 26.5 rounds to 27
  assert.strictEqual(bp.daily[0].pop, 100);
  assert.ok(Array.isArray(bp.narration) && bp.narration.length >= 2);
  assert.ok(/rain/i.test(bp.narration.map((s) => s.text).join(' ')), 'the rain hour is narrated');

  // imperial: units tag flips, numbers are used as returned (no double conversion), visibility -> miles
  const bpi = weather.buildBoardPayload(place, OM_FC, 'imperial');
  assert.strictEqual(bpi.current.units, 'imperial');
  assert.strictEqual(bpi.current.wind.speed, 12, 'imperial wind used as-is (already mph)');
  assert.strictEqual(bpi.current.visibility, 16.7, '26800 m -> ~16.7 mi');

  // --- run(): geocode -> forecast -> board payload, all mocked, no real network ---
  r = await weather.run({ location: 'Manila' }, { config: { weatherUnits: 'metric' }, fetch: omDispatch(OM_GEO, OM_FC) });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.overlay.kind, 'forecast');
  assert.strictEqual(r.overlay.title, 'Metro Manila, Philippines');
  assert.ok(/Right now/.test(r.speak), 'spoken line is the narration');
  assert.strictEqual(r.speak, r.overlay.narration.map((s) => s.text).join(' '), 'speak === joined narration');

  // country query "Lebanon today?" -> cleaned -> geocoded, no key needed anywhere
  let usedUrl = '';
  r = await weather.run({ location: 'Lebanon today?' }, {
    config: {},
    fetch: async (url) => {
      if (!usedUrl) usedUrl = url;
      return String(url).indexOf('geocoding-api') >= 0
        ? { status: 200, json: async () => OM_GEO }
        : { status: 200, json: async () => OM_FC };
    }
  });
  assert.strictEqual(r.ok, true, 'works with no API key configured');
  assert.ok(/name=Lebanon(&|$)/.test(usedUrl), 'geocoded for "Lebanon", not "Lebanon today?": ' + usedUrl);

  // no location and no default -> asks once, and NEVER hits the network
  let hit = false;
  r = await weather.run({}, { config: {}, fetch: async () => { hit = true; return { status: 200, json: async () => OM_GEO }; } });
  assert.strictEqual(r.ok, false);
  assert.ok(Array.isArray(r.needs) && r.needs.includes('location'), 'asks for the location');
  assert.strictEqual(hit, false, 'no network call without a location');

  // geocoding finds nothing -> safe error, raw body not leaked
  r = await weather.run({ location: 'Zzzznowhere' }, { config: {}, fetch: omFetch(200, { results: [] }) });
  assert.strictEqual(r.ok, false);
  assert.ok(/find weather/i.test(r.error), 'friendly not-found');

  // forecast endpoint down -> safe error
  r = await weather.run({ location: 'Manila' }, {
    config: {},
    fetch: async (url) => (String(url).indexOf('geocoding-api') >= 0
      ? { status: 200, json: async () => OM_GEO }
      : { status: 503, json: async () => ({}) })
  });
  assert.strictEqual(r.ok, false);
  assert.ok(/unavailable|try again/i.test(r.error), 'friendly forecast-down message');

  console.log('test-handlers: all assertions passed');
})().catch((e) => { console.error(e); process.exit(1); });
