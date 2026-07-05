# Camera Shell Redesign + Greeting (D1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the fullscreen camera overlay into a modern glass "viewfinder" that greets the user aloud and auto-starts listening on open, with a clean feed (no always-on boxes).

**Architecture:** Pure string helpers (`greetingLine`, `statusLabel`) live in a Node-tested `lib/cameraUi.js` and are exposed to the sandboxed renderer through `preload.js` (which has `require`). All UI change is in `renderer/index.html`'s `#cam-full` overlay: reskinned chrome + a `setCamStatus()` pill + a greeting→auto-listen open flow, and removal of the COCO-SSD detection layer. No main-process changes; greeting reuses `speak()`, listening reuses `startRecording()`, vision/capture untouched.

**Tech Stack:** Electron renderer (vanilla JS/CSS), `theme.css` accent, plain-node `assert` tests.

**Spec:** `docs/superpowers/specs/2026-07-05-camera-shell-redesign-design.md`
**Branch:** `camera-shell` (off `master`; independent of the weather-board PR).

## Global Constraints

- Glass + `theme.css` `--accent`; viewfinder chrome = accent targeting-bracket corners + faint rule-of-thirds grid + soft vignette. Win10 (`data-os="win10"`) → solid glass fallback. Honor `prefers-reduced-motion` (no pulse, instant show).
- Status states exactly: `idle|listening|looking|speaking|error` → labels `Idle` / `Listening…` / `Looking…` / `Speaking…` / `Camera error`; unknown → `Idle`.
- Greeting is persona/name-based; empty/default name → a generic line. Spoken via the existing `speak()`; then auto-`startRecording()` when TTS goes idle (`ttsActive()` false), with a ~6 s max-wait fallback.
- Guards: TTS off → greeting shows as caption, still auto-listen; mic denied → skip auto-listen, show "tap the mic to talk", pill stays `Idle`; closing the camera stops recording + cancels pending greeting/auto-listen.
- Remove the ambient detection layer (`ensureDetector`/`startFocusBoxes`/`stopFocusBoxes`/`drawBoxes` + the TF.js/COCO-SSD `loadScript` CDN calls). KEEP the empty `#cam-overlay` canvas element (D2 reuses it).
- Renderer cannot `require()`; use `preload.js` to expose the helpers. No new npm deps.
- Commits end with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`. Never commit `.claude/settings.local.json`.
- Node suite (this branch, master baseline): `node tests/test-engines.js && node tests/test-migrate.js && node tests/test-downloads.js && node tests/test-kernel.js && node tests/test-handlers.js && node tests/test-integration.js && node tests/test-overlay-card.js && node tests/test-camera-ui.js`.

---

### Task 1: `lib/cameraUi.js` pure helpers + preload bridge exposure

**Files:**
- Create: `lib/cameraUi.js`
- Create: `tests/test-camera-ui.js`
- Modify: `package.json` (add the test to `npm test`)
- Modify: `preload.js` (expose the two helpers on `window.bridge`)

**Interfaces:**
- Produces (Tasks 2–3 consume via the bridge): `greetingLine(name) -> string`, `statusLabel(state) -> string`. Bridge: `window.bridge.cameraGreeting(name) -> string`, `window.bridge.cameraStatus(state) -> string`.

- [ ] **Step 1: Write the failing test** — `tests/test-camera-ui.js`:

```js
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
```

- [ ] **Step 2: Run to verify it fails** — `node tests/test-camera-ui.js` → FAIL `Cannot find module '../lib/cameraUi'`.

- [ ] **Step 3: Implement** — `lib/cameraUi.js`:

```js
// lib/cameraUi.js
// Pure helpers for the camera shell (D1). No Electron/DOM: unit-tested under plain node and
// exposed to the sandboxed renderer through preload.js (window.bridge.cameraGreeting/Status).

// The default/placeholder assistant name; a real one produces a personalised greeting.
const DEFAULT_NAME = 'Caryl';

// Spoken greeting when camera mode opens. A real name personalises it; blank -> generic.
function greetingLine(name) {
  const n = String(name == null ? '' : name).trim();
  if (!n) return 'Hey — what are we looking at?';
  return n + ' here — what are we looking at?';
}

