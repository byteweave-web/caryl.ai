# Unified OS — System UI Design

**Date:** 2026-07-07
**Status:** Approved — implementation planning. Hybrid window model · IBM Plex Sans for chat prose · **Dynamic Translucency** for focus layers. Architecture only; no code in this doc.
**Supersedes/absorbs:** `2026-07-03-settings-redesign-design.md` styling, `2026-07-04-kernel-overlay-card-design.md` chrome, `2026-07-04-weather-board-design.md` chrome, `2026-07-05-camera-shell-redesign-design.md`. The Nexus deck (`2026-07-07-nexus-deck-orb-tab-design.md`) is the visual North Star and is *not* changed by this work.

---

## 1. Goal

Move Caryl from "a tool with a chat window and an orb tab" to an **Agentic OS**: a
single, cohesive visual system where every surface — Chat, Settings, Weather, the
minimized bubble, notifications, and the Camera — feels like one physical object
living in the same deep-space environment as the Nexus Orb. The Orb is the **Core**;
every panel is **Data-Radiation** emitted from it.

Design values, non-negotiable:

- **Unified glassmorphism** — one frosted-glass material, high-contrast type, subtle
  chromatic aberration, shared everywhere.
- **Context-aware HUD** — Chat is not a tab; it is a floating layer that composites
  *over* the live engine and recedes into the Orb's peripheral vision when minimized.
- **System feel** — a global **System Shell** wraps every overlay on one shared grid
  and spacing system.
- **Motion continuity** — toggling surfaces is a **camera pull-back**, never a page flip.
- **Data-physicality** — high density, minimal chrome, tethered readouts. No web-app tropes.

## 2. Locked decisions (from brainstorming)

| # | Decision | Choice | Consequence |
|---|----------|--------|-------------|
| D1 | Window model | **Hybrid** | Main window = true System Shell (Chat/Settings/Camera as HUD layers over the live engine). Weather board, mini-bubble, notification overlay stay separate OS windows but share the identical stylesheet — "detached shards of the same object." |
| D2 | Motion | **Composited depth** | The engine stays a self-contained black box driven only by state. The shell fakes the camera pull-back with CSS (scale + depth-of-field blur + dim) on the engine layer while HUD glass slides forward. No engine internals touched. |
| D3 | Camera vision | **Ambient scene-watcher** | Cheap on-device frame-diff detects a meaningful scene change → one local-vision pass → a single high-confidence suggestion chip. Visible "watching" state + mute. Not per-frame. |
| D4 | Theme | **One opinionated look** | Deep-space is *the* aesthetic. Full Light is retired. The accent swatches survive as `--core` recolors (cyan/teal/amber/violet…) driving glow + energy only. |

---

## 3. Design Language — the material the OS is made of

### 3.1 The single stylesheet (cohesion mechanism)

A new **`renderer/system-shell.css`** holds every token, the `.glass` material, the
grid, the type ramp, the grain, and the chromatic-aberration utilities. **Every window
and HTML file imports it** (`index.html`, `weather-board.html`, `mini-overlay.html`,
`overlay.html`, `overlay-card.html`, `research-overlay.html`). That shared import — not
a style guide, not copy-paste — is what makes the surfaces literally the same material.
This is the concrete meaning of "the System Shell wraps them."

### 3.2 Tokens (promoted from the deck to canonical)

```
--void   #05060B   background of the universe
--ink    #E8ECF4   primary text
--dim    #5A657D   labels / secondary / hairlines
--steel  #22304A   structural lines, inactive meters
--core   #58C6FF   THE accent — the only user-recolorable token; drives every glow + the orb energy
--good   #5AD19A   --warn #E0B15A   --bad #E9637B   (status only, never decoration)
```

Fonts (all vendored offline in `renderer/vendor/fonts`, already the pattern):

