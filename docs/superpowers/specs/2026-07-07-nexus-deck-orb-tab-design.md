# Nexus Deck as the Live Orb Tab — Design

**Date:** 2026-07-07
**Status:** Approved (iframe approach; roster agents stay decorative; fully offline)

## Goal

Replace the 2D canvas orb in the main app's **Orb tab** with the standalone
`renderer/nexus-deck.html` 3D scene, driven live by Caryl's voice state
(listening / speaking / busy / idle) so it reacts the way the current orb does —
and make it work **fully offline**, with zero external network requests.

## Existing scaffold (discovered during design)

`#view-orb` already contains `#nexus-three-canvas`, `#nexus-leaders`, and
`#nexus-readouts` with supporting CSS — but **no JavaScript drives them** (the
only three.js in `index.html` is the unrelated on-demand GLTF model exporter).
These are dead scaffold elements; the iframe supersedes them and they are
removed as part of this work.

## Approach

**Iframe + `postMessage` bridge.** `nexus-deck.html` stays self-contained and
is embedded in `#view-orb` via an `<iframe>`. `renderer/index.html` already
computes all required state in its `orb` object (`level`, `speaking`, `busy`,
`recording`); it forwards that to the deck each tick. The deck's scene code is
not rewritten — only a small driver surface is added.

Rejected alternatives: inlining three.js into `index.html` (huge merge,
importmap conflict), separate BrowserWindow (user wants it *in* the Orb tab).

## Components

### 1. `renderer/nexus-deck.html` — additive driver surface

- **`?embed=1` param:** skip the boot ignition veil; hide the deck's own corner
  chrome (help hints, log panel, telemetry index) so it reads as a clean orb
  beneath `index.html`'s existing `orb-state` / `orb-caption` overlays.
- **Expose `window.__nexus` always** (currently gated behind `?shot=1`).
- **`message` listener** accepting:
  - `{type:'caryl-orb', state}` — live orb state.
  - `{type:'caryl-active', active}` — whether the Orb tab is visible.
- **`driveState(s)` mapper** onto the existing core knobs:
  - `recording` → cool "listen glow": hold `coreUniforms.uActivity` ≈ 0.6, cool flare.
  - `speaking` → `broadcast()` on the rising edge + hold `uActivity` high while speaking.
  - `busy` → raise `sim.load` / `sim.rate` (accretion spin-up).
  - `idle` → release; let telemetry settle naturally.
  - While live-driven, suppress the deck's random auto-dispatch (`sim.nextDispatch`)
    so motion reflects Caryl, not noise.
- **`setActive(false)`** throttles/pauses the render loop (reuses the existing
  `visibilitychange` pause path), because an iframe hidden via CSS `display:none`
  does **not** receive `document.hidden`.

### 2. `renderer/index.html` — swap canvas for iframe + bridge

- Replace `<canvas id="orb-canvas">` with
  `<iframe id="orb-deck" src="nexus-deck.html?embed=1">`. Keep `orb-state` /
  `orb-caption` overlays on top. Remove the dead `#nexus-three-canvas`,
  `#nexus-leaders`, `#nexus-readouts` scaffold and their now-unused CSS.
- `initOrb()` stops driving a 2D canvas; the `orb` object remains the single
  source of truth for state.
- In the existing orb ticker / `poll()`, `postMessage` the `orb` state to the
  iframe (throttled to animation cadence).
- `setView()` sends `{type:'caryl-active', active}` so the deck pauses render
  when the user is on Chat / Settings.

### 3. Offline vendoring (zero external requests)

- **three.js:** add `three@0.160.0` as a devDependency, `npm install`, then
  vendor the runtime files into `renderer/vendor/three/`:
  - `build/three.module.js` → `renderer/vendor/three/three.module.js`
  - `examples/jsm/` → `renderer/vendor/three/addons/` (whole tree, so
    postprocessing, shaders, and the GLTF exporter all resolve).
- **Rewrite the importmap in BOTH `nexus-deck.html` and `index.html`** to local
  relative paths (both files live in `renderer/`, so the paths match):
  ```json
  { "imports": {
      "three": "./vendor/three/three.module.js",
      "three/addons/": "./vendor/three/addons/" } }
  ```
- **Fonts:** vendor the deck's two Google fonts (Big Shoulders Display, IBM Plex
  Mono) as local `woff2` under `renderer/vendor/fonts/` with a local `@font-face`
  block; drop the `fonts.googleapis.com` / `fonts.gstatic.com` `<link>` tags.
  The deck's existing CSS fallbacks remain as a safety net. `index.html` loads no
  web fonts, so it needs no font work.
- **Result:** the deck's `#fallback` panel ("requires WebGL + network") now only
  triggers on genuine WebGL failure, not on a missing network — the Orb tab
  renders offline.
- **Verification:** confirm no request hits `cdn.jsdelivr.net`,
  `fonts.googleapis.com`, or `fonts.gstatic.com` (grep the tree + run the deck
  with the network offline / DevTools network tab).

## Out of scope (YAGNI)

- Mapping the 7 roster agents to real engines / automation agents — they stay
  decorative telemetry.
- Inlining three.js source into `index.html` (vendored as ES modules via the
  importmap instead).
- New IPC in `main.js` — this is a pure renderer-side, `file://` iframe change.

## Trade-off

The deck is a full three.js + UnrealBloom pipeline, heavier than the 2D orb.
Mitigated by pausing render when the tab is inactive and honoring the deck's
existing reduced-motion / economy modes.