// Internal camera state -> the status-pill label shown in the top bar. Unknown -> Idle.
const STATUS = { idle: 'Idle', listening: 'Listening…', looking: 'Looking…', speaking: 'Speaking…', error: 'Camera error' };
function statusLabel(state) {
  return STATUS[String(state || '')] || 'Idle';
}

module.exports = { greetingLine, statusLabel, DEFAULT_NAME };
```

- [ ] **Step 4: Run to verify it passes** — `node tests/test-camera-ui.js` → `test-camera-ui: all assertions passed`.

- [ ] **Step 5: Expose on the bridge** — in `preload.js`, near the top add `const cameraUi = require('./lib/cameraUi');` and inside the `exposeInMainWorld('bridge', { ... })` object add:

```js
  // ----- Camera shell (D1): pure UI helpers, single-sourced from lib/cameraUi.js -----
  cameraGreeting: (name) => cameraUi.greetingLine(name),
  cameraStatus: (state) => cameraUi.statusLabel(state),
```

- [ ] **Step 6: Wire into `npm test`** — in `package.json`, append `&& node tests/test-camera-ui.js` to the `test` script (after `test-overlay-card.js`, before the `.venv` python invocation).

- [ ] **Step 7: Verify + commit**

Run: `node tests/test-camera-ui.js && node --check preload.js`
Then:
```bash
git add lib/cameraUi.js tests/test-camera-ui.js package.json preload.js
git commit -m "feat(camera): pure greeting/status helpers (lib/cameraUi.js) + preload bridge exposure"
```

---

### Task 2: Glass viewfinder redesign (`#cam-full`) + status pill; remove ambient boxes

**Files:**
- Modify: `renderer/index.html` (the `#cam-full` markup ~line 521, its inline styles, and the camera JS: remove the COCO-SSD block ~lines 1450–1502; add `setCamStatus`)

**Interfaces:**
- Consumes: `window.bridge.cameraStatus(state)` (Task 1). Existing: `toggleCamera`, `switchCamera`, `camSendInput`, `askAboutCamera`, `makeModelFromCamera`, `toggleRecording`, `getUserMedia`.
- Produces (Task 3 consumes): a global `setCamStatus(state)` that sets the pill text via `bridge.cameraStatus(state)` and toggles the listening-dot pulse; element ids `#cam-status`, `#cam-status-dot`, `#cam-name`.

- [ ] **Step 1: Rebuild the `#cam-full` overlay markup.** Replace the current `#cam-full` block with the glass viewfinder. Binding contract (ids/behaviors that Task 3 + existing code depend on): keep `#cam-live`, `#cam-overlay` (now empty), `#cam-pick`, `#cam-caption`, `#cam-input`, `#cam-mic`; add `#cam-name`, `#cam-status`, `#cam-status-dot`; keep the Exit / "What is this?" / "Make 3D" actions calling their existing handlers. Layers (all chrome `pointer-events:none` except controls):

```html
<!-- Fullscreen live camera (glass viewfinder) -->
<div id="cam-full" style="display:none;position:fixed;inset:0;z-index:9999;background:#05070c;flex-direction:column;overflow:hidden">
  <div id="cam-stage" style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center">
    <video id="cam-live" autoplay muted playsinline style="max-width:100vw;max-height:100vh;display:block"></video>
    <canvas id="cam-overlay" style="position:absolute;left:0;top:0;pointer-events:none"></canvas>
  </div>
  <!-- viewfinder chrome: bracket corners + thirds grid + vignette -->
  <div id="cam-vf" style="position:absolute;inset:0;pointer-events:none;z-index:2">
    <span class="vf-corner tl"></span><span class="vf-corner tr"></span><span class="vf-corner bl"></span><span class="vf-corner br"></span>
    <div class="vf-grid"></div><div class="vf-vignette"></div>
  </div>
  <!-- top bar -->
  <div class="cam-top" style="position:absolute;top:0;left:0;right:0;z-index:4;display:flex;align-items:center;justify-content:space-between;padding:14px 16px">
    <div class="cam-glass" style="display:flex;align-items:center;gap:9px">
      <span id="cam-status-dot" class="cam-dot"></span>
      <b id="cam-name">Caryl</b><span id="cam-status" style="opacity:.8">Idle</span>
    </div>
    <div style="display:flex;align-items:center;gap:9px">
      <select id="cam-pick" onchange="switchCamera()" class="cam-glass" style="display:none;max-width:190px"></select>
      <button onclick="toggleCamera()" class="cam-glass cam-btn" title="Exit camera">&#8592; Exit</button>
    </div>
  </div>
  <!-- caption -->
  <div id="cam-caption" class="cam-glass" style="position:absolute;bottom:104px;left:50%;transform:translateX(-50%);max-width:82%;text-align:center;z-index:4;display:none"></div>
  <!-- bottom cluster -->
  <div class="cam-bottom" style="position:absolute;bottom:0;left:0;right:0;z-index:4;display:flex;gap:9px;padding:18px 16px;justify-content:center;align-items:center">
    <input id="cam-input" placeholder="Ask about what you're showing…" onkeydown="if(event.key==='Enter')camSendInput()" class="cam-glass cam-field">
    <button id="cam-mic" onclick="toggleRecording()" class="cam-glass cam-btn cam-round" title="Talk">&#127908;</button>
    <button onclick="askAboutCamera()" class="cam-accent" title="Ask about this">What is this?</button>
    <button onclick="makeModelFromCamera()" class="cam-glass cam-btn" title="Build a 3D model">&#129513; Make 3D</button>
  </div>
</div>
```

