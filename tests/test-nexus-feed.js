// tests/test-nexus-feed.js
// ------------------------------------------------------------------
// Pure tests for the Live Orb feed (voice state + task choreography).
// Plain node + assert; runs in `npm test` (no Electron / DOM needed).
// Single source of truth is renderer/nexus-feed.js.
// ------------------------------------------------------------------
'use strict';

const assert = require('assert');
const NF = require('../renderer/nexus-feed');

let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e && e.stack || e)); }
}

console.log('renderer/nexus-feed.js');

// ---- normalizeMicLevel ---------------------------------------------
check('normalize: at/below 1.5x floor -> 0', function () {
  assert.strictEqual(NF.normalizeMicLevel(0.009, 0.006), 0);
  assert.strictEqual(NF.normalizeMicLevel(0.0, 0.006), 0);
});
check('normalize: at 8x floor -> 1 (clamped above)', function () {
  assert.strictEqual(NF.normalizeMicLevel(0.048, 0.006), 1);
  assert.strictEqual(NF.normalizeMicLevel(0.5, 0.006), 1);
});
check('normalize: monotonic in between', function () {
  const a = NF.normalizeMicLevel(0.015, 0.006);
  const b = NF.normalizeMicLevel(0.03, 0.006);
  assert.ok(a > 0 && a < 1, 'mid value in (0,1), got ' + a);
  assert.ok(b > a, 'louder -> bigger');
});
check('normalize: floor guarded to >= 0.003 (zero/NaN floor usable)', function () {
  const v = NF.normalizeMicLevel(0.01, 0);
  assert.ok(v > 0 && v < 1, 'usable with zero floor, got ' + v);
  assert.strictEqual(NF.normalizeMicLevel(0.01, 0), NF.normalizeMicLevel(0.01, NaN));
});
check('normalize: garbage rms -> 0', function () {
  assert.strictEqual(NF.normalizeMicLevel(NaN, 0.006), 0);
  assert.strictEqual(NF.normalizeMicLevel(-1, 0.006), 0);
});

// ---- computeState precedence ---------------------------------------
const T = 1000000;
check('state: defaults -> idle', function () {
  const f = NF.createFeed();
  const s = f.computeState(T);
  assert.strictEqual(s.mode, 'idle'); assert.strictEqual(s.text, 'idle');
  assert.strictEqual(s.level, 0); assert.strictEqual(s.levelSrc, 'none');
});
check('state: speaking beats everything (except offline)', function () {
  const f = NF.createFeed();
  f.setInputs({ ttsPlaying: true, recording: true, lwCapturing: true, aiStatus: 'working' }, T);
  const s = f.computeState(T);
  assert.strictEqual(s.mode, 'speaking'); assert.strictEqual(s.text, 'speaking');
});
check('state: wake capture alone -> listening (THE reported bug)', function () {
  const f = NF.createFeed();
  f.setInputs({ lwCapturing: true }, T);
  const s = f.computeState(T);
  assert.strictEqual(s.mode, 'listening'); assert.strictEqual(s.text, 'listening');
});
check('state: main-side ai_status listening -> listening', function () {
  const f = NF.createFeed();
  f.setInputs({ aiStatus: 'listening' }, T);
  assert.strictEqual(f.computeState(T).mode, 'listening');
});
check('state: thinking / working / researching / automation texts', function () {
  const f = NF.createFeed();
  f.setInputs({ aiStatus: 'thinking' }, T);
  assert.deepStrictEqual([f.computeState(T).mode, f.computeState(T).text], ['busy', 'thinking']);
  f.setInputs({ aiStatus: 'working' }, T);
  assert.strictEqual(f.computeState(T).text, 'working on it');
  f.setInputs({ aiStatus: 'researching' }, T);
  assert.strictEqual(f.computeState(T).text, 'working on it');
  f.setInputs({ aiStatus: 'idle', automationRunning: true }, T);
  assert.deepStrictEqual([f.computeState(T).mode, f.computeState(T).text], ['busy', 'working on it']);
});
check('state: conversation open / grace armed -> attentive', function () {
  const f = NF.createFeed();
  f.setInputs({ conversationOpen: true }, T);
  assert.deepStrictEqual([f.computeState(T).mode, f.computeState(T).text], ['attentive', 'attentive']);
  const g = NF.createFeed();
  g.setInputs({ graceArmed: true }, T);
  assert.strictEqual(g.computeState(T).mode, 'attentive');
});
check('state: offline overrides text (and parks mode at idle)', function () {
  const f = NF.createFeed();
  f.setInputs({ offline: true, ttsPlaying: true }, T);
  const s = f.computeState(T);
  assert.strictEqual(s.text, 'offline'); assert.strictEqual(s.mode, 'idle');
});

