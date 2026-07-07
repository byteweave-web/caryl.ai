# Live Orb — Honest Voice + Work Choreography: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the embedded Nexus deck a truthful live monitor — glow tracks real voice, packets fire only for real sub-agent work (swarm/automation/camera), with return pulses on completion — and fix the wake-word path leaving `#pill-state`/`#orb-state` stuck on `idle`.

**Architecture:** A pure feed module (`renderer/nexus-feed.js`, dual-exported like `renderer/shell-reducer.js`) turns raw inputs (voice flags, mic RMS, TTS envelope, `ai_status`, swarm events) into a display state + task directives. Thin wiring in `renderer/index.html` pumps that state to the deck iframe over the existing postMessage channel and becomes the single writer for the state text. `renderer/nexus-deck.html` gains a v2 live surface: mode-driven core energy, a speaking LFO, and direction-aware packets (`caryl-task` dispatch/return/reject).

**Tech Stack:** Vanilla JS (no new deps) · Electron offscreen probe harness (`tools/probe_shell.js`) · plain `node`+`assert` tests.

**Spec:** `docs/superpowers/specs/2026-07-07-live-orb-workspace-design.md`. One deviation, decided here: the feed lives at `renderer/nexus-feed.js` (not `lib/nexusFeed.js`) — `index.html` loads sibling scripts (`<script src="shell-reducer.js">` precedent) and tests already require from `../renderer/` (`test-shell-reducer.js`).

## Global Constraints