| Var | Family | Used for |
|-----|--------|----------|
| `--mono` | IBM Plex Mono | data, micro-labels, chrome, timestamps, meters |
| `--disp` | Big Shoulders Display | wordmarks, temperatures, large numerals |
| `--read` | IBM Plex Sans | **chat prose only** — legible at length, stays in the Plex family so it never reads "web-app" |

> **R1 — decided (review).** `--read` = **IBM Plex Sans**, confined to running prose
> (chat, weather narration). Everything structural stays mono/condensed. Mixing a third
> family *only* where readability demands it keeps density high without punishing the eyes.
> The font is vendored offline alongside Plex Mono + Big Shoulders.

### 3.3 The glass material — one class, three elevations

`.glass` is the canonical frosted surface; elevation is a modifier, not a new recipe.

- **Fill:** `rgba(12,16,26,.55)` over the void.
- **Blur:** `backdrop-filter: blur(22px) saturate(1.3)`.
- **Hairline, not border:** `1px solid rgba(255,255,255,.06)` + an inset top highlight
  `rgba(255,255,255,.05)` (light catches the top edge — the "physical object" tell).
- **Grain:** a tiled data-URI noise layer at ~3% opacity, `mix-blend-mode: overlay`,
  so glass has tooth instead of reading as flat CSS.
- **Elevation** = glow depth + blur radius: `--e1` ambient readouts, `--e2` focus
  layers (Chat/Settings/Camera), `--e3` transient (chips, toasts, coder-diff).

### 3.4 Chromatic aberration (controlled, not decorative)

A `--ca` utility applies a **very** subtle RGB split: on display headings, a 2-layer
text-shadow offset ±0.4px in `--core` / `--bad`; on glass edges, a 1px fringe via a
dual-color box-shadow. It is intentionally near-subliminal — the "lens" tell of a HUD.
**It disables under `prefers-reduced-transparency` and `prefers-reduced-motion`** and is
capped so it never harms legibility (see §11).

### 3.5 Dynamic Translucency (focus-layer opacity — decided in review)

A focus layer's glass fill is **not a fixed value**; it is an eased variable
`--glass-density` whose target the §4.2 reducer computes from `{focus, depth, coverage,
power}`:

- **During the pull-back** (`--focus-depth` easing 0→1) the glass is at its **most
  translucent** — you watch the Core recede *through* it. This is the premium moment and
  the whole reason the engine lives behind everything.
- **Settled as the sustained focus**, the fill eases **denser** (~`rgba(12,16,26,.72)`)
  for text contrast, while the engine keeps rendering — dimmed and blurred — behind it.
- **Occlusion threshold:** if a layer becomes **fully-covering** (e.g. maximized Settings
  on a small window) **or** the machine is on **battery-saver**, density crosses ~`.92`,
  at which the compositor (§12) throttles/pauses the engine — invisible pixels stop
  costing GPU.
- **Per-surface targets:** Settings (dense forms) rides denser; Chat (prose) stays
  lighter — prose needs less contrast help and benefits more from the glow behind it.

This is what "Dynamic Translucency" means: glowing-engine-behind while you interact,
contrast + battery pragmatism when parked. It is one variable, set in one reducer.

### 3.6 Density & grid

