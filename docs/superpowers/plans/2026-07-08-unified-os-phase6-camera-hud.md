# Unified OS Phase 6 — Camera & Multimodal HUD: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** The Persistent Viewfinder (monitor ↔ fullscreen choreography riding the shell's `camera`/`camera-full` focuses and the Phase 5 slot allocator) plus the Active Observer (ambient scene-watcher: frame-diff → one local-vision pass → one suggestion chip), with a visible watching state and mute.

**Architecture:** One `#cam-live` video element reparented between a new slot-allocated glass monitor and the existing `#cam-full` fullscreen surface — tracking/grabbing code keeps working by id. `renderer/scene-watcher.js` follows the house pattern: pure node-tested core (`frameDelta`, `createGate`, `parseSceneReply`, `suggestionFor`) + a `createWatcher` glue with injected `{video, grabFrame, classify, isBusy, onSuggest}`. Classification is a direct renderer fetch to local Ollama (fixed port 11434); suggestions render through a new `Shell.chip` (the action variant of the Phase 5 toast).

**Tech Stack:** Vanilla renderer JS · `node + assert` tests · offscreen-Electron probe harness (`canvas.captureStream()` fakes the webcam).

**Spec:** `docs/superpowers/specs/2026-07-08-unified-os-phase6-camera-hud.md`

## Global Constraints

- **No new npm dependencies.**
- **Never sweep-commit:** `git add` ONLY the files each task lists. **Do NOT touch** `main.js`, `preload.js`, `lib/cameraUi.js`, `lib/config.js`, `renderer/wakeword.js`, `tests/test-camera-ui.js`, `tests/test-grounding.js` (unrelated in-flight edits).
- **Focus/density contract (reducer, already shipped):** `camera → 0.55` (engine renders) · `camera-full → 0.98` (≥ .92 ⇒ engine throttles). No reducer changes.
- **Camera claim (verbatim):** `{id:'camera', priority:50, slots:['BR','TR','TL','BL']}`. Chip claim: `{id:'chip', priority:85, slots:['TR','TL','BR']}`.
- **Watcher numbers (verbatim):** sample `500ms` · downscale `64×48` · change `≥ .085` · stable `≤ .03` for `1000ms` · min interval `20000ms` · chip dwell `12000ms` · Ollama `http://127.0.0.1:11434/api/generate`, `options:{temperature:0, num_predict:6}`.
- Probe runs: `node_modules/.bin/electron tools/probe_shell.js --probe=tools/probes/<name>.js --wait=1800` → exit 0 + `RESULT: PASS`. Ignore the harness's one pre-existing deprecation warning. Do NOT run full `npm test`.
- In probes, set the page's live-stream flag with a **bare** `_liveStream = stream;` (top-level `let` binding — `window._liveStream` would be a different, dead slot).

---

### Task 1: Scene-watcher pure core

**Files:**
- Create: `renderer/scene-watcher.js`
- Create: `tests/test-scene-watcher.js`
- Modify: `package.json` (test chain)

**Interfaces:**
- Consumes: nothing (pure core; `createWatcher` takes injected deps).
- Produces: `window.SceneWatcher` + `module.exports` with `frameDelta(a,b)→0..1`, `createGate(opts)→{feed(delta,now)→'idle'|'changed'|'stabilizing'|'fire'|'cooldown'}`, `parseSceneReply(text)→scene|null`, `suggestionFor(scene)→{text,question}|null`, `createWatcher({video,grabFrame,classify,isBusy,onSuggest,onDisarm,sampleMs,size,gate})→{start,stop,muted,state}`.

- [ ] **Step 1: Write the failing test**

