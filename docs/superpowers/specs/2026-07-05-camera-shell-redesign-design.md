# Advanced Camera Mode — D1: Shell Redesign + Greeting — Design Spec

**Date:** 2026-07-05
**Sub-project:** D (Advanced Camera Mode), piece **D1** of 5. Later pieces (own specs):
D2 voice-driven object focus/highlight, D3 real 3D via meshy.ai/tripo.ai, D4 health/diet
analysis, D5 keep-camera-open research overlay.
**Status:** Implemented (D1). See docs/superpowers/plans/2026-07-05-camera-shell-redesign.md.

## Context

Camera mode today is a fullscreen overlay in the main window (`renderer/index.html`
`#cam-full`): a centered `<video id="cam-live">`, a `<canvas id="cam-overlay">` running
always-on COCO-SSD generic object boxes (TensorFlow.js from CDN), a camera picker, a text
input, and Ask / Make-3D / mic buttons. It opens silently. D1 makes it a modern glass
"viewfinder", greets the user aloud on open, and auto-starts listening — the shell that
D2–D5 plug into. Nothing about the capture→vision path or the existing action buttons'
*function* changes; D1 is chrome + open/close behavior.

Decisions locked with the user (2026-07-05):

- **Build order:** D1 first (foundation), then D2–D5, each its own spec/plan/build.
- **Aesthetic:** match the app's glassmorphism + `theme.css` accent (recolors with the
  user's theme) with a camera-specific **viewfinder** treatment (targeting-bracket corners,
  faint rule-of-thirds grid, soft vignette) — cohesive with the HUD panel and weather board.
- **Greeting:** on open the assistant speaks a **persona/name** line (e.g. "Caryl here —
  what are we looking at?"), then **auto-starts listening** via the existing voice pipeline.
- **Clean feed:** remove the always-on COCO-SSD boxes; the feed is just video + chrome.
  Boxes appear **only when the user asks the AI to focus on something** — that on-demand,
  intent-confirming highlight is **D2**, not D1.
- **Placement:** stays a fullscreen overlay **inside the main window** (not its own
  window); D5's research overlay will later float as a separate window on top.

## Architecture

Single file of real change: `renderer/index.html` (the `#cam-full` markup, its styles, and
the camera JS around `toggleCamera`). No main-process changes required for D1 (greeting uses
the existing `speak()`; listening uses the existing `startRecording()`; vision/capture
untouched). Small pure helpers are extracted to a tiny testable module so D1 has real unit
coverage despite the UI being DOM-bound.

**New pure module `lib/cameraUi.js`** (plain node, no Electron/DOM), unit-tested:
- `greetingLine(assistantName) -> string` — the spoken greeting from the persona name
  (falls back to a generic line when the name is empty/default).
- `statusLabel(state) -> string` — maps an internal state (`idle|listening|looking|
  speaking|error`) to the pill text (`Idle`, `Listening…`, `Looking…`, `Speaking…`, and an
  error label). Single source of truth for the pill.

The renderer imports these (the app already uses ES `import` in the renderer for three.js;
if a plain `<script type="module">`/require boundary is awkward, the two functions may be
inlined in `index.html` **and** duplicated verbatim in `lib/cameraUi.js` for the test — but
prefer a real import so there is one source). Implementation picks the cleaner of the two at
build time; the test targets `lib/cameraUi.js` either way.

## Visual redesign (glass viewfinder)

`#cam-full` reskinned; video stays centered and untouched in aspect. Layers over it:

- **Viewfinder chrome** (pointer-events:none): four accent targeting-bracket corners inset
  from the frame (same signature as the HUD), a faint 3×3 rule-of-thirds grid
  (`rgba(255,255,255,.08)`), and a soft radial vignette for focus. Accent = `--accent`.
- **Top bar (glass pill row):** left = assistant name + a **status pill** with a state dot
  (`Idle` / `Listening…` / `Looking…` / `Speaking…`); the dot pulses while listening. Right
  = camera-switch button (shown only when >1 video input) and an Exit button. Glass =
  `rgba(20,24,32,.5)` + backdrop-blur; solid fallback on `data-os="win10"`.
- **Bottom cluster (glass):** the caption line (assistant's spoken reply mirrored as text,
  so it's usable muted), a text input ("Ask about what you're showing…"), a mic/talk button
  reflecting listen state, and the existing "What is this?" + "Make 3D" actions — reskinned
  to the glass language (unchanged behavior; D3 later redoes Make-3D).
- **Motion:** the overlay fades + scales in (~.2s); the listening dot pulses; honors
  `prefers-reduced-motion` (no pulse, instant show).

## Greeting + auto-listen flow

On `toggleCamera()` open (after the stream starts and video plays):
1. status → `speaking`; caption shows the greeting text; `speak(greetingLine(name))` via the
   existing TTS (Piper or browser).
2. When TTS finishes (the renderer already tracks queue-idle via `ttsActive()`), status →
   `listening` and `startRecording()` is called through the existing voice pipeline
   (respects the user's VAD / mic-device settings). A short max-wait fallback (~6 s) starts
   listening even if a TTS end signal is missed.
3. While recording, the pill reads `Listening…`; a normal vision answer flips it to
   `Looking…` then back to `Idle`.

Guards: **TTS disabled** → `ttsActive()` is immediately false, so the greeting still shows as
a caption and listening auto-starts. **No mic permission** → skip `startRecording()`, show a
"tap the mic to talk" hint, pill stays `Idle`. **Closing the camera** stops recording and
cancels any pending greeting/auto-listen so nothing lingers. The assistant **name** comes
from the same source the HUD uses (`bridge.status().assistant_name`, cached on open).

## Removed in D1

The always-on detection layer: `ensureDetector`, `startFocusBoxes`, `stopFocusBoxes`,
`drawBoxes`, the TF.js/COCO-SSD CDN `loadScript` calls, and the `#cam-overlay` box drawing.
The `#cam-overlay` canvas element is **kept** (empty) — D2 reuses it for the intentional,
on-demand focus box. No other behavior changes.

## Error handling

| Failure | Behavior |
|---|---|
| No camera / permission denied | Glass error card over the feed with a Retry button (not a black screen); pill `error` |
| Camera switch fails | Keep the current stream, brief hint |
| TTS unavailable/disabled | Greeting shown as caption; auto-listen still fires |
| Mic permission denied | Skip auto-listen; "tap to talk" hint; pill `Idle` |
| Vision/capture path | Unchanged from today |

## Testing

- **Unit (`tests/test-camera-ui.js`, added to `npm test`):** `greetingLine` (named vs
  empty/default → generic; no crash on odd input) and `statusLabel` (every state → its
  label; unknown → a safe default).
- **Manual gate:** open camera → glass viewfinder renders with theme accent → greeting
  speaks → mic auto-starts (pill `Listening…`) → ask about an object → answer + caption →
  camera switch (multi-cam) → exit is clean (stream + mic stop); TTS-off and
  mic-denied variants behave per the table; Win10 solid-glass fallback.

## Out of scope (later D-pieces)

On-demand / voice-driven focus boxes (D2 — reuses `#cam-overlay`), real mesh 3D via
meshy/tripo (D3 — replaces the procedural Make-3D), physique/calorie analysis (D4),
keep-camera-open research overlay window (D5).
