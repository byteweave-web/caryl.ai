# Unified OS — Phase 1: Foundation (Implementation Plan)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the System Shell substrate — one shared glass material, the live engine promoted to a full-bleed background, and a single `--focus-depth` motion spine — then prove it by turning Chat from a tab into a floating layer with a real camera pull-back.

**Architecture:** A pure, DOM-free **shell reducer** (`renderer/shell-reducer.js`, node-testable) turns shell state into animated targets. A tiny **runtime** (`renderer/system-shell.js`) applies those targets to CSS custom properties; CSS `@property` eases them so the engine defocus + glass rise are GPU-cheap and declarative. All visuals live in one imported stylesheet (`renderer/system-shell.css`). Verified with an offscreen-Electron probe harness that asserts computed-style and hit-testing invariants on the real `index.html`.

**Tech Stack:** Electron 43 (Chromium — supports CSS `@property`/Houdini), vanilla renderer JS loaded via `<script>` tags (no bundler), plain `node + assert` unit tests, offscreen `BrowserWindow` probes (the existing `tools/shot_orb_tab.js` pattern).

## Global Constraints

- **Fully offline.** Zero external network requests. Fonts (IBM Plex Mono, IBM Plex Sans, Big Shoulders Display) are vendored under `renderer/vendor/fonts/` and referenced locally — never a CDN.
- **Canonical tokens (verbatim):** `--void:#05060B` · `--ink:#E8ECF4` · `--dim:#5A657D` · `--steel:#22304A` · `--core:#58C6FF` (the ONLY user-recolorable token) · `--good:#5AD19A` · `--warn:#E0B15A` · `--bad:#E9637B`.
- **Fonts:** `--mono:"IBM Plex Mono"` (data/chrome), `--disp:"Big Shoulders Display"` (numerals), `--read:"IBM Plex Sans"` (chat prose only).
- **Layer/z contract:** L0 engine `z:0` · L1 marginalia `z:10` · L2 focus `z:20` · L3 transient `z:30` · L4 veil `z:40`.
- **Dynamic Translucency ceilings:** chat `.62` · settings `.72` · camera `.55` · camera-full `.98`; occlusion threshold `.92` (≥ ⇒ engine may throttle).
- **Motion:** pull-back is `420ms cubic-bezier(.2,.8,.2,1)`; engine defocus = `scale → .92`, `blur → 6px`, `brightness → .6`.
- **Fallbacks:** `html[data-os="win10"]` ⇒ no `backdrop-filter` (opaque-gradient glass); `prefers-reduced-motion` ⇒ opacity-only, no scale/blur; `prefers-reduced-transparency` ⇒ solid fills; chromatic aberration off in all three.
- **The Nexus deck (`nexus-deck.html`) is a black box** — driven only by the existing `postMessage`/`driveState` + `deckSetActive` bridge. This phase does not edit it.
- Do **not** commit unrelated working-tree changes. Each task commits only its own files.

---

### Task 1: The shell reducer (pure state → animated targets)

**Files:**
- Create: `renderer/shell-reducer.js`
- Create: `tests/test-shell-reducer.js`
- Modify: `package.json` (add the test to the `test` script)

**Interfaces:**
- Consumes: nothing (pure, no imports).
- Produces: `window.ShellReducer` (browser global) **and** `module.exports` (node) with:
  - `deriveShell(state) → { focus, focusDepthTarget, glassDensityTarget, engineThrottle, marginaliaDim, zTop, reducedMotion }`
    - `state = { focus:'orb'|'chat'|'settings'|'camera'|'camera-full', coverage:0..1, power:'normal'|'saver', reducedMotion:bool, win10:bool }`
  - `FOCUS: string[]`, `Z: {engine,marginalia,focus,transient,veil}`, `DENSITY: object`, `OCCLUSION: 0.92`

- [ ] **Step 1: Write the failing test**

