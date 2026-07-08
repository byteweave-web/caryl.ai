// tests/test-ratelimit.js
// ------------------------------------------------------------------
// Pure unit tests for lib/ratelimit.js.
// Covers the bug class that produces the "unusual traffic" page:
//   1. TokenBucket math (refill, consume, wait time)
//   2. Per-host cooldown gate (refuses fetch while active)
//   3. isUnusualTraffic body detection (string, JSON object, error.message)
//   4. triggerCooldown monotonicity (later longer cooldowns win)
// All in plain node, no Electron — runs in `npm test`.
// ------------------------------------------------------------------
'use strict';

const assert = require('assert');
const rl = require('../lib/ratelimit');
// Import the real isRateLimitError from the swarm router so these tests
// stay tied to the production contract. If the regex list changes in
// router.js, the test follows automatically.
const routerIsRateLimitError = require('../lib/swarm/router').isRateLimitError;

// Helpers ------------------------------------------------------------------
function assertContains(label, haystack, needle) {
  assert.ok(
    haystack && haystack.indexOf(needle) >= 0,
    label + ': expected to find "' + needle + '" in ' + JSON.stringify(haystack)
  );
}

let passed = 0, failed = 0;
function test(name, fn) {
  try {
    rl.resetForTests();
    fn();
    passed++;
    console.log('  ok   ' + name);
  } catch (e) {
    failed++;
    console.log('  FAIL ' + name + '\n       ' + (e && e.stack || e));
  }
}

console.log('lib/ratelimit.js');

// TokenBucket ------------------------------------------------------------
test('TokenBucket: starts full and consumes tokens', function () {
  const b = new rl.TokenBucket(60, 60);
  const r = b.tryConsume(1);
  assert.strictEqual(r.ok, true, 'first consume should succeed');
  assert.strictEqual(r.tokens, 59);
});

test('TokenBucket: drains in burst', function () {
  const b = new rl.TokenBucket(60, 3);
  assert.strictEqual(b.tryConsume(1).ok, true);
  assert.strictEqual(b.tryConsume(1).ok, true);
  assert.strictEqual(b.tryConsume(1).ok, true);
  const r = b.tryConsume(1);
  assert.strictEqual(r.ok, false, '4th consume should be denied');
  assert.ok(r.waitMs > 0, 'waitMs must be positive');
});

test('TokenBucket: refill matches elapsed time', function () {
  const b = new rl.TokenBucket(60, 60);   // 60 RPM = 1 per second
  b.tokens = 0;
  b.lastRefill = Date.now() - 5000;       // pretend 5s ago
  // After 5s wall-clock, only ~5 tokens have refilled. Demanding 10 must
  // be denied (this assertion is the inverse of what the original test
  // asserted; the comment is the source of truth).
  const r = b.tryConsume(10);
  assert.strictEqual(r.ok, false, 'with only ~5 tokens refilled, consume(10) must be denied');
  assert.ok(r.tokens >= 4 && r.tokens <= 6, 'tokens should be ~5, got ' + r.tokens);
  assert.ok(r.waitMs > 0, 'waitMs must be positive (need ~5 more tokens)');
});

test('TokenBucket: consumeAsync resolves and reports tokens', async function () {
  const b = new rl.TokenBucket(600, 6);   // 10/sec
  const r = await b.consumeAsync(2);
  assert.strictEqual(r.ok, true);
  assert.ok(r.tokens >= 0 && r.tokens <= 4);
});

// Cooldown gate -----------------------------------------------------------
test('gateRequest: throws COOLDOWN when host has active cooldown', function () {
  rl.triggerCooldown('api.test.local', 60000, 'test_setup');
  let thrown = null;
  try { rl.gateRequest('api.test.local', { ratePerMin: 30, burst: 30 }); } catch (e) { thrown = e; }
  assert.ok(thrown, 'should have thrown');
  assert.strictEqual(thrown.code, 'COOLDOWN');
  assert.ok(thrown.cooldownRemainingMs > 0);
});

