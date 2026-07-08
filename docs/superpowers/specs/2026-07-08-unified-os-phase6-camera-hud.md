# Unified OS — Phase 6: Camera & Multimodal HUD (Persistent Viewfinder + Active Observer)

**Date:** 2026-07-08 · **Branch:** `nexus-deck-orb-tab` · **Status:** approved (continuation of the approved master spec §10, D3)
**Parent spec:** `2026-07-07-unified-os-ui-design.md` (§10, §4.2, D3). Builds on Phases 1–5 (consumes the Phase 5 slot allocator + transient chip host).

## 1. Problem

The camera today is **all-or-nothing**: `toggleCamera()` jumps straight to `#cam-full`, a
`z-index:9999` fullscreen overlay outside the shell system. There is no monitor mode ("situational
awareness, not clutter"), no non-clutter behavior, no focus choreography (the engine neither pulls
back nor throttles), and the camera is **passive** — it only ever answers when asked. The reducer
has carried `camera` (density .55) and `camera-full` (density .98 → engine throttle) since Phase 1,
unused.

## 2. Goal

The brief's **Persistent Viewfinder** and **Active Observer**:

1. **Monitor mode** — opening the camera summons a compact glass viewfinder anchored by the Phase 5
   slot allocator (prefers BR), over the pulled-back engine (`focus:'camera'`). It re-anchors/ghosts
   around satellites automatically, and dims when it isn't the focus.
2. **Fullscreen precision mode** — clicking the viewfinder expands to the existing full HD
   inspection surface (`focus:'camera-full'`) — engine throttles while occluded; Esc/Exit collapses
   back to the monitor with the same pull-back easing.
3. **Ambient scene-watcher (D3)** — a cheap on-device frame-diff (no model) detects a meaningful,
   *stabilized* scene change → **one** local-vision classification → **one** high-confidence
   suggestion chip ("I see a bill — scan & log it?"). Accept routes into the existing camera-vision
   chat flow. Visible watching state + one-click mute; frames never leave the device.

**Non-goals:** no `nexus-deck.html` changes; no reducer changes (it already specifies both camera
focuses); no cloud watcher (no local vision model ⇒ the watcher silently stays off); no changes to
the tracking/grounding pipeline (fullscreen keeps it verbatim); `main.js`/`preload.js`/
`lib/cameraUi.js` are **not touched** (all carry unrelated in-flight edits; nothing here needs them).

## 3. Decisions (derived from the approved §10 + D3)

1. **One `#cam-live` video element**, reparented between the monitor body and `#cam-stage`
   (fullscreen). `grabCameraFrame()` and the tracker read `#cam-live` by id — both keep working
   untouched.
2. **Entry lands in monitor mode.** `toggleCamera()` keeps its whole open/close contract (stream,
   greet+listen, status, composer-button tint, voice-close) but shows the monitor instead of
   fullscreen. Closing (✕ / composer 📷 / voice "close the camera") still tears everything down.
3. **Focus choreography:** monitor open ⇒ `Shell.setFocus('camera')` (engine pulls back, density
   .55, keeps rendering). Expand ⇒ `'camera-full'` (density .98 ≥ .92 ⇒ the runtime's existing
   `deckSetActive(false)` throttle). Collapse ⇒ back to `'camera'`. Full close ⇒ `'orb'`.
4. **Non-clutter (§10.2):** the monitor claims `{id:'camera', priority:50, slots:['BR','TR','TL','BL']}`.
   Allocator ghosting (35%, non-interactive, hover-reveal) applies on collision as built in Phase 5.
   Additionally, when the camera isn't the focus the monitor **dims to 55%** (hover restores) — a
   milder, still-interactive echo of ghosting, so the feed stays situational awareness while you chat.