Create `tests/test-scene-watcher.js`:

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/test-scene-watcher.js`
Expected: FAIL — `Cannot find module '../renderer/scene-watcher'`.

- [ ] **Step 3: Write the module**

Create `renderer/scene-watcher.js`:

```js
// renderer/scene-watcher.js
// The ambient scene-watcher (spec D3 / Phase 6): cheap on-device frame-diff -> change gate
// -> ONE local-vision classification -> ONE suggestion. Pure, node-tested core up top
// (frameDelta / createGate / parseSceneReply / suggestionFor); createWatcher at the bottom
// is the only DOM-touching glue and takes every dependency injected, so tests and probes
// never need a webcam or a model. Dual-exported like the other shell cores.
(function (root) {
  'use strict';

  // Mean absolute grayscale difference, normalized 0..1. Conservative on bad input:
  // a missing/mismatched frame reads as "no change" (never a false suggestion).
  function frameDelta(a, b) {
    if (!a || !b || !a.length || a.length !== b.length) return 0;
    var sum = 0;
    for (var i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
    return sum / (a.length * 255);
  }

  // Change gate (event-driven, not per-frame): a big delta marks "changed"; once deltas
  // stay calm for stableMs (you held the object steady) it fires EXACTLY once, then a
  // minimum interval must pass before anything can fire again.
  function createGate(opts) {
    opts = opts || {};
    var changeThreshold = typeof opts.changeThreshold === 'number' ? opts.changeThreshold : 0.085;
    var stableThreshold = typeof opts.stableThreshold === 'number' ? opts.stableThreshold : 0.03;
    var stableMs = typeof opts.stableMs === 'number' ? opts.stableMs : 1000;
    var minIntervalMs = typeof opts.minIntervalMs === 'number' ? opts.minIntervalMs : 20000;

    var stabilizing = false;
    var stableStart = null;
    var lastFire = -Infinity;

    return {
      feed: function (delta, now) {
        if (now - lastFire < minIntervalMs) return 'cooldown';
        if (!stabilizing) {
          if (delta >= changeThreshold) { stabilizing = true; stableStart = null; return 'changed'; }
          return 'idle';
        }
        if (delta >= stableThreshold) { stableStart = null; return 'stabilizing'; } // still moving
        if (stableStart === null) { stableStart = now; return 'stabilizing'; }
        if (now - stableStart >= stableMs) {
          stabilizing = false; stableStart = null; lastFire = now;
          return 'fire';
        }
        return 'stabilizing';
      },
    };
  }

  // Strict one-word confidence gate: only an exact scene word passes; 'none', prose,
  // or anything chatty is rejected (a wrong "I see a bill" is worse than silence).
  var SCENES = ['document', 'bill', 'product', 'whiteboard'];
  function parseSceneReply(text) {
    var t = String(text == null ? '' : text).trim().toLowerCase();
    t = t.replace(/^["'`\s]+/, '').replace(/["'`.,!\s]+$/, '');
    return SCENES.indexOf(t) >= 0 ? t : null;
  }

  var SUGGEST = {
    bill: { text: 'I see a bill — scan & log it?', question: 'This is a bill or invoice. Read it and log the vendor, date, total amount, and due date.' },
    document: { text: 'I see a document — read it?', question: 'Read this document and summarize the key points.' },
    product: { text: 'I see a product — identify it?', question: 'Identify this product and tell me anything useful about it.' },
    whiteboard: { text: 'I see a whiteboard — transcribe it?', question: 'Transcribe the whiteboard contents into clean notes.' },
  };
  function suggestionFor(scene) { return SUGGEST[scene] || null; }

  // --------------------------------------------------------------------------
  // Glue. The only part that touches the DOM (an offscreen canvas + the video).
  // --------------------------------------------------------------------------
  function createWatcher(opts) {
    opts = opts || {};
    var video = opts.video;
    var grabFrame = opts.grabFrame;
    var classify = opts.classify;
    var isBusy = opts.isBusy || function () { return false; };
    var onSuggest = opts.onSuggest || function () {};
    var onDisarm = opts.onDisarm || function () {};
    var sampleMs = opts.sampleMs || 500;
    var size = opts.size || { w: 64, h: 48 };
    var gate = createGate(opts.gate);
    var canvas = null, prev = null, timer = null, inflight = false, dead = false, isMuted = false;

    function gray() {
      if (!video || !video.videoWidth) return null;
      if (!canvas) { canvas = document.createElement('canvas'); canvas.width = size.w; canvas.height = size.h; }
      var ctx = canvas.getContext('2d', { willReadFrequently: true });
      try { ctx.drawImage(video, 0, 0, size.w, size.h); } catch (_e) { return null; }
      var d;
      try { d = ctx.getImageData(0, 0, size.w, size.h).data; } catch (_e) { return null; }
      var g = new Array(size.w * size.h);
      for (var i = 0, j = 0; i < d.length; i += 4, j++) g[j] = (d[i] + d[i + 1] + d[i + 2]) / 3;
      return g;
    }

    function sample() {
      if (dead || isMuted || inflight) return;
      if (typeof document !== 'undefined' && document.hidden) return;
      if (isBusy()) { prev = null; return; } // don't diff across busy gaps
      var g = gray(); if (!g) return;
      if (prev && gate.feed(frameDelta(prev, g), Date.now()) === 'fire') fire();
      prev = g;
    }

    function fire() {
      inflight = true;
      Promise.resolve()
        .then(function () { return grabFrame(); })
        .then(function (frame) {
          return Promise.resolve(classify(frame)).then(function (reply) {
            var scene = parseSceneReply(reply);
            var s = scene && suggestionFor(scene);
            if (s) onSuggest({ scene: scene, frame: frame, text: s.text, question: s.question });
          });
        })
        .catch(function () {
          // Classification path broken (no model / network) -> disarm for this session.
          dead = true;
          try { onDisarm(); } catch (_e) {}
        })
        .then(function () { inflight = false; });
    }

    return {
      start: function () { dead = false; prev = null; if (!timer) timer = setInterval(sample, sampleMs); },
      stop: function () { if (timer) { clearInterval(timer); timer = null; } prev = null; },
      muted: function (m) { isMuted = !!m; if (isMuted) prev = null; },
      state: function () { return { running: !!timer, dead: dead, muted: isMuted, inflight: inflight }; },
    };
  }

  var api = { frameDelta: frameDelta, createGate: createGate, parseSceneReply: parseSceneReply, suggestionFor: suggestionFor, createWatcher: createWatcher, SCENES: SCENES };
  root.SceneWatcher = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node tests/test-scene-watcher.js`
Expected: `test-scene-watcher: OK`

- [ ] **Step 5: Wire into the suite**

In `package.json`, in the `"test"` script, insert `node tests/test-scene-watcher.js && ` immediately after `node tests/test-shell-slots.js && `.

- [ ] **Step 6: Commit**

```bash
git add renderer/scene-watcher.js tests/test-scene-watcher.js package.json
git commit -m "feat(camera): scene-watcher pure core — frame-diff gate + strict scene parse (Phase 6)"
```

---

### Task 2: `Shell.chip` — the action chip

**Files:**
- Create: `tools/probes/chip.js`
- Modify: `renderer/system-shell.js` (Shell.chip)
- Modify: `renderer/system-shell.css` (.shell-chip)

**Interfaces:**
- Consumes: `Slots.claim/release` (Phase 5), `.shell-toast` base look.
- Produces: `Shell.chip(text, {actions:[{label, fn}], ms=12000})` — claim id `'chip'`, priority 85, slots `['TR','TL','BR']`; any button click runs `fn` then releases; auto-release after `ms`; a new chip replaces the current one.

- [ ] **Step 1: Write the failing probe**

Create `tools/probes/chip.js`:

```js
(async function () {
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  await sleep(300);
  var out = {};
  out.api = !!(window.Shell && typeof window.Shell.chip === 'function');
  if (!out.api) return JSON.stringify({ pass: false, detail: out });

  var ran = { scan: 0 };
  window.Shell.chip('I see a bill — scan & log it?', {
    ms: 5000,
    actions: [{ label: 'Scan', fn: function () { ran.scan++; } }, { label: 'Dismiss' }],
  });
  await sleep(120);
  var c = document.querySelector('.shell-chip');
  out.exists = !!c;
  out.inTR = !!(c && c.parentElement && c.parentElement.id === 'slot-TR');
  out.text = c ? c.textContent : '';
  var btns = c ? c.querySelectorAll('.chip-btn') : [];
  out.buttons = btns.length;
  out.primaryFirst = !!(btns[0] && btns[0].classList.contains('primary') && /scan/i.test(btns[0].textContent));

  if (btns[0]) btns[0].click();
  await sleep(60);
  out.actionRan = ran.scan === 1;
  out.releasedAfterClick = !(c && c.parentElement && c.parentElement.classList &&
                             c.parentElement.classList.contains('slotzone'));

  // a new chip replaces the old and auto-expires
  window.Shell.chip('short chip', { ms: 1500, actions: [{ label: 'Ok' }] });
  await sleep(120);
  var c2 = document.querySelector('.shell-chip');
  out.reshown = !!(c2 && c2.parentElement && c2.parentElement.id === 'slot-TR' && /short chip/.test(c2.textContent));
  await sleep(1800);
  out.expired = !(c2 && c2.parentElement && c2.parentElement.classList &&
                  c2.parentElement.classList.contains('slotzone'));

  var pass = out.exists && out.inTR && /scan & log/i.test(out.text) && out.buttons === 2 &&
             out.primaryFirst && out.actionRan && out.releasedAfterClick && out.reshown && out.expired;
  return JSON.stringify({ pass: pass, detail: out });
})()
```

- [ ] **Step 2: Run the probe to verify it fails**

Run: `node_modules/.bin/electron tools/probe_shell.js --probe=tools/probes/chip.js --wait=1800`
Expected: `RESULT: FAIL` — `api:false`.

- [ ] **Step 3: Chip CSS**

In `renderer/system-shell.css`, append directly after the `.shell-toast` block (before the reduced-motion rule that follows it is fine — keep the chip rules together after `.shell-toast.show`):

```css
/* The action chip: a toast with buttons (Phase 6 scene suggestions). One at a time. */
.shell-chip{ display:flex; flex-direction:column; gap:8px; pointer-events:auto; }
.shell-chip .chip-actions{ display:flex; gap:8px; justify-content:flex-end; }
.shell-chip .chip-btn{ font-family:var(--mono); font-size:10px; letter-spacing:.08em;
  text-transform:uppercase; color:var(--ink); background:transparent;
  border:1px solid var(--hair); border-radius:8px; padding:5px 10px; cursor:pointer; }
.shell-chip .chip-btn:hover{ border-color:var(--dim); }
.shell-chip .chip-btn.primary{ color:var(--core);
  border-color:color-mix(in srgb, var(--core) 55%, transparent); }
```

- [ ] **Step 4: `Shell.chip` in system-shell.js**

Insert directly after the `function toast(text, opts) {…}` block (before `var Shell = {`):

```js
  // ---- Phase 6: the action chip — a toast with buttons (scene-watcher suggestions) ----
  // One at a time (spec D3: ONE high-confidence suggestion); a new chip replaces the old.
  var chipEl = null, chipTimer = null;
  function dismissChip() {
    if (chipTimer) { clearTimeout(chipTimer); chipTimer = null; }
    if (chipEl) chipEl.classList.remove('show');
    Slots.release('chip');
  }
  function chip(text, opts) {
    opts = opts || {};
    if (!chipEl) {
      chipEl = document.createElement('div');
      chipEl.className = 'shell-toast shell-chip glass';
      chipEl.setAttribute('role', 'status');
      chipEl.setAttribute('aria-live', 'polite');
    }
    chipEl.textContent = '';
    var msg = document.createElement('div');
    msg.className = 'chip-text';
    msg.textContent = String(text || '');
    chipEl.appendChild(msg);
    var row = document.createElement('div');
    row.className = 'chip-actions';
    (opts.actions || []).forEach(function (a, i) {
      if (!a || !a.label) return;
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip-btn' + (i === 0 ? ' primary' : '');
      b.textContent = a.label;
      b.addEventListener('click', function () {
        try { if (typeof a.fn === 'function') a.fn(); } catch (_e) {}
        dismissChip();
      });
      row.appendChild(b);
    });
    chipEl.appendChild(row);
    Slots.claim('chip', { priority: 85, slots: ['TR', 'TL', 'BR'], el: chipEl });
    requestAnimationFrame(function () { if (chipEl) chipEl.classList.add('show'); });
    if (chipTimer) clearTimeout(chipTimer);
    chipTimer = setTimeout(dismissChip, Math.max(1500, +opts.ms || 12000));
  }
```

Then add `chip: chip,` to the `Shell` object literal, directly under `toast: toast,`.

- [ ] **Step 5: Run the probe to verify it passes**

Run: `node_modules/.bin/electron tools/probe_shell.js --probe=tools/probes/chip.js --wait=1800`
Expected: `RESULT: PASS`.

- [ ] **Step 6: Regression + commit**

```bash
node_modules/.bin/electron tools/probe_shell.js --probe=tools/probes/toast.js --wait=1800
node_modules/.bin/electron tools/probe_shell.js --probe=tools/probes/slots.js --wait=1800
git add tools/probes/chip.js renderer/system-shell.js renderer/system-shell.css
git commit -m "feat(shell): Shell.chip — action chip for scene suggestions (Phase 6)"
```
Expected: both probes `RESULT: PASS` before committing.

---

### Task 3: The monitor + the camera choreography

**Files:**
- Create: `tools/probes/camera-hud.js`
- Modify: `renderer/index.html` (monitor markup + CSS, choreography fns, toggleCamera rewire, Esc, onCameraFocus, Exit button)

**Interfaces:**
- Consumes: `Shell.slots`, `Shell.setFocus`, reducer densities, `#cam-full`/`#cam-stage`/`#cam-live` (existing), `startTracking` (existing).
- Produces (window-global, used by buttons/probes/Task 4): `camEnterMonitor(stream)`, `expandCamera()`, `collapseCamera()`, `camExitMonitor()`, plus stubs `armSceneWatch()`/`stopSceneWatch()` (no-ops until Task 4 replaces them).

- [ ] **Step 1: Write the failing probe**

Create `tools/probes/camera-hud.js`:

```js
(async function () {
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  await sleep(300);
  var out = {};
  out.fns = ['camEnterMonitor', 'expandCamera', 'collapseCamera', 'camExitMonitor']
    .every(function (f) { return typeof window[f] === 'function'; });
  if (!out.fns) return JSON.stringify({ pass: false, detail: out });
  var root = document.documentElement;

  // fake webcam (offscreen harness has none)
  var cv = document.createElement('canvas'); cv.width = 320; cv.height = 180;
  cv.getContext('2d').fillRect(0, 0, 320, 180);
  var stream = cv.captureStream(5);
  _liveStream = stream; // top-level let binding — bare assignment reaches it

  camEnterMonitor(stream);
  await sleep(250);
  var mon = document.getElementById('cam-monitor');
  out.monShown = !!(mon && mon.style.display !== 'none');
  out.monInZone = !!(mon && mon.parentElement && mon.parentElement.classList.contains('slotzone'));
  out.monSlot = mon && mon.dataset.slot;                                        // BR
  out.focusMonitor = root.getAttribute('data-focus');                           // camera
  out.densityMonitor = root.style.getPropertyValue('--glass-density').trim();   // 0.55
  var live = document.getElementById('cam-live');
  out.liveInMonitor = !!(live && live.closest('#cam-monitor'));

  expandCamera();
  await sleep(250);
  out.focusFull = root.getAttribute('data-focus');                              // camera-full
  out.densityFull = root.style.getPropertyValue('--glass-density').trim();      // 0.98
  var full = document.getElementById('cam-full');
  out.fullShown = !!(full && full.style.display !== 'none');
  out.liveInStage = !!(live && live.closest('#cam-stage'));

  collapseCamera();
  await sleep(250);
  out.focusBack = root.getAttribute('data-focus');                              // camera
  out.fullHidden = !!(full && full.style.display === 'none');
  out.liveBackInMonitor = !!(live && live.closest('#cam-monitor'));

  camExitMonitor();
  await sleep(150);
  out.focusOrb = root.getAttribute('data-focus');                               // orb
  out.monHidden = !!(mon && mon.style.display === 'none');
  out.claimGone = !((window.Shell.slots.get().placements || {}).camera);
  var live2 = document.getElementById('cam-live');
  out.liveBackInStage = !!(live2 && live2.closest('#cam-stage'));

  try { stream.getTracks().forEach(function (t) { t.stop(); }); } catch (_e) {}
  _liveStream = null;

  var pass = out.monShown && out.monInZone && out.monSlot === 'BR' &&
             out.focusMonitor === 'camera' && out.densityMonitor === '0.55' &&
             out.liveInMonitor && out.focusFull === 'camera-full' && out.densityFull === '0.98' &&
             out.fullShown && out.liveInStage && out.focusBack === 'camera' && out.fullHidden &&
             out.liveBackInMonitor && out.focusOrb === 'orb' && out.monHidden && out.claimGone &&
             out.liveBackInStage;
  return JSON.stringify({ pass: pass, detail: out });
})()
```

- [ ] **Step 2: Run the probe to verify it fails**

Run: `node_modules/.bin/electron tools/probe_shell.js --probe=tools/probes/camera-hud.js --wait=1800`
Expected: `RESULT: FAIL` — `fns:false`.

- [ ] **Step 3: Monitor markup**

In `renderer/index.html`, directly before the `<!-- Fullscreen live camera (glass viewfinder) -->` comment, add:

```html
<!-- Camera monitor (Phase 6): the persistent viewfinder — a compact glass HUD anchored by
     the slot allocator; #cam-live is reparented here <-> #cam-stage (fullscreen). -->
<div id="cam-monitor" class="cam-monitor glass" style="display:none">
  <div class="cam-mon-head">
    <span id="watch-dot" class="watch-dot" title="Scene watching off"></span>
    <span class="cam-mon-label">CAM</span>
    <span style="flex:1"></span>
    <button id="cam-mon-mute" class="cam-mon-btn" onclick="toggleSceneWatch()" title="Mute scene watching">&#128065;</button>
    <button class="cam-mon-btn" onclick="expandCamera()" title="Fullscreen (precision)">&#x26F6;</button>
    <button class="cam-mon-btn" onclick="toggleCamera()" title="Close camera">&#10005;</button>
  </div>
  <div class="cam-mon-body" id="cam-mon-body" onclick="expandCamera()" title="Click for fullscreen"></div>
</div>
```

- [ ] **Step 4: Monitor CSS**

In `renderer/index.html`'s inline `<style>`, directly after the `.cam-relock` rules (after the line `@media (prefers-reduced-motion:reduce){#track-chip,.cam-relock{transition:none} #track-chip .tc-dot{animation:none}}`), add:

```css
/* ---- Camera monitor (Phase 6): the persistent viewfinder in a slot zone ---- */
.cam-monitor{ --e:2; width:300px; overflow:hidden; border-radius:12px; }
.cam-mon-head{ display:flex; align-items:center; gap:8px; padding:7px 10px;
  font-family:var(--mono); font-size:9px; letter-spacing:.18em; color:var(--dim);
  border-bottom:1px solid var(--hair); }
.cam-mon-btn{ background:transparent; border:0; color:var(--dim); font-size:12px;
  padding:2px 5px; cursor:pointer; line-height:1; }
.cam-mon-btn:hover{ color:var(--ink); }
.cam-mon-body{ height:168px; background:#000; cursor:pointer; display:flex;
  align-items:center; justify-content:center; }
.cam-mon-body video{ width:100%; height:100%; object-fit:cover; display:block; }
.watch-dot{ width:7px; height:7px; border-radius:50%; background:var(--faint); flex:none; }
.watch-dot.watching{ background:var(--core); box-shadow:0 0 8px var(--core);
  animation:campulse 2.2s ease-in-out infinite; }
.watch-dot.muted{ background:transparent; border:1px solid var(--dim); }
@media (prefers-reduced-motion:reduce){ .watch-dot.watching{ animation:none; } }
/* When the camera isn't the focus the monitor dims to 55% (situational awareness); hover
   restores. The allocator's .ghosted (35%, non-interactive) stays the stronger state. */
:root:not([data-focus="camera"]):not([data-focus="camera-full"]) .cam-monitor:not(.ghosted):not(:hover){ filter:opacity(.55); }
```

- [ ] **Step 5: The choreography functions**

In `renderer/index.html`, directly before `async function toggleCamera(){`, add:

```js
// ---- Phase 6: monitor <-> fullscreen choreography (spec §4.2). ONE #cam-live element is
// reparented between the monitor body and #cam-stage, so grabCameraFrame() and the tracker
// (both find it by id) keep working untouched. The element always returns to #cam-stage on
// exit so it stays connected (getElementById can't see detached nodes).
let _camMon = null;
function camMonEl(){ if(!_camMon) _camMon = document.getElementById('cam-monitor'); return _camMon; }
function camLiveEl(){
  return document.getElementById('cam-live') || (camMonEl() && camMonEl().querySelector('#cam-live')) || null;
}
// Scene-watcher stubs — Task 4 replaces these with the real wiring.
function armSceneWatch(){}
function stopSceneWatch(){}
function toggleSceneWatch(){}
function camEnterMonitor(stream){
  const mon = camMonEl(); const body = mon && mon.querySelector('#cam-mon-body');
  const v = camLiveEl();
  if(v && stream && v.srcObject !== stream){ v.srcObject = stream; try{ v.play(); }catch(_e){} }
  if(v && body && v.parentElement !== body) body.appendChild(v);
  if(mon) mon.style.display = 'block';
  if(window.Shell && Shell.slots) Shell.slots.claim('camera', { priority: 50, slots: ['BR','TR','TL','BL'], el: mon });
  if(window.Shell) Shell.setFocus('camera');
  armSceneWatch();
}
function expandCamera(){
  if(!_liveStream) return;
  const full = document.getElementById('cam-full'); const stage = document.getElementById('cam-stage');
  const v = camLiveEl();
  if(v && stage && v.parentElement !== stage) stage.insertBefore(v, stage.firstChild);
  if(full){ full.style.display = 'block'; requestAnimationFrame(function(){ full.classList.add('show'); }); }
  if(window.Shell) Shell.setFocus('camera-full');
}
function collapseCamera(){
  const full = document.getElementById('cam-full');
  if(full){ full.classList.remove('show'); full.style.display = 'none'; }
  const mon = camMonEl(); const body = mon && mon.querySelector('#cam-mon-body');
  const v = camLiveEl();
  if(v && body && v.parentElement !== body) body.appendChild(v);
  if(window.Shell) Shell.setFocus('camera');
}
function camExitMonitor(){
  stopSceneWatch();
  // #cam-live goes home to #cam-stage BEFORE the monitor detaches, so it stays findable.
  const stage = document.getElementById('cam-stage'); const v = camLiveEl();
  if(v && stage && v.parentElement !== stage) stage.insertBefore(v, stage.firstChild);
  const mon = camMonEl();
  if(mon) mon.style.display = 'none';
  if(window.Shell && Shell.slots) Shell.slots.release('camera');
  if(window.Shell && /^camera/.test(Shell.state.focus)) Shell.setFocus('orb');
}
```

- [ ] **Step 6: Rewire toggleCamera + Exit + Esc + tracking auto-expand**

(a) In `toggleCamera()`'s **open** branch, replace:

```js
    if(full){ full.style.display='block'; requestAnimationFrame(function(){ full.classList.add('show'); }); }
```

with:

```js
    camEnterMonitor(_liveStream);   // Phase 6: entry lands in monitor mode (spec §3.2)
```

(b) In `toggleCamera()`'s **close** branch, directly after the line
`if(full){ full.classList.remove('show'); full.style.display='none'; }`, add:

```js
    camExitMonitor();
```

(c) The `#cam-full` Exit button collapses to the monitor instead of closing. Replace:

```html
      <button onclick="toggleCamera()" title="Exit camera" class="cam-glass cam-btn">&#8592; Exit</button>
```

with:

```html
      <button onclick="collapseCamera()" title="Back to monitor" class="cam-glass cam-btn">&#8592; Monitor</button>
```

(d) Esc collapses fullscreen to monitor. Replace the settings Esc handler:

```js
document.addEventListener('keydown', function(e){
  if(e.key==='Escape' && ((window.Shell && Shell.state.focus==='settings') || document.getElementById('settings').classList.contains('open'))) closeSettings();
});
```

with:

```js
document.addEventListener('keydown', function(e){
  if(e.key!=='Escape') return;
  if(window.Shell && Shell.state.focus==='camera-full'){ collapseCamera(); return; }
  if((window.Shell && Shell.state.focus==='settings') || document.getElementById('settings').classList.contains('open')) closeSettings();
});
```

(e) Precision tasks auto-expand. Replace the `onCameraFocus` block:

```js
if(window.bridge && window.bridge.onCameraFocus){ window.bridge.onCameraFocus(function(p){
  const cf = document.getElementById('cam-full');
  if(cf && cf.style.display!=='none') startTracking(p);
}); }
```

with:

```js
if(window.bridge && window.bridge.onCameraFocus){ window.bridge.onCameraFocus(function(p){
  const cf = document.getElementById('cam-full');
  if(_liveStream && cf && cf.style.display==='none') expandCamera(); // precision task -> fullscreen (spec §3.5)
  if(cf && cf.style.display!=='none') startTracking(p);
}); }
```

- [ ] **Step 7: Run the probe to verify it passes**

Run: `node_modules/.bin/electron tools/probe_shell.js --probe=tools/probes/camera-hud.js --wait=1800`
Expected: `RESULT: PASS`.

- [ ] **Step 8: Regression + commit**

```bash
node tests/test-shell-reducer.js
for p in slots toast chip motion interaction dock; do
  r=$(timeout 90 node_modules/.bin/electron tools/probe_shell.js --probe=tools/probes/$p.js --wait=2600 2>/dev/null | grep -E '^RESULT:')
  printf '%-12s %s\n' "$p" "$r"
done
git add tools/probes/camera-hud.js renderer/index.html
git commit -m "feat(camera): persistent viewfinder — monitor mode + fullscreen choreography on the shell focuses (Phase 6)"
```
Expected: reducer OK + 6× `RESULT: PASS` before committing.

---

### Task 4: Arm the Active Observer (watcher wiring + privacy)

**Files:**
- Modify: `renderer/index.html` (script tag, real armSceneWatch/stopSceneWatch/toggleSceneWatch, watch-dot sync)
- Modify: `tools/probes/camera-hud.js` (watch-dot + mute assertions)

**Interfaces:**
- Consumes: `SceneWatcher.createWatcher` (Task 1), `Shell.chip` (Task 2), monitor + choreography (Task 3), existing `grabCameraFrame`, `lastStatus` (the ~1s status poll), `bridge.lookCamera`, `NexusOrb.taskBegin`.
- Produces: watcher armed while camera open + `lastStatus.vision_model` + `lastStatus.ollama_up` + not muted; `localStorage.sceneWatchMuted` persistence; `.watch-dot` truthful states.

- [ ] **Step 1: Load the module**

In `renderer/index.html` `<head>`, directly after `<script src="slot-allocator.js"></script>`:

```html
<script src="scene-watcher.js"></script>
```

- [ ] **Step 2: Replace the Task 3 stubs with the real wiring**

In `renderer/index.html`, replace:

```js
// Scene-watcher stubs — Task 4 replaces these with the real wiring.
function armSceneWatch(){}
function stopSceneWatch(){}
function toggleSceneWatch(){}
```

with:

```js
// ---- Phase 6: the ambient scene-watcher (spec D3) — the Active Observer ----
// Armed ONLY when a LOCAL vision model is live (status.vision_model is non-null only when
// vision resolves to the local engine) — the frame never leaves this machine. A pulsing
// --core dot is the honest "watching" tell; mute persists across sessions.
let _watcher = null;
function sceneWatchMuted(){ return localStorage.getItem('sceneWatchMuted') === '1'; }
function watchDotSync(){
  const d = document.getElementById('watch-dot'); if(!d) return;
  const st = _watcher && _watcher.state();
  const armed = !!(st && st.running && !st.dead);
  const muted = sceneWatchMuted();
  d.classList.toggle('watching', armed && !muted);
  d.classList.toggle('muted', muted);
  d.title = muted ? 'Scene watching muted' : (armed ? 'Watching for scenes (local vision)' : 'Scene watching off');
  const b = document.getElementById('cam-mon-mute'); if(b) b.title = muted ? 'Unmute scene watching' : 'Mute scene watching';
}
function toggleSceneWatch(){
  localStorage.setItem('sceneWatchMuted', sceneWatchMuted() ? '0' : '1');
  if(_watcher) _watcher.muted(sceneWatchMuted());
  watchDotSync();
}
// One quiet classification pass against the local Ollama vision model (fixed port 11434;
// its default origins allow file://). Any failure rejects -> the watcher disarms itself.
function classifyFrame(dataUrl){
  const model = lastStatus && lastStatus.vision_model;
  if(!model) return Promise.reject(new Error('no local vision'));
  const b64 = String(dataUrl).replace(/^data:image\/\w+;base64,/, '');
  return fetch('http://127.0.0.1:11434/api/generate', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: model,
      prompt: 'Look at this image. Answer with exactly one word - document, bill, product, whiteboard, or none. Which single word best describes the main subject?',
      images: [b64], stream: false, options: { temperature: 0, num_predict: 6 } })
  }).then(function(r){ if(!r.ok) throw new Error('ollama ' + r.status); return r.json(); })
    .then(function(j){ return (j && j.response) || ''; });
}
function armSceneWatch(){
  stopSceneWatch();
  if(!(window.SceneWatcher && lastStatus && lastStatus.vision_model && lastStatus.ollama_up)){ watchDotSync(); return; }
  _watcher = SceneWatcher.createWatcher({
    video: camLiveEl(), grabFrame: grabCameraFrame, classify: classifyFrame,
    isBusy: function(){
      return !!(typeof _trackTarget !== 'undefined' && _trackTarget) || recording ||
             !!(lastStatus && lastStatus.ai_status && lastStatus.ai_status !== 'idle');
    },
    onDisarm: watchDotSync,
    onSuggest: function(s){
      if(!window.Shell || !Shell.chip) return;
      Shell.chip(s.text, { ms: 12000, actions: [
        { label: 'Scan', fn: function(){
            try{ if(window.NexusOrb) NexusOrb.taskBegin('camera','VISION','scene suggest','ai-idle'); }catch(_e){}
            window.bridge.lookCamera(s.frame, s.question);
        } },
        { label: 'Dismiss' }
      ]});
    },
  });
  _watcher.muted(sceneWatchMuted());
  _watcher.start();
  watchDotSync();
}
function stopSceneWatch(){ if(_watcher){ _watcher.stop(); _watcher = null; } watchDotSync(); }
```

- [ ] **Step 3: Extend the camera-hud probe with watcher/privacy assertions**

In `tools/probes/camera-hud.js`, directly after the `out.liveInMonitor = …` line, insert:

```js
  // Watcher honesty: no local vision model in this harness -> the dot must NOT claim watching.
  var dot = document.getElementById('watch-dot');
  out.dotExists = !!dot;
  out.dotNotWatching = !!(dot && !dot.classList.contains('watching'));
  // Mute toggle persists + stamps the dot.
  localStorage.removeItem('sceneWatchMuted');
  toggleSceneWatch();
  out.mutedPersisted = localStorage.getItem('sceneWatchMuted') === '1';
  out.dotMuted = !!(dot && dot.classList.contains('muted'));
  toggleSceneWatch();
  out.unmuted = localStorage.getItem('sceneWatchMuted') === '0';
```

and extend the `pass` expression with:

```js
             out.dotExists && out.dotNotWatching && out.mutedPersisted && out.dotMuted && out.unmuted &&
```

(inserted as an additional line inside the existing `var pass = …` conjunction, before `out.liveBackInStage;`).

- [ ] **Step 4: Verify**

```bash
node tests/test-scene-watcher.js
node_modules/.bin/electron tools/probe_shell.js --probe=tools/probes/camera-hud.js --wait=1800
```
Expected: node OK; `RESULT: PASS` (fns exist for real now; dot honest; mute persists).

- [ ] **Step 5: Commit**

```bash
git add renderer/index.html tools/probes/camera-hud.js
git commit -m "feat(camera): ambient scene-watcher armed — local-vision chip suggestions + watching dot + mute (Phase 6)"
```

---

### Task 5: Full regression (verification only, no commit)

- [ ] **Step 1: Node suites**

```bash
node tests/test-shell-reducer.js && node tests/test-slot-allocator.js && node tests/test-shell-slots.js && node tests/test-scene-watcher.js && node tests/test-nexus-feed.js && node tests/test-kernel.js && node tests/test-overlay-card.js
```
Expected: all OK.

- [ ] **Step 2: The full probe deck (14 index + 4 satellite)**

```bash
for p in engine-l0 material dock transcript motion fallbacks interaction select live-orb settings-focus slots toast chip camera-hud; do
  r=$(timeout 90 node_modules/.bin/electron tools/probe_shell.js --probe=tools/probes/$p.js --wait=2600 2>/dev/null | grep -E '^RESULT:')
  printf '%-15s %s\n' "$p" "$r"
done
for f in overlay-card.html weather-board.html overlay.html mini-overlay.html; do
  r=$(timeout 60 node_modules/.bin/electron tools/probe_shell.js --file=$f --probe=tools/probes/satellite-material.js --wait=1800 2>/dev/null | grep -E '^RESULT:')
  printf '%-20s %s\n' "$f" "$r"
done
```
Expected: 14× `RESULT: PASS` + 4× `RESULT: PASS`.

- [ ] **Step 3: Manual spot-check (report to Farouk, not blocking)**

📷 → monitor rises BR over the pulled-back engine; switch to Chat → monitor dims, hover restores; ask for weather → monitor re-anchors/ghosts around the board; click the feed → fullscreen HD, engine rests; Esc → back to monitor; with local vision on, hold a bill steady → dot pulses → one chip → Scan → the reading lands in chat; 👁 → dot hollow, silence.

---

## Self-Review (done at plan time)

- **Spec coverage:** §3.1/§4.1 one-video reparenting → Task 3 Step 5 (`camLiveEl` + stage-home rule); §3.2 entry-in-monitor + full close → Task 3 Step 6a/6b; §3.3 focus choreography + throttle → probe asserts densities 0.55/0.98 (throttle rides the existing runtime `deckSetActive` path, already covered by `test-shell-reducer`); §3.4 non-clutter → claim `['BR','TR','TL','BL']` + dim-when-unfocused CSS (Task 3 Step 4); §3.5 auto-expand → Task 3 Step 6e; §3.6 pipeline numbers → Task 1 gate defaults + Task 4 `classifyFrame`; §3.7 chip → Task 2 (id/priority/slots per spec §4.4); §3.8 arming/privacy → Task 4 (armed condition, dot states, mute persistence, busy/hidden pauses, fail-disarm via onDisarm); §3.9 pure core → Task 1; §4.5 multimodal → Task 4 onSuggest (NexusOrb pulse + lookCamera).
- **Placeholder scan:** none — Task 3's watcher stubs are explicitly replaced by Task 4 Step 2 with full code (declared in both tasks' interface blocks).
- **Type consistency:** `createWatcher` option names (`video, grabFrame, classify, isBusy, onSuggest, onDisarm`) identical in Task 1 source and Task 4 call; `state()` shape `{running,dead,muted,inflight}` matches `watchDotSync`; `suggestionFor` `{text,question}` matches `onSuggest` usage (`s.text`, `s.question`, plus `s.frame` added by the glue); `Shell.chip(text,{actions,ms})` matches Task 2 source and probe; choreography fn names identical across markup `onclick`s, Task 3 JS, and the probe; `camLiveEl`/`camMonEl` used consistently.
- **Environment checks:** probes never call `getUserMedia` or Ollama (fake stream, no `vision_model` in the stub status); the bare `_liveStream = stream;` note is a Global Constraint so the probe reaches the page's `let` binding.
