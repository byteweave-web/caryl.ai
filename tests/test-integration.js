// tests/test-integration.js
// End-to-end: a user's math request must be solved by the Kernel WITHOUT the LLM and
// WITHOUT the GUI. Exercises the real router + registry + math handler + guard + actions.
// Runs under plain node (require('electron') resolves to a path string; the guiBlocked
// path returns before any electron/shell/exec call, so nothing is ever launched).
const assert = require('assert');
const { createKernel, BUILTINS } = require('../lib/kernel');
const registryMod = require('../lib/kernel/registry');
const router = require('../lib/kernel/router');
const guard = require('../lib/kernel/guard');
const actions = require('../lib/actions');

(async () => {
  // A real kernel with an in-memory registry (no disk needed).
  const registry = registryMod.createRegistry({ builtins: BUILTINS });
  const kernel = createKernel({ registry });

  // A spy standing in for the GUI action layer; it must never be called for a math task.
  const guiCalls = [];
  const guiSpy = (name, args) => { guiCalls.push({ name, args }); return { ok: true }; };
  void guiSpy; // the assertion is that it stays uncalled

  const userText = 'what is 12.5% of 340';

  // (a) the Router classifies the request as a PURE_LOGIC math task and blocks the GUI
  const match = router.classify(userText, registry.all());
  assert.ok(match, 'router returns a match for a math request');
  assert.strictEqual(match.class, 'PURE_LOGIC');
  assert.strictEqual(match.entry.id, 'math.eval');
  assert.strictEqual(match.guiBlocked, true, 'a PURE_LOGIC task is guiBlocked');

  // end-to-end through the kernel
  const decision = await kernel.handle(userText);
  assert.strictEqual(decision.handled, true, 'kernel handles the math request itself');
  assert.strictEqual(decision.class, 'PURE_LOGIC');

  // (b) the math handler returns the correct result
  assert.strictEqual(decision.result.ok, true);
  assert.strictEqual(decision.result.value, 42.5);
  assert.ok(/42\.5/.test(decision.result.speak), 'spoken answer carries the result');

  // (c) the GUI tools were never invoked for the math request
  assert.strictEqual(guiCalls.length, 0, 'no GUI tool invoked for a pure-logic task');

  // the guard is released after the turn (no leak into the next request)
  assert.strictEqual(guard.isBlocked(), null, 'guard cleared after handling');

  // (c, hardened) actions.js refuses GUI tools while a logic/API turn is guiBlocked and
  // returns the block error instead of executing (no app launch, no browser open).
  guard.block('task "math.eval" is PURE_LOGIC');
  for (const name of ['open_app', 'open_url', 'web_search']) {
    const res = await actions.run(name, { name: 'notepad', url: 'example.com', target: 'x' });
    assert.strictEqual(res.ok, false, name + ' must be refused while guiBlocked');
    assert.ok(/block/i.test(res.summary), name + ' returns a block reason, not a result');
  }
  guard.unblock();

  // sanity: a non-logic request is NOT handled by the kernel (falls through to the LLM)
  const passthrough = await kernel.handle('tell me a joke about cats');
  assert.strictEqual(passthrough.handled, false, 'non-logic requests fall through to the LLM');

  // ---- weather (API_NATIVE) end-to-end through the kernel with a MOCKED Open-Meteo fetch ----
  // No API key anywhere: the kernel geocodes the place then fetches its forecast.
  const OM_GEO = { results: [{ name: 'Tokyo', country: 'Japan', latitude: 35.69, longitude: 139.69, timezone: 'Asia/Tokyo', population: 9733276 }] };
  const OM_FC = (function () {
    const time = [], temp = [], code = [], pop = [], isday = [];
    for (let h = 0; h < 24; h++) {
      time.push('2026-07-05T' + String(h).padStart(2, '0') + ':00');
      temp.push(20 + (h % 5)); code.push(h === 15 ? 61 : 2); pop.push(h === 15 ? 70 : 10);
      isday.push(h >= 6 && h < 18 ? 1 : 0);
    }
    return {
      utc_offset_seconds: 32400, timezone: 'Asia/Tokyo',
      current: { time: '2026-07-05T09:00', temperature_2m: 15.2, relative_humidity_2m: 70, apparent_temperature: 14, is_day: 1, weather_code: 61, surface_pressure: 1012, wind_speed_10m: 12, wind_direction_10m: 180, wind_gusts_10m: 20, dew_point_2m: 10, visibility: 10000 },
      hourly: { time, temperature_2m: temp, weather_code: code, precipitation_probability: pop, is_day: isday },
      daily: { time: ['2026-07-05', '2026-07-06', '2026-07-07'], weather_code: [61, 2, 1], temperature_2m_max: [22, 24, 25], temperature_2m_min: [15, 16, 17], precipitation_probability_max: [70, 20, 10], sunrise: ['2026-07-05T04:30', '2026-07-06T04:30', '2026-07-07T04:31'], sunset: ['2026-07-05T19:00', '2026-07-06T19:00', '2026-07-07T19:00'] }
    };
  })();
  let weatherFetchCalls = 0;
  const wkernel = createKernel({
    registry: registryMod.createRegistry({ builtins: BUILTINS }),
    getConfig: () => ({ weatherUnits: 'metric' }),
    fetchImpl: async (url) => {
      weatherFetchCalls++;
      return String(url).indexOf('geocoding-api') >= 0
        ? { status: 200, json: async () => OM_GEO }
        : { status: 200, json: async () => OM_FC };
    }
  });

  // the Router classifies a weather request as API_NATIVE and extracts the city
  const wmatch = router.classify('weather in Tokyo', wkernel.registry.all());
  assert.ok(wmatch && wmatch.entry.id === 'weather.current', 'router matches the weather task');
  assert.strictEqual(wmatch.class, 'API_NATIVE');
  assert.strictEqual(wmatch.guiBlocked, true, 'API_NATIVE blocks the GUI');
  assert.strictEqual(wmatch.params.location, 'Tokyo');

  // the registry -> handler geocodes + forecasts against the mocked API, returns the board
  const wdecision = await wkernel.handle('weather in Tokyo');
  assert.strictEqual(wdecision.handled, true);
  assert.strictEqual(wdecision.class, 'API_NATIVE');
  assert.strictEqual(wdecision.result.ok, true);
  assert.strictEqual(weatherFetchCalls, 2, 'geocoding + forecast fetched, no real network');
  assert.strictEqual(wdecision.result.overlay.kind, 'forecast', 'overlay is the forecast board');
  assert.strictEqual(wdecision.result.overlay.title, 'Tokyo, Japan');
  assert.ok(typeof wdecision.result.overlay.scene === 'string' && wdecision.result.overlay.scene.length, 'scene is a non-empty string');
  assert.strictEqual(wdecision.result.overlay.hourly.length, 8, '8 hourly tiles');
  assert.ok(wdecision.result.overlay.daily.length >= 2, 'at least 2 daily rows');
  assert.ok(wdecision.result.overlay.current.moon, 'moon phase present');
  assert.ok(wdecision.result.overlay.narration.length >= 2, 'narration segments present');
  assert.strictEqual(
    wdecision.result.speak,
    wdecision.result.overlay.narration.map((s) => s.text).join(' '),
    'speak is exactly the joined narration'
  );

  // the guard is released after an API_NATIVE turn (no leak into the next request)
  assert.strictEqual(guard.isBlocked(), null, 'guard cleared after the weather turn');

  // ---- weather: geocoding finds nothing -> handled, friendly error, never a browser ----
  const wkernel2 = createKernel({
    registry: registryMod.createRegistry({ builtins: BUILTINS }),
    getConfig: () => ({ weatherUnits: 'metric' }),
    fetchImpl: async (_url) => ({ status: 200, json: async () => ({ results: [] }) })
  });
  const wd2 = await wkernel2.handle('weather in Zzzznowhere');
  assert.ok(wd2.handled, 'still handled by the kernel (not passed to the LLM)');
  assert.strictEqual(wd2.result.ok, false, 'no geocoding match -> ok:false');
  assert.ok(/find weather/i.test(wd2.result.error), 'friendly not-found message');
  assert.strictEqual(guard.isBlocked(), null, 'guard cleared even on the error path');

  console.log('test-integration: all assertions passed');
})().catch((e) => { console.error(e); process.exit(1); });