Create `tests/test-shell-reducer.js`:

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/test-shell-reducer.js`
Expected: FAIL — `Cannot find module '../renderer/shell-reducer'`.

- [ ] **Step 3: Write the reducer**

Create `renderer/shell-reducer.js`:

```js
// renderer/shell-reducer.js
// Pure, DOM-free derivation of the System Shell's animated targets from its state.
// Dual-exported: window.ShellReducer (renderer <script>) AND module.exports (node tests).
// Same input -> same output, no side effects. This is the "brain"; system-shell.js applies it.
(function (root) {
  'use strict';

  // 'orb' means "no focus layer up" — the Core itself is in focus.
  var FOCUS = ['orb', 'chat', 'settings', 'camera', 'camera-full'];

  // z-index bands (spec §4.1).
  var Z = { engine: 0, marginalia: 10, focus: 20, transient: 30, veil: 40 };

  // Per-surface Dynamic Translucency ceiling (spec §3.5).
  var DENSITY = { orb: 0, chat: 0.62, settings: 0.72, camera: 0.55, 'camera-full': 0.98 };

  var OCCLUSION = 0.92; // >= this, the engine is considered hidden and may be throttled.

  function clamp01(n) { n = +n; if (!(n > 0)) return 0; return n > 1 ? 1 : n; }

  function deriveShell(state) {
    state = state || {};
    var focus = FOCUS.indexOf(state.focus) >= 0 ? state.focus : 'orb';
    var atOrb = focus === 'orb';

    var focusDepthTarget = atOrb ? 0 : 1;

    // Density target: the surface ceiling, forced to occlusion when fully covering the
    // window or when on battery-saver (a parked layer lets the engine throttle).
    var ceiling = DENSITY[focus] || 0;
    var coverage = clamp01(state.coverage);
    var density = atOrb ? 0 : ceiling;
    if (!atOrb && coverage >= 1) density = 1;
    if (!atOrb && state.power === 'saver') density = Math.max(density, OCCLUSION);
    density = clamp01(density);

    return {
      focus: focus,
      focusDepthTarget: focusDepthTarget,
      glassDensityTarget: density,
      engineThrottle: density >= OCCLUSION,
      marginaliaDim: atOrb ? 1 : 0.5,
      zTop: atOrb ? Z.marginalia : Z.focus,
      reducedMotion: !!state.reducedMotion
    };
  }

  var api = { deriveShell: deriveShell, FOCUS: FOCUS, Z: Z, DENSITY: DENSITY, OCCLUSION: OCCLUSION };
  root.ShellReducer = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node tests/test-shell-reducer.js`
Expected: `test-shell-reducer: OK`

- [ ] **Step 5: Wire into the suite**

In `package.json`, add `test-shell-reducer.js` to the `test` script, immediately after `test-grounding.js`:

```
"test": "node tests/test-engines.js && node tests/test-migrate.js && node tests/test-downloads.js && node tests/test-kernel.js && node tests/test-handlers.js && node tests/test-integration.js && node tests/test-overlay-card.js && node tests/test-camera-ui.js && node tests/test-grounding.js && node tests/test-shell-reducer.js && node tests/test-ratelimit.js && node tests/test-mesh3d.js && .venv\\Scripts\\python.exe tests/test_automation.py",
```

- [ ] **Step 6: Commit**

```bash
git add renderer/shell-reducer.js tests/test-shell-reducer.js package.json
git commit -m "feat(shell): pure System Shell reducer (state -> animated targets) + tests"
```

---

### Task 2: The glass material + the offscreen probe harness

Builds `renderer/system-shell.css` (the shared material) and the reusable probe harness that every later task verifies against. The harness is folded into this task because this is the first task whose deliverable needs a computed-style check.

**Files:**
- Create: `renderer/system-shell.css`
- Create: `tools/_shell_probe_preload.js`
- Create: `tools/probe_shell.js`
- Create: `tools/probes/material.js`
- Modify: `renderer/index.html` (add `<link rel="stylesheet" href="system-shell.css">` in `<head>`, after the existing importmap/scripts block, before the inline `<style>` at line ~16 so tokens are available but the page's own rules can still override during migration)

**Interfaces:**
- Produces: a `.glass` class; `:root` custom properties `--void --ink --dim --steel --core --good --warn --bad --mono --disp --read --grid --gutter`; two registered animatable properties `--focus-depth` and `--glass-density` (via `@property`); `data-os="win10"` / reduced-motion / reduced-transparency fallback branches.
- Produces (harness): `npx electron tools/probe_shell.js --probe=tools/probes/<name>.js` → loads `renderer/index.html` offscreen, evaluates the probe (an IIFE returning `JSON.stringify({pass:boolean, detail:object})`), prints `detail`, exits `0` on pass / `1` on fail.

- [ ] **Step 1: Write the probe preload (stub bridge so the real renderer boots offscreen)**

Create `tools/_shell_probe_preload.js`:

```js
// Test-only preload for tools/probe_shell.js — NOT shipped.
// index.html's real preload exposes window.bridge/api over IPC; offscreen there is no
// backend, so stub every bridge/api member with a Proxy that is callable and returns a
// resolved promise. Lets the real renderer script run past its top-level IPC calls.
function autoApi() {
  return new Proxy(function () {}, {
    get: (_t, p) => (p === 'then' ? undefined : autoApi()),
    apply: () => Promise.resolve({}),
  });
}
for (const k of ['bridge', 'api', 'electron', 'electronAPI']) {
  try { window[k] = autoApi(); } catch (_) {}
}
```

- [ ] **Step 2: Write the reusable harness runner**

Create `tools/probe_shell.js`:

```js
// tools/probe_shell.js
// Offscreen-load renderer/index.html and run a probe file against it. A probe is an IIFE
// string returning JSON.stringify({pass, detail}). Exit 0 on pass, 1 on fail.
// Usage: npx electron tools/probe_shell.js --probe=tools/probes/material.js
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const arg = (k, d) => { const m = process.argv.find(a => a.startsWith(`--${k}=`)); return m ? m.split('=').slice(1).join('=') : d; };
const PROBE = path.resolve(arg('probe', ''));
const WAIT = parseInt(arg('wait', '1400'), 10);

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-web-security');

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false, width: 1080, height: 760,
    webPreferences: {
      offscreen: true, backgroundThrottling: false, webSecurity: false,
      contextIsolation: false, sandbox: false,
      preload: path.join(__dirname, '_shell_probe_preload.js'),
    },
  });
  win.webContents.on('console-message', (_e, _l, msg, line, src) => {
    if (/probe|shell|error/i.test(msg)) console.log(`[page] ${msg}${src ? ` (${path.basename(src)}:${line})` : ''}`);
  });

  const file = path.resolve(__dirname, '..', 'renderer', 'index.html');
  await win.loadURL('file://' + file.replace(/\\/g, '/'));
  await new Promise(r => setTimeout(r, WAIT));

  let out = { pass: false, detail: { error: 'probe threw' } };
  try {
    const body = fs.readFileSync(PROBE, 'utf8');
    const res = await win.webContents.executeJavaScript(body);
    out = JSON.parse(res);
  } catch (e) { out.detail = { error: String(e && e.message || e) }; }

  console.log('\n===== PROBE: ' + path.basename(PROBE) + ' =====');
  console.log(JSON.stringify(out.detail, null, 2));
  console.log('RESULT: ' + (out.pass ? 'PASS' : 'FAIL'));
  app.exit(out.pass ? 0 : 1);
});
```

- [ ] **Step 3: Write the failing material probe**

Create `tools/probes/material.js`:

```js
(function () {
  var cs = getComputedStyle(document.documentElement);
  var tok = function (n) { return cs.getPropertyValue(n).trim(); };

  // A .glass element to read the material off of.
  var el = document.createElement('div');
  el.className = 'glass';
  document.body.appendChild(el);
  var gs = getComputedStyle(el);

  var detail = {
    void: tok('--void'), core: tok('--core'), ink: tok('--ink'),
    mono: tok('--mono'), read: tok('--read'), disp: tok('--disp'),
    glassBg: gs.backgroundColor,
    glassBorder: gs.borderTopWidth + ' ' + gs.borderTopColor,
    backdrop: (gs.backdropFilter || gs.webkitBackdropFilter || ''),
    focusDepthInit: tok('--focus-depth'),
    glassDensityInit: tok('--glass-density'),
  };

  var pass =
    tok('--void').toLowerCase() === '#05060b' &&
    tok('--core').toLowerCase() === '#58c6ff' &&
    /IBM Plex Mono/.test(tok('--mono')) &&
    /IBM Plex Sans/.test(tok('--read')) &&
    /Big Shoulders/.test(tok('--disp')) &&
    parseFloat(gs.borderTopWidth) <= 1.5 &&                 // hairline, not a chunky border
    /blur\(/.test(gs.backdropFilter || gs.webkitBackdropFilter || '') && // frosted
    tok('--focus-depth') === '0' &&                          // registered @property, starts at rest
    tok('--glass-density') === '0';

  return JSON.stringify({ pass: pass, detail: detail });
})()
```

- [ ] **Step 4: Run the probe to verify it fails**

Run: `npx electron tools/probe_shell.js --probe=tools/probes/material.js`
Expected: `RESULT: FAIL` (no `system-shell.css` yet — tokens empty, `.glass` unstyled).

- [ ] **Step 5: Write the material stylesheet**

Create `renderer/system-shell.css`:

```css
/* renderer/system-shell.css
   The single shared material of the Unified OS. Imported by EVERY window/file so every
   surface is literally cut from the same glass. Deep-space, hairlines, grain, subtle
   chromatic aberration. Tokens promoted from the Nexus deck to canonical (spec §3). */

:root{
  --void:#05060B; --ink:#E8ECF4; --dim:#5A657D; --steel:#22304A;
  --core:#58C6FF;                       /* the ONLY user-recolorable token */
  --good:#5AD19A; --warn:#E0B15A; --bad:#E9637B;
  --mono:"IBM Plex Mono", ui-monospace, Consolas, monospace;
  --disp:"Big Shoulders Display", "Arial Narrow", system-ui, sans-serif;
  --read:"IBM Plex Sans", system-ui, -apple-system, Segoe UI, sans-serif;
  --grid:8px;                           /* 8pt base */
  --gutter:30px;                        /* HUD marginalia inset (matches the deck) */
  --hair:rgba(255,255,255,.06);         /* hairline, not a border */
  --hair-lit:rgba(255,255,255,.05);     /* inset top highlight */
}

/* Animatable custom properties — Chromium @property (Electron 43). These make the whole
   camera pull-back declarative: the runtime sets a target, CSS eases it, calc() consumers
   (engine transform, glass alpha) update for free. */
@property --focus-depth  { syntax:'<number>'; inherits:true; initial-value:0; }
@property --glass-density{ syntax:'<number>'; inherits:true; initial-value:0; }

:root{ --focus-depth:0; --glass-density:0; }

/* Ease the spine. 420ms cubic-bezier(.2,.8,.2,1) is THE motion of the OS (spec §5). */
:root{ transition:--focus-depth 420ms cubic-bezier(.2,.8,.2,1),
                  --glass-density 420ms cubic-bezier(.2,.8,.2,1); }

/* ---- the glass material: one class, elevation via --e (1..3) ---- */
.glass{
  --e:2;
  position:relative;
  background:rgba(12,16,26, calc(.42 + .34*var(--glass-density)));  /* Dynamic Translucency */
  border:1px solid var(--hair);
  box-shadow:0 calc(6px*var(--e)) calc(24px*var(--e)) rgba(0,0,0,.45),
             inset 0 1px 0 var(--hair-lit);
  -webkit-backdrop-filter:blur(22px) saturate(1.3);
  backdrop-filter:blur(22px) saturate(1.3);
  border-radius:14px;
}
/* grain: a tiny tiled noise data-URI at ~3%, overlay blend, so glass has tooth */
.glass::after{
  content:""; position:absolute; inset:0; border-radius:inherit; pointer-events:none;
  opacity:.03; mix-blend-mode:overlay;
  background-image:url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='120' height='120'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2'/></filter><rect width='120' height='120' filter='url(%23n)'/></svg>");
  background-size:120px 120px;
}

/* subtle chromatic aberration utility (spec §3.4) — near-subliminal RGB split */
.ca{ text-shadow:.4px 0 0 rgba(88,198,255,.35), -.4px 0 0 rgba(233,99,123,.28); }

/* ---- fallback matrix (spec §11) — one policy, here ---- */
html[data-os="win10"] .glass{                    /* no backdrop-filter on Win10 */
  -webkit-backdrop-filter:none; backdrop-filter:none;
  background:linear-gradient(180deg, rgba(18,24,36,.94), rgba(10,14,22,.96));
}
html[data-os="win10"] .ca{ text-shadow:none; }
@media (prefers-reduced-transparency: reduce){
  .glass{ -webkit-backdrop-filter:none; backdrop-filter:none; background:rgba(10,13,20,.98); }
  .ca{ text-shadow:none; }
}
@media (prefers-reduced-motion: reduce){
  :root{ transition:none; }                       /* opacity-only motion is applied per-layer */
  .ca{ text-shadow:none; }
}
```

- [ ] **Step 6: Link the stylesheet into index.html**

In `renderer/index.html`, add this line in `<head>` immediately before the opening inline `<style>` (~line 16):

```html
<link rel="stylesheet" href="system-shell.css">
```

- [ ] **Step 7: Run the probe to verify it passes**

Run: `npx electron tools/probe_shell.js --probe=tools/probes/material.js`
Expected: `RESULT: PASS` (tokens resolve; `.glass` is a frosted hairline surface; `--focus-depth`/`--glass-density` register at `0`).

- [ ] **Step 8: Commit**

```bash
git add renderer/system-shell.css tools/_shell_probe_preload.js tools/probe_shell.js tools/probes/material.js renderer/index.html
git commit -m "feat(shell): system-shell.css glass material + offscreen probe harness"
```

---

### Task 3: Promote the engine to a full-bleed L0 background

Move the Nexus deck iframe out of the Orb *tab* and make it the persistent background of the whole app, behind a focus-depth-driven defocus. The "Orb view" becomes simply "no focus layer up."

**Files:**
- Modify: `renderer/index.html` — relocate `#orb-deck`; add engine defocus CSS; keep `#view-orb`'s meta caption as marginalia.
- Create: `tools/probes/engine-l0.js`

**Interfaces:**
- Consumes: `.glass`, `--focus-depth` from Task 2.
- Produces: `#orb-deck` as a fixed, full-viewport, `z:0` element present at all times; a `.engine` wrapper whose transform/filter read `--focus-depth`.

- [ ] **Step 1: Write the failing probe**

Create `tools/probes/engine-l0.js`:

```js
(function () {
  var deck = document.getElementById('orb-deck');
  var vw = window.innerWidth, vh = window.innerHeight;
  var detail = { hasDeck: !!deck };
  if (!deck) return JSON.stringify({ pass: false, detail: detail });

  var r = deck.getBoundingClientRect();
  var cs = getComputedStyle(deck);
  var wrap = deck.closest('.engine') || deck.parentElement;
  var wcs = getComputedStyle(wrap);

  detail.rect = { w: Math.round(r.width), h: Math.round(r.height) };
  detail.zIndex = wcs.zIndex || cs.zIndex;
  detail.position = wcs.position;

  // Full-bleed: covers (near) the whole viewport.
  var fullBleed = r.width >= vw - 2 && r.height >= vh - 2;
  // Behind focus layers: engine z resolves below the L2 focus band (20).
  var zNum = parseInt(wcs.zIndex || cs.zIndex || '0', 10) || 0;
  detail.zNum = zNum;

  var pass = fullBleed && zNum < 20;
  return JSON.stringify({ pass: pass, detail: detail });
})()
```

- [ ] **Step 2: Run the probe to verify it fails**

Run: `npx electron tools/probe_shell.js --probe=tools/probes/engine-l0.js`
Expected: `RESULT: FAIL` — `#orb-deck` is still inside `#view-orb` (only full-bleed when that tab is active; not a persistent z:0 background).

- [ ] **Step 3: Relocate the engine to L0**

In `renderer/index.html`, remove the `#orb-deck` iframe from inside `#view-orb` (the `<div class="view active" id="view-orb">` block ~line 243–249) and place it as the first child of `<body>`, wrapped in an `.engine` layer, immediately after the opening `<body>` tag (replacing the old `<canvas id="bg-canvas">` background role):

```html
<div class="engine" id="engine">
  <iframe class="orb-deck" id="orb-deck" src="nexus-deck.html?embed=1" title="Caryl Nexus Deck"></iframe>
</div>
```

Leave `#view-orb` in place but now containing **only** its `.orb-meta` caption block (the state/caption overlays) — it becomes a transparent marginalia layer, not the engine's host.

- [ ] **Step 4: Add the engine layer + defocus CSS**

In `renderer/index.html`'s inline `<style>`, add:

```css
.engine{ position:fixed; inset:0; z-index:0; pointer-events:none;
  transform:scale( calc(1 - .08*var(--focus-depth)) );
  filter:blur( calc(6px*var(--focus-depth)) ) brightness( calc(1 - .4*var(--focus-depth)) );
  transform-origin:50% 42%; }
.engine #orb-deck{ position:absolute; inset:0; width:100%; height:100%; border:0; display:block; }
@media (prefers-reduced-motion: reduce){
  .engine{ transform:none; filter:brightness( calc(1 - .4*var(--focus-depth)) ); } /* dim only */
}
```

- [ ] **Step 5: Run the probe to verify it passes**

Run: `npx electron tools/probe_shell.js --probe=tools/probes/engine-l0.js`
Expected: `RESULT: PASS` — deck is full-bleed at `z:0`, present regardless of focus.

- [ ] **Step 6: Commit**

```bash
git add renderer/index.html tools/probes/engine-l0.js
git commit -m "feat(shell): promote Nexus engine to a full-bleed L0 background"
```

---

### Task 4: The motion spine runtime + Chat as an L2 floating layer

Wire the reducer to the DOM and convert Chat from a `display:none` tab into an L2 glass layer whose entrance runs the camera pull-back. This is the phase's proof-of-life and must preserve composer interactivity (guards against the earlier overlay-click regression).

**Files:**
- Create: `renderer/system-shell.js`
- Modify: `renderer/index.html` — load `system-shell.js`; convert `#view-chat` to an L2 focus layer + `.glass`; route `setView` through the shell.
- Create: `tools/probes/motion.js`

**Interfaces:**
- Consumes: `window.ShellReducer.deriveShell` (Task 1); `--focus-depth`, `--glass-density`, `.glass` (Task 2); `.engine` (Task 3); the deck's existing `deckSetActive(bool)` (already in `index.html`).
- Produces: `window.Shell` with:
  - `Shell.setFocus(name)` — `name ∈ ShellReducer.FOCUS`; applies the derived targets to the DOM.
  - `Shell.state` — the current shell state object.
  - Shell reads `data-os`, `prefers-reduced-motion`, and battery (if available) to fill reducer inputs.

- [ ] **Step 1: Write the failing probe**

Create `tools/probes/motion.js`:

```js
(function () {
  var root = document.documentElement;
  var out = { steps: {} };

  // Preconditions
  out.steps.hasShell = typeof window.Shell === 'object' && typeof window.Shell.setFocus === 'function';
  if (!out.steps.hasShell) return JSON.stringify({ pass: false, detail: out });

  // Open Chat -> focus-depth target 1, chat layer active + glass, engine defocused.
  window.Shell.setFocus('chat');
  var chat = document.getElementById('view-chat');
  out.steps.focusDepthTarget = root.style.getPropertyValue('--focus-depth').trim();
  out.steps.chatActive = chat && chat.classList.contains('active');
  out.steps.chatIsGlass = chat && chat.classList.contains('glass');

  // Composer must remain the top hit-test target (regression guard for the cdm-panel bug).
  var send = document.querySelector('.composer .send');
  var input = document.getElementById('chat-input');
  var topSend = send && document.elementFromPoint(
    send.getBoundingClientRect().left + send.getBoundingClientRect().width / 2,
    send.getBoundingClientRect().top + send.getBoundingClientRect().height / 2);
  out.steps.sendClickable = !!(send && (topSend === send || send.contains(topSend)));
  var topIn = input && document.elementFromPoint(
    input.getBoundingClientRect().left + 20, input.getBoundingClientRect().top + input.getBoundingClientRect().height / 2);
  out.steps.inputClickable = !!(input && (topIn === input || input.contains(topIn)));

  // Return to Orb -> focus-depth target 0.
  window.Shell.setFocus('orb');
  out.steps.focusDepthBack = root.style.getPropertyValue('--focus-depth').trim();

  var pass = out.steps.focusDepthTarget === '1' && out.steps.chatActive && out.steps.chatIsGlass &&
             out.steps.sendClickable && out.steps.inputClickable && out.steps.focusDepthBack === '0';
  return JSON.stringify({ pass: pass, detail: out });
})()
```

- [ ] **Step 2: Run the probe to verify it fails**

Run: `npx electron tools/probe_shell.js --probe=tools/probes/motion.js`
Expected: `RESULT: FAIL` — `window.Shell` is undefined.

- [ ] **Step 3: Write the shell runtime**

Create `renderer/system-shell.js`:

```js
// renderer/system-shell.js
// The runtime that applies the pure reducer's targets to the DOM. CSS @property eases
// --focus-depth / --glass-density, so this file only sets targets, toggles the active
// focus layer, dims the marginalia, and throttles the engine when it's occluded.
(function () {
  'use strict';
  if (!window.ShellReducer) { console.error('[shell] ShellReducer missing'); return; }
  var R = window.ShellReducer;
  var root = document.documentElement;

  var state = { focus: 'orb', coverage: 0, power: 'normal', reducedMotion: false, win10: false };

  function readEnv() {
    state.win10 = root.dataset.os === 'win10';
    try { state.reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (_e) {}
  }

  function apply() {
    var t = R.deriveShell(state);
    // Ease targets (CSS @property does the interpolation).
    root.style.setProperty('--focus-depth', String(t.focusDepthTarget));
    root.style.setProperty('--glass-density', String(t.glassDensityTarget));
    // Marginalia dim.
    root.style.setProperty('--marginalia-dim', String(t.marginaliaDim));
    // Toggle the single active focus layer (orb = none).
    document.querySelectorAll('.view').forEach(function (v) {
      v.classList.toggle('active', v.id === 'view-' + t.focus);
    });
    root.setAttribute('data-focus', t.focus);
    // Engine throttle: reuse the deck's existing pause contract. Only fully render when
    // the engine is actually visible (not occluded, i.e. not throttled).
    try { if (typeof window.deckSetActive === 'function') window.deckSetActive(!t.engineThrottle); } catch (_e) {}
  }

  var Shell = {
    state: state,
    setFocus: function (name) {
      state.focus = (R.FOCUS.indexOf(name) >= 0) ? name : 'orb';
      apply();
    },
  };

  readEnv();
  apply();
  try { matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change', function () { readEnv(); apply(); }); } catch (_e) {}
  window.Shell = Shell;
})();
```

- [ ] **Step 4: Load the scripts and convert Chat to L2**

In `renderer/index.html`:

(a) In `<head>`, load the reducer + runtime **after** the existing `<script src="wakeword.js"></script>` line (~line 13):

```html
<script src="shell-reducer.js"></script>
<script src="system-shell.js" defer></script>
```

(b) Make `#view-chat` an L2 glass focus layer. Change its opening tag (~line 226) and add layout CSS to the inline `<style>`:

```html
<div class="view glass" id="view-chat">
```

```css
.stage .view{ position:absolute; inset:0; }
#view-chat{ z-index:20; left:50%; top:50%; width:min(720px,94vw); height:min(78vh,760px);
  transform:translate(-50%, calc(-50% + 14px*(1 - var(--focus-depth))));
  opacity:var(--focus-depth); pointer-events:none;
  display:flex; flex-direction:column; overflow:hidden; }
#view-chat.active{ pointer-events:auto; }
@media (prefers-reduced-motion: reduce){
  #view-chat{ transform:translate(-50%,-50%); }   /* opacity-only entrance */
}
```

(c) Replace the two tab buttons' handlers (~lines 212–213) to route through the shell instead of the old `setView`:

```html
<button class="tab active" data-view="orb" onclick="Shell.setFocus('orb')">Orb</button>
<button class="tab" data-view="chat" onclick="Shell.setFocus('chat')">Chat</button>
```

(d) Keep the legacy `setView` function defined (other code calls `deckSetActive`/`_bgApply` through it); at the **top of `setView`**, delegate focus to the shell so both paths agree — add as the first line of `function setView(v){` (~line 680):

```js
  if (window.Shell && (v === 'orb' || v === 'chat')) { window.Shell.setFocus(v); }
```

- [ ] **Step 5: Run the probe to verify it passes**

Run: `npx electron tools/probe_shell.js --probe=tools/probes/motion.js`
Expected: `RESULT: PASS` — opening Chat sets `--focus-depth` target `1`, `#view-chat` is an active glass layer, the Send button and input are the top hit-test targets, and returning to Orb sets `--focus-depth` back to `0`.

- [ ] **Step 6: Regression — the earlier fixes still hold**

Run: `node tests/test-shell-reducer.js`
Expected: `test-shell-reducer: OK`
Run: `npx electron tools/probe_shell.js --probe=tools/probes/material.js`
Expected: `RESULT: PASS`

- [ ] **Step 7: Commit**

```bash
git add renderer/system-shell.js renderer/index.html tools/probes/motion.js
git commit -m "feat(shell): motion spine runtime + Chat as an L2 floating layer (camera pull-back)"
```

---

### Task 5: Fallback matrix verification (Win10 · reduced-motion · reduced-transparency)

Prove the fallback branches so the "one cohesive object" survives on Win10 and accessibility settings — the surfaces where glass/motion silently break otherwise.

**Files:**
- Create: `tools/probes/fallbacks.js`
- Modify: `renderer/system-shell.css` only if a branch is found missing (the branches were authored in Task 2; this task verifies and patches).

**Interfaces:**
- Consumes: everything from Tasks 2–4.
- Produces: no new API — a verification gate.

- [ ] **Step 1: Write the failing probe**

Create `tools/probes/fallbacks.js`:

```js
(function () {
  // Force the Win10 branch and confirm the glass loses backdrop-filter for the opaque recipe.
  document.documentElement.dataset.os = 'win10';
  var el = document.createElement('div'); el.className = 'glass'; document.body.appendChild(el);
  var gs = getComputedStyle(el);
  var backdrop = (gs.backdropFilter || gs.webkitBackdropFilter || 'none');
  var bg = gs.backgroundImage + ' ' + gs.backgroundColor;

  var detail = { win10Backdrop: backdrop, win10Bg: bg };
  // Win10: no blur, and a real (gradient or solid) opaque fill.
  var win10ok = !/blur\(/.test(backdrop) && (/gradient/.test(gs.backgroundImage) || /rgb/.test(gs.backgroundColor));

  // reset
  document.documentElement.dataset.os = 'win11';
  var pass = win10ok;
  return JSON.stringify({ pass: pass, detail: detail });
})()
```

- [ ] **Step 2: Run the probe**

Run: `npx electron tools/probe_shell.js --probe=tools/probes/fallbacks.js`
Expected: `RESULT: PASS` if the Task 2 `html[data-os="win10"] .glass` branch is correct. If it **FAILs**, the branch is missing/wrong — fix `renderer/system-shell.css` so the Win10 `.glass` sets `backdrop-filter:none` + the `linear-gradient` opaque fill (as authored in Task 2 Step 5), then re-run until PASS.

- [ ] **Step 3: Commit**

```bash
git add tools/probes/fallbacks.js renderer/system-shell.css
git commit -m "test(shell): verify Win10/reduced-transparency glass fallback matrix"
```

---

## Phase 1 done — what ships

After Task 5: one shared glass material, the Nexus engine as a live full-bleed background, a declarative `--focus-depth` pull-back, and Chat as a floating L2 layer that composites over the defocused Core — all offline, Win10-safe, and reduced-motion-safe, with the composer-click regression guarded.

## Follow-up plans (each its own spec§ → plan → implement cycle)

These are **not** in this plan — each becomes its own `docs/superpowers/plans/` document so every increment stays independently shippable (spec §14):

- **Phase 2 — Chat transcript & peripheral dock** (spec §6.2–6.3): retire bubbles for the data-physical transcript; minimize → BL ledger dock.
- **Phase 3 — Settings as a focus layer** (spec §7): modal → L2, denser Dynamic Translucency, appearance trimmed to accents.
- **Phase 4 — Satellites** (spec §8): weather / mini-bubble / overlay import `system-shell.css`, materialize-from-Core entrance.
- **Phase 5 — Slot allocator** (spec §9): named corner slots + priority → re-anchor/ghost; wire weather + toasts + chat dock.
- **Phase 6 — Camera & Multimodal HUD** (spec §10): viewfinder monitor/fullscreen, ghost/re-anchor via the allocator, then the ambient scene-watcher + privacy state + multimodal wiring.

---

## Self-Review

**Spec coverage (Phase 1 scope):** §3.1 shared stylesheet ✓ (Task 2) · §3.2 tokens/fonts ✓ (Task 2, Global Constraints) · §3.3 glass ✓ (Task 2) · §3.4 chromatic aberration ✓ (`.ca`, Task 2) · §3.5 Dynamic Translucency ✓ (reducer Task 1 + `--glass-density` Task 2) · §3.6 grid tokens ✓ (`--grid/--gutter`, Task 2) · §4.1 z-contract ✓ (reducer `Z`, engine z:0 Task 3, chat z:20 Task 4) · §4.2 reducer ✓ (Task 1) · §5 motion spine ✓ (Tasks 2+4) · §6.1 Chat as layer ✓ (Task 4; §6.2/§6.3 deferred to Phase 2 by design) · §11 fallbacks ✓ (Tasks 2+5) · §12 engine throttle ✓ (reducer `engineThrottle` + `deckSetActive`, Tasks 1+4). Deferred-by-design: §7–§10 (later phases, listed above). No in-scope gaps.

**Placeholder scan:** No TBD/TODO; every code step contains complete files. The only conditional work (Task 5 Step 2 "fix if FAIL") references the exact branch authored in Task 2 Step 5 — not a placeholder.

**Type consistency:** `deriveShell` return shape is identical across Task 1 (definition), the reducer source, and its consumers in `system-shell.js` (Task 4) — `focusDepthTarget`, `glassDensityTarget`, `engineThrottle`, `marginaliaDim`, `zTop`, `focus`, `reducedMotion`. `Shell.setFocus` / `Shell.state` / `window.Shell` names match between Task 4's interface block, the runtime source, and `tools/probes/motion.js`. `ShellReducer.FOCUS`/`Z`/`DENSITY`/`OCCLUSION` names match between Task 1 source, tests, and runtime. CSS custom-property names (`--focus-depth`, `--glass-density`, `--core`, `--void`, `--mono`, `--read`, `--disp`) are identical across the CSS, the probes, and the runtime.