- **No new npm dependencies.**
- **Never sweep-commit:** the working tree carries unrelated changes. `git add` ONLY the files each task lists.
- Code style: `renderer/index.html` host code uses ES5-ish `function(){}`; `renderer/nexus-deck.html` uses modern ES (arrows/template literals). Match the file you're in.
- Probe runs use the Bash tool: `node_modules/.bin/electron tools/probe_shell.js --probe=tools/probes/<name>.js --wait=<ms>`; exit 0 = PASS.
- The standalone deck (`nexus-deck.html` opened WITHOUT `?embed=1`) keeps its demo choreography — ambient dispatcher, boot sequence, click/space `broadcast()` all untouched.
- Magic numbers (from spec): 90 000 ms task auto-return · 400 ms audio-level freshness · ~45 ms (22 msg/s) pump post throttle · speaking LFO ≈ 4.5 Hz, amplitude halved under `prefers-reduced-motion`.
- postMessage always uses targetOrigin `'*'` (file:// context, existing convention).

---

### Task 1: Pure feed module + node tests

**Files:**
- Create: `renderer/nexus-feed.js`
- Create: `tests/test-nexus-feed.js`
- Modify: `package.json` (test script chain)

**Interfaces:**
- Consumes: nothing (pure; caller supplies `now` in ms).
- Produces (used by Tasks 4–6):
  - `NexusFeed.normalizeMicLevel(rms, floor) → 0..1`
  - `NexusFeed.createFeed() → feed` with:
    - `feed.setInputs(partial, now) → directives[]` — inputs: `{recording, lwCapturing, conversationOpen, graceArmed, ttsPlaying, aiStatus, automationRunning, offline}`
    - `feed.micLevel(rms, floor, now)` / `feed.ttsLevel(v, now)`
    - `feed.computeState(now) → {mode:'idle'|'attentive'|'listening'|'speaking'|'busy', text:'idle'|'attentive'|'listening'|'speaking'|'thinking'|'working on it'|'offline', level:0..1, levelSrc:'mic'|'tts'|'none'}`
    - `feed.swarmEvent(ev, now) → directives[]`
    - `feed.taskBegin(key, agent, label, opts, now) → directives[]` (`opts.endOn:'ai-idle'` supported)
    - `feed.taskEnd(key, ok, now) → directives[]`
    - `feed.sweep(now) → directives[]`
    - `feed.openCount() → number`
  - Directive shape: `{op:'dispatch'|'return'|'reject'|'note', agent?, id, ok?, label?}`
  - `NexusFeed.TASK_TIMEOUT_MS === 90000`, `NexusFeed.LEVEL_FRESH_MS === 400`

- [ ] **Step 1: Write the failing tests**

Create `tests/test-nexus-feed.js`:

```js
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node tests/test-nexus-feed.js`
Expected: crash with `Cannot find module '../renderer/nexus-feed'` (exit != 0).

- [ ] **Step 3: Write the implementation**

Create `renderer/nexus-feed.js`:

```js
// renderer/nexus-feed.js
// Pure, DOM-free brain of the Live Orb: turns raw inputs (voice flags, mic RMS, TTS
// envelope, ai_status, swarm events) into a display state + task directives for the
// embedded Nexus deck. Dual-exported: window.NexusFeed (renderer <script>) AND
// module.exports (node tests) — same pattern as renderer/shell-reducer.js.
// Same input -> same output; the caller supplies `now` (ms) so nothing here ticks.
(function (root) {
  'use strict';

  var TASK_TIMEOUT_MS = 90000; // leaked dispatch auto-returns (spec §10)
  var LEVEL_FRESH_MS = 400;    // audio level older than this reads as silence

  // Router alphabet (TitleCase) -> deck roster (UPPERCASE). Orchestrator IS the core
  // (note, no packet); PLANNER has no live source yet (spec §8).
  var SWARM_TO_ROSTER = {
    RESEARCHER: 'RESEARCHER', EXECUTOR: 'EXECUTOR', CODER: 'CODER',
    MEMORY: 'MEMORY', VISION: 'VISION', CRITIC: 'CRITIC',
  };

  function clamp01(n) { n = +n; if (!(n > 0)) return 0; return n > 1 ? 1 : n; }

  // Floor-relative mic curve: silence at 1.5x the ambient floor, full glow at 8x,
  // so the swell reads the same in a quiet or a noisy room.
  function normalizeMicLevel(rms, floor) {
    var f = +floor; if (!(f > 0.003)) f = 0.003;
    var lo = f * 1.5, hi = f * 8;
    var n = ((+rms || 0) - lo) / (hi - lo);
    return n <= 0 ? 0 : n >= 1 ? 1 : n;
  }

  function createFeed() {
    var inputs = {
      recording: false, lwCapturing: false, conversationOpen: false, graceArmed: false,
      ttsPlaying: false, aiStatus: 'idle', automationRunning: false, offline: false,
    };
    var lvl = { mic: 0, micAt: -1e9, tts: 0, ttsAt: -1e9 };
    var open = {}; // id -> { agent, at, endOn }

    function taskBegin(key, agent, label, opts, now) {
      if (open[key]) { open[key].at = now; return []; } // refresh, don't stack
      open[key] = { agent: agent, at: now, endOn: (opts && opts.endOn) || 'event' };
      return [{ op: 'dispatch', agent: agent, id: key, label: label || '' }];
    }
    function taskEnd(key, ok, now) {
      var rec = open[key];
      if (!rec) return [];
      delete open[key];
      return [{ op: 'return', agent: rec.agent, id: key, ok: ok !== false }];
    }

    function setInputs(partial, now) {
      var prev = { automationRunning: inputs.automationRunning, aiStatus: inputs.aiStatus };
      var k; for (k in partial) if (Object.prototype.hasOwnProperty.call(partial, k)) inputs[k] = partial[k];
      var out = [];
      // Automation lifecycle rides the status-poll edge -> EXECUTOR.
      if (!prev.automationRunning && inputs.automationRunning) {
        out = out.concat(taskBegin('automation', 'EXECUTOR', 'automation run', { endOn: 'automation' }, now));
      } else if (prev.automationRunning && !inputs.automationRunning) {
        out = out.concat(taskEnd('automation', true, now));
      }
      // ai-idle-scoped tasks (camera asks) close when the AI turn ends.
      var wasBusy = prev.aiStatus === 'thinking' || prev.aiStatus === 'working' || prev.aiStatus === 'researching';
      var isBusy = inputs.aiStatus === 'thinking' || inputs.aiStatus === 'working' || inputs.aiStatus === 'researching';
      if (wasBusy && !isBusy) {
        Object.keys(open).forEach(function (id) {
          if (open[id].endOn === 'ai-idle') out = out.concat(taskEnd(id, true, now));
        });
      }
      return out;
    }

    function computeState(now) {
      var i = inputs, mode, text;
      if (i.ttsPlaying) { mode = 'speaking'; text = 'speaking'; }
      else if (i.recording || i.lwCapturing || i.aiStatus === 'listening') { mode = 'listening'; text = 'listening'; }
      else if (i.aiStatus === 'thinking') { mode = 'busy'; text = 'thinking'; }
      else if (i.aiStatus === 'working' || i.aiStatus === 'researching' || i.automationRunning) { mode = 'busy'; text = 'working on it'; }
      else if (i.conversationOpen || i.graceArmed) { mode = 'attentive'; text = 'attentive'; }
      else { mode = 'idle'; text = 'idle'; }
      if (i.offline) { mode = 'idle'; text = 'offline'; }
      var level = 0, levelSrc = 'none';
      if (mode === 'speaking') {
        if (now - lvl.ttsAt < LEVEL_FRESH_MS) { level = lvl.tts; levelSrc = 'tts'; }
      } else if (now - lvl.micAt < LEVEL_FRESH_MS) { level = lvl.mic; levelSrc = 'mic'; }
      return { mode: mode, text: text, level: level, levelSrc: levelSrc };
    }

    function swarmEvent(ev, now) {
      if (!ev || typeof ev !== 'object') return [];
      var kind = ev.kind, id = String(ev.task_id || '');
      if (kind === 'dispatch-rejected') return [{ op: 'reject', id: id, label: 'rejected' }];
      if (kind === 'dispatch-rate-limited') return [{ op: 'reject', id: id, label: 'rate-limited' }];
      var up = String(ev.to || '').toUpperCase();
      if (up === 'ORCHESTRATOR') {
        return kind === 'dispatch-start' ? [{ op: 'note', id: id, label: String(ev.action || 'orchestrate') }] : [];
      }
      var agent = SWARM_TO_ROSTER[up];
      if (!agent) return [];
      var key = id + '·' + agent;
      if (kind === 'dispatch-start') return taskBegin(key, agent, String(ev.action || ''), { endOn: 'event' }, now);
      if (kind === 'dispatch-end') {
        var out = taskEnd(key, ev.ok === true, now);
        // end-without-start still shows a return pulse — harmless and honest (spec §10)
        return out.length ? out : [{ op: 'return', agent: agent, id: key, ok: ev.ok === true }];
      }
      return [];
    }

    function sweep(now) {
      var out = [];
      Object.keys(open).forEach(function (id) {
        if (now - open[id].at >= TASK_TIMEOUT_MS) {
          var agent = open[id].agent;
          delete open[id];
          out.push({ op: 'return', agent: agent, id: id, ok: false });
        }
      });
      return out;
    }

    return {
      setInputs: setInputs,
      micLevel: function (rms, floor, now) { lvl.mic = normalizeMicLevel(rms, floor); lvl.micAt = now; },
      ttsLevel: function (v, now) { lvl.tts = clamp01(v); lvl.ttsAt = now; },
      computeState: computeState,
      swarmEvent: swarmEvent,
      taskBegin: taskBegin,
      taskEnd: taskEnd,
      sweep: sweep,
      openCount: function () { return Object.keys(open).length; },
    };
  }

  var api = {
    createFeed: createFeed,
    normalizeMicLevel: normalizeMicLevel,
    TASK_TIMEOUT_MS: TASK_TIMEOUT_MS,
    LEVEL_FRESH_MS: LEVEL_FRESH_MS,
  };
  root.NexusFeed = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node tests/test-nexus-feed.js`
Expected: every line `ok`, final `N passed, 0 failed`, exit 0.

- [ ] **Step 5: Wire into `npm test`**

In `package.json`, in the `"test"` script, replace
`node tests/test-shell-reducer.js && node tests/test-ratelimit.js`
with
`node tests/test-shell-reducer.js && node tests/test-nexus-feed.js && node tests/test-ratelimit.js`

Run: `node tests/test-shell-reducer.js && node tests/test-nexus-feed.js`
Expected: both suites pass.

- [ ] **Step 6: Commit**

```bash
git add renderer/nexus-feed.js tests/test-nexus-feed.js package.json
git commit -m "feat(orb): pure NexusFeed — voice state + honest task choreography brain"
```

---

### Task 2: Deck live surface v2 (modes, speaking LFO, probe hook, ready handshake)

**Files:**
- Modify: `renderer/nexus-deck.html` (the embed + live-drive section, ~lines 856–902, and nothing else)

**Interfaces:**
- Consumes: `{type:'caryl-orb', state:{mode, level, levelSrc}}` postMessages (Task 4 sends them); legacy `{level,speaking,busy,recording}` still accepted.
- Produces: `window.__deckProbe() → {on, mode, level, levelSrc, uActivity, load, pkts:[{name,dir,t}]}` (Task 6 asserts on it); `{type:'caryl-ready'}` posted to parent when embedded (Task 4 listens).

- [ ] **Step 1: Replace the `live` snapshot + `driveState`**

In `renderer/nexus-deck.html` replace:

```js
const live = { on:false, recording:false, speaking:false, busy:false, level:0, wasSpeaking:false };

/* one host message → update the live snapshot; broadcast on the rising edge of speech */
function driveState(s){
  if(!s || typeof s!=='object') return;
  live.on = true;
  live.recording = !!s.recording;
  live.speaking  = !!s.speaking;
  live.busy      = !!s.busy;
  live.level     = Math.max(0, Math.min(1, +s.level || 0));
  if(live.speaking && !live.wasSpeaking) broadcast();   // core → all agents ping
  live.wasSpeaking = live.speaking;
}
```

with:

```js
const live = { on:false, mode:'idle', levelSrc:'none', level:0 };

/* one host message → update the live snapshot. v2 hosts send {mode, level, levelSrc};
   a legacy host's {level,speaking,busy,recording} still maps to a sane mode. Speaking
   no longer broadcasts to all agents — packets now mean real work only (spec §5). */
function driveState(s){
  if(!s || typeof s!=='object') return;
  live.on = true;
  if(typeof s.mode === 'string'){
    live.mode = s.mode;
    live.levelSrc = s.levelSrc || 'none';
  }else{
    live.mode = s.speaking ? 'speaking' : (s.recording ? 'listening' : (s.busy ? 'busy' : 'idle'));
    live.levelSrc = s.recording ? 'mic' : 'none';
  }
  live.level = Math.max(0, Math.min(1, +s.level || 0));
}
```

- [ ] **Step 2: Replace `stepLive` (mode tiers + speaking pulse)**

Replace:

```js
function stepLive(dt){
  if(!live.on) return;
  sim.nextDispatch = 9;                       // suppress random dispatch while live
  let target;
  if(live.speaking)       target = 1.25 + live.level*0.35;   // broadcasting
  else if(live.recording) target = 0.62 + live.level*0.30;   // listening glow
  else if(live.busy)      target = 0.85;                      // working
  else                    target = 0.30 + live.level*0.20;    // idle breath
  coreUniforms.uActivity.value += (target - coreUniforms.uActivity.value) * Math.min(1, dt*3.2);
  const loadTarget = (live.busy||live.speaking) ? 0.9 : (live.recording ? 0.5 : 0.15);
  sim.load += (loadTarget - sim.load) * Math.min(1, dt*1.5);  // accretion spin-up
}
```

with:

```js
function stepLive(dt){
  if(!live.on) return;
  sim.nextDispatch = 9;                       // suppress random dispatch while live
  let target;
  if(live.mode==='speaking'){
    /* the core talks: real Piper envelope when the host has one, else a ~4.5Hz
       talking-rhythm LFO (half amplitude under prefers-reduced-motion) */
    const env = live.levelSrc==='tts'
      ? live.level
      : 0.5 + (REDUCED ? 0.25 : 0.5) * Math.sin(sim.time * Math.PI * 9);
    target = 1.05 + env*0.45;
  }
  else if(live.mode==='listening')  target = 0.62 + live.level*0.35;  // tracks YOUR voice
  else if(live.mode==='busy')       target = 0.85;                    // working
  else if(live.mode==='attentive')  target = 0.45 + live.level*0.15;  // armed, waiting
  else                              target = 0.30 + live.level*0.20;  // idle breath
  coreUniforms.uActivity.value += (target - coreUniforms.uActivity.value) * Math.min(1, dt*3.2);
  const loadTarget = (live.mode==='busy'||live.mode==='speaking') ? 0.9 : (live.mode==='listening' ? 0.5 : 0.15);
  sim.load += (loadTarget - sim.load) * Math.min(1, dt*1.5);  // accretion spin-up
}
```

(`REDUCED` already exists in this file — it gates the idle camera drift.)

- [ ] **Step 3: Add the probe surface + ready handshake**

Immediately AFTER the existing `window.addEventListener('message', …)` block, add:

```js
/* Offscreen-probe surface (tools/probes/live-orb.js) + host handshake: the app queues
   caryl-task directives until this ready ping so early dispatches are never lost. */
window.__deckProbe = function(){
  return {
    on: live.on, mode: live.mode, level: live.level, levelSrc: live.levelSrc,
    uActivity: coreUniforms.uActivity.value, load: sim.load,
    pkts: agents.filter(a=>a.pktT>=0).map(a=>({ name:a.d.name, dir:a.pktDir||1, t:a.pktT })),
  };
};
if(EMBED){ try{ window.parent.postMessage({ type:'caryl-ready' }, '*'); }catch(_e){} }
```

- [ ] **Step 4: Verify the deck still loads (existing probe suite)**

Run:
```bash
for p in engine-l0 material dock transcript motion fallbacks interaction select; do
  r=$(timeout 60 node_modules/.bin/electron tools/probe_shell.js --probe=tools/probes/$p.js --wait=2000 2>/dev/null | grep -E '^RESULT:')
  printf '%-14s %s\n' "$p" "$r"
done
```
Expected: all 8 lines `RESULT: PASS` (a deck syntax error would break `engine-l0`).

- [ ] **Step 5: Commit**

```bash
git add renderer/nexus-deck.html
git commit -m "feat(deck): live surface v2 — voice modes, speaking pulse, no fake broadcast"
```

---

### Task 3: Deck task choreography (direction-aware packets, return pulses, rejects)

**Files:**
- Modify: `renderer/nexus-deck.html` (agent literal ~line 519, `dispatch()` ~line 597, packet renderer ~lines 1057–1070, embed section)

**Interfaces:**
- Consumes: `{type:'caryl-task', op:'dispatch'|'return'|'reject'|'note', agent, id, ok?, label?}` postMessages (Task 5 sends them).
- Produces: visible packets with `a.pktDir` (+1 out, −1 home) readable via `__deckProbe().pkts` (Task 6).

- [ ] **Step 1: Give packets a direction**

In the `agents.push({ … })` literal, replace:
```js
    filGeo, filPos, filMat, packet, pktMat, pktT:-1, pktDur:0.9,
```
with:
```js
    filGeo, filPos, filMat, packet, pktMat, pktT:-1, pktDur:0.9, pktDir:1,
```

In `dispatch()`, replace:
```js
  agent.pktT = 0; agent.flash = Math.max(agent.flash, 1);
```
with:
```js
  agent.pktT = 0; agent.pktDir = 1; agent.flash = Math.max(agent.flash, 1);
```

- [ ] **Step 2: Direction-aware packet renderer + core acknowledge**

Replace the packet block:

```js
    /* packet along filament */
    if(a.pktT >= 0){
      a.pktT += dt/a.pktDur;
      if(a.pktT >= 1){ a.pktT = -1; a.pktMat.opacity = 0; }
      else{
        const s = a.pktT*a.pktT*(3-2*a.pktT), i = Math.min(54, (s*55)|0), fr = s*55 - i;
        a.packet.position.set(
          a.filPos[i*3]*(1-fr)+a.filPos[(i+1)*3]*fr,
          a.filPos[i*3+1]*(1-fr)+a.filPos[(i+1)*3+1]*fr,
          a.filPos[i*3+2]*(1-fr)+a.filPos[(i+1)*3+2]*fr);
        a.pktMat.opacity = Math.sin(s*Math.PI)*0.95;
        a.packet.scale.setScalar(10 + s*10);
      }
    }
```

with:

```js
    /* packet along filament — pktDir +1 travels core→agent, −1 travels agent→core
       (a completed task pulsing home). filPos[0] is the core end of the tether. */
    if(a.pktT >= 0){
      a.pktT += dt/a.pktDur;
      if(a.pktT >= 1){
        a.pktT = -1; a.pktMat.opacity = 0;
        if(a.pktDir < 0){  // return pulse arrived: the core acknowledges
          coreUniforms.uActivity.value = Math.min(1.6, coreUniforms.uActivity.value + 0.35);
          a.pktDir = 1;
        }
      }
      else{
        const p = a.pktT*a.pktT*(3-2*a.pktT), s = a.pktDir < 0 ? 1-p : p;
        const i = Math.min(54, (s*55)|0), fr = s*55 - i;
        a.packet.position.set(
          a.filPos[i*3]*(1-fr)+a.filPos[(i+1)*3]*fr,
          a.filPos[i*3+1]*(1-fr)+a.filPos[(i+1)*3+1]*fr,
          a.filPos[i*3+2]*(1-fr)+a.filPos[(i+1)*3+2]*fr);
        a.pktMat.opacity = Math.sin(p*Math.PI)*0.95;
        a.packet.scale.setScalar(10 + p*10);
      }
    }
```

- [ ] **Step 3: Task handlers in the embed section**

In the embed + live-drive section, immediately BEFORE the `window.addEventListener('message', …)` block, add:

```js
/* ---- real task choreography (host → caryl-task) ---- */
function returnPulse(a, ok){
  a.pktDir = -1; a.pktT = 0; a.flash = Math.max(a.flash, 0.7);
  a.state = 'READY'; a.queue = Math.max(0, a.queue - 1);
  a.actTarget = Math.max(0.15, a.actTarget - 0.30);
  log(`RETURN <span class="who" style="color:${a.d.css}">${a.d.name}</span> → core · ${ok?'done':'failed'}`, a.d.css);
}
let _flareBaseColor = null;
function rejectFlicker(label){
  if(_flareBaseColor === null) _flareBaseColor = flareMat.color.getHex();
  flareMat.color.set(0xFF4D7E);
  flareMat.opacity = Math.max(flareMat.opacity, 0.85);
  shellMat.uniforms.uFlare.value = Math.max(shellMat.uniforms.uFlare.value, 0.5);
  setTimeout(()=>{ flareMat.color.setHex(_flareBaseColor); }, 300);
  log(`REJECT <span class="who" style="color:#FF4D7E">${label||'dispatch'}</span>`);
}
function driveTask(m){
  if(!m || typeof m!=='object') return;
  if(m.op === 'reject'){ rejectFlicker(m.label); return; }
  if(m.op === 'note'){ log(`CORE · ${m.label||''}`); return; }
  const a = agents.find(x => x.d.name === String(m.agent||'').toUpperCase());
  if(!a){ console.warn('[deck] unknown agent:', m.agent); return; }
  if(m.op === 'dispatch'){ a.pktDir = 1; dispatch(a); }
  else if(m.op === 'return'){ returnPulse(a, m.ok !== false); }
}
```

- [ ] **Step 4: Route the message**

In the message listener, replace:
```js
  if(d.type === 'caryl-orb')         driveState(d.state || d);
  else if(d.type === 'caryl-active') setActive(!!d.active);
```
with:
```js
  if(d.type === 'caryl-orb')         driveState(d.state || d);
  else if(d.type === 'caryl-task')   driveTask(d);
  else if(d.type === 'caryl-active') setActive(!!d.active);
```

- [ ] **Step 5: Verify deck loads; commit**

Run the same 8-probe loop as Task 2 Step 4. Expected: all PASS.

```bash
git add renderer/nexus-deck.html
git commit -m "feat(deck): direction-aware packets — dispatch out, return pulses home, reject flicker"
```

---

### Task 4: Host voice pipeline (single writer + real audio levels)

**Files:**
- Modify: `renderer/index.html`

**Interfaces:**
- Consumes: `NexusFeed.createFeed()` (Task 1); deck's `caryl-ready` + `__deckProbe` (Tasks 2–3).
- Produces: `window.NexusOrb` = `{ setOffline(bool), micLevel(rms,floor), ttsLevel(v), swarmEvent(ev), taskBegin(key,agent,label,endOn), taskEnd(key,ok) }` (Task 5 hooks call these); posts `caryl-orb` (v2 shape) + `caryl-task` to the deck; is the ONLY writer of `#pill-state` / `#orb-state` / `#led-listen`.

- [ ] **Step 1: Load the feed**

After `<script src="shell-reducer.js"></script>` add:
```html
<script src="nexus-feed.js"></script>
```

- [ ] **Step 2: Find every `orb` reader before deleting it**

Run: `grep -n "orb\." renderer/index.html | grep -vE "orb-deck|orb-state|orb-caption|orb-meta|window\.bridge|NexusOrb"`
Expected: matches ONLY at the four known sites — the `let orb` declaration (~711), `setMicState` (~1506), the poll block (~2586–2589), `refreshSpeakingUI` (~2866–2873), and `initOrb`'s pump (~2736–2745). If anything else reads `orb.`, STOP and rework that site first (report it in the task summary).

- [ ] **Step 3: Delete the `orb` object; rewrite `initOrb` as the NexusOrb pump**

Delete the line:
```js
let orb = {level:0, speaking:false, target:0};
```

In `setMicState`, delete the line:
```js
  if(orb){ orb.target = on ? 0.85 : 0; }
```

Replace the whole `initOrb` function (keep its name — the call site at the bottom of the file stays):

```js
// The Orb tab is the Nexus deck (renderer/nexus-deck.html) in an <iframe>. This pump is
// the single source of truth for Caryl's live state: it feeds renderer/nexus-feed.js
// (pure brain), posts the computed state to the deck at ~22 msg/s, forwards task
// directives (packets = real work only), and is the ONLY writer of the state text
// (#pill-state / #orb-state) and the listen LED — poll() and the voice paths just
// supply inputs. That single-writer rule is what fixes the wake-word "idle" bug.
function initOrb(){
  if(!window.NexusFeed){ console.error('[orb] NexusFeed missing — live orb disabled'); return; }
  const feed = window.NexusFeed.createFeed();
  const deckEl = document.getElementById('orb-deck');
  function deckWin(){ return deckEl && deckEl.contentWindow; }

  // Task directives queue until the deck says caryl-ready, so early automation
  // dispatches are never lost to an iframe that is still booting.
  let deckReady = false; const taskQ = [];
  function postTask(d){
    const w = deckWin();
    if(deckReady && w){ w.postMessage({ type:'caryl-task', op:d.op, agent:d.agent, id:d.id, ok:d.ok, label:d.label }, '*'); }
    else taskQ.push(d);
  }
  window.addEventListener('message', function(ev){
    if(ev.data && ev.data.type === 'caryl-ready'){
      deckReady = true;
      while(taskQ.length) postTask(taskQ.shift());
    }
  });

  let lastText = '';
  function applyOrbState(st){
    if(st.text !== lastText){
      lastText = st.text;
      const ps = document.getElementById('pill-state'); if(ps) ps.textContent = st.text;
      const os = document.getElementById('orb-state'); if(os) os.textContent = st.text;
    }
    const led = document.getElementById('led-listen');
    if(led) led.className = 'led' + (st.text === 'offline' ? ' off' : (st.mode !== 'idle' ? ' on' : ''));
  }

  function sync(nowMs){
    feed.setInputs({
      recording: !!recording,
      lwCapturing: !!_lwCapturing,
      conversationOpen: !!_conversationMode,
      graceArmed: Date.now() < _followupGraceUntil,
      ttsPlaying: ttsActive() || !!(lastStatus && lastStatus.ai_speaking),
      aiStatus: lastStatus ? (lastStatus.ai_status || 'idle') : 'idle',
      automationRunning: !!(lastStatus && lastStatus.automation_running)
    }, nowMs).forEach(postTask);
    return feed.computeState(nowMs);
  }

  let lastPost = 0, lastSweep = 0;
  (function pump(ts){
    ts = ts || 0;
    if(ts - lastPost > 45){                    // throttle to ~22 msg/s
      lastPost = ts;
      const nowMs = Date.now();
      const st = sync(nowMs);
      applyOrbState(st);
      const w = deckWin();
      if(w) w.postMessage({ type:'caryl-orb', state:{ mode: st.mode, level: st.level, levelSrc: st.levelSrc } }, '*');
      if(nowMs - lastSweep > 1000){ lastSweep = nowMs; feed.sweep(nowMs).forEach(postTask); }
    }
    requestAnimationFrame(pump);
  })(0);

  window.NexusOrb = {
    setOffline: function(off){ feed.setInputs({ offline: !!off }, Date.now()).forEach(postTask); },
    micLevel: function(rms, floor){ feed.micLevel(rms, floor, Date.now()); },
    ttsLevel: function(v){ feed.ttsLevel(v, Date.now()); },
    swarmEvent: function(ev){ feed.swarmEvent(ev, Date.now()).forEach(postTask); },
    taskBegin: function(key, agent, label, endOn){ feed.taskBegin(key, agent, label, { endOn: endOn }, Date.now()).forEach(postTask); },
    taskEnd: function(key, ok){ feed.taskEnd(key, ok, Date.now()).forEach(postTask); }
  };
}
```

- [ ] **Step 4: poll() supplies inputs instead of writing the pill**

Replace the offline early-return:
```js
  if(!s){ document.getElementById('pill-state').textContent='offline'; document.getElementById('led-listen').className='led off'; return; }
```
with:
```js
  if(!s){ if(window.NexusOrb) NexusOrb.setOffline(true); return; }
```

Replace the whole state block:
```js
  // The voice plays in THIS window (renderer), but main reports ai_speaking:false and goes
  // idle the moment text generation ends - so treat local TTS playback as "speaking" too.
  const speakingNow = !!s.ai_speaking || ttsActive();

  let state='idle', busy=false;
  if(speakingNow){ state='speaking'; busy=true; }
  else if(s.ai_status==='researching'||s.ai_status==='working'){ state='working on it'; busy=true; }
  else if(s.ai_status==='thinking'){ state='thinking'; busy=true; }
  else if(recording){ state='listening'; }   // mic actively recording (push-to-talk / wake command)
  else if(s.ai_status==='listening' || (s.latest_volume||0)>0.6){ state='listening'; }
  document.getElementById('pill-state').textContent=state;
  document.getElementById('led-listen').className='led '+(state==='idle'?'':'on');

  orb.speaking=speakingNow;
  orb.busy=busy;
  orb.target=recording?0.85:(speakingNow?1:(busy?0.7:Math.min(1,(s.latest_volume||0)/6)));
  const os=document.getElementById('orb-state'); if(os) os.textContent=state;
```
with:
```js
  // Voice/orb state flows through renderer/nexus-feed.js — the pump in initOrb() reads
  // lastStatus (set above) each frame and is the single writer for #pill-state,
  // #orb-state and the listen LED. poll() only clears the offline latch here.
  if(window.NexusOrb) NexusOrb.setOffline(false);
```

- [ ] **Step 5: refreshSpeakingUI keeps ONLY the grace logic**

Replace the whole `refreshSpeakingUI` function (keep `let _wasEngaged=false;` above it):
```js
function refreshSpeakingUI(){
  const speakingNow = ttsActive();
  // Orb visuals + state text are owned by the NexusFeed pump (initOrb). This 200ms
  // ticker only keeps the follow-up grace window honest: the 25s clock starts the
  // moment Caryl stops being engaged (done talking AND done generating) - NOT while
  // reply text is still streaming (see the original bug note on _followupGraceUntil).
  const busyNow = speakingNow || (lastStatus && (lastStatus.ai_status==='working' || lastStatus.ai_status==='thinking'));
  if(!busyNow && _wasEngaged && !document.hasFocus()){ _followupGraceUntil = Date.now() + FOLLOWUP_GRACE_MS; }
  _wasEngaged = busyNow;
}
```

- [ ] **Step 6: `_setVoiceStatus` stops writing the pill**

Replace its body:
```js
function _setVoiceStatus(state, label){
  // State text + LED are owned by the NexusFeed pump (conversation flags flow in via
  // sync()). This helper now only surfaces the human-readable hint line.
  if(label){ try { setHint(label); } catch(_e) {} }
}
```

- [ ] **Step 7: Feed the real mic levels**

(a) Wake path — in `wireWakeWord()`, at the TOP of the existing `WakeWord.on('level', function(lvl){ … })` handler body, add:
```js
    try{ if(window.NexusOrb) NexusOrb.micLevel(lvl, _lwAmbientFloor); }catch(_e){}
```

(b) Mic-button path — in `startRecording()`'s `_recVadTimer` interval, directly after
```js
        const lvl=Math.sqrt(ss/buf.length);
```
add:
```js
        try{ if(window.NexusOrb) NexusOrb.micLevel(lvl, floor); }catch(_e){}
```

- [ ] **Step 8: Tap the Piper TTS envelope**

Above `_drainAudioQueue`, add:
```js
// Real speech envelope for the Orb: tap Piper playback through WebAudio.
// createMediaElementSource REROUTES the element's output, so if any wiring step fails
// we reconnect straight to the destination — TTS must never go silent for a visual.
let _ttsTapCtx = null;
function _tapTtsAudio(a){
  if(!window.NexusOrb) return;
  const Ctx = window.AudioContext || window.webkitAudioContext; if(!Ctx) return;
  if(!_ttsTapCtx) _ttsTapCtx = new Ctx();
  if(_ttsTapCtx.state === 'suspended'){ try{ _ttsTapCtx.resume(); }catch(_e){} }
  const src = _ttsTapCtx.createMediaElementSource(a);
  let an = null;
  try{
    an = _ttsTapCtx.createAnalyser(); an.fftSize = 1024;
    src.connect(an); an.connect(_ttsTapCtx.destination);
  }catch(e){ try{ src.connect(_ttsTapCtx.destination); }catch(_e2){} return; }
  const buf = new Float32Array(an.fftSize);
  (function sample(){
    if(_ttsAudio !== a || a.ended || a.paused) return;  // clip done; the next clip re-taps
    an.getFloatTimeDomainData(buf);
    let ss = 0; for(let i = 0; i < buf.length; i++) ss += buf[i]*buf[i];
    NexusOrb.ttsLevel(Math.min(1, Math.sqrt(ss/buf.length) * 4));
    requestAnimationFrame(sample);
  })();
}
```
In `_drainAudioQueue`, after `a.play().catch(next);` add:
```js
    try{ _tapTtsAudio(a); }catch(_e){}
```

- [ ] **Step 9: Verify (probes + no stray `orb.`)**

Run: `grep -n "orb\." renderer/index.html | grep -vE "orb-deck|orb-state|orb-caption|orb-meta|window\.bridge|NexusOrb"`
Expected: no output.

Run the 8-probe loop (Task 2 Step 4). Expected: all PASS — `interaction`/`select`/`engine-l0` prove the page still boots with the rewired pump.

- [ ] **Step 10: Commit**

```bash
git add renderer/index.html
git commit -m "feat(orb): NexusFeed pump — single-writer state text + real mic/TTS levels (fixes wake-word idle)"
```

---

### Task 5: Host task-event wiring (swarm, camera)

**Files:**
- Modify: `renderer/index.html`

**Interfaces:**
- Consumes: `window.NexusOrb.swarmEvent / taskBegin` (Task 4); `bridge.onSwarmEvent` (exists in preload.js).
- Produces: live `caryl-task` traffic for real work. (Automation needs no wiring here — the feed derives it from `automationRunning` inside `sync()`.)

- [ ] **Step 1: Swarm events → feed**

Directly after the `initOrb` function definition, add:
```js
// Real sub-agent work → deck packets. The swarm router (lib/swarm/router.js) emits
// dispatch-start BEFORE a handler runs and dispatch-end after; the feed maps agent
// names (TitleCase alphabet) onto the deck roster and handles reject/rate-limit.
if(window.bridge && window.bridge.onSwarmEvent){
  window.bridge.onSwarmEvent(function(ev){
    try{ if(window.NexusOrb) NexusOrb.swarmEvent(ev); }catch(_e){}
  });
}
```

- [ ] **Step 2: Camera asks → VISION**

In `camSendInput()`, after `window.bridge.sendText(t);` add:
```js
  try{ if(window.NexusOrb) NexusOrb.taskBegin('camera', 'VISION', 'camera ask', 'ai-idle'); }catch(_e){}
```

In the `onCameraCapture` handler, after the `setCamStatus('looking')` line, add:
```js
    try{ if(window.NexusOrb) NexusOrb.taskBegin('camera', 'VISION', 'camera look', 'ai-idle'); }catch(_e){}
```

- [ ] **Step 3: Verify + commit**

Run: `node tests/test-nexus-feed.js` — Expected: PASS (wiring compiles against the tested API).
Run the 8-probe loop — Expected: all PASS.

```bash
git add renderer/index.html
git commit -m "feat(orb): route real work — swarm dispatch/return + camera VISION pulses"
```

---

### Task 6: End-to-end probe + full verification

**Files:**
- Create: `tools/probes/live-orb.js`

**Interfaces:**
- Consumes: `window.__deckProbe()` (Tasks 2–3), host globals `_lwCapturing` (top-level `let`, reachable from `executeJavaScript`), the pump (Task 4).

- [ ] **Step 1: Write the probe**

Create `tools/probes/live-orb.js`:

```js
(async function () {
  function sleep(ms){ return new Promise(function(r){ setTimeout(r, ms); }); }
  var out = {};
  var deck = document.getElementById('orb-deck');
  var dw = deck && deck.contentWindow;

  // Wait for the embedded deck to expose its probe surface.
  var tries = 0;
  while (tries++ < 50 && !(dw && dw.__deckProbe)) { await sleep(100); dw = deck && deck.contentWindow; }
  out.probeFnPresent = !!(dw && dw.__deckProbe);
  if (!out.probeFnPresent) return JSON.stringify({ pass:false, detail: out });

  // 1) Wake-capture flag -> the WHOLE chain shows listening (feed -> pump -> pill + deck).
  _lwCapturing = true;
  await sleep(450);
  var st = dw.__deckProbe();
  out.mode = st.mode; out.liveOn = st.on;
  out.pillText = document.getElementById('pill-state').textContent;
  out.orbText = document.getElementById('orb-state').textContent;
  _lwCapturing = false;
  await sleep(200);

  // 2) Speaking pulse: drive the deck directly; core energy must rise well above idle.
  dw.postMessage({ type:'caryl-orb', state:{ mode:'speaking', level:0, levelSrc:'none' } }, '*');
  await sleep(300);
  var a1 = dw.__deckProbe().uActivity;
  await sleep(350);
  var a2 = dw.__deckProbe().uActivity;
  out.speakEnergy = Math.max(a1, a2);

  // 3) Task choreography: dispatch out (dir +1), then a return pulse home (dir -1).
  dw.postMessage({ type:'caryl-task', op:'dispatch', agent:'VISION', id:'probe·VISION', label:'probe' }, '*');
  await sleep(180);
  var pkts = dw.__deckProbe().pkts;
  out.dispatchPkt = pkts.filter(function(p){ return p.name === 'VISION'; })[0] || null;
  await sleep(1100);  // pktDur 0.9s — let it land
  dw.postMessage({ type:'caryl-task', op:'return', agent:'VISION', id:'probe·VISION', ok:true }, '*');
  await sleep(180);
  pkts = dw.__deckProbe().pkts;
  out.returnPkt = pkts.filter(function(p){ return p.name === 'VISION'; })[0] || null;

  var pass = out.liveOn === true && out.mode === 'listening'
    && out.pillText === 'listening' && out.orbText === 'listening'
    && out.speakEnergy > 0.7
    && !!out.dispatchPkt && out.dispatchPkt.dir === 1
    && !!out.returnPkt && out.returnPkt.dir === -1;
  return JSON.stringify({ pass: pass, detail: out });
})()
```

- [ ] **Step 2: Run it**

Run: `timeout 90 node_modules/.bin/electron tools/probe_shell.js --probe=tools/probes/live-orb.js --wait=2600`
Expected: `RESULT: PASS` with detail showing `mode:"listening"`, `pillText:"listening"`, `dispatchPkt.dir:1`, `returnPkt.dir:-1`. If `speakEnergy` hovers just under 0.7, re-run once (offscreen rAF cadence); a persistent miss means `stepLive` isn't applying the speaking tier — debug, don't lower the threshold.

- [ ] **Step 3: Full suite (all 9 probes + node tests)**

Run the 8-probe loop PLUS `live-orb`, and `npm test`.
Expected: 9× `RESULT: PASS`; `npm test` fully green (the trailing python test needs the repo's `.venv` — if it fails for environment reasons unrelated to this change, report it explicitly rather than claiming green).

- [ ] **Step 4: Commit**

```bash
git add tools/probes/live-orb.js
git commit -m "test(orb): live-orb probe — listening chain, speaking pulse, packet directions"
```

---

## Self-Review (done at plan time)

- **Spec coverage:** §1 bug → Task 4 (single writer + `lwCapturing` input); §4 state model → Tasks 1/2; §5 packet rules → Tasks 1/3/5 (strict: only swarm/automation/camera emit); §7 contract → Tasks 2/3/4 (incl. legacy shape + ready handshake); §8 mapping → Task 1 (`SWARM_TO_ROSTER`, Orchestrator note, rate-limited); §9 audio → Task 4 (wake RMS, recVad RMS, Piper tap, LFO in Task 2); §10 errors → Tasks 1 (sweep/dedupe) & 4 (queue-until-ready, silence-safe tap); §11 testing → Tasks 1/6. **Stretch `active_subsystems` (RESEARCHER/MEMORY) is deliberately NOT in this plan** — spec marks it fast-follow.
- **Placeholders:** none; every step carries full code or an exact command + expected output.
- **Type consistency:** directive `{op,agent,id,ok,label}` identical in feed (Task 1), postTask (Task 4), driveTask (Task 3), probe (Task 6); state `{mode,text,level,levelSrc}` identical in feed/pump/deck; `NexusOrb` API used in Tasks 5–6 matches its Task 4 definition; `__deckProbe` shape matches between Tasks 2 and 6.