5. **Precision tasks auto-expand:** `camera:focus` (the "focus on X" tracking flow) expands the
   monitor to fullscreen before seeding the tracker (the tracker's chrome lives in `#cam-full`).
6. **Scene-watcher pipeline (D3, event-driven):** every 500ms the live frame is downscaled to
   64×48 grayscale; mean-abs delta ≥ .085 marks "changed"; deltas ≤ .03 for 1000ms after that mark
   "stabilized" → fire **one** classification; then a 20s minimum cooldown. Classification is a
   **direct renderer fetch to the local Ollama vision model** (`http://127.0.0.1:11434/api/generate`,
   the fixed port from `lib/ollama.js`; model = the polled `status.vision_model`, which is non-null
   only when vision resolves to the local engine; Ollama's default origins allow `file://*`).
   Prompt asks for one word: `document | bill | product | whiteboard | none`. Only a strict
   single-word, non-`none` reply passes the confidence gate.
7. **The suggestion is a Phase 5 chip.** `Shell.chip(text, {actions, ms})` — the action variant of
   the toast (claim id `'chip'`, priority 85, slots `['TR','TL','BR']`, one at a time, 12s dwell).
   Accept → `bridge.lookCamera(frame, sceneQuestion)` — the answer lands in the chat transcript
   (multimodal §10.5, one conversation). Dismiss → release.
8. **Watcher arming & privacy:** armed only while the camera is open AND `status.vision_model` +
   `status.ollama_up` are truthy AND not muted. A pulsing `--core` dot on the monitor header is the
   visible watching state; the mute button (persisted `localStorage.sceneWatchMuted`) stops all
   analysis. Paused while: page hidden, mic recording, AI busy (`status.ai_status !== 'idle'`),
   object tracking active, a chip already showing, or a classification in flight. A classification
   network failure disarms the watcher until the camera is reopened (fail-silent per master spec §15).
9. **Pure core, thin glue** (house pattern): `renderer/scene-watcher.js` exports node-tested pure
   parts (`frameDelta`, `createGate`, `parseSceneReply`, `suggestionFor`) plus a `createWatcher`
   glue that takes injected `{video, grabFrame, classify, isBusy, onSuggest}` — the probe and tests
   never need a real webcam or model.

## 4. Design

### 4.1 The monitor — `#cam-monitor` (index.html markup + page CSS)

```
┌───────────────────────────────┐
│ ● CAM            👁  ⤢  ✕    │   header: watch-dot · label · mute · expand · close
│  ┌─────────────────────────┐  │
│  │      #cam-live video    │  │   click video = expand (precision)
│  └─────────────────────────┘  │
└───────────────────────────────┘
```

- `.cam-monitor` is `.glass` (`--e:2`), ~300px wide, video ~168px tall (16:9), hairline header in
  `--mono` micro-caps. It lives in a slot zone (never positioned by hand).
- `.watch-dot`: 7px `--core` dot; `.watching` pulses (reduced-motion: static); muted ⇒ hollow
  (border only) + title "Scene watching muted".
- Dim-when-unfocused: `:root:not([data-focus="camera"]):not([data-focus="camera-full"])
  .cam-monitor:not(.ghosted):not(:hover){ filter:opacity(.55) }` (page CSS; the allocator's
  `.ghosted` stays the stronger override).

### 4.2 Camera choreography (index.html JS)

New internals (exposed on `window` for probes/buttons):

- `camEnterMonitor(stream)` — set `#cam-live.srcObject`, reparent `#cam-live` into the monitor
  body, show monitor, `Shell.slots.claim('camera', …)`, `Shell.setFocus('camera')`, arm the watcher
  (per §3.8).
- `expandCamera()` — reparent `#cam-live` into `#cam-stage`, show `#cam-full` (`display:block` +
  `.show`), `Shell.setFocus('camera-full')`.
- `collapseCamera()` — hide `#cam-full`, reparent back to the monitor, `Shell.setFocus('camera')`.
- `camExitMonitor()` — stop watcher, hide monitor, `Shell.slots.release('camera')`,
  `Shell.setFocus('orb')`.

Rewired existing paths:
- `toggleCamera()` open-branch calls `camEnterMonitor(stream)` (instead of showing `#cam-full`);
  close-branch additionally runs `collapse` bookkeeping + `camExitMonitor()`.
- The `#cam-full` "← Exit" button becomes `collapseCamera()` (title "Back to monitor"); full close
  belongs to the monitor ✕ / composer 📷 / voice close (`onCameraClose → toggleCamera`, unchanged).
- Esc while `focus==='camera-full'` → `collapseCamera()` (added beside the settings Esc handler).
- `onCameraFocus` handler: if the stream is live but `#cam-full` is hidden → `expandCamera()`
  first, then `startTracking(payload)` as today.

### 4.3 The scene-watcher — `renderer/scene-watcher.js`

```
SceneWatcher = {
  frameDelta(a, b)                         // Uint8ClampedArray/number[] grayscale, → 0..1 mean abs diff
  createGate({changeThreshold=.085, stableThreshold=.03, stableMs=1000,
              minIntervalMs=20000})        // → { feed(delta, nowMs) → 'idle'|'changed'|'stabilizing'|'fire'|'cooldown' }
  parseSceneReply(text)                    // → 'document'|'bill'|'product'|'whiteboard'|null (strict one-word)
  suggestionFor(scene)                     // → { text, question } (chip copy + the lookCamera question)
  createWatcher({video, grabFrame, classify, isBusy, onSuggest,
                 sampleMs=500, size={w:64,h:48}})
                                           // → { start(), stop(), muted(bool), state() }
}
```

- Dual-export (`window.SceneWatcher` + `module.exports`); everything above `createWatcher` is pure.
- `createWatcher` glue: `setInterval(sampleMs)`; draw `video` into an offscreen 64×48 canvas,
  grayscale it, feed the gate; skip sampling entirely while `isBusy()`/hidden/muted. On `'fire'`:
  `frame = await grabFrame()`, `reply = await classify(frame)` (in-flight guard), `scene =
  parseSceneReply(reply)`; if a scene passes → `onSuggest(Object.assign({scene, frame},
  suggestionFor(scene)))`. classify rejection ⇒ permanent disarm (until `start()` again).
- The classify implementation is injected from index.html (the Ollama fetch of §3.6): body
  `{model, prompt, images:[<b64 sans data: prefix>], stream:false, options:{temperature:0, num_predict:6}}`.

### 4.4 `Shell.chip` — the action chip (system-shell.js + system-shell.css)

`Shell.chip(text, {actions:[{label, fn}], ms=12000})`: reuses the `.shell-toast` look with a
`.shell-chip` modifier (button row: mono hairline buttons, first button `--core`-accented). Claim
`{id:'chip', priority:85, slots:['TR','TL','BR']}` — a toast and a chip can coexist (the allocator
separates them). Any button click runs its `fn` (errors swallowed) then releases; auto-release
after `ms`. One chip at a time — a new chip replaces the current one.

### 4.5 Multimodal wiring (§10.5)

Chip accept → `NexusOrb.taskBegin('camera','VISION', 'scene suggest', 'ai-idle')` (the same pulse
`askAboutCamera` uses) + `bridge.lookCamera(frame, question)` — the reply flows into the same
transcript/TTS as every other camera ask. Camera, voice, and text remain one conversation.

## 5. Files touched

- **Create:** `renderer/scene-watcher.js` · `tests/test-scene-watcher.js` ·
  `tools/probes/camera-hud.js` · `tools/probes/chip.js`
- **Modify:** `renderer/index.html` (monitor markup/CSS, choreography, watcher wiring, Esc) ·
  `renderer/system-shell.js` (Shell.chip) · `renderer/system-shell.css` (.shell-chip button row) ·
  `package.json` (test chain)
- **Not touched:** `main.js` · `preload.js` · `lib/cameraUi.js` · `renderer/shell-reducer.js` ·
  `nexus-deck.html` · the tracking pipeline.

## 6. Error handling / edge cases

- **No local vision model / Ollama down:** watcher never arms; camera stays fully on-demand
  (master spec §15 risk, honored). Watching dot hidden when unarmed (nothing pretends to watch).
- **Classification failure (network/CORS/model):** one failure disarms the watcher for this camera
  session; no retry storms, no user-facing error (a wrong "I see a bill" is worse than silence —
  and so is a toast about a background feature failing).
- **getUserMedia fails:** unchanged existing path (hint/toast "Camera error…", nothing claimed).
- **Voice close while fullscreen:** `toggleCamera()` close-branch hides both surfaces and releases
  the claim — no orphaned monitor.
- **Chip while camera closes:** watcher stops first; a visible chip stays until dwell/dismiss (its
  frame is already captured; accept still works — `lookCamera` takes the frozen frame).
- **Monitor + satellites:** pure Phase 5 behavior (re-anchor BR→TR→TL→BL, else ghost-in-place).
- **Reduced motion:** watch-dot pulse and monitor transitions collapse to static/opacity-only.
- **Probe environment:** no webcam, no Ollama — probes drive `camEnterMonitor` with
  `canvas.captureStream()` and unit tests inject a fake `classify`; the watcher is never armed in
  probes (stub bridge status has no `vision_model`).

## 7. Testing

- **`tests/test-scene-watcher.js`** (node): `frameDelta` — identical ⇒ 0, inverted ⇒ ~1, length
  guard; `createGate` — no fire below change threshold · change→jitter (≥ stableThreshold) delays ·
  change→stable ⇒ exactly one `'fire'` · cooldown blocks a second fire until `minIntervalMs` ·
  clock injected (no real timers); `parseSceneReply` — 'document'/'Bill.'/'  PRODUCT ' pass,
  'a busy desk scene'/'none'/''/undefined ⇒ null; `suggestionFor` — every scene yields non-empty
  `text` (chip copy) + `question`, bill copy mentions scan & log.
- **`tools/probes/chip.js`**: `Shell.chip` renders text + two buttons in `#slot-TR`; clicking
  action 1 runs its `fn` and releases the claim; a new chip replaces the old; auto-expire works.
- **`tools/probes/camera-hud.js`**: with a `canvas.captureStream()` fake — `camEnterMonitor` ⇒
  monitor visible in a slot zone (`data-slot` set), `data-focus="camera"`, `--glass-density`
  target `0.55`, `#cam-live` inside the monitor; `expandCamera()` ⇒ `data-focus="camera-full"`,
  density `0.98`, `#cam-full` visible, `#cam-live` inside `#cam-stage`; `collapseCamera()` ⇒ back
  to monitor + `camera`; `camExitMonitor()` ⇒ focus `orb`, claim released, monitor hidden.
- **Regression:** the Phase 5 deck — node suites (`test-shell-reducer`, `test-slot-allocator`,
  `test-shell-slots`, `test-nexus-feed`, `test-kernel`, `test-overlay-card`, `test-scene-watcher`)
  + all index probes (now 14 incl. `slots`, `toast`, `chip`, `camera-hud`) + 4 satellite material
  probes. The reducer's `camera`/`camera-full` rows are already asserted in `test-shell-reducer`.
- **Manual (Farouk):** 📷 → monitor rises BR over the pulled-back engine; chat while it's open →
  it dims; ask for weather → it re-anchors/ghosts; click the feed → fullscreen HD + engine rest;
  Esc → monitor; hold a bill up (local vision on) → watching dot pulses → one chip → Scan → the
  answer lands in chat; 👁 mute → dot hollow, no more suggestions.

## 8. Post-ship revision (Farouk, 2026-07-08) — the monitor behaves like the weather board

Farouk's direction after using it: *"the camera is not draggable and why does it have blur behind
it?? make it draggable and remove blur behind it and make it resizable just the same as the weather
overlay."* The monitor stops being a slot-allocated, focus-driving HUD element and becomes a
**free-floating, user-owned panel** — the same contract as the weather board window:

1. **Draggable** by its header (pointer capture; buttons excluded); **resizable** via native CSS
   `resize:both` (bottom-right grip). Bounds are clamped to the viewport and **persisted** to
   `localStorage.camMonitorBounds` (drag saves on pointerup; sizes save via a ResizeObserver) —
   the monitor reopens where you left it, like `weatherBoardBounds`.
2. **No blur, twice over:** the `.glass` material is dropped (no `backdrop-filter` behind the
   panel — a near-opaque `rgba(8,11,17,.92)` fill + hairline instead, solid on Win10), and opening
   the monitor **no longer changes shell focus** — the engine stays crisp (no pull-back blur/dim).
   The reducer's `camera` focus is now unused by the monitor; **fullscreen keeps everything**
   (`camera-full`, density .98, engine throttle), and collapse restores the focus you expanded from.
3. **Slot allocator claim dropped** for the monitor (manual placement supersedes allocation —
   exactly how the user-dragged weather window is treated). Default spawn stays the BR gutter
   corner. The dim-when-unfocused rule is retired with it. Toast/chip behavior is unchanged.
4. Scene-watcher, mute/watch-dot, precision auto-expand, Esc-collapse, and the one-`#cam-live`
   reparenting contract are all unchanged. The `camera-hud` probe is rewritten to this contract
   (free-floating + fixed + resizable + default BR spawn + no backdrop blur on win11 + drag moves
   and persists + focus stays put at monitor).