- [ ] **Step 2: Add the viewfinder CSS** in the page `<style>`. Chrome uses `--accent`; glass degrades solid on Win10:

```css
.cam-glass{background:rgba(16,20,28,.5);border:1px solid rgba(255,255,255,.14);color:#fff;border-radius:12px;
  padding:9px 13px;font:inherit;font-size:13px;-webkit-backdrop-filter:blur(12px);backdrop-filter:blur(12px)}
html[data-os="win10"] .cam-glass{background:rgba(16,20,28,.92);-webkit-backdrop-filter:none;backdrop-filter:none}
.cam-btn{cursor:pointer} .cam-btn:hover{background:rgba(255,255,255,.12)}
.cam-round{width:48px;height:48px;border-radius:50%;font-size:18px;display:grid;place-items:center}
.cam-field{flex:0 1 420px;font-size:14px;padding:12px 16px;border-radius:24px;outline:none}
.cam-accent{background:var(--accent);border:none;color:#06121b;border-radius:24px;padding:12px 22px;font:inherit;font-size:14px;font-weight:600;cursor:pointer}
.cam-dot{width:9px;height:9px;border-radius:50%;background:var(--accent);box-shadow:0 0 10px var(--accent)}
#cam-full.listening .cam-dot{animation:campulse 1.3s ease-in-out infinite}
@keyframes campulse{0%,100%{opacity:1}50%{opacity:.35}}
.vf-corner{position:absolute;width:34px;height:34px;border:2px solid var(--accent);opacity:.8}
.vf-corner.tl{top:64px;left:20px;border-right:none;border-bottom:none}
.vf-corner.tr{top:64px;right:20px;border-left:none;border-bottom:none}
.vf-corner.bl{bottom:92px;left:20px;border-right:none;border-top:none}
.vf-corner.br{bottom:92px;right:20px;border-left:none;border-top:none}
.vf-grid{position:absolute;inset:64px 20px 92px 20px;
  background-image:linear-gradient(rgba(255,255,255,.08) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.08) 1px,transparent 1px);
  background-size:33.33% 33.33%,33.33% 33.33%}
.vf-vignette{position:absolute;inset:0;background:radial-gradient(ellipse at center,transparent 55%,rgba(0,0,0,.5) 100%)}
#cam-full{opacity:0;transform:scale(1.01);transition:opacity .2s ease,transform .2s ease}
#cam-full.show{opacity:1;transform:none}
@media (prefers-reduced-motion:reduce){#cam-full{transition:none} #cam-full.listening .cam-dot{animation:none}}
```

- [ ] **Step 3: Add `setCamStatus` + show/hide animation** in the camera JS. `setCamStatus(state)` sets the pill and toggles the `listening` class (drives the dot pulse); `toggleCamera` adds/removes `show`:

