# Advanced Camera Mode — D2: Voice-Driven Object Focus + Targeting Box — Design Spec

**Date:** 2026-07-05
**Sub-project:** D (Advanced Camera Mode), piece **D2** of 5. D1 (glass viewfinder shell +
greeting) shipped (PR #5). Remaining: D3 real 3D (meshy/tripo), D4 health/diet, D5 research
overlay.
**Status:** Approved design, pre-implementation.

## Context

D1 left the camera feed clean and kept an empty `#cam-overlay` canvas reserved for exactly
this. D2 adds intentional, voice-driven object highlighting: when the user says "focus on
the object in my hand" (or "lock onto / highlight / point to X"), the AI singles out **that**
object and draws a targeting box — the box (plus a spoken confirmation) proves it understood
the right thing.

The vision path already streams a text answer through `describeImageToChat` / a one-shot
`describeObjectForModel`, both using `streamChat` against `visionCfg(cfg)` — an
OpenAI-compatible endpoint (Gemini 2.5 Flash, Qwen-VL via Groq, gpt-4o-mini, or local
Ollama vision). The camera action protocol already has `see_camera` / `close_camera`
dispatched in the `ui:sendText` action chain, and `requestCameraFrame()` grabs a live frame
from the renderer. D2 reuses all of this.

Decisions locked with the user (2026-07-05):

- **Box behavior:** a **one-shot lock** — a single grounding call, box drawn at that spot
  with a lock animation, **held ~5 s then fades** (a still lock, not live tracking).
- **Confirmation:** **spoken + labeled box** — the grounding call returns a short `label`; the
  box shows a caption and the assistant says "Locked on the &lt;label&gt;."
- **On failure:** **say it honestly, no box** — one retry on a fresh frame; if still not
  found, speak a brief "I can't quite pinpoint that — hold it up clearly?" and draw NO box.
  Never a guessed/best-effort box.

## Architecture

Two pure, unit-tested helpers in a new **`lib/grounding.js`** (no Electron/DOM), plus one
main-process async shell and one renderer draw function. The grounding call is a normal
vision request; the risk (grounding accuracy varies by model) is absorbed by strict
prompting + graceful fallback.

- **`parseGroundingBox(raw)` (pure):** takes the model's raw text answer, returns
  `{ found:boolean, label:string, box:[x1,y1,x2,y2] }` with box normalized 0–1, top-left
  origin, or `{ found:false }`. Handles: fenced/unfenced JSON, extra prose around the JSON,
  Gemini's `0–1000 [ymin,xmin,ymax,xmax]` order, pixel-coord boxes (when a companion
  `imgW/imgH` is provided or values &gt; 1 with a detectable scale), `found:false`, missing/
  malformed keys, degenerate/zero-area boxes → `found:false`. Clamps to `[0,1]` and orders
  x1&lt;x2, y1&lt;y2.
- **`mapBoxToCanvas(box, video, canvas)` (pure):** normalized box + `{vw,vh}` (video native)
  + `{cw,ch}` (canvas/displayed) → pixel `{x,y,w,h}` accounting for `object-fit` letterbox
  (the video is centered/contained in the stage), so the box lands on the actual object, not
  a stretched approximation.
- **`groundObject(cfg, dataUrl, target)` (main.js shell):** builds the strict-JSON grounding
  prompt, calls `streamChat` (non-streamed accumulation like `describeObjectForModel`),
  passes the raw answer to `parseGroundingBox`. Returns the parsed result. On `found:false`
  and first attempt, the caller retries once with a fresh `requestCameraFrame()`.

## Data flow

```
user (camera open): "focus on the object in my hand"
  -> LLM emits {"action":"focus_object","target":"the object in my hand"}
  -> main.js focus_object branch:
       setCamStatus looking (renderer), requestCameraFrame()
       res = groundObject(cfg, frame, target)
       if !res.found: one retry with a fresh frame
       if res.found:
         mainWindow.send('camera:focus', { box: res.box, label: res.label })
         speak("Locked on the " + res.label + ".")
       else:
         speak("I can't quite pinpoint that — can you hold it up clearly?")   // no box
  -> renderer onCameraFocus({box,label}):
       drawFocusBox() on #cam-overlay via mapBoxToCanvas(...) — accent box + bracket ticks
       + label chip + lock animation, held ~5s, then clear.
```

## Action protocol

Add to the capability prompt (near `see_camera`):
`{"action":"focus_object","target":"the object the user wants highlighted"}` — with guidance:
use it when the user asks to FOCUS ON / LOCK ONTO / HIGHLIGHT / POINT TO / TRACK a specific
thing in the camera; `target` is their description of that thing. Distinct from `see_camera`
(which answers a question about the view). Only valid while the camera is open — if it isn't,
fall through to normal handling.

## Renderer (`#cam-overlay`)

`drawFocusBox(box, label)`: size the canvas to the displayed video, compute pixels via
`mapBoxToCanvas`, draw an accent rounded targeting rectangle with corner brackets and a small
label chip above it; a short CSS/canvas lock animation (quick scale-in + one pulse). A module
timer holds it ~5 s then clears the canvas (a new focus resets the timer). Preload gains
`onCameraFocus(cb)`. The box is cleared on camera close (D1's close path) and on a new lock.

## Error handling

| Failure | Behavior |
|---|---|
| Camera not open when `focus_object` fires | Fall through (no crash); the model shouldn't emit it, but guard anyway |
| No frame (permission/no webcam) | The existing "could not get a camera image" path; no box |
| Vision empty/timeout/error | Treated as `found:false` → retry once → honest fallback |
| Malformed / non-JSON answer | `parseGroundingBox` → `found:false` |
| Degenerate/out-of-range box | Clamped; zero-area → `found:false` |
| Camera closed mid-grounding | Drop the result (renderer no-ops if `#cam-full` hidden) |

## Testing

- **Unit (`tests/test-grounding.js`, added to `npm test`):** `parseGroundingBox` across the
  format zoo — clean JSON 0–1, fenced JSON, JSON with surrounding prose, Gemini
  `0–1000 [ymin,xmin,ymax,xmax]`, `found:false`, missing keys, junk/empty, zero-area, and
  out-of-range clamping; `mapBoxToCanvas` — exact-fit (no letterbox), pillarbox (wide canvas),
  letterbox (tall canvas), and box-at-edges.
- **Manual gate:** camera open, hold an object, "focus on the &lt;thing&gt; in my hand" →
  labeled targeting box on the object + "Locked on the &lt;thing&gt;." spoken; hide the object
  / ask for something not present → honest no-box fallback after a brief retry; box fades after
  ~5 s; box clears on camera close. Try on Gemini and on Qwen-VL.

## Out of scope (later)

Live tracking (box following a moving object), multi-object highlight, tap-to-focus, and
using the locked object as context for a follow-up ("research it" is D5, "make a 3D of it" is
D3). D2 is the lock + confirmation only.
