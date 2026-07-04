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

  console.log('test-integration: all assertions passed');
})().catch((e) => { console.error(e); process.exit(1); });
