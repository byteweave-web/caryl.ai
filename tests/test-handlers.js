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

// --- weather: mocked network, error mapping, exact overlay schema ---
// The overlay card schema is shared with systemStats; both must satisfy it identically.
function assertOverlaySchema(payload, label) {
  assert.ok(payload && typeof payload === 'object', label + ': payload is an object');
  assert.strictEqual(typeof payload.title, 'string', label + ': title is a string');
  assert.ok(payload.title.length > 0, label + ': title non-empty');
  assert.strictEqual(typeof payload.accent, 'string', label + ': accent is a string');
  assert.ok(payload.accent.length > 0, label + ': accent non-empty');
  assert.ok(Array.isArray(payload.rows) && payload.rows.length > 0, label + ': rows non-empty array');
  for (const row of payload.rows) {
    assert.strictEqual(typeof row.label, 'string', label + ': row.label is a string');
    assert.strictEqual(typeof row.value, 'string', label + ': row.value is a string');
    assert.deepStrictEqual(Object.keys(row).sort(), ['label', 'value'], label + ': row has exactly {label,value}');
  }
}

// systemStats and weather payloads must match the SAME overlay schema.
assertOverlaySchema(sys.buildPayload(raw), 'systemStats');

const OWM_OK = {
  name: 'Paris', sys: { country: 'FR' },
  main: { temp: 18.3, feels_like: 17.1, humidity: 62 },
  weather: [{ main: 'Clouds', description: 'broken clouds' }],
  wind: { speed: 4.1 }
};
// A fetch stub returning a Response-like object with a given status + JSON body.
function fetchReturning(status, body) {
  return async (_url) => ({ status, json: async () => body });
}

(async () => {
  // buildPayload is pure and schema-exact
  let wp = weather.buildPayload(weather.normalize(OWM_OK), 'metric');
  assertOverlaySchema(wp, 'weather');
  assert.ok(/Paris/.test(wp.title), 'title carries the city');
  assert.ok(wp.rows.some((r) => /18/.test(r.value)), 'temperature is present');
  assert.ok(wp.rows.some((r) => /°C/.test(r.value)), 'metric shows °C');

  // imperial units -> °F
  wp = weather.buildPayload(weather.normalize(OWM_OK), 'imperial');
  assert.ok(wp.rows.some((r) => /°F/.test(r.value)), 'imperial shows °F');

  // run() happy path with mocked network + injected config
  let r = await weather.run({ location: 'Paris' }, { config: { openWeatherApiKey: 'k', weatherUnits: 'metric' }, fetch: fetchReturning(200, OWM_OK) });
  assert.strictEqual(r.ok, true);
  assertOverlaySchema(r.overlay, 'weather.run overlay');
  assert.ok(typeof r.speak === 'string' && /Paris/.test(r.speak), 'spoken line names the place');

  // 404 -> safe user-facing message, raw API text not leaked
  r = await weather.run({ location: 'Nowherecity' }, { config: { openWeatherApiKey: 'k' }, fetch: fetchReturning(404, { cod: '404', message: 'city not found' }) });
  assert.strictEqual(r.ok, false);
  assert.ok(/couldn.?t find|not find|find weather/i.test(r.error), 'friendly 404 message');
  assert.ok(!/city not found/i.test(r.error), 'raw API message is not leaked to the user');

  // 401 -> invalid key message
  r = await weather.run({ location: 'Paris' }, { config: { openWeatherApiKey: 'bad' }, fetch: fetchReturning(401, { cod: 401, message: 'Invalid API key' }) });
  assert.strictEqual(r.ok, false);
  assert.ok(/key/i.test(r.error), 'invalid-key message mentions the key');

  // network throw -> safe connection error, raw error not leaked
  r = await weather.run({ location: 'Paris' }, { config: { openWeatherApiKey: 'k' }, fetch: async () => { throw new Error('ENOTFOUND boom'); } });
  assert.strictEqual(r.ok, false);
  assert.ok(/connect|reach|network|unavailable/i.test(r.error), 'friendly network error');
  assert.ok(!/ENOTFOUND/.test(r.error), 'raw network error is not leaked');

  // 200 but incomplete body -> safe error, not a crash
  r = await weather.run({ location: 'Paris' }, { config: { openWeatherApiKey: 'k' }, fetch: fetchReturning(200, { name: 'X' }) });
  assert.strictEqual(r.ok, false);
  assert.ok(/weather/i.test(r.error), 'incomplete data yields a safe error');

  // missing API key -> friendly settings prompt, and NEVER hits the network
  let hit = false;
  r = await weather.run({ location: 'Paris' }, { config: {}, fetch: async () => { hit = true; return { status: 200, json: async () => OWM_OK }; } });
  assert.strictEqual(r.ok, false);
  assert.ok(/api key|settings/i.test(r.error), 'missing key points the user to Settings');
  assert.strictEqual(hit, false, 'no network call without an API key');

  // missing location and no default -> asks for it, and NEVER hits the network
  hit = false;
  r = await weather.run({}, { config: { openWeatherApiKey: 'k' }, fetch: async () => { hit = true; return { status: 200, json: async () => OWM_OK }; } });
  assert.strictEqual(r.ok, false);
  assert.ok(Array.isArray(r.needs) && r.needs.includes('location'), 'asks for the location');
  assert.strictEqual(hit, false, 'no network call without a location');

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

  const wnorm = { city: 'Tokyo', country: 'JP', temp: 24.4, feelsLike: 25, humidity: 40, description: 'clear sky', windSpeed: 3 };

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

  // --- imperial dewPoint: single rounding, not double rounding ---
  // Regression for: dewPoint() rounds to whole C internally; buildBoardPayload's imperial
  // branch used to convert that ALREADY-ROUNDED C to F and round again, which can differ
  // by 1F from the correct compute-raw-then-round-once-in-F result.
  // Differing case found by grid search (temp=86F/30C, rh=67%): raw Magnus dew point is
  // ~23.200000374757668C. Old (double-round): Math.round(Math.round(23.2)*9/5+32) = 73F.
  // New (single-round): Math.round(23.200000374757668*9/5+32) = 74F.
  const OWM_CUR_IMPERIAL = {
    name: 'Phoenix', sys: { country: 'US', sunrise: 1000, sunset: 52000 }, dt: 30000, timezone: -25200,
    main: { temp: 86, feels_like: 88, humidity: 67, pressure: 1007 }, visibility: 21000,
    weather: [{ description: 'clear sky', icon: '01d' }], wind: { speed: 5, deg: 180, gust: 8 }
  };
  const wnImp = weather.normalize(OWM_CUR_IMPERIAL);
  const bpImp = weather.buildBoardPayload(wnImp, fn2, 'imperial');
  assert.strictEqual(bpImp.current.dewPoint, 74, 'single-rounded F dew point, not the old double-rounded 73');

  // Contract consistency: dewPoint()'s rounded-C result still equals rounding dewPointRaw().
  assert.strictEqual(weather.dewPoint(28.4, 67), Math.round(weather.dewPointRaw(28.4, 67)));

  console.log('test-handlers: all assertions passed');
})().catch((e) => { console.error(e); process.exit(1); });