test('gateRequest: ok after cooldown expires', function () {
  rl.triggerCooldown('api.test.local', -1, 'immediately-expired');   // -1ms = in the past
  let thrown = null;
  try { rl.gateRequest('api.test.local', { ratePerMin: 30, burst: 30 }); } catch (e) { thrown = e; }
  assert.strictEqual(thrown, null, 'expired cooldown should not throw');
});

test('triggerCooldown: extends on later longer call', function () {
  rl.triggerCooldown('api.test.local', 10000, 'first');
  rl.triggerCooldown('api.test.local', 60000, 'second');
  const rem = rl.cooldownRemainingMs('api.test.local');
  assert.ok(rem > 50000, 'should be ~60s, got ' + rem);
});

test('triggerCooldown: shorter later call does NOT shorten', function () {
  rl.triggerCooldown('api.test.local', 60000, 'long');
  rl.triggerCooldown('api.test.local', 10000, 'short');
  const rem = rl.cooldownRemainingMs('api.test.local');
  assert.ok(rem > 50000, 'shorter call must not reduce cooldown, got ' + rem);
});

// isUnusualTraffic -------------------------------------------------------
test('isUnusualTraffic: detects the user-reported page (string)', function () {
  const body = 'Our systems have detected unusual traffic from your computer network.';
  assert.strictEqual(rl.isUnusualTraffic(body), true);
});

test('isUnusualTraffic: detects full anti-abuse page body', function () {
  const body =
    'This page appears when Google automatically detects requests coming from your ' +
    'computer network which appear to be in violation of the terms of service.';
  assert.strictEqual(rl.isUnusualTraffic(body), true);
});

test('isUnusualTraffic: detects JSON {error:{message}} envelope', function () {
  const obj = { error: { message: 'Please try your request again later.' } };
  assert.strictEqual(rl.isUnusualTraffic(obj), true);
});

test('isUnusualTraffic: negative on benign 200 message', function () {
  assert.strictEqual(rl.isUnusualTraffic('Hello! How can I help?'), false);
});

test('isUnusualTraffic: negative on plain 401 auth error', function () {
  const obj = { error: { message: 'Invalid API key.' } };
  assert.strictEqual(rl.isUnusualTraffic(obj), false);
});

test('isUnusualTraffic: negative on plain 400 bad request', function () {
  assert.strictEqual(rl.isUnusualTraffic('Bad request: model not found'), false);
});

// router.isRateLimitError — test the real exported function so any change to
// the swarm router's pattern set updates this test automatically.
test('router isRateLimitError: detects 429', function () {
  assert.strictEqual(routerIsRateLimitError('API 429: Rate limited.'), true);
});

test('router isRateLimitError: detects COOLDOWN tag from providers.js', function () {
  assert.strictEqual(routerIsRateLimitError('cool-down: api blocked for 30s (COOLDOWN)'), true);
});

test('router isRateLimitError: detects unusual-traffic anti-abuse page', function () {
  assert.strictEqual(routerIsRateLimitError(
    'Our systems have detected unusual traffic from your computer network.'
  ), true);
});

test('router isRateLimitError: negative on a benign handler error', function () {
  assert.strictEqual(routerIsRateLimitError('handler_threw: TypeError: undefined'), false);
});

// gateRequest / isInCooldown interaction ---------------------------------
test('isInCooldown: returns true during cooldown, false after', function () {
  rl.triggerCooldown('api.test.local', 60000, 'set');
  assert.strictEqual(rl.isInCooldown('api.test.local'), true);
  rl.triggerCooldown('api.test.local', -1, 'expire');
  assert.strictEqual(rl.isInCooldown('api.test.local'), false);
});

test('host extraction from URL works', function () {
  assert.strictEqual(rl._hostOf('https://generativelanguage.googleapis.com/v1beta/openai'),
    'generativelanguage.googleapis.com');
  assert.strictEqual(rl._hostOf('https://api.groq.com/openai/v1/'),
    'api.groq.com');
});

// Summary -----------------------------------------------------------------
console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) process.exit(1);