// ---- audio levels ----------------------------------------------------
check('level: fresh mic RMS flows while listening (levelSrc mic)', function () {
  const f = NF.createFeed();
  f.setInputs({ lwCapturing: true }, T);
  f.micLevel(0.048, 0.006, T);
  const s = f.computeState(T + 100);
  assert.strictEqual(s.levelSrc, 'mic'); assert.strictEqual(s.level, 1);
});
check('level: stale mic RMS (>=400ms) decays to none/0', function () {
  const f = NF.createFeed();
  f.setInputs({ lwCapturing: true }, T);
  f.micLevel(0.048, 0.006, T);
  const s = f.computeState(T + NF.LEVEL_FRESH_MS);
  assert.strictEqual(s.level, 0); assert.strictEqual(s.levelSrc, 'none');
});
check('level: mic ambience also flows at idle/attentive (honest room noise)', function () {
  const f = NF.createFeed();
  f.micLevel(0.02, 0.006, T);
  assert.strictEqual(f.computeState(T + 50).levelSrc, 'mic');
});
check('level: tts envelope flows while speaking (levelSrc tts), clamped', function () {
  const f = NF.createFeed();
  f.setInputs({ ttsPlaying: true }, T);
  f.ttsLevel(0.8, T);
  const s = f.computeState(T + 100);
  assert.strictEqual(s.levelSrc, 'tts'); assert.ok(Math.abs(s.level - 0.8) < 1e-9);
  f.ttsLevel(7, T); assert.strictEqual(f.computeState(T).level, 1);
});
check('level: speaking without fresh tts envelope -> levelSrc none (deck LFO)', function () {
  const f = NF.createFeed();
  f.setInputs({ ttsPlaying: true }, T);
  assert.strictEqual(f.computeState(T).levelSrc, 'none');
});

// ---- swarm events ----------------------------------------------------
check('swarm: dispatch-start -> dispatch directive, opens task', function () {
  const f = NF.createFeed();
  const d = f.swarmEvent({ kind: 'dispatch-start', to: 'Vision', task_id: 't-1', action: 'ocr' }, T);
  assert.deepStrictEqual(d, [{ op: 'dispatch', agent: 'VISION', id: 't-1·VISION', label: 'ocr' }]);
  assert.strictEqual(f.openCount(), 1);
});
check('swarm: duplicate dispatch-start refreshes, emits nothing', function () {
  const f = NF.createFeed();
  f.swarmEvent({ kind: 'dispatch-start', to: 'Vision', task_id: 't-1', action: 'ocr' }, T);
  const d = f.swarmEvent({ kind: 'dispatch-start', to: 'Vision', task_id: 't-1', action: 'ocr' }, T + 10);
  assert.deepStrictEqual(d, []); assert.strictEqual(f.openCount(), 1);
});
check('swarm: dispatch-end -> return directive with ok, closes task', function () {
  const f = NF.createFeed();
  f.swarmEvent({ kind: 'dispatch-start', to: 'Executor', task_id: 't-2', action: 'uia' }, T);
  const d = f.swarmEvent({ kind: 'dispatch-end', to: 'Executor', task_id: 't-2', action: 'uia', ok: true }, T + 50);
  assert.deepStrictEqual(d, [{ op: 'return', agent: 'EXECUTOR', id: 't-2·EXECUTOR', ok: true }]);
  assert.strictEqual(f.openCount(), 0);
});
check('swarm: end-without-start still returns (visually harmless), no crash', function () {
  const f = NF.createFeed();
  const d = f.swarmEvent({ kind: 'dispatch-end', to: 'Coder', task_id: 't-9', ok: false }, T);
  assert.strictEqual(d.length, 1); assert.strictEqual(d[0].op, 'return'); assert.strictEqual(d[0].ok, false);
});
check('swarm: Orchestrator -> note only (core is the orchestrator)', function () {
  const f = NF.createFeed();
  const d = f.swarmEvent({ kind: 'dispatch-start', to: 'Orchestrator', task_id: 't-3', action: 'plan' }, T);
  assert.deepStrictEqual(d, [{ op: 'note', id: 't-3', label: 'plan' }]);
  assert.strictEqual(f.openCount(), 0);
  assert.deepStrictEqual(f.swarmEvent({ kind: 'dispatch-end', to: 'Orchestrator', task_id: 't-3', ok: true }, T), []);
});
check('swarm: unknown agent -> no directives', function () {
  const f = NF.createFeed();
  assert.deepStrictEqual(f.swarmEvent({ kind: 'dispatch-start', to: 'Widget', task_id: 't-4' }, T), []);
});
check('swarm: rejected / rate-limited -> reject directives, tasks untouched', function () {
  const f = NF.createFeed();
  f.swarmEvent({ kind: 'dispatch-start', to: 'Memory', task_id: 't-5', action: 'recall' }, T);
  const r1 = f.swarmEvent({ kind: 'dispatch-rejected', error: { reason: 'bad' } }, T);
  assert.strictEqual(r1[0].op, 'reject'); assert.strictEqual(r1[0].label, 'rejected');
  const r2 = f.swarmEvent({ kind: 'dispatch-rate-limited', to: 'Memory', task_id: 't-5', error: '429' }, T);
  assert.strictEqual(r2[0].op, 'reject'); assert.strictEqual(r2[0].label, 'rate-limited');
  assert.strictEqual(f.openCount(), 1);
});

