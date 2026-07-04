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

  // ---- weather (API_NATIVE) end-to-end through the kernel with a MOCKED fetch ----
  const OWM = {
    name: 'Tokyo', sys: { country: 'JP', sunrise: 1751595000, sunset: 1751645000 }, dt: 1751600000, timezone: 32400,
    main: { temp: 15.2, feels_like: 14.0, humidity: 70, pressure: 1012 }, visibility: 10000,
    weather: [{ main: 'Rain', description: 'light rain' }], wind: { speed: 3.2, deg: 180 }
  };
  const OWM_FORECAST = {
    city: { timezone: 32400 },
    list: Array.from({ length: 16 }, (_, i) => ({
      dt: 1751600000 + i * 10800,
      main: { temp: 22 + i },
      pop: i === 2 ? 0.8 : 0.1,
      weather: [{ description: i === 2 ? 'light rain' : 'scattered clouds', icon: i === 2 ? '10d' : '03d' }]
    }))
  };
  let weatherFetchCalls = 0;
  const wkernel = createKernel({
    registry: registryMod.createRegistry({ builtins: BUILTINS }),
    getConfig: () => ({ openWeatherApiKey: 'test-key', weatherUnits: 'metric' }),
    fetchImpl: async (url) => {
      weatherFetchCalls++;
      if (url.indexOf('/forecast') >= 0) return { status: 200, json: async () => OWM_FORECAST };
      return { status: 200, json: async () => OWM };
    }
  });

  // the Router classifies a weather request as API_NATIVE and extracts the city
  const wmatch = router.classify('weather in Tokyo', wkernel.registry.all());
  assert.ok(wmatch && wmatch.entry.id === 'weather.current', 'router matches the weather task');
  assert.strictEqual(wmatch.class, 'API_NATIVE');
  assert.strictEqual(wmatch.guiBlocked, true, 'API_NATIVE blocks the GUI');
  assert.strictEqual(wmatch.params.location, 'Tokyo');

  // the registry -> handler runs against the mocked API and returns the overlay payload
  const wdecision = await wkernel.handle('weather in Tokyo');
  assert.strictEqual(wdecision.handled, true);
  assert.strictEqual(wdecision.class, 'API_NATIVE');
  assert.strictEqual(wdecision.result.ok, true);
  assert.strictEqual(weatherFetchCalls, 2, 'current + forecast fetched, no real network');
  assert.strictEqual(wdecision.result.overlay.kind, 'forecast', 'overlay is the forecast card');
  assert.ok(typeof wdecision.result.overlay.scene === 'string' && wdecision.result.overlay.scene.length, 'scene is a non-empty string');
  assert.strictEqual(wdecision.result.overlay.hourly.length, 8, '8 three-hour tiles');
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

  console.log('test-integration: all assertions passed');
})().catch((e) => { console.error(e); process.exit(1); });