```js
function setCamStatus(state){
  const el=document.getElementById('cam-status'); if(el) el.textContent=(window.bridge&&window.bridge.cameraStatus)?window.bridge.cameraStatus(state):'Idle';
  const root=document.getElementById('cam-full'); if(root) root.classList.toggle('listening', state==='listening');
}
```

In `toggleCamera()`'s OPEN branch, after the stream starts and `v.play()`, add `const cf=document.getElementById('cam-full'); if(cf){ cf.style.display='flex'; requestAnimationFrame(function(){ cf.classList.add('show'); }); }` (replace the old plain `display` set). In the CLOSE branch, `const cf=document.getElementById('cam-full'); if(cf){ cf.classList.remove('show'); }` before hiding, and set `setCamStatus('idle')`. Also populate `#cam-name` from `bridge.status().assistant_name` on open (cache it).

- [ ] **Step 4: Remove the ambient detection layer.** Delete `ensureDetector`, `startFocusBoxes`, `stopFocusBoxes`, `drawBoxes`, `getAccentColor` (if only used by boxes), the `_cocoModel/_detectRAF/_detectBusy/_detectFailed` vars, the `loadScript` TF.js/COCO-SSD calls, and any `startFocusBoxes()/stopFocusBoxes()` invocations in `toggleCamera`/`switchCamera`. Leave `#cam-overlay` in the DOM (empty). Confirm no remaining reference to the deleted names.

- [ ] **Step 5: Verify**

Run:
```
node -e "const s=require('fs').readFileSync('renderer/index.html','utf8');const b=[...s.matchAll(/<script>([\s\S]*?)<\/script>/g)];b.forEach(m=>new Function(m[1]));['cam-status','vf-corner','setCamStatus','cam-name'].forEach(k=>{if(s.indexOf(k)<0)throw new Error('missing '+k)});['cocoSsd','startFocusBoxes','drawBoxes','ensureDetector'].forEach(k=>{if(s.indexOf(k)>=0)throw new Error('stale detection ref: '+k)});console.log('index.html ok, detection removed')"
```
Expected: `index.html ok, detection removed`. Also `node tests/test-camera-ui.js`.

- [ ] **Step 6: Commit**

```bash
git add renderer/index.html
git commit -m "feat(camera): glass viewfinder redesign (bracket corners, grid, status pill); remove ambient COCO-SSD boxes"
```

---

### Task 3: Greeting + auto-listen open flow

**Files:**
- Modify: `renderer/index.html` (camera open flow + a small greeting/auto-listen helper)

**Interfaces:**
- Consumes: `window.bridge.cameraGreeting(name)` (Task 1), `setCamStatus` (Task 2), existing `speak()`, `ttsActive()`, `startRecording()`, `stopRecording()`/`recording`, `bridge.status()`, `#cam-caption`.
- Produces: on camera open the assistant greets then auto-listens; on close it stops cleanly.

- [ ] **Step 1: Add the greeting/auto-listen helper.** New function called from `toggleCamera()`'s open branch (after `show` is added and `#cam-name` is set):

```js
let _camGreetTimer=null, _camAutoListen=false;
async function camGreetAndListen(){
  _camAutoListen=true;
  let name='Caryl';
  try{ const s=await window.bridge.status(); if(s&&s.assistant_name) name=s.assistant_name; }catch(e){}
  const nm=document.getElementById('cam-name'); if(nm) nm.textContent=name;
  const line=(window.bridge&&window.bridge.cameraGreeting)?window.bridge.cameraGreeting(name):'What are we looking at?';
  const cap=document.getElementById('cam-caption'); if(cap){ cap.textContent=line; cap.style.display='block'; }
  setCamStatus('speaking');
  try{ speak(line); }catch(e){}
  // Start listening once TTS goes idle (immediately if TTS is off/disabled), with a max wait.
  const started=Date.now();
  (function waitTts(){
    if(!_camAutoListen) return;                 // camera closed meanwhile
    const stillSpeaking = (function(){ try{ return ttsActive(); }catch(e){ return false; } })();
    if(stillSpeaking && Date.now()-started<6000){ _camGreetTimer=setTimeout(waitTts,180); return; }
    _camGreetTimer=null;
    if(!_camAutoListen) return;
    beginCamListen();
  })();
}
function beginCamListen(){
  setCamStatus('listening');
  try{ if(!recording) startRecording(); }
  catch(e){ setCamStatus('idle'); const cap=document.getElementById('cam-caption'); if(cap){ cap.textContent='Tap the mic to talk.'; cap.style.display='block'; } }
}
function camStopGreetListen(){
  _camAutoListen=false;
  if(_camGreetTimer){ clearTimeout(_camGreetTimer); _camGreetTimer=null; }
  try{ if(recording) stopRecording(); }catch(e){}
}
```