// ---- host task lifecycle (automation / camera) -----------------------
check('lifecycle: automation edge via setInputs -> EXECUTOR dispatch then return', function () {
  const f = NF.createFeed();
  const d1 = f.setInputs({ automationRunning: true }, T);
  assert.deepStrictEqual(d1, [{ op: 'dispatch', agent: 'EXECUTOR', id: 'automation', label: 'automation run' }]);
  const d2 = f.setInputs({ automationRunning: false }, T + 500);
  assert.deepStrictEqual(d2, [{ op: 'return', agent: 'EXECUTOR', id: 'automation', ok: true }]);
});
check('lifecycle: camera task ends when the AI turn ends (endOn ai-idle)', function () {
  const f = NF.createFeed();
  const d1 = f.taskBegin('camera', 'VISION', 'camera ask', { endOn: 'ai-idle' }, T);
  assert.deepStrictEqual(d1, [{ op: 'dispatch', agent: 'VISION', id: 'camera', label: 'camera ask' }]);
  assert.deepStrictEqual(f.setInputs({ aiStatus: 'working' }, T + 10), []);
  const d2 = f.setInputs({ aiStatus: 'idle' }, T + 900);
  assert.deepStrictEqual(d2, [{ op: 'return', agent: 'VISION', id: 'camera', ok: true }]);
  assert.strictEqual(f.openCount(), 0);
});
check('lifecycle: duplicate taskBegin refreshes silently; unknown taskEnd -> []', function () {
  const f = NF.createFeed();
  f.taskBegin('camera', 'VISION', 'camera ask', {}, T);
  assert.deepStrictEqual(f.taskBegin('camera', 'VISION', 'camera ask', {}, T + 5), []);
  assert.deepStrictEqual(f.taskEnd('nope', true, T), []);
});
check('lifecycle: sweep auto-returns leaked tasks after 90s, ok:false', function () {
  const f = NF.createFeed();
  f.swarmEvent({ kind: 'dispatch-start', to: 'Coder', task_id: 't-7', action: 'patch' }, T);
  assert.deepStrictEqual(f.sweep(T + NF.TASK_TIMEOUT_MS - 1), []);
  const d = f.sweep(T + NF.TASK_TIMEOUT_MS);
  assert.deepStrictEqual(d, [{ op: 'return', agent: 'CODER', id: 't-7·CODER', ok: false }]);
  assert.strictEqual(f.openCount(), 0);
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) process.exit(1);
