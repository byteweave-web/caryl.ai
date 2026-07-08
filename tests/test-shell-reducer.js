// tests/test-shell-reducer.js
// Pure tests for the System Shell reducer (state -> animated targets). node + assert.
const assert = require('assert');
const S = require('../renderer/shell-reducer');

// orb (no focus layer): everything at rest, engine full-bright, chrome undimmed
let r = S.deriveShell({ focus: 'orb' });
assert.strictEqual(r.focusDepthTarget, 0, 'orb focus-depth 0');
assert.strictEqual(r.glassDensityTarget, 0, 'orb density 0');
assert.strictEqual(r.engineThrottle, false, 'orb never throttles');
assert.strictEqual(r.marginaliaDim, 1, 'orb chrome full');
assert.strictEqual(r.zTop, S.Z.marginalia, 'orb top layer is marginalia');

// chat: pulled forward, light density, engine still visible
r = S.deriveShell({ focus: 'chat' });
assert.strictEqual(r.focusDepthTarget, 1, 'chat focus-depth 1');
assert.strictEqual(r.glassDensityTarget, S.DENSITY.chat, 'chat rides light density');
assert.strictEqual(r.engineThrottle, false, 'chat does not throttle engine');
assert.strictEqual(r.marginaliaDim, 0.5, 'chat dims chrome');
assert.strictEqual(r.zTop, S.Z.focus, 'chat top layer is focus band');

// settings: denser fill for form contrast, engine still visible by default
r = S.deriveShell({ focus: 'settings' });
assert.strictEqual(r.glassDensityTarget, S.DENSITY.settings, 'settings denser');
assert.strictEqual(r.engineThrottle, false, 'settings not throttled by default');
assert.strictEqual(r.focusDepthTarget, 1, 'settings pulls the engine back');

// camera-full: opaque -> crosses occlusion -> engine throttles
r = S.deriveShell({ focus: 'camera-full' });
assert.ok(r.glassDensityTarget >= S.OCCLUSION, 'camera-full is occluding');
assert.strictEqual(r.engineThrottle, true, 'camera-full throttles engine');

// coverage=1 forces occlusion even on a normally-translucent surface
r = S.deriveShell({ focus: 'settings', coverage: 1 });
assert.strictEqual(r.glassDensityTarget, 1, 'full coverage -> density 1');
assert.strictEqual(r.engineThrottle, true, 'full coverage throttles');

// battery saver pushes any focus layer to occlusion so the engine can rest
r = S.deriveShell({ focus: 'chat', power: 'saver' });
assert.ok(r.glassDensityTarget >= S.OCCLUSION, 'saver -> occluding density');
assert.strictEqual(r.engineThrottle, true, 'saver throttles');

// unknown focus is coerced to orb (never throws / never a broken layer)
r = S.deriveShell({ focus: 'nonsense' });
assert.strictEqual(r.focus, 'orb', 'unknown focus coerced to orb');

// reducedMotion is passed through for the runtime to honor
assert.strictEqual(S.deriveShell({ focus: 'chat', reducedMotion: true }).reducedMotion, true);

console.log('test-shell-reducer: OK');
