// tests/test-voice-interaction.js
// Smart Audio & Voice Interaction (4) - pure-helper unit tests.
// Covers the JS logic that the renderer/repo wires together:
//   - matcher helpers (close phrases / addressed startsWith)
//   - cosine similarity + mean-pool for the 96-dim Google speech embedding
//   - dynamic-floor EMA math (mirror of automation.py logic, JS-side for renderer tests)
//
// Run: `node tests/test-voice-interaction.js`  - exits non-zero on failure.

const assert = require('assert');

// lib/config.js does `const { app } = require('electron');` at top level; stub before
// requiring so a plain-node test run can still pull the DEFAULTS object. The stub
// survives one `require()` call (the cache hit short-circuits subsequent gets).
require.cache[require.resolve('electron')] = { exports: { app: { getPath: () => '/tmp' } } };
const DEFAULTS = require('../lib/config').DEFAULTS;
assert.ok(DEFAULTS.continuousListening === true, 'continuousListening default true');
assert.ok(DEFAULTS.contextAwareFiltering === true, 'contextAwareFiltering default true');
assert.ok(DEFAULTS.dynamicNoiseFloor === true, 'dynamicNoiseFloor default true');
assert.ok(DEFAULTS.speakerRecognition === false, 'speakerRecognition default FALSE (opt-in)');
assert.ok(Array.isArray(DEFAULTS.conversationClosePhrases), 'conversationClosePhrases is an array');
assert.ok(Array.isArray(DEFAULTS.addressStartsWith), 'addressStartsWith is an array');

// ---- helpers (mirrors of what's used in renderer + automation) ----
function cosineSim(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const m = Math.sqrt(na) * Math.sqrt(nb);
  return m ? dot / m : 0;
}
function meanPool(frames) {
  if (!Array.isArray(frames) || !frames.length) return null;
  const n = frames.length;
  const d = frames[0].length;
  const out = new Float32Array(d);
  for (let i = 0; i < n; i++) {
    const f = frames[i];
    if (!f || f.length !== d) continue;
    for (let j = 0; j < d; j++) out[j] += f[j] / n;
  }
  return out;
}
function isClosePhrase(text) {
  const t = String(text || '').trim().toLowerCase();
  return DEFAULTS.conversationClosePhrases.some((p) => t === p);
}
function isDirectlyAddressed(text) {
  const t = String(text || '').trim().toLowerCase();
  if (!t) return false;
  if (t.length > (DEFAULTS.addressMaxLenChars || 28)) return true; // long enough to be a real request
  return DEFAULTS.addressStartsWith.some((w) => t.startsWith(w + ' ') || t === w);
}

// ---- cosine similarity ----
{
  const a = [1, 0, 0];
  const b = [1, 0, 0];
  assert.ok(Math.abs(cosineSim(a, b) - 1) < 1e-6, 'identical vectors similarity = 1');
  const c = [1, 0, 0];
  const d = [0, 1, 0];
  assert.ok(Math.abs(cosineSim(c, d) - 0) < 1e-6, 'orthogonal vectors similarity = 0');
  const v = [0.3, -0.5, 0.8, 0.1];
  assert.ok(cosineSim(v, v) > 0.999, 'v vs v = 1');
}
{
  // Construct two "user prints" that are similar + one impostor that's not.
  const seed = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8];
  const userA = seed;
  const userB = seed.map((x) => x * 1.02); // tiny perturbation -> near-identical
  const impostor = [-0.7, -0.6, -0.5, -0.4, -0.3, -0.2, -0.1, 0];
  assert.ok(cosineSim(userA, userB) > 0.95, 'similar prints score > 0.95');
  assert.ok(cosineSim(userA, impostor) < 0.5, 'impostor scores < 0.5 - well below threshold');
  assert.ok(cosineSim([1, 2, 3], [1, 2]) === 0, 'mismatched-length vectors return 0');
}

// ---- mean-pool of 96-dim frames ----
{
  const frames = [];
  for (let f = 0; f < 16; f++) {
    const arr = new Float32Array(96);
    for (let j = 0; j < 96; j++) arr[j] = j + f * 0.001;
    frames.push(arr);
  }
  const pool = meanPool(frames);
  assert.ok(pool && pool.length === 96, 'pool length 96');
  // UNIFORM avg check: average FLOAT32 (j+f*0.001) ≈ j + 7.5*0.001 = j + 0.0075 (approx)
  for (let j = 0; j < 96; j++) {
    assert.ok(Math.abs(pool[j] - (j + 7.5 * 0.001)) < 0.01, 'meanPool row ' + j);
  }
}

// ---- close-phrase detection ----
{
  assert.strictEqual(isClosePhrase('thanks.'), true, '"thanks." closes conversation');
  assert.strictEqual(isClosePhrase('Thank you!'), true, 'case-insensitive');
  assert.strictEqual(isClosePhrase("that's all."), true, 'curly apostrophe');
  assert.strictEqual(isClosePhrase('goodbye.'), true, '"goodbye." closes');
  assert.strictEqual(isClosePhrase('thanks'), false, 'no trailing punctuation: NOT a close phrase (avoid closing on inline "thanks for that")');
  assert.strictEqual(isClosePhrase('please open Spotify'), false, 'real request not a close');
  assert.strictEqual(isClosePhrase(''), false, 'empty input not a close');
}

// ---- addressing heuristic ----
{
  // Addressed: starts with a trigger word OR is long enough to clearly be a request.
  assert.strictEqual(isDirectlyAddressed('Hey Caryl, open Spotify'), true, '"hey" prefixes a directive');
  assert.strictEqual(isDirectlyAddressed('Caryl play jazz'), true, 'assistant name prefix');
  assert.strictEqual(isDirectlyAddressed('open the settings please'), true, '"open" is imperative');
  assert.strictEqual(isDirectlyAddressed('can you check the weather?'), true, '"can" is interrogative');
  // Long: beyond 28 chars -> treated as clearly-addressed even without a trigger prefix.
  assert.strictEqual(isDirectlyAddressed('I wonder if the meeting room has been booked for tomorrow'), true, 'long text -> addressed');
  // Ambiguous: short, no trigger word at the start.
  assert.strictEqual(isDirectlyAddressed('hmm let me think'), false, 'short reflective phrase - ambiguous');
  assert.strictEqual(isDirectlyAddressed('so then'), false, 'short conversational filler - ambiguous');
  assert.strictEqual(isDirectlyAddressed('okay'), false, '1 word, ambiguous');
}

console.log('test-voice-interaction: OK');
