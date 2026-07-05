# Camera Object Focus (D2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Voice command "focus on the object in my hand" makes the AI ground that object via the vision model and draw a one-shot labeled targeting box on the live feed (+ spoken confirmation), with an honest no-box fallback.

**Architecture:** Two pure helpers in `lib/grounding.js` (`parseGroundingBox` normalizes the model's box output; `mapBoxToCanvas` handles letterbox scaling) — both node-tested. A `groundObject()` shell in main.js runs the vision call and a new `focus_object` action drives it; on success it sends `camera:focus {box,label}` to the renderer, which draws on D1's reserved `#cam-overlay`.

**Tech Stack:** Electron, vanilla JS/CSS, OpenAI-compatible vision (`streamChat`/`visionCfg`), plain-node `assert` tests.

**Spec:** `docs/superpowers/specs/2026-07-05-camera-object-focus-design.md`
**Branch:** `camera-focus` (off master; D1 shipped).

## Global Constraints

- Box normalized `[x1,y1,x2,y2]`, 0–1, top-left origin, x1&lt;x2 / y1&lt;y2, clamped to [0,1]; zero/degenerate area (either side &lt; 0.005) → `found:false`.
- Grounding output is untrusted text: `parseGroundingBox` must never throw and must return `{found:false}` on any malformed/junk/empty input. Handles: fenced/prose-wrapped JSON, `found:false`, named keys (`x1..`/`xmin..`/`left,top,right,bottom`), `box`/`bbox`/`boundingBox` arrays as `[x1,y1,x2,y2]`, `box_2d` array as Gemini order `[ymin,xmin,ymax,xmax]`, and scale: values &gt;1 divided by `imgDims` when provided else by 1000.
- One-shot lock: box held ~5000 ms then cleared; a new lock resets the timer; camera close clears it.
- On grounding `found:false`: one retry on a **fresh** frame; if still not found, speak "I can't quite pinpoint that — can you hold it up clearly?" and draw NO box. Never a guessed box.
- On success: `speak("Locked on the " + label + ".")` (or a generic "Locked on it." if label empty) + labeled box.
- `focus_object` only acts when the camera is open; otherwise fall through harmlessly.
- No new npm deps. Renderer can't `require()` — the pure helpers reach it via `preload.js`.
- Commits end `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`. Never commit `.claude/settings.local.json`.
- Node suite: `node tests/test-engines.js && node tests/test-migrate.js && node tests/test-downloads.js && node tests/test-kernel.js && node tests/test-handlers.js && node tests/test-integration.js && node tests/test-overlay-card.js && node tests/test-camera-ui.js && node tests/test-grounding.js`.

---

### Task 1: `lib/grounding.js` pure helpers + preload exposure

**Files:**
- Create: `lib/grounding.js`, `tests/test-grounding.js`
- Modify: `package.json` (add to `npm test`), `preload.js` (expose `mapBoxToCanvas` for the renderer)

**Interfaces:**
- Produces: `parseGroundingBox(raw, imgDims?) -> { found, label?, box? }` (box normalized 0–1); `mapBoxToCanvas(box, video, canvas) -> { x, y, w, h }` (canvas px). Bridge: `window.bridge.mapBoxToCanvas(box, video, canvas)`.

- [ ] **Step 1: Write the failing test** — `tests/test-grounding.js`:

```js
// tests/test-grounding.js
// Pure tests for grounding-box parsing + letterbox mapping. Plain node + assert.
const assert = require('assert');
const g = require('../lib/grounding');

function approx(a, b, eps) { return Math.abs(a - b) <= (eps == null ? 1e-9 : eps); }

// --- parseGroundingBox: clean normalized JSON ---
let r = g.parseGroundingBox('{"found":true,"label":"coffee mug","box":[0.1,0.2,0.5,0.6]}');
assert.strictEqual(r.found, true);
assert.strictEqual(r.label, 'coffee mug');
assert.deepStrictEqual(r.box, [0.1, 0.2, 0.5, 0.6]);

// fenced + surrounding prose
r = g.parseGroundingBox('Sure! ```json\n{"found":true,"label":"pen","box":[0.2,0.2,0.4,0.5]}\n``` hope that helps');
assert.strictEqual(r.found, true);
assert.strictEqual(r.label, 'pen');

// found:false
assert.strictEqual(g.parseGroundingBox('{"found":false}').found, false);

// Gemini box_2d order [ymin,xmin,ymax,xmax] at 0..1000 -> reordered + scaled
r = g.parseGroundingBox('{"label":"cup","box_2d":[200,100,600,500]}');
assert.strictEqual(r.found, true);
assert.ok(approx(r.box[0], 0.1) && approx(r.box[1], 0.2) && approx(r.box[2], 0.5) && approx(r.box[3], 0.6), 'box_2d reordered x1,y1,x2,y2 and /1000');

// named xmin/ymin/xmax/ymax
r = g.parseGroundingBox('{"label":"book","xmin":0.1,"ymin":0.1,"xmax":0.3,"ymax":0.4}');
assert.deepStrictEqual(r.box, [0.1, 0.1, 0.3, 0.4]);

// left/top/right/bottom
r = g.parseGroundingBox('{"name":"phone","left":0.5,"top":0.5,"right":0.9,"bottom":0.8}');
assert.strictEqual(r.label, 'phone');
assert.deepStrictEqual(r.box, [0.5, 0.5, 0.9, 0.8]);

// values >1 with no imgDims -> /1000
r = g.parseGroundingBox('{"found":true,"label":"x","box":[100,200,500,600]}');
assert.ok(approx(r.box[0], 0.1) && approx(r.box[2], 0.5));

// pixel coords with imgDims
r = g.parseGroundingBox('{"found":true,"label":"x","box":[64,96,320,240]}', { w: 640, h: 480 });
assert.ok(approx(r.box[0], 0.1) && approx(r.box[1], 0.2) && approx(r.box[2], 0.5) && approx(r.box[3], 0.5));

// reversed corners get ordered; out-of-range clamped
r = g.parseGroundingBox('{"found":true,"label":"x","box":[0.6,0.6,0.2,0.2]}');
assert.deepStrictEqual(r.box, [0.2, 0.2, 0.6, 0.6]);
r = g.parseGroundingBox('{"found":true,"label":"x","box":[-0.2,-0.1,1.4,1.2]}');
assert.deepStrictEqual(r.box, [0, 0, 1, 1]);

// degenerate / zero-area -> not found
assert.strictEqual(g.parseGroundingBox('{"found":true,"label":"x","box":[0.5,0.5,0.5,0.5]}').found, false);

// junk / empty / non-json -> not found, never throws
assert.strictEqual(g.parseGroundingBox('I could not find it').found, false);
assert.strictEqual(g.parseGroundingBox('').found, false);
assert.strictEqual(g.parseGroundingBox(null).found, false);
assert.strictEqual(g.parseGroundingBox('{"box":"nope"}').found, false);
assert.strictEqual(g.parseGroundingBox('{"box":[1,2,3]}').found, false, 'need 4 numbers');

// --- mapBoxToCanvas: letterbox math ---
// exact fit (no letterbox)
let m = g.mapBoxToCanvas([0.1, 0.2, 0.5, 0.6], { vw: 100, vh: 100 }, { cw: 100, ch: 100 });
assert.ok(approx(m.x, 10) && approx(m.y, 20) && approx(m.w, 40) && approx(m.h, 40));
// pillarbox: 100x100 video into 200x100 canvas -> centered, offsetX 50
m = g.mapBoxToCanvas([0, 0, 1, 1], { vw: 100, vh: 100 }, { cw: 200, ch: 100 });
assert.ok(approx(m.x, 50) && approx(m.y, 0) && approx(m.w, 100) && approx(m.h, 100));
// letterbox: 100x100 into 100x200 -> offsetY 50
m = g.mapBoxToCanvas([0, 0, 1, 1], { vw: 100, vh: 100 }, { cw: 100, ch: 200 });
assert.ok(approx(m.x, 0) && approx(m.y, 50) && approx(m.w, 100) && approx(m.h, 100));
// degenerate video dims -> zeros, no NaN
m = g.mapBoxToCanvas([0, 0, 1, 1], { vw: 0, vh: 0 }, { cw: 100, ch: 100 });
assert.ok(isFinite(m.x) && isFinite(m.w));

console.log('test-grounding: all assertions passed');
```

- [ ] **Step 2: Run to verify it fails** — `node tests/test-grounding.js` → FAIL `Cannot find module '../lib/grounding'`.

- [ ] **Step 3: Implement** — `lib/grounding.js`:

```js
// lib/grounding.js
// Pure helpers for camera object focus (D2). No Electron/DOM: node-tested and exposed to the
// renderer via preload.js. parseGroundingBox turns an untrusted vision answer into a
// normalized box (or found:false); mapBoxToCanvas maps that box onto the letterboxed video.

function toNum(v) { const n = Number(v); return isFinite(n) ? n : null; }

// Pull the first balanced JSON object out of a raw model answer (may be fenced / prose-wrapped).
function extractJson(raw) {
  const s = String(raw == null ? '' : raw);
  const start = s.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < s.length; i++) {
    if (s[i] === '{') depth++;
    else if (s[i] === '}') { depth--; if (depth === 0) { try { return JSON.parse(s.slice(start, i + 1)); } catch (_e) { return null; } } }
  }
  return null;
}

// Extract 4 corner numbers in [x1,y1,x2,y2] source order using key/shape heuristics, or null.
function fourFrom(obj) {
  const n = toNum, h = (k) => obj[k] !== undefined;
  if (h('x1') && h('y1') && h('x2') && h('y2')) return [n(obj.x1), n(obj.y1), n(obj.x2), n(obj.y2)];
  if (h('xmin') && h('ymin') && h('xmax') && h('ymax')) return [n(obj.xmin), n(obj.ymin), n(obj.xmax), n(obj.ymax)];
  if (h('left') && h('top') && h('right') && h('bottom')) return [n(obj.left), n(obj.top), n(obj.right), n(obj.bottom)];
  if (Array.isArray(obj.box_2d) && obj.box_2d.length >= 4) { const b = obj.box_2d.map(n); return [b[1], b[0], b[3], b[2]]; } // Gemini [ymin,xmin,ymax,xmax]
  const arr = Array.isArray(obj.box) ? obj.box : Array.isArray(obj.bbox) ? obj.bbox : Array.isArray(obj.boundingBox) ? obj.boundingBox : null;
  if (arr && arr.length >= 4) { const b = arr.map(n); return [b[0], b[1], b[2], b[3]]; }
  return null;
}

function parseGroundingBox(raw, imgDims) {
  const obj = extractJson(raw);
  if (!obj || typeof obj !== 'object') return { found: false };
  if (obj.found === false) return { found: false };
  const four = fourFrom(obj);
  if (!four || four.some((v) => v == null)) return { found: false };
  let [x1, y1, x2, y2] = four;
  const maxv = Math.max(x1, y1, x2, y2);
  if (maxv > 1) {
    if (imgDims && imgDims.w > 0 && imgDims.h > 0) { x1 /= imgDims.w; x2 /= imgDims.w; y1 /= imgDims.h; y2 /= imgDims.h; }
    else { x1 /= 1000; y1 /= 1000; x2 /= 1000; y2 /= 1000; }
  }
  const clamp = (v) => Math.max(0, Math.min(1, v));
  const bx1 = clamp(Math.min(x1, x2)), bx2 = clamp(Math.max(x1, x2));
  const by1 = clamp(Math.min(y1, y2)), by2 = clamp(Math.max(y1, y2));
  if (bx2 - bx1 < 0.005 || by2 - by1 < 0.005) return { found: false };
  const label = String(obj.label || obj.name || obj.object || obj.class || '').trim();
  return { found: true, label, box: [bx1, by1, bx2, by2] };
}

// Normalized box + native video dims + displayed-canvas dims -> pixel rect, accounting for
// object-fit: contain letterboxing (video centered in the canvas/stage).
function mapBoxToCanvas(box, video, canvas) {
  const b = Array.isArray(box) ? box : [0, 0, 0, 0];
  const vw = (video && video.vw) || 0, vh = (video && video.vh) || 0;
  const cw = (canvas && canvas.cw) || 0, ch = (canvas && canvas.ch) || 0;
  if (vw <= 0 || vh <= 0 || cw <= 0 || ch <= 0) return { x: 0, y: 0, w: 0, h: 0 };
  const scale = Math.min(cw / vw, ch / vh);
  const dispW = vw * scale, dispH = vh * scale;
  const offX = (cw - dispW) / 2, offY = (ch - dispH) / 2;
  return { x: offX + b[0] * dispW, y: offY + b[1] * dispH, w: (b[2] - b[0]) * dispW, h: (b[3] - b[1]) * dispH };
}

module.exports = { parseGroundingBox, mapBoxToCanvas };
```

- [ ] **Step 4: Run to verify it passes** — `node tests/test-grounding.js` → `test-grounding: all assertions passed`.

- [ ] **Step 5: Expose `mapBoxToCanvas` on the bridge** — in `preload.js`, add near the top `const grounding = require('./lib/grounding');` and inside the bridge object (near the camera helpers):

```js
  // ----- Camera object focus (D2): letterbox box mapping from lib/grounding.js -----
  mapBoxToCanvas: (box, video, canvas) => grounding.mapBoxToCanvas(box, video, canvas),
```

- [ ] **Step 6: Wire into `npm test`** — append `&& node tests/test-grounding.js` after `test-camera-ui.js` in `package.json`.

- [ ] **Step 7: Verify + commit**

Run: `node tests/test-grounding.js && node --check preload.js`
```bash
git add lib/grounding.js tests/test-grounding.js package.json preload.js
git commit -m "feat(camera): pure grounding-box parser + letterbox mapper (lib/grounding.js) + preload"
```

---

### Task 2: `groundObject()` + `focus_object` action in main.js

**Files:**
- Modify: `main.js` (a `groundObject` helper near `describeObjectForModel`; a `focus_object` branch in the `ui:sendText` action chain near `see_camera`; the action-protocol capability line)

**Interfaces:**
- Consumes: `lib/grounding.js` `parseGroundingBox` (required at top of main.js); existing `visionCfg`, `streamChat`, `requestCameraFrame`, `speak`, `setCamStatus` is renderer-only (do NOT call it from main; use the status via the renderer). `mainWindow.webContents.send`.
- Produces: on a `focus_object` action, sends `camera:focus { box:[x1,y1,x2,y2], label }` to the renderer (Task 3 draws it); speaks the confirmation or the fallback.

- [ ] **Step 1: Require the parser** — at the top of main.js where other `lib/` modules are required, add `const { parseGroundingBox } = require('./lib/kernel');`? No — `require('./lib/grounding')`:

```js
const { parseGroundingBox } = require('./lib/grounding');
```

- [ ] **Step 2: Add `groundObject`** near `describeObjectForModel` (it mirrors that one-shot vision-call pattern):

```js
// Ask the vision model to LOCATE a described object and return a normalized bounding box.
// Returns { found, label?, box? } via parseGroundingBox. One call; the caller may retry.
async function groundObject(cfg, dataUrl, target) {
  const want = String(target || 'the main object').trim();
  const q =
    'Find this object in the image: "' + want + '".\n' +
    'Reply with ONLY a compact JSON object and nothing else:\n' +
    '{"found":true,"label":"<2-3 word name of the object>","box":[x1,y1,x2,y2]}\n' +
    'The box is the tight bounding box around that object, as fractions of the image ' +
    'from 0 to 1: x1,y1 = top-left corner, x2,y2 = bottom-right corner (x is left->right, ' +
    'y is top->bottom). If the object is not visible, reply exactly {"found":false}. ' +
    'No prose, no code fence.';
  const v = visionCfg(cfg);
  let raw = '';
  try {
    await streamChat({
      baseUrl: v.baseUrl, apiKey: v.apiKey, model: v.model, temperature: 0,
      messages: [{ role: 'user', content: [{ type: 'text', text: q }, { type: 'image_url', image_url: { url: dataUrl } }] }],
      signal: activeController ? activeController.signal : undefined,
      onToken: (d) => { raw += d; }
    });
  } catch (_e) { return { found: false }; }
  return parseGroundingBox(raw);
}
```

- [ ] **Step 3: Add the `focus_object` action branch** — in the `ui:sendText` action chain, right after the `see_camera` branch (main.js ~3912):

```js
      } else if (action.action === 'focus_object') {
        // Voice "focus on X": ground the object and draw a one-shot targeting box on the feed.
        const target = String(action.target || action.query || '').trim();
        activity.push({ kind: 'action', text: 'Focusing on ' + (target || 'that') + '…', time: clockTime() });
        aiStatus = 'working';
        let res = { found: false };
        let frame = await requestCameraFrame();
        if (frame) {
          res = await groundObject(cfg, frame, target);
          if (!res.found) { // one retry on a fresh frame
            frame = await requestCameraFrame();
            if (frame) res = await groundObject(cfg, frame, target);
          }
        }
        if (res.found) {
          if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('camera:focus', { box: res.box, label: res.label });
          const say = res.label ? ('Locked on the ' + res.label + '.') : 'Locked on it.';
          activity.push({ kind: 'said', text: say, time: clockTime() });
          mem().add('assistant', say);
          speak(say);
        } else {
          const say = 'I can’t quite pinpoint that — can you hold it up clearly?';
          activity.push({ kind: 'said', text: say, time: clockTime() });
          mem().add('assistant', say);
          speak(say);
        }
        aiStatus = 'idle';
```

- [ ] **Step 4: Add the capability line** — in the action-protocol prompt (near the `see_camera` line, main.js ~3673):

```js
    '{"action":"focus_object","target":"the object the user wants highlighted, e.g. the mug in my hand"}\n' +
```

and in the accompanying guidance text add a sentence: `Use focus_object when the user asks you to FOCUS ON, LOCK ONTO, HIGHLIGHT, POINT TO, or TRACK a specific object in the camera view; target is their description of it. It draws a targeting box. Use see_camera instead when they ask a question about the view.`

- [ ] **Step 5: Verify + commit**

Run: `node --check main.js && node tests/test-grounding.js`
```bash
git add main.js
git commit -m "feat(camera): focus_object action + groundObject vision call (one retry, honest fallback)"
```

---

### Task 3: `drawFocusBox` on `#cam-overlay` + preload bridge + clear-on-close

**Files:**
- Modify: `renderer/index.html` (a `drawFocusBox` + `clearFocusBox`, an `onCameraFocus` subscription, clear on camera close), `preload.js` (`onCameraFocus`)

**Interfaces:**
- Consumes: `window.bridge.mapBoxToCanvas` (Task 1), IPC `camera:focus` (Task 2). Existing `#cam-live`, `#cam-overlay`, `#cam-stage`, `--accent`, `esc`.
- Produces: draws the labeled targeting box; auto-clears after ~5 s and on camera close.

- [ ] **Step 1: preload `onCameraFocus`** — in `preload.js` bridge, near the other camera methods:

```js
  onCameraFocus: (cb) => ipcRenderer.on('camera:focus', (_e, payload) => cb(payload)),
```

- [ ] **Step 2: renderer draw + wiring** — add to the camera JS in `renderer/index.html`:

```js
// ---- One-shot focus targeting box (D2) on the reserved #cam-overlay canvas ----
let _focusTimer=null;
function clearFocusBox(){
  if(_focusTimer){ clearTimeout(_focusTimer); _focusTimer=null; }
  const c=document.getElementById('cam-overlay'); if(c){ try{ const x=c.getContext('2d'); x.clearRect(0,0,c.width,c.height); }catch(e){} }
}
function drawFocusBox(payload){
  const video=document.getElementById('cam-live'); const canvas=document.getElementById('cam-overlay'); const stage=document.getElementById('cam-stage');
  if(!video||!canvas||!stage||!payload||!Array.isArray(payload.box)) return;
  const cw=stage.clientWidth, ch=stage.clientHeight;
  if(canvas.width!==cw) canvas.width=cw; if(canvas.height!==ch) canvas.height=ch;
  canvas.style.width=cw+'px'; canvas.style.height=ch+'px';
  const m=(window.bridge&&window.bridge.mapBoxToCanvas)?window.bridge.mapBoxToCanvas(payload.box,{vw:video.videoWidth,vh:video.videoHeight},{cw:cw,ch:ch}):null;
  if(!m||m.w<=0) return;
  const ctx=canvas.getContext('2d'); ctx.clearRect(0,0,cw,ch);
  const accent=(function(){ try{ return getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()||'#7fd1ff'; }catch(e){ return '#7fd1ff'; } })();
  // dim outside the box slightly to draw the eye
  ctx.save(); ctx.fillStyle='rgba(0,0,0,.28)'; ctx.fillRect(0,0,cw,ch); ctx.clearRect(m.x,m.y,m.w,m.h); ctx.restore();
  // targeting rectangle + corner brackets
  ctx.strokeStyle=accent; ctx.lineWidth=Math.max(2,Math.round(cw/420)); ctx.strokeRect(m.x,m.y,m.w,m.h);
  const t=Math.max(14,Math.min(28,m.w*0.18)); ctx.lineWidth=Math.max(3,Math.round(cw/300));
  [[m.x,m.y,1,1],[m.x+m.w,m.y,-1,1],[m.x,m.y+m.h,1,-1],[m.x+m.w,m.y+m.h,-1,-1]].forEach(function(c){
    ctx.beginPath(); ctx.moveTo(c[0],c[1]+c[3]*t); ctx.lineTo(c[0],c[1]); ctx.lineTo(c[0]+c[2]*t,c[1]); ctx.stroke();
  });
  // label chip above the box
  const label=String(payload.label||'').trim();
  if(label){ ctx.font='600 14px system-ui,sans-serif'; const tw=ctx.measureText(label).width+16; const lx=m.x, ly=Math.max(0,m.y-26);
    ctx.fillStyle=accent; ctx.globalAlpha=.92; ctx.fillRect(lx,ly,tw,22); ctx.globalAlpha=1; ctx.fillStyle='#06121b'; ctx.fillText(label,lx+8,ly+16); }
  if(_focusTimer) clearTimeout(_focusTimer);
  _focusTimer=setTimeout(clearFocusBox,5000);
}
if(window.bridge && window.bridge.onCameraFocus){ window.bridge.onCameraFocus(function(p){
  const cf=document.getElementById('cam-full'); if(cf && cf.style.display!=='none') drawFocusBox(p);
}); }
```

- [ ] **Step 3: clear on close** — in `toggleCamera()`'s close branch (where it already stops the stream / calls `camStopGreetListen`), add `clearFocusBox();`.

- [ ] **Step 4: Verify**

Run:
```
node -e "const s=require('fs').readFileSync('renderer/index.html','utf8');const b=[...s.matchAll(/<script>([\s\S]*?)<\/script>/g)];b.forEach(m=>new Function(m[1]));['drawFocusBox','clearFocusBox','onCameraFocus','mapBoxToCanvas'].forEach(k=>{if(s.indexOf(k)<0)throw new Error('missing '+k)});console.log('focus box wired, parses')"
```
Expected: `focus box wired, parses`. Also `node tests/test-grounding.js`.

- [ ] **Step 5: Commit**

```bash
git add renderer/index.html preload.js
git commit -m "feat(camera): draw one-shot labeled targeting box on #cam-overlay (5s hold, clear on close)"
```

---

### Task 4: Full-suite verification + manual gate

- [ ] **Step 1:** Full node suite (all print `... all assertions passed`):
```
node tests/test-engines.js && node tests/test-migrate.js && node tests/test-downloads.js && node tests/test-kernel.js && node tests/test-handlers.js && node tests/test-integration.js && node tests/test-overlay-card.js && node tests/test-camera-ui.js && node tests/test-grounding.js
```
Plus `node --check main.js && node --check preload.js`.
- [ ] **Step 2: MANUAL GATE (human).** Root repo on `camera-focus`. Open camera, hold an object: say "focus on the &lt;thing&gt; in my hand" → a labeled accent targeting box locks onto it with the surround dimmed, and "Locked on the &lt;thing&gt;." is spoken; the box fades after ~5 s. Ask to focus on something not visible → honest "can't pinpoint that" spoken, no box, after a brief retry. Box clears on Exit. Try with the vision model set to Gemini and to Qwen-VL; note accuracy differences (expected). Confirm normal "what is this?" (see_camera) still works.
- [ ] **Step 3:** Spec `**Status:**` → `Implemented (D2).` Commit `docs: mark D2 camera object-focus spec implemented`.

---

## Self-review notes (done)

- Spec coverage: parseGroundingBox format-zoo + mapBoxToCanvas letterbox → T1; groundObject + focus_object action + retry + fallback + spoken confirm → T2; drawFocusBox labeled box on #cam-overlay + 5s hold + clear-on-close → T3; action-protocol line → T2; tests → T1 + manual gate T4.
- Type consistency: `parseGroundingBox`→`{found,label,box}` consumed by T2; `camera:focus {box,label}` sent by T2, consumed by T3's `onCameraFocus`; `mapBoxToCanvas(box,{vw,vh},{cw,ch})` (T1) called by T3 via the bridge with those exact keys.
- Renderer canvas sized to `#cam-stage` (full stage) so `mapBoxToCanvas`'s letterbox offset lands the box on the contained video. imgDims omitted in prod (parser uses the /1000 heuristic); tests cover both paths.
```
