// tests/test-scene-watcher.js
// Pure tests for the ambient scene-watcher core (spec D3 / Phase 6). node + assert.
const assert = require('assert');
const W = require('../renderer/scene-watcher');

// ---- frameDelta: mean absolute grayscale difference, normalized 0..1 ----
assert.strictEqual(W.frameDelta([0, 100, 200, 255], [0, 100, 200, 255]), 0, 'identical -> 0');
assert.strictEqual(W.frameDelta([0, 0, 0, 0], [255, 255, 255, 255]), 1, 'black->white -> 1');
assert.strictEqual(W.frameDelta([0, 0], [0, 255]), 0.5, 'half changed -> .5');
assert.strictEqual(W.frameDelta(null, [1, 2]), 0, 'missing frame -> 0 (conservative)');
assert.strictEqual(W.frameDelta([1, 2, 3], [1, 2]), 0, 'length mismatch -> 0 (conservative)');

// ---- createGate: change -> stabilize -> exactly one fire -> cooldown ----
const g = W.createGate({ changeThreshold: 0.085, stableThreshold: 0.03, stableMs: 1000, minIntervalMs: 20000 });
assert.strictEqual(g.feed(0.01, 0), 'idle', 'calm stays idle');
assert.strictEqual(g.feed(0.20, 500), 'changed', 'big delta marks changed');
assert.strictEqual(g.feed(0.09, 1000), 'stabilizing', 'still moving: stability clock resets');
assert.strictEqual(g.feed(0.01, 1500), 'stabilizing', 'calm begins');
assert.strictEqual(g.feed(0.01, 2000), 'stabilizing', 'calm 500ms < 1000ms');
assert.strictEqual(g.feed(0.01, 2600), 'fire', 'calm 1100ms >= 1000ms -> fire once');
assert.strictEqual(g.feed(0.30, 3000), 'cooldown', 'inside min interval -> cooldown');
assert.strictEqual(g.feed(0.30, 22601), 'changed', 'after min interval a new change registers');
assert.strictEqual(g.feed(0.01, 23000), 'stabilizing', 'stabilizing again');
assert.strictEqual(g.feed(0.01, 24100), 'fire', 'second cycle fires');

// below the change threshold nothing ever arms
const g2 = W.createGate({});
assert.strictEqual(g2.feed(0.05, 0), 'idle', 'sub-threshold -> idle');
assert.strictEqual(g2.feed(0.05, 5000), 'idle', 'still idle');

// ---- parseSceneReply: strict one-word confidence gate ----
assert.strictEqual(W.parseSceneReply('document'), 'document');
assert.strictEqual(W.parseSceneReply('Bill.'), 'bill');
assert.strictEqual(W.parseSceneReply('  PRODUCT '), 'product');
assert.strictEqual(W.parseSceneReply('"whiteboard"'), 'whiteboard');
assert.strictEqual(W.parseSceneReply('a busy desk scene'), null, 'multi-word -> null');
assert.strictEqual(W.parseSceneReply('none'), null, 'none -> null');
assert.strictEqual(W.parseSceneReply(''), null);
assert.strictEqual(W.parseSceneReply(undefined), null);

// ---- suggestionFor: chip copy + the lookCamera question ----
['document', 'bill', 'product', 'whiteboard'].forEach(function (s) {
  const sg = W.suggestionFor(s);
  assert.ok(sg && sg.text && sg.question, s + ' has text+question');
});
assert.ok(/scan & log/i.test(W.suggestionFor('bill').text), 'bill copy offers scan & log');
assert.strictEqual(W.suggestionFor('nope'), null, 'unknown scene -> null');

console.log('test-scene-watcher: OK');
