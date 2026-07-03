// tests/test-engines.js
const assert = require('assert');
const eng = require('../lib/engines');

// deriveFromLegacy: pure online defaults
let e = eng.deriveFromLegacy({});
assert.deepStrictEqual(e, { chat: 'online', vision: 'online', stt: 'online', tts: 'online' });

// legacy offline mode forces chat/vision/stt offline
e = eng.deriveFromLegacy({ mode: 'offline' });
assert.deepStrictEqual(e, { chat: 'offline', vision: 'offline', stt: 'offline', tts: 'online' });

// individual legacy flags
assert.strictEqual(eng.deriveFromLegacy({ useLocalVision: true }).vision, 'offline');
assert.strictEqual(eng.deriveFromLegacy({ useLocalVision: true }).chat, 'online');
assert.strictEqual(eng.deriveFromLegacy({ useLocalStt: true }).stt, 'offline');
assert.strictEqual(eng.deriveFromLegacy({ ttsEngine: 'piper' }).tts, 'offline');

// normalizeEngines: derives when absent, keeps valid, repairs partial
let n = eng.normalizeEngines({ mode: 'offline' });
assert.strictEqual(n.changed, true);
assert.strictEqual(n.engines.chat, 'offline');
n = eng.normalizeEngines({ engines: { chat: 'offline', vision: 'online', stt: 'online', tts: 'online' } });
assert.strictEqual(n.changed, false);
n = eng.normalizeEngines({ engines: { chat: 'bogus' }, useLocalStt: true });
assert.strictEqual(n.changed, true);
assert.strictEqual(n.engines.stt, 'offline'); // repaired from legacy flags

// resolveEngine: reads engines first, falls back to legacy derivation
assert.strictEqual(eng.resolveEngine({ engines: { chat: 'offline', vision: 'online', stt: 'online', tts: 'online' } }, 'chat'), 'offline');
assert.strictEqual(eng.resolveEngine({ mode: 'offline' }, 'chat'), 'offline');
assert.strictEqual(eng.resolveEngine({}, 'vision'), 'online');
assert.strictEqual(eng.resolveEngine({}, 'nonsense'), 'online'); // unknown capability -> online

// engineReady
const ctxUp = { ollamaUp: true, localVisionModel: 'moondream', piperConfigured: true };
const ctxDown = { ollamaUp: false, localVisionModel: '', piperConfigured: false };
assert.strictEqual(eng.engineReady({ engines: { chat: 'online', vision: 'online', stt: 'online', tts: 'online' }, apiKey: 'k' }, 'chat', ctxDown).ready, true);
assert.strictEqual(eng.engineReady({ engines: { chat: 'online', vision: 'online', stt: 'online', tts: 'online' } }, 'chat', ctxDown).ready, false); // no api key
assert.strictEqual(eng.engineReady({ engines: { chat: 'offline', vision: 'online', stt: 'online', tts: 'online' } }, 'chat', ctxUp).ready, true);
assert.strictEqual(eng.engineReady({ engines: { chat: 'offline', vision: 'online', stt: 'online', tts: 'online' } }, 'chat', ctxDown).ready, false);
assert.strictEqual(eng.engineReady({ engines: { chat: 'online', vision: 'offline', stt: 'online', tts: 'online' } }, 'vision', ctxUp).ready, true);
assert.strictEqual(eng.engineReady({ engines: { chat: 'online', vision: 'offline', stt: 'online', tts: 'online' } }, 'vision', ctxDown).ready, false);
assert.strictEqual(eng.engineReady({ engines: { chat: 'online', vision: 'online', stt: 'online', tts: 'offline' } }, 'tts', ctxDown).ready, false);
assert.strictEqual(eng.engineReady({ engines: { chat: 'online', vision: 'online', stt: 'online', tts: 'offline' } }, 'tts', ctxUp).ready, true);

console.log('test-engines: all assertions passed');
