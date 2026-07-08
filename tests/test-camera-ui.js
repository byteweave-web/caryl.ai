// tests/test-camera-ui.js
// ------------------------------------------------------------------
// Pure tests for the camera shell's greeting + status-label helpers.
// Plain node + assert; runs in `npm test` (no Electron / DOM needed).
// Single source of truth is lib/cameraUi.js - any change there is
// picked up here on next run, no parity upkeep needed.
// ------------------------------------------------------------------
'use strict';

const assert = require('assert');
const cam = require('../lib/cameraUi');

let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e && e.stack || e)); }
}

console.log('lib/cameraUi.js');

// ---- greetingLine ---------------------------------------------------
check('greetingLine: includes /Caryl/i when the persona is set', function () {
  assert.ok(/caryl/i.test(cam.greetingLine('Caryl')), 'names the assistant');
});
check('greetingLine: uses whatever real name the user gave', function () {
  assert.ok(cam.greetingLine('Jarvis').indexOf('Jarvis') >= 0, 'uses the given name');
  assert.ok(cam.greetingLine('  Bob  ').indexOf('Bob') >= 0, 'trims surrounding whitespace');
});
check('greetingLine: blank/whitespace name -> a non-empty generic line', function () {
  const genericEmpty = cam.greetingLine('');
  const genericWs   = cam.greetingLine('   ');
  assert.ok(genericEmpty && genericEmpty.length > 0, 'empty name -> non-empty generic line');
  assert.strictEqual(genericEmpty, genericWs, 'blank == whitespace');
});
check('greetingLine: a real name differs from the generic line', function () {
  assert.notStrictEqual(cam.greetingLine('Caryl'), cam.greetingLine(''));
});
check('greetingLine: null / undefined / numbers / objects / arrays -> generic line (not "[object Object] here \u2026")', function () {
  const generic = cam.greetingLine('');
  assert.strictEqual(cam.greetingLine(null),      generic, 'null -> generic');
  assert.strictEqual(cam.greetingLine(undefined), generic, 'undefined -> generic');
  assert.strictEqual(cam.greetingLine(0),         generic, 'number -> generic');
  assert.strictEqual(cam.greetingLine({}),        generic, 'object -> generic');
  assert.strictEqual(cam.greetingLine([]),        generic, 'array -> generic');
  assert.strictEqual(cam.greetingLine(false),     generic, 'boolean -> generic');
});

// ---- statusLabel ----------------------------------------------------
check('statusLabel: every documented state -> its label', function () {
  assert.strictEqual(cam.statusLabel('idle'),      'Idle');
  assert.strictEqual(cam.statusLabel('listening'), 'Listening\u2026');
  assert.strictEqual(cam.statusLabel('looking'),   'Looking\u2026');
  assert.strictEqual(cam.statusLabel('speaking'),  'Speaking\u2026');
  assert.strictEqual(cam.statusLabel('error'),     'Camera error');
});
check('statusLabel: unknown / null / empty -> Idle (safe default)', function () {
  assert.strictEqual(cam.statusLabel('nonsense'), 'Idle');
  assert.strictEqual(cam.statusLabel(''),         'Idle');
  assert.strictEqual(cam.statusLabel(null),       'Idle');
  assert.strictEqual(cam.statusLabel(undefined),  'Idle');
  assert.strictEqual(cam.statusLabel(42),         'Idle');
});

// ---- module shape (catch renames) ----------------------------------
check('module.exports shape', function () {
  assert.strictEqual(typeof cam.greetingLine, 'function');
  assert.strictEqual(typeof cam.statusLabel,  'function');
  assert.strictEqual(typeof cam.DEFAULT_NAME, 'string');
  assert.ok(cam.DEFAULT_NAME.length > 0);
  // _STATUS is a frozen object with the documented 5 entries.
  assert.strictEqual(typeof cam._STATUS, 'object');
  assert.ok(Object.isFrozen(cam._STATUS));
  assert.ok(cam._STATUS.idle && cam._STATUS.listening && cam._STATUS.looking &&
            cam._STATUS.speaking && cam._STATUS.error);
});

// ---- summary -------------------------------------------------------
console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) process.exit(1);
