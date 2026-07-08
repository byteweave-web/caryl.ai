# Unified OS — Phase 5: The Slot Allocator (non-clutter, as a system)

**Date:** 2026-07-08 · **Branch:** `nexus-deck-orb-tab` · **Status:** approved (continuation of the approved master spec §9)
**Parent spec:** `2026-07-07-unified-os-ui-design.md` (§9, §4.2, §8). Builds on Phases 1–4.

## 1. Problem

The brief demands **Non-Clutter Enforcement**: *"If multiple overlays are active (e.g. Weather +
Camera + Nexus Deck), the camera viewfinder must automatically re-anchor to a corner of the screen
or 'ghost' (reduce opacity) to prevent visual noise."* Today nothing enforces this:

- The chat peripheral dock is **hardcoded** to the lower-left (`.chat-dock{left/bottom:var(--gutter)}`).
- Transient messages (`setHint`) render **only inside the Chat composer** — invisible at Orb focus
  ("Opening camera…", "Camera error" are lost exactly when the user isn't in Chat).
- The kernel's satellite windows (weather board, overlay card) float **over** the shell and the shell
  has no idea which of its corners they cover.
- Phase 6's camera monitor viewfinder has nowhere to anchor and no ghosting mechanism to obey.

## 2. Goal

One small engine — the **slot allocator** — that every floating HUD element uses, so clutter is
impossible *by construction*: named corner slots, priorities, acceptable-slot lists, re-anchor on
collision, ghost when nothing is free. Wire the three §9 consumers: the **chat dock**, a new
**shell toast** (the L3 transient chip host Phase 6's suggestion chips will reuse), and **weather /
satellite occupancy** (the kernel's windows mark the shell corners they physically cover).

**Non-goals:** the camera viewfinder itself (Phase 6 — it only *consumes* this allocator);
repositioning satellite **windows** (they stay user-draggable OS windows; the allocator only makes
the *in-shell* elements yield to them); occupancy from the mini-bubble/HUD-panel windows (the
mechanism is generic — their wiring can be added by whoever next touches `main.js`, which is
carrying unrelated in-flight work this phase must not sweep into its commits).

## 3. Decisions (derived from the approved §9 + brief)

1. **Pure core, thin runtime** — same split as Phase 1: `renderer/slot-allocator.js` is a pure,
   DOM-free, node-tested module (`window.SlotAllocator` + `module.exports`); `system-shell.js`
   applies its output to the DOM.
2. **Slots** are `TL TR BL BR` + `CENTER`. Only the four corners get DOM zones; `CENTER` exists in
   the model for external occupancy (a centered weather board covers the shell's middle) and for
   Phase 6's camera-full veil to consult — no in-shell element anchors there.
3. **Slot zones are real DOM hosts** (`#slot-TL … #slot-BR`, class `.slotzone`, L3 `z:30`,
   `pointer-events:none`). Allocated elements are **reparented into their zone**; one positioning
   mechanism, no per-element coordinates. Zones sit inside the HUD gutter (`--gutter`), the top pair
   inset below the topbar.
4. **Ghosting** = `opacity:.35` + `pointer-events:none` (spec-verbatim). A zone hosting a ghost gets
   `pointer-events:auto` and reveals the ghost on hover (`opacity:.92`, interactive) — "until
   hovered/activated". Ghost rules use `!important`: ghosting is an OS-level override that must beat
   any element's own opacity styling (e.g. `.chat-dock.on`).
5. **Priorities** (higher wins): toast **90** · camera **50** (reserved, Phase 6) · chat dock **20**.
   External (satellite-window) occupancy is **absolute** — in-shell elements can never evict a real
   window physically covering the corner.
6. **Ghost-in-place:** an element with no free acceptable slot ghosts in its *preferred* slot
   (`slots[0]`) — it coexists at 35% under/beside the winner rather than vanishing.
7. **Satellite occupancy rides a push event** (`shell:satellites`), computed in the main process by
   a new pure-core module `lib/shell-slots.js` and driven by `lib/kernel/overlay.js` (the module
   that already owns the weather-board and overlay-card windows — both clean files). A shell corner
   counts as covered when a visible satellite window overlaps **≥ 25%** of that corner's region.
8. **Dirty-file discipline:** `main.js` is **not touched**. `preload.js` gains exactly **one line**
   (`onSatellites`), committed via a surgically staged patch so the unrelated in-flight preload work
   stays out of the commit.
9. **The reducer is untouched.** Slots are marginalia-level concerns orthogonal to focus/density;
   `Shell.slots.get()` satisfies §4.2's `shell.slots` observability.

## 4. Design

### 4.1 The pure allocator — `renderer/slot-allocator.js`

```
SLOTS = ['TL','TR','BL','BR','CENTER']

allocate(elements, external) → {
  placements: { [id]: { slot: 'TL'|'TR'|'BL'|'BR'|'CENTER'|null, ghost: bool } },
  zones:      { TL:[ids…], TR:[…], BL:[…], BR:[…], CENTER:[…] },   // render order per zone
  ghosted:    [ids…]
}
```

- `elements`: `[{ id, priority, slots }]` — `slots` is the acceptable list in preference order;
  unknown slot names are filtered out; an element with no valid slots gets
  `{slot:null, ghost:true}`.
- `external`: array of slot names that are absolutely unavailable (satellite-covered).
- Algorithm: sort by `priority` desc (ties keep input order); each element takes its first
  acceptable slot that is neither external nor already assigned this pass; if none, it ghosts in
  `slots[0]`. Pure, deterministic, no DOM.

### 4.2 The runtime — `Shell.slots` + `Shell.toast` (system-shell.js)

```
Shell.slots.claim(id, { priority, slots, el })   // register + (re)apply
Shell.slots.release(id)                          // unregister + re-apply
Shell.slots.external(list)                       // satellite occupancy (slot names)
Shell.slots.get()                                // { placements, external } — probes/observability
```

`apply()`: run `allocate`, reparent each claimed `el` into `#slot-<slot>` (ghost-in-place included),
stamp `el.dataset.slot`, toggle `.ghosted`, toggle each zone's `.has-ghost`, then dispatch a
`shell:slots` CustomEvent (same decoupling pattern as `shell:focus`).

`Shell.toast(text, {ms=3200})`: lazily creates the single `.shell-toast.glass` element, sets text,
claims `{id:'toast', priority:90, slots:['TR','TL','BR']}`, auto-releases after `ms` (re-toast
resets the timer). `role="status" aria-live="polite"`. This is the L3 transient chip host that
Phase 6's suggestion chips extend (Accept/Dismiss variant).

Satellite listener (guarded — works with the probe harness's stub bridge):
`window.bridge.onSatellites(p => { Shell.state.satellites = p.sats || []; Shell.slots.external(p.slots || []); })`
— `Shell.state.satellites` satisfies §4.2's `satellites` field observably.

### 4.3 The zones + material — system-shell.css & index.html

- Four static zone divs appended after `.app` in `index.html`.
- CSS in `system-shell.css` (the OS mechanism per §13): `.slotzone` fixed at the gutter corners
  (top pair inset `+48px` for the topbar), `z-index:30`, flex, `pointer-events:none`;
  `.ghosted`/`.has-ghost:hover` rules per decision 4; `.shell-toast` (mono 11px, `--core` left
  tick, glass) with a rise-in transition honoring reduced-motion.

### 4.4 The chat dock joins the allocator

- `.chat-dock` CSS drops its hardcoded `position:absolute;left;bottom` (the BL zone positions it).
- Markup stays `#chat-dock` (the dock probe keys on the id); on `DOMContentLoaded` `index.html`
  claims it: `Shell.slots.claim('chat-dock', {priority:20, slots:['BL'], el})`.
- Reparenting moves it out of `#view-orb`, so its "Orb-focus only" visibility — previously a side
  effect of `#view-orb`'s `display:none` — is already guaranteed by its own `.on` logic
  (`updateChatDock` only adds `.on` at orb focus and removes it otherwise; without `.on` the dock
  is `opacity:0; pointer-events:none`). No behavior change.

### 4.5 setHint → toast bridge (index.html)

Transient hints (`lockMs` set) also surface as a shell toast when Chat isn't the focus:
`if (lockMs && window.Shell && Shell.toast && Shell.state.focus !== 'chat') Shell.toast(text, {ms:Math.min(lockMs,4000)})`.
Default (non-transient) hint text never toasts.

### 4.6 Satellite occupancy — `lib/shell-slots.js` + `lib/kernel/overlay.js`

Pure core (node-tested, no Electron):

```
cornerRegions(mainBounds, {w=380, h=280, topInset=64}) → {TL,TR,BL,BR,CENTER: rects}
  // CENTER = the middle 50%×50% of mainBounds
occupiedSlots(mainBounds, satRects, {ratio=0.25}) → ['TR', 'CENTER', …]
  // a slot is occupied when ANY sat rect covers ≥ ratio of its region's area
computePublish(wins) → { slots:[…], sats:[…] } | null
  // wins: [{url, bounds, visible}] — classifies by page name
  // (weather-board→weather, overlay-card→card, mini-overlay→mini, overlay→overlay,
  //  research-overlay→research; index.html→the shell). null when no main window found.
```

Integration (`publish(electronMod)`, same file): enumerate `BrowserWindow.getAllWindows()`, feed
`computePublish`, send `shell:satellites {slots, sats}` to the main window's webContents, and
idempotently hook `move/resize/show/hide/closed` (WeakSet) on the involved windows to re-publish
(debounced 150ms). `lib/kernel/overlay.js` calls `publish()` after it shows, hides, or destroys its
windows — the board's user-drag already emits `moved`, which the self-hook catches.

Renderer side: preload's one new line
`onSatellites: (cb) => ipcRenderer.on('shell:satellites', (_e, p) => cb(p)),`.

## 5. Files touched

- **Create:** `renderer/slot-allocator.js` · `tests/test-slot-allocator.js` ·
  `lib/shell-slots.js` · `tests/test-shell-slots.js` · `tools/probes/slots.js`
- **Modify:** `renderer/system-shell.js` (Shell.slots/Shell.toast/onSatellites) ·
  `renderer/system-shell.css` (zones/ghost/toast rules) · `renderer/index.html` (zone divs,
  allocator script tag, dock CSS trim + claim, setHint bridge) · `lib/kernel/overlay.js`
  (publish calls) · `package.json` (two node tests join the chain) · `preload.js` (**one line**,
  surgically staged)
- **Not touched:** `main.js`, `renderer/shell-reducer.js`, `nexus-deck.html`, satellite HTML files.

## 6. Error handling / edge cases

- **Allocator input hygiene:** unknown slot names filtered; empty/invalid `slots` ⇒ `{slot:null,
  ghost:true}`; duplicate claim ids overwrite (a claim is an upsert); release of an unknown id is a
  no-op.
- **Priority ties:** input (registration) order wins — deterministic across re-applies.
- **Element removed from the DOM by other code:** a claim owns its element's placement — the next
  apply() reparents it back into its zone (`appendChild` re-adds). Elements that must truly leave
  the layer are `release()`d; release also removes the element from its zone (it was ours to place).
- **Satellite on another monitor / not overlapping:** geometric intersection yields no occupied
  slots — nothing ghosts.
- **Main window minimized/hidden:** publish still computes (bounds remain); harmless — nobody sees
  the shell.
- **No main window found** (`computePublish → null`): publish is a no-op.
- **Stub-bridge probes:** `bridge.onSatellites` resolves to a callable proxy in the offscreen
  harness — the listener never fires there; probes drive `Shell.slots.external()` directly.
- **Reduced motion:** ghost/toast transitions collapse to none via the existing media query.

## 7. Testing

- **`tests/test-slot-allocator.js`** (node): solo element takes preferred slot · higher priority
  evicts → lower re-anchors to next acceptable · external blocks a slot → re-anchor · nothing free
  → ghost-in-place at `slots[0]` · ties keep input order · unknown slot names filtered · empty
  slots ⇒ null+ghost · release frees (via a second allocate without the element) · CENTER usable as
  external.
- **`tests/test-shell-slots.js`** (node): corner regions sized/inset correctly · 25% ratio boundary
  (24% ⇒ free, 26% ⇒ occupied) · centered-board rect ⇒ CENTER occupied, corners free ·
  full-work-area rect ⇒ all five occupied · `computePublish` classifies pages, ignores unknown
  URLs, returns null without a main window, skips invisible windows.
- **`tools/probes/slots.js`** (offscreen harness, index.html): `Shell.slots` API present · fake
  element A `{50,[BR,TR]}` lands BR solid · fake B `{90,[BR]}` claims → B takes BR, A re-anchors TR
  · `external(['TR'])` → A ghosts in BR (zone `.has-ghost`) · `external([])` → A solid again ·
  `release(B)` → A returns to BR · `#chat-dock` claimed at BL with `data-slot="BL"` ·
  `Shell.toast('…',{ms:300})` appears in `#slot-TR` and auto-releases.
- **Regression:** all existing probes (engine-l0, material, dock, transcript, motion, fallbacks,
  interaction, select, live-orb, settings-focus, satellite-material×4) + the node suites that were
  green before this phase. The dock probe is the critical one (reparenting must not change its
  `.on`/text behavior).
- **Manual (Farouk):** ask for weather → board opens over the shell → the chat dock ghosts if the
  board covers BL, recovers on hover; camera-open toast appears top-right at Orb focus.
