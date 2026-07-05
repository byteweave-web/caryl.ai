// tests/test-camera-ui.js
// Pure tests for the camera shell's greeting + status-label helpers. Plain node + assert.
const assert = require('assert');
const cam = require('../lib/cameraUi');

// greetingLine: persona/name line; empty/default -> a generic line; always non-empty, no crash.
assert.ok(/caryl/i.test(cam.greetingLine('Caryl')), 'names the assistant');
assert.ok(cam.greetingLine('Jarvis').indexOf('Jarvis') >= 0, 'uses the given name');
const generic = cam.greetingLine('');
assert.ok(generic && generic.length > 0, 'empty name -> a non-empty generic line');
assert.ok(cam.greetingLine('') === cam.greetingLine('   '), 'blank/whitespace name -> same generic line');
assert.ok(cam.greetingLine('Caryl') !== generic, 'a real name differs from the generic line');
assert.ok(cam.greetingLine(null).length > 0 && cam.greetingLine(undefined).length > 0, 'null/undefined never crash');

// statusLabel: every state -> its label; unknown -> Idle.
assert.strictEqual(cam.statusLabel('idle'), 'Idle');
assert.strictEqual(cam.statusLabel('listening'), 'Listening…');
assert.strictEqual(cam.statusLabel('looking'), 'Looking…');
assert.strictEqual(cam.statusLabel('speaking'), 'Speaking…');
assert.strictEqual(cam.statusLabel('error'), 'Camera error');
assert.strictEqual(cam.statusLabel('nonsense'), 'Idle', 'unknown -> Idle');
assert.strictEqual(cam.statusLabel(''), 'Idle');
assert.strictEqual(cam.statusLabel(undefined), 'Idle');

console.log('test-camera-ui: all assertions passed');