Note on mic-denied: `startRecording()` already surfaces its own permission failure; if it throws synchronously the catch shows the hint. If it fails async (getUserMedia rejects inside it), that path already exists — the pill just won't advance past `listening`; acceptable for D1 (documented). Do NOT add a second permission prompt.

- [ ] **Step 2: Wire open/close.** In `toggleCamera()` open branch, after the `show` class + name set, call `camGreetAndListen();`. In the close branch (and in the `onCameraClose` bridge handler path), call `camStopGreetListen();` and `setCamStatus('idle')` before hiding.

- [ ] **Step 3: Reflect looking/idle around vision.** Where a camera question is sent (`askAboutCamera` / `camSendInput` / the `onCameraCapture` frame grab), call `setCamStatus('looking')`; the existing answer/caption path should call `setCamStatus('idle')` when done (add it where the camera caption is set/cleared). Keep this minimal — one `looking` on send, back to `idle` on answer.

- [ ] **Step 4: Verify**

Run:
```
node -e "const s=require('fs').readFileSync('renderer/index.html','utf8');const b=[...s.matchAll(/<script>([\s\S]*?)<\/script>/g)];b.forEach(m=>new Function(m[1]));['camGreetAndListen','beginCamListen','camStopGreetListen','cameraGreeting'].forEach(k=>{if(s.indexOf(k)<0)throw new Error('missing '+k)});console.log('greeting flow present, parses')"
```
Expected: `greeting flow present, parses`. Also run `node tests/test-camera-ui.js`.

- [ ] **Step 5: Commit**

```bash
git add renderer/index.html
git commit -m "feat(camera): spoken persona greeting + auto-listen on open (TTS-off and mic-denied guarded); clean close"
```

---

### Task 4: Full-suite verification + manual gate

- [ ] **Step 1:** Full node suite (all print `... all assertions passed`):
```
node tests/test-engines.js && node tests/test-migrate.js && node tests/test-downloads.js && node tests/test-kernel.js && node tests/test-handlers.js && node tests/test-integration.js && node tests/test-overlay-card.js && node tests/test-camera-ui.js
```
- [ ] **Step 2: MANUAL GATE (human).** From a checkout WITH node_modules (root repo reset to `camera-shell`): open camera → glass viewfinder with bracket corners + grid + theme-accent chrome; assistant **speaks a greeting** then the pill flips to **Listening…** with the pulsing dot and the mic auto-starts; ask about an object → pill **Looking…** → answer + caption; camera switch (multi-cam) works; **Exit** stops the stream and mic cleanly (no lingering recording, no greeting on a closed camera). Variants: TTS off in Settings → greeting shows as caption, still auto-listens; deny mic → "tap the mic to talk", pill stays Idle; Win10 → solid glass. Feed is clean (no ambient boxes).
- [ ] **Step 3:** Spec `**Status:**` → `Implemented (D1).` Commit `docs: mark D1 camera shell spec implemented`.

---

## Self-review notes (done)

- Spec coverage: glass/viewfinder + theme + Win10 fallback + reduced-motion → T2; greeting+auto-listen + all guards → T3; clean feed / remove COCO-SSD (keep empty `#cam-overlay`) → T2 step 4; status states → T1/T2; pure helpers + tests + bridge → T1; in-main-window overlay preserved → T2; manual gate → T4.
- Type consistency: `greetingLine`/`statusLabel` (T1) ↔ `bridge.cameraGreeting`/`cameraStatus` (T1) ↔ `setCamStatus`/`camGreetAndListen` (T2/T3). Status strings match the spec table exactly.
- Deviation: helpers exposed via preload bridge rather than duplicated inline (spec allowed either; bridge is single-source). Frontend HTML/CSS is given as a binding structural contract + near-complete styles; final pixel polish is implementation + the T4 manual gate (a visual redesign can't be unit-tested here).
