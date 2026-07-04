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

  console.log('test-handlers: all assertions passed');
})().catch((e) => { console.error(e); process.exit(1); });