- **8pt base grid.** HUD gutter = 30px (matches the deck's marginalia inset).
- **Type ramp:** micro-label 8.5px · label 10px · meta 11px mono · body 14px read ·
  numeral 30–40px disp — all letter-spaced per the deck (.14em–.3em on labels).
- **Tabular numerals everywhere** numbers change (clocks, temps, meters, token counts).

---

## 4. The System Shell — the global wrapper

The main window becomes a fixed **layer stack**. Nothing is a "page." Everything is a
`z`-addressed layer over one persistent engine.

### 4.1 Layer / z contract

| Layer | z | Contents | Pointer events |
|-------|---|----------|----------------|
| **L0 Engine** | 0 | the live Nexus deck iframe, always rendering, full-bleed background of the *whole app* (not just an Orb tab) | none (visual only) |
| **L1 Marginalia** | 10 | persistent HUD frame — wordmark + vitals (TL), chronometer + status pills (TR), ledger/activity ticker (BL), legend + nav (BR) | selective |
| **L2 Focus** | 20 | exactly one of: Chat · Settings · Camera(monitor) — the glass surface currently "pulled forward" | full |
| **L3 Transient** | 30 | suggestion chips, toasts, the coder-diff panel, weather-in-shell card | full when present |
| **L4 Veil** | 40 | fullscreen precision modes (Camera-fullscreen), destructive confirms | full |

> This directly fixes the class of bug we just repaired: L3/L4 surfaces get
> `pointer-events` **only while active** as a first-class rule of the contract, never
> an invisible always-on catcher.

### 4.2 The shell state model (one object drives everything)

```
shell = {
  focus:      'orb' | 'chat' | 'settings' | 'camera' | 'camera-full',
  depth:      0..1,          // eased --focus-depth, the motion spine (§5)
  satellites: Set<'weather'|'mini'|'overlay'>,   // separate windows currently open
  watching:   bool,          // camera ambient scene-watcher armed
  slots:      { TL,TR,BL,BR, CENTER } // occupancy for the non-clutter allocator (§9)
}
```

One reducer maps `shell` → z-layers, `--focus-depth`, `--glass-density` (§3.5, Dynamic
Translucency), engine throttle, and marginalia dimming. It is small, pure, and testable
in isolation.

### 4.3 The marginalia frame = the OS chrome

The deck's four-corner HUD (vitals / chron / ledger / legend) is promoted to the
**app's** persistent chrome, rendered by the shell (not the deck), so it stays put
while focus layers come and go:

- **TL** wordmark `CARYL` + live vitals meters (mode, model, tokens) as hairline bars.
- **TR** chronometer + status pills (listening/speaking LED, mode).
- **BL** the **ledger** — a rolling activity ticker; also the **Chat peripheral dock**
  (§6.3).
- **BR** the **legend/nav** — the surface switcher (Orb · Chat · Settings · Camera) as
  letter-spaced hairline entries, not pill tabs.

---

## 5. Motion Spine — the camera pull-back

A single CSS custom property, **`--focus-depth` (0 → 1)**, is the whole illusion.
`0` = Orb in focus; `1` = a HUD focus layer in focus. One eased driver animates it;
everything else *reads* it.

**Choreography (open Chat/Settings/Camera):** `--focus-depth` 0→1 over **420ms
`cubic-bezier(.2,.8,.2,1)`**:

- **L0 Engine:** `scale(1 → .92)`, `filter: blur(0 → 6px) brightness(1 → .6)` — the
  orb dollies back and defocuses.
- **L2 Focus glass:** `translateY(14px → 0)` + `translateZ` feel via scale `.98 → 1`,
  opacity 0→1, glow `--e2` ramps in — the panel rises toward the viewer.
- **L1 Marginalia:** dims to `.5` — the chrome yields attention to content.

Reverse on minimize = the **pull-back to Orb**: the panel recedes and the engine
refocuses. This is literally "the camera pulling back to the Core."

> **Recommendation R2 — the abstract seam.** The shell drives `--focus-depth` only; the
> composited illusion consumes it today. If we ever want the *literal* engine dolly, we
> route that same value to the deck via one new bridge message — zero redesign. (This is
> the "both, later" path from the brainstorm, kept free.)

**Satellite materialize (R3, cross-window nicety):** separate windows (weather,
mini-bubble, notifications) can't share the canvas, so they **fade+scale in from the
direction of the main window's Orb** (spawn offset toward the shell, settle into place).
They still feel *emitted from the Core* without a shared 3D space.

Fallbacks: under `prefers-reduced-motion`, transitions become **opacity-only** (no
blur/scale). On Win10 (no `backdrop-filter`), the engine defocus uses brightness+opacity
only, and glass uses the opaque-gradient recipe (§11).

---

## 6. Chat as a floating layer

### 6.1 From tab to layer

`#view-chat` stops being a `display:none` tab. It becomes **L2 Focus glass** — a
centered column (max 720px) of glass floating over the live, defocused engine. Opening
it runs the §5 pull-back.

### 6.2 The transcript, de-web-app'd

Rounded chat bubbles are retired for a **data-physical transcript**:

- **You:** right-aligned, a `--core` tick + hairline rule + tabular timestamp, prose in
  `--read`. No filled bubble — just the hairline and the text.
- **Caryl:** left-aligned, a thin `--core` leader from the left gutter (a tether back
  toward the Core), mono meta line (`brain · HH:MM`), prose in `--read`.
- **System/thought lines:** centered dim mono, no chrome.
- Reasoning, images, plan cards, 3D cards, automation confirms keep their current
  functions but are reskinned to `.glass` + hairline (they already have structure; only
  material changes).

### 6.3 Minimized = the Orb's peripheral vision

"Minimize chat" does not close it — it **condenses into the BL ledger**: the last
exchange becomes a two-line hairline ticker in the Orb's lower-left periphery, and the
last Caryl reply also drives the existing `orb-caption`. Re-opening re-expands from that
corner (motion continuity — it grows from where it shrank to). This is the literal
"seamlessly transition into the Nexus Orb's peripheral vision."

---

## 7. Settings as a focus layer

The 880×580 centered modal + scrim is retired. Settings becomes an **L2 Focus** layer
using the same pull-back and glass, laid out on the shared grid. Being form-heavy, it
rides the **denser** end of Dynamic Translucency (§3.5) for field contrast, and crosses
the occlusion threshold (letting the engine throttle) when maximized on a small window:

- Left: a **nav ledger** (hairline entries, letter-spaced, the same visual grammar as
  the BR legend) — engines · voice · automation · personality · chats · appearance · about.
- Right: an **instrument panel** — fields as hairline rows, toggles as LED switches,
  sliders as thin meters with `--core` fills and tabular readouts (mirrors the deck's
  vitals meters).

Appearance page loses the theme grid (D4) and keeps only the **accent (core-color)
swatches** + the accent-driven mini-bubble preview.

---

## 8. Weather, Mini-bubble, Overlay — the styled satellites

All three stay separate OS windows (D1) and all three import `system-shell.css`.

- **Weather board** — its readouts become **instruments**: condensed `--disp`
  temperature, hairline meters for humidity/wind/precip, mono day labels, `--core` for
  the "now" marker. When invoked *from chat*, the same component renders as an **L3
  in-shell card** (one component, two hosts — the kernel already routes weather through
  `cardCtl`).
- **Mini-bubble** — keeps its hard constraint: **no `backdrop-filter`** (it renders murky
  on a 92px window). It reconciles by simulating glass with the **opaque-gradient recipe**
  (§11) and shares `--core` + the orb-energy language. It is the Core's *detached
  peripheral* — the same energy, shrunk. The six per-accent structures survive as
  `--core`-driven variants (they are already accent-keyed).
- **Notification overlay / overlay-card** — reskinned to `.glass` + hairline + grain,
  docked to a screen corner via the slot allocator (§9); shares the toast/chip component
  with the in-shell L3 transient.

---

## 9. The Slot Allocator — non-clutter, as a system (R4)

The brief's "camera must re-anchor to a corner or ghost when it's crowded" is
generalized into one small engine that *every* floating element uses, so clutter is
impossible by construction rather than by ad-hoc `if`s.

- The shell grid exposes named **slots**: `TL TR BL BR` (+ `CENTER` for focus layers).
- Each floating element declares a **priority** and a set of **acceptable slots**.
- The allocator assigns slots by priority; on collision the lower-priority element
  **re-anchors** to its next acceptable slot, or if none is free, **ghosts** (drops to
  ~35% opacity + `pointer-events:none` until hovered/activated).
- Example: open Weather (BR) + Camera-monitor (prefers BR, falls to TR) + a toast
  (TR, higher prio) → camera ghosts or slides to TL automatically.

This is the concrete "Non-Clutter Enforcement" mechanism, and it's reusable for the
camera, weather popout, toasts, and the chat peripheral dock.

---

## 10. Camera & Multimodal HUD Protocol

### 10.1 Persistent Viewfinder, two scales

- **Monitor mode (L2/L3):** a compact glass viewfinder anchored via the slot allocator —
  situational awareness, never full-bleed. Frosted, hairline-framed, physically anchored
  to the shell grid.
- **Fullscreen precision mode (L4):** click the viewfinder (or voice) to expand to a
  dedicated HD inspection mode (circuit boards, documents). Engine throttles while it's
  opaque-covering (§12). Click-out / voice collapses it back to Monitor with the same
  pull-back easing.

### 10.2 Non-clutter behavior

Camera uses §9: with Weather + deck also present it auto-re-anchors to a free corner and
**ghosts** (reduces opacity) when it isn't the active focus, exactly per the brief.

### 10.3 Ambient scene-watcher (D3) — "preemptive perception"

Pipeline, event-driven not per-frame:

1. **On-device frame-diff:** downscale the live frame to ~64px and compute a cheap delta
   each ~500ms — *no model, negligible cost*.
2. **Change gate:** when delta exceeds a threshold and then **stabilizes ~1s** (you held
   something up and steadied it), fire **one** local-vision pass.
3. **Confidence gate:** only if the vision result is a high-confidence, *actionable*
   scene (document / bill / product / whiteboard) do we surface **one** suggestion.
4. **Suggestion chip (L3):** e.g. *"I see a bill — scan & log it?"* with Accept / Dismiss.
   Accept routes into existing actions (`see_camera`, `focus_object`, `make_3d`, or a new
   `scan_document` intent).
5. **Throttle:** a minimum interval between passes; watcher pauses when the app is
   backgrounded or on battery-saver (optional toggle).

### 10.4 Privacy, first-class

A visible **"watching" state** (a pulsing `--core` dot on the viewfinder + a marginalia
indicator) whenever the scene-watcher is armed, and a **mute** toggle that stops all
analysis. The camera frame never leaves the device for the watcher (local model only).

### 10.5 Multimodal integration

The viewfinder feed is the **primary sensor**. Vision runs locally; suggestions and
answers flow into the same chat transcript so camera, voice, and text are one
conversation, not three modes.

---

## 11. Accessibility & fallback matrix

Consolidates fallbacks that are currently scattered across files into one policy in
`system-shell.css`.

| Condition | Glass | Motion | Chromatic aberration |
|-----------|-------|--------|----------------------|
| Modern Win11 | real `backdrop-filter` blur+saturate | full pull-back | subtle on |
| **Win10 / no backdrop-filter** (`html[data-os=win10]`) | **opaque layered-gradient** glass (the mini-bubble's proven trick) | brightness+opacity defocus, no blur | off |
| `prefers-reduced-motion` | unchanged | **opacity-only**, no scale/blur | off |
| `prefers-reduced-transparency` | solid `--void`-derived fills | full | off |
| `prefers-contrast: more` | raise hairline + text contrast | full | off |

The existing `data-os` detection (`getShellStyle().osVariant`) already drives the Win10
branch and is reused verbatim.

## 12. Performance / the compositor

The engine keeps rendering behind the HUD, so we bound its cost:

- When a layer crosses the **occlusion threshold** — `--glass-density ≥ .92` (§3.5):
  Camera-fullscreen always, Settings when maximized-small or on battery-saver — the shell
  **throttles/pauses** the deck's WebGL loop via the existing `deckSetActive` contract.
  The engine is effectively invisible, so it shouldn't burn GPU.
- When a translucent focus layer is up (Chat/Settings glass), the engine keeps running
  but the shell may **drop its target FPS** (it's blurred and dimmed, detail is wasted).
- One place decides this — the §4.2 reducer — from `shell.focus`.

---

## 13. Component & file inventory (architecture, not code)

**New**

- `renderer/system-shell.css` — tokens, `.glass`, grid, type ramp, grain, `--ca`, fallbacks.
- `renderer/system-shell.js` — the shell reducer: `shell` state → z-layers,
  `--focus-depth` driver, slot allocator, engine throttle, marginalia dimming.
- `renderer/slot-allocator.js` (or a function inside shell.js) — §9.
- `renderer/scene-watcher.js` — §10.3 frame-diff + change/confidence gates + chip.

**Changed**

- `renderer/index.html` — engine promoted to L0 full-bleed; Chat/Settings/Camera become
  L2 layers; marginalia frame; imports `system-shell.css`; retires tabs/modal/scrim chrome.
- `renderer/weather-board.html`, `mini-overlay.html`, `overlay.html`, `overlay-card.html`,
  `research-overlay.html` — import `system-shell.css`, reskin to glass+hairline; satellite
  materialize entrance.
- `nexus-deck.html` — **unchanged** (black box; still driven by `driveState`). Optionally
  gains a documented camera-dolly message *later* (R2), not now.
- `main.js` — no structural change; may pass a `--focus-depth`-style hint to satellites
  for the materialize direction (optional).

## 14. Phased implementation roadmap (for the plan)

1. **Foundation** — `system-shell.css` + tokens + `.glass` + grid + fallbacks; engine to
   L0 full-bleed; the `--focus-depth` motion spine + shell reducer. *Ship: Orb + Chat
   with real pull-back.*
2. **Chat layer** — transcript redesign, peripheral dock, minimize choreography.
3. **Settings layer** — modal → focus layer; appearance page trimmed to accents.
4. **Satellites** — weather / mini-bubble / overlay adopt the shared css + materialize.
5. **Slot allocator** — formalize §9; wire weather + toasts + chat dock through it.
6. **Camera HUD** — viewfinder monitor/fullscreen, ghost/re-anchor, then the ambient
   scene-watcher + privacy + multimodal wiring.

Each phase is independently shippable and leaves the app coherent.

## 15. Open questions / risks

- **Engine-behind-everything cost.** Running WebGL under a blurred glass layer on low-end
  GPUs — mitigated by §12, but needs a measured FPS floor before Phase 2 sign-off.
- **`backdrop-filter` + WebGL stacking** on Win10/older Electron can be flaky; the opaque
  fallback (§11) is the safety net and should be validated early.
- **Scene-watcher false positives** — the confidence gate must be conservative; a wrong
  "I see a bill" is worse than silence. Start strict, loosen with data.
- **Local vision model availability** — proactive perception assumes a local vision model
  is installed; when absent, the watcher silently disables and the camera stays on-demand.
- **Third font — resolved:** IBM Plex Sans is vendored for chat prose (R1).
- **Focus-layer opacity — resolved:** Dynamic Translucency (§3.5) replaces a fixed
  translucent-vs-opaque choice; opacity is contextual per surface.

## 16. Success criteria

- Chat, Settings, Weather, Camera, and the mini-bubble are visibly **one system** — same
  glass, grid, type, glow — with no rounded "web-app" chrome remaining.
- Switching Orb ↔ Chat reads as a **camera pull-back**, not a cut.
- No floating element can ever occlude another without re-anchoring or ghosting.
- The camera can proactively, *and privately*, offer a relevant action when the scene
  warrants — and stays silent otherwise.
- One stylesheet + one reducer own the look and the motion; adding a new surface means
  importing the css and declaring a slot, nothing more.
