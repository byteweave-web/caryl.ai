# Unified OS Phase 5 — Slot Allocator: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** The non-clutter engine of spec §9 — named corner slots, priorities, re-anchor/ghost on collision — wired to its first three consumers: the chat dock (BL), a new shell toast (TR transient), and satellite-window occupancy (weather board / overlay card mark the shell corners they cover).

**Architecture:** Pure core, thin runtime — twice. In the renderer: `slot-allocator.js` (pure, node-tested) + `Shell.slots`/`Shell.toast` in `system-shell.js` applying placements to four static `.slotzone` hosts. In the main process: `lib/shell-slots.js` (pure geometry/classification, node-tested) + a debounced `publish()` broadcast that `lib/kernel/overlay.js` triggers, received in the renderer over one new preload line.

**Tech Stack:** Vanilla renderer JS (`<script>` tags, no bundler) · plain `node + assert` tests · offscreen-Electron probe harness (`tools/probe_shell.js`).

**Spec:** `docs/superpowers/specs/2026-07-08-unified-os-phase5-slot-allocator.md`

## Global Constraints

- **No new npm dependencies.**
- **Never sweep-commit:** `git add` ONLY the files each task lists. `main.js`, `preload.js`, `lib/cameraUi.js`, `lib/config.js`, `renderer/wakeword.js`, `tests/test-camera-ui.js`, `tests/test-grounding.js` carry unrelated in-flight edits — **`main.js` is not touched at all**; `preload.js` is touched by exactly one task via a surgically staged patch (Task 5).
- **Canonical tokens (verbatim, already in system-shell.css):** `--core:#58C6FF` · `--gutter:30px` · z-contract L3 = `30`.
- **Ghost recipe (spec-verbatim):** `filter:opacity(.35)` + `pointer-events:none`; hover-reveal `opacity(.92)` + interactive. `pointer-events` uses `!important` (OS-level override); the dim uses `filter` so it *multiplies* with an element's own opacity (a hidden dock stays hidden while ghosted).
- **Priorities:** toast `90` · camera `50` (reserved for Phase 6) · chat dock `20`.
- **Occupancy:** corner regions `380×280`, top pair inset `64px`; a slot is occupied at `≥ 25%` coverage; publish debounce `150ms`; event channel `shell:satellites`.
- Probe runs: `node_modules/.bin/electron tools/probe_shell.js --probe=tools/probes/<name>.js --wait=1800` — exit 0 + `RESULT: PASS`. One pre-existing deprecation warning is printed by the harness; ignore it. Do NOT run full `npm test` (it includes the in-flight-modified suites); run the targeted node suites + probes listed per task.

---

### Task 1: The pure allocator

**Files:**
- Create: `renderer/slot-allocator.js`
- Create: `tests/test-slot-allocator.js`
- Modify: `package.json` (test chain)

**Interfaces:**
- Consumes: nothing (pure, no imports).
- Produces: `window.SlotAllocator` (browser) **and** `module.exports` (node) with:
  - `SLOTS: ['TL','TR','BL','BR','CENTER']`
  - `allocate(elements, external) → { placements: {id:{slot,ghost}}, zones: {TL:[ids],TR:[],BL:[],BR:[],CENTER:[]}, ghosted: [ids] }`
    - `elements: [{id:string, priority:number, slots:string[]}]` (preference order), `external: string[]`.

- [ ] **Step 1: Write the failing test**

Create `tests/test-slot-allocator.js`:

```js
// tests/test-slot-allocator.js
// Pure tests for the Unified OS slot allocator (spec §9). node + assert.
const assert = require('assert');
const A = require('../renderer/slot-allocator');

// solo element takes its preferred slot, solid
let r = A.allocate([{ id: 'cam', priority: 50, slots: ['BR', 'TR'] }], []);
assert.deepStrictEqual(r.placements.cam, { slot: 'BR', ghost: false }, 'solo -> preferred');

// higher priority evicts: lower re-anchors to its next acceptable slot
r = A.allocate([
  { id: 'cam', priority: 50, slots: ['BR', 'TR', 'TL'] },
  { id: 'toast', priority: 90, slots: ['BR'] },
], []);
assert.deepStrictEqual(r.placements.toast, { slot: 'BR', ghost: false }, 'high prio wins BR');
assert.deepStrictEqual(r.placements.cam, { slot: 'TR', ghost: false }, 'low prio re-anchors');

// external occupancy blocks a slot outright
r = A.allocate([{ id: 'cam', priority: 50, slots: ['BR', 'TR'] }], ['BR']);
assert.deepStrictEqual(r.placements.cam, { slot: 'TR', ghost: false }, 'external -> re-anchor');

// nothing free -> ghost IN PLACE at the preferred slot, after the solid occupant
r = A.allocate([
  { id: 'toast', priority: 90, slots: ['TR'] },
  { id: 'cam', priority: 50, slots: ['TR'] },
], []);
assert.deepStrictEqual(r.placements.cam, { slot: 'TR', ghost: true }, 'no slot free -> ghost in place');
assert.deepStrictEqual(r.ghosted, ['cam'], 'ghost list');
assert.deepStrictEqual(r.zones.TR, ['toast', 'cam'], 'zone hosts solid first, then ghost');

// everything acceptable externally covered -> ghost at home
r = A.allocate([{ id: 'dock', priority: 20, slots: ['BL'] }], ['BL']);
assert.deepStrictEqual(r.placements.dock, { slot: 'BL', ghost: true }, 'external-only -> ghost at home');

// priority ties keep input (registration) order
r = A.allocate([
  { id: 'a', priority: 50, slots: ['TL', 'TR'] },
  { id: 'b', priority: 50, slots: ['TL', 'TR'] },
], []);
assert.strictEqual(r.placements.a.slot, 'TL', 'tie: first registered wins TL');
assert.strictEqual(r.placements.b.slot, 'TR', 'tie: second takes next');

// unknown slot names are filtered; an empty acceptable list -> {slot:null, ghost:true}
r = A.allocate([{ id: 'x', priority: 10, slots: ['NOPE', 'TL'] }], []);
assert.deepStrictEqual(r.placements.x, { slot: 'TL', ghost: false }, 'unknown names filtered');
r = A.allocate([{ id: 'x', priority: 10, slots: ['NOPE'] }], []);
assert.deepStrictEqual(r.placements.x, { slot: null, ghost: true }, 'no valid slots -> null+ghost');

// CENTER is a modelled slot (external CENTER occupancy is representable)
r = A.allocate([{ id: 'x', priority: 10, slots: ['CENTER'] }], ['CENTER']);
assert.deepStrictEqual(r.placements.x, { slot: 'CENTER', ghost: true }, 'CENTER blockable');

// releasing = allocating without the element (pure function: absence is release)
r = A.allocate([{ id: 'cam', priority: 50, slots: ['BR'] }], []);
assert.strictEqual(r.placements.cam.slot, 'BR', 'cam returns to BR once toast is gone');

// junk inputs never throw
assert.doesNotThrow(function () { A.allocate(null, null); A.allocate([{}], undefined); });

console.log('test-slot-allocator: OK');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/test-slot-allocator.js`
Expected: FAIL — `Cannot find module '../renderer/slot-allocator'`.

- [ ] **Step 3: Write the allocator**

Create `renderer/slot-allocator.js`:

```js
// renderer/slot-allocator.js
// Pure, DOM-free corner-slot allocation for the Unified OS (spec §9): named slots,
// priorities, acceptable-slot lists, re-anchor on collision, ghost when nothing is free.
// Dual-exported: window.SlotAllocator (renderer <script>) AND module.exports (node tests).
// Same input -> same output, no side effects. system-shell.js applies the output to the DOM.
(function (root) {
  'use strict';

  var SLOTS = ['TL', 'TR', 'BL', 'BR', 'CENTER'];

  function validSlots(list) {
    var out = [];
    (Array.isArray(list) ? list : []).forEach(function (s) {
      if (SLOTS.indexOf(s) >= 0 && out.indexOf(s) < 0) out.push(s);
    });
    return out;
  }

  // elements: [{id, priority, slots:[preference order]}]; external: slot names covered by
  // real satellite windows — absolutely unavailable. Higher priority wins; ties keep input
  // order. An element with no free acceptable slot ghosts IN PLACE at its preferred slot
  // (slots[0]) — visible at 35%, never vanished. No valid slots at all -> {slot:null, ghost}.
  function allocate(elements, external) {
    var ext = validSlots(external);
    var els = (Array.isArray(elements) ? elements : [])
      .filter(function (e) { return e && typeof e.id === 'string' && e.id; })
      .map(function (e, i) { return { id: e.id, priority: +e.priority || 0, slots: validSlots(e.slots), order: i }; });
    els.sort(function (a, b) { return (b.priority - a.priority) || (a.order - b.order); });

    var taken = {};
    var placements = {};
    var zones = { TL: [], TR: [], BL: [], BR: [], CENTER: [] };
    var ghosted = [];

    els.forEach(function (e) {
      var slot = null;
      for (var i = 0; i < e.slots.length; i++) {
        var s = e.slots[i];
        if (ext.indexOf(s) < 0 && !taken[s]) { slot = s; break; }
      }
      if (slot) {
        taken[slot] = e.id;
        placements[e.id] = { slot: slot, ghost: false };
        zones[slot].push(e.id);
      } else {
        var home = e.slots.length ? e.slots[0] : null;
        placements[e.id] = { slot: home, ghost: true };
        if (home) zones[home].push(e.id);
        ghosted.push(e.id);
      }
    });

    return { placements: placements, zones: zones, ghosted: ghosted };
  }

  var api = { allocate: allocate, SLOTS: SLOTS };
  root.SlotAllocator = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node tests/test-slot-allocator.js`
Expected: `test-slot-allocator: OK`

- [ ] **Step 5: Wire into the suite**

In `package.json`, in the `"test"` script, insert `node tests/test-slot-allocator.js && ` immediately after `node tests/test-shell-reducer.js && `.

- [ ] **Step 6: Commit**

```bash
git add renderer/slot-allocator.js tests/test-slot-allocator.js package.json
git commit -m "feat(shell): pure corner-slot allocator (priority, re-anchor, ghost) + tests (Phase 5)"
```

---

### Task 2: Slot zones + `Shell.slots` runtime + the chat dock joins

**Files:**
- Create: `tools/probes/slots.js`
- Modify: `renderer/system-shell.css` (zone/ghost rules)
- Modify: `renderer/system-shell.js` (Shell.slots)
- Modify: `renderer/index.html` (script tag, zone divs, dock CSS trim, dock claim)

**Interfaces:**
- Consumes: `window.SlotAllocator.allocate/SLOTS` (Task 1); zones `#slot-TL #slot-TR #slot-BL #slot-BR`.
- Produces: `Shell.slots.claim(id, {priority, slots, el})` · `Shell.slots.release(id)` · `Shell.slots.external(list)` · `Shell.slots.get() → {placements, ghosted, external}`; `shell:slots` CustomEvent; elements carry `data-slot` + `.ghosted`; zones carry `.has-ghost`.

- [ ] **Step 1: Write the failing probe**

Create `tools/probes/slots.js`:

```js
(async function () {
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  await sleep(300); // DOMContentLoaded work (the dock claim) has run by now
  var out = {};
  var S = window.Shell && window.Shell.slots;
  out.api = !!(S && S.claim && S.release && S.external && S.get);
  if (!out.api) return JSON.stringify({ pass: false, detail: out });

  // the chat dock is a citizen already (claimed on DOMContentLoaded, BL)
  var dock = document.getElementById('chat-dock');
  out.dockSlot = dock && dock.dataset.slot;
  out.dockInZone = !!(dock && dock.parentElement && dock.parentElement.id === 'slot-BL');

  // fake camera element: prefers BR, accepts TR/TL
  var cam = document.createElement('div'); cam.id = 'probe-cam'; cam.textContent = 'CAM';
  S.claim('probe-cam', { priority: 50, slots: ['BR', 'TR', 'TL'], el: cam });
  out.camSolo = cam.dataset.slot + ':' + cam.classList.contains('ghosted'); // "BR:false"

  // higher-priority element takes BR -> camera re-anchors to TR
  var chip = document.createElement('div'); chip.id = 'probe-chip'; chip.textContent = 'CHIP';
  S.claim('probe-chip', { priority: 90, slots: ['BR'], el: chip });
  out.chipSlot = chip.dataset.slot;                       // BR
  out.camReanchored = cam.dataset.slot;                   // TR
  out.camInTR = !!(cam.parentElement && cam.parentElement.id === 'slot-TR');

  // satellites cover TR and TL -> camera has nowhere -> ghosts at its preferred BR
  S.external(['TR', 'TL']);
  out.camGhost = cam.classList.contains('ghosted');
  out.camGhostSlot = cam.dataset.slot;                    // BR (in place, under the chip)
  out.zoneHasGhost = document.getElementById('slot-BR').classList.contains('has-ghost');
  out.externalEcho = (S.get().external || []).join(',');  // "TR,TL"

  // satellites leave -> camera un-ghosts back to TR
  S.external([]);
  out.camBack = cam.dataset.slot + ':' + cam.classList.contains('ghosted'); // "TR:false"

  // chip releases -> camera returns to BR; the chip element left the zones
  S.release('probe-chip');
  out.camHome = cam.dataset.slot;                          // BR
  out.chipGone = !chip.parentElement;

  S.release('probe-cam');

  var pass = out.dockSlot === 'BL' && out.dockInZone &&
             out.camSolo === 'BR:false' && out.chipSlot === 'BR' &&
             out.camReanchored === 'TR' && out.camInTR === true &&
             out.camGhost === true && out.camGhostSlot === 'BR' && out.zoneHasGhost === true &&
             out.externalEcho === 'TR,TL' &&
             out.camBack === 'TR:false' && out.camHome === 'BR' && out.chipGone === true;
  return JSON.stringify({ pass: pass, detail: out });
})()
```

- [ ] **Step 2: Run the probe to verify it fails**

Run: `node_modules/.bin/electron tools/probe_shell.js --probe=tools/probes/slots.js --wait=1800`
Expected: `RESULT: FAIL` — `api:false` (`Shell.slots` doesn't exist yet).

- [ ] **Step 3: Zone + ghost CSS**

Append to `renderer/system-shell.css`:

```css
/* ---- Phase 5: the slot layer (spec §9) — corner zones, ghosting ---- */
/* Zones are the L3 hosts the allocator reparents floating HUD elements into. The zone
   positions; the element acts. Zones are pointer-transparent; interactivity belongs to
   their children (and to the zone itself only while it hosts a ghost — hover-reveal). */
.slotzone{ position:fixed; z-index:30; display:flex; flex-direction:column; gap:10px;
  pointer-events:none; max-width:40vw; }
.slotzone[data-zone="TL"]{ top:calc(var(--gutter) + 48px); left:var(--gutter); align-items:flex-start; }
.slotzone[data-zone="TR"]{ top:calc(var(--gutter) + 48px); right:var(--gutter); align-items:flex-end; }
.slotzone[data-zone="BL"]{ bottom:var(--gutter); left:var(--gutter); align-items:flex-start; }
.slotzone[data-zone="BR"]{ bottom:var(--gutter); right:var(--gutter); align-items:flex-end; }
/* Ghosting (spec §9): filter multiplies with the element's own opacity, so a hidden
   element stays hidden while ghosted. pointer-events is an OS-level override (!important
   beats e.g. .chat-dock.on). A zone hosting a ghost becomes its hover-reveal surface. */
.ghosted{ filter:opacity(.35); pointer-events:none !important; transition:filter .3s ease; }
.slotzone.has-ghost{ pointer-events:auto; }
.slotzone.has-ghost:hover .ghosted{ filter:opacity(.92); pointer-events:auto !important; }
@media (prefers-reduced-motion: reduce){ .ghosted{ transition:none; } }
```

- [ ] **Step 4: The runtime — `Shell.slots` in system-shell.js**

In `renderer/system-shell.js`, insert between the end of `function apply() {…}` and `var Shell = {`:

```js
  // ---- Phase 5: the slot layer (spec §9) ----
  // Pure allocation lives in slot-allocator.js; this applies placements to the DOM:
  // reparent each claimed element into its corner zone, stamp data-slot, toggle ghosting.
  var claims = {};      // id -> { priority, slots, el }
  var externalSlots = []; // slot names covered by satellite windows (absolute)

  function zoneEl(slot) { return document.getElementById('slot-' + slot); }

  function claimList() {
    return Object.keys(claims).map(function (id) {
      return { id: id, priority: claims[id].priority, slots: claims[id].slots };
    });
  }

  function applySlots() {
    if (!window.SlotAllocator) return;
    var out = window.SlotAllocator.allocate(claimList(), externalSlots);
    Object.keys(out.placements).forEach(function (id) {
      var c = claims[id]; if (!c || !c.el) return;
      var p = out.placements[id];
      var zone = p.slot && zoneEl(p.slot);
      if (zone && c.el.parentElement !== zone) zone.appendChild(c.el);
      if (p.slot) c.el.dataset.slot = p.slot; else delete c.el.dataset.slot;
      c.el.classList.toggle('ghosted', !!p.ghost);
    });
    // A zone "has a ghost" when any current child is ghosted (it becomes the hover surface).
    ['TL', 'TR', 'BL', 'BR'].forEach(function (s) {
      var z = zoneEl(s); if (!z) return;
      z.classList.toggle('has-ghost', !!z.querySelector('.ghosted'));
    });
    try { document.dispatchEvent(new CustomEvent('shell:slots', { detail: Slots.get() })); } catch (_e) {}
  }

  var Slots = {
    // A claim is an upsert; the claim owns the element's placement from here on.
    claim: function (id, spec) {
      if (!id || !spec || !spec.el) return;
      claims[id] = { priority: +spec.priority || 0, slots: (spec.slots || []).slice(), el: spec.el };
      applySlots();
    },
    // Release also removes the element from its zone (it was ours to place).
    release: function (id) {
      var c = claims[id];
      if (!c) return;
      delete claims[id];
      if (c.el) {
        c.el.classList.remove('ghosted');
        delete c.el.dataset.slot;
        if (c.el.parentElement && c.el.parentElement.classList.contains('slotzone')) c.el.remove();
      }
      applySlots();
    },
    external: function (list) {
      externalSlots = Array.isArray(list) ? list.slice() : [];
      applySlots();
    },
    get: function () {
      var out = window.SlotAllocator
        ? window.SlotAllocator.allocate(claimList(), externalSlots)
        : { placements: {}, zones: {}, ghosted: [] };
      return { placements: out.placements, ghosted: out.ghosted, external: externalSlots.slice() };
    },
  };
```

Then add `slots: Slots,` to the `Shell` object literal, directly under `state: state,`:

```js
  var Shell = {
    state: state,
    slots: Slots,
    setFocus: function (name) {
```

- [ ] **Step 5: index.html — load the allocator, add zones, the dock joins**

(a) In `<head>`, directly after `<script src="shell-reducer.js"></script>`:

```html
<script src="slot-allocator.js"></script>
```

(b) In the inline `<style>`, the `.chat-dock` rule drops its hardcoded anchor. Replace:

```css
.chat-dock{position:absolute;left:var(--gutter,30px);bottom:var(--gutter,30px);max-width:340px;
```

with:

```css
.chat-dock{max-width:340px;  /* positioned by its slot zone (Shell.slots, spec §9) */
```

(c) After the closing `</div>` of `<div class="app">` (immediately before `<aside class="settings glass" id="settings">`), add:

```html
<!-- L3 slot layer: the non-clutter corner allocator's zones (spec §9). Shell.slots
     reparents floating HUD elements into these; the zone positions, the element acts. -->
<div class="slotzone" data-zone="TL" id="slot-TL"></div>
<div class="slotzone" data-zone="TR" id="slot-TR"></div>
<div class="slotzone" data-zone="BL" id="slot-BL"></div>
<div class="slotzone" data-zone="BR" id="slot-BR"></div>
```

(d) In the main `<script>` block, directly after the line `window.updateChatDock = updateChatDock;`:

```js
// The dock is a slot-allocator citizen: BL is its identity (the Orb's peripheral vision,
// spec §6.3) — it ghosts rather than re-anchors when a satellite window covers that corner.
// DOMContentLoaded runs after deferred scripts, so Shell exists by now.
document.addEventListener('DOMContentLoaded', function () {
  try {
    var d = document.getElementById('chat-dock');
    if (d && window.Shell && Shell.slots) Shell.slots.claim('chat-dock', { priority: 20, slots: ['BL'], el: d });
  } catch (_e) {}
});
```

- [ ] **Step 6: Run the probe to verify it passes**

Run: `node_modules/.bin/electron tools/probe_shell.js --probe=tools/probes/slots.js --wait=1800`
Expected: `RESULT: PASS`.

- [ ] **Step 7: Regression — the dock still behaves**

```bash
node tests/test-shell-reducer.js && node tests/test-slot-allocator.js
node_modules/.bin/electron tools/probe_shell.js --probe=tools/probes/dock.js --wait=2600
node_modules/.bin/electron tools/probe_shell.js --probe=tools/probes/motion.js --wait=2600
```
Expected: both node suites OK; both probes `RESULT: PASS` (the dock probe is the reparenting canary).

- [ ] **Step 8: Commit**

```bash
git add tools/probes/slots.js renderer/system-shell.css renderer/system-shell.js renderer/index.html
git commit -m "feat(shell): slot zones + Shell.slots runtime — chat dock becomes a slot citizen (Phase 5)"
```

---

### Task 3: `Shell.toast` — the L3 transient chip

**Files:**
- Create: `tools/probes/toast.js`
- Modify: `renderer/system-shell.js` (Shell.toast)
- Modify: `renderer/system-shell.css` (.shell-toast)
- Modify: `renderer/index.html` (setHint bridge)

**Interfaces:**
- Consumes: `Shell.slots.claim/release` (Task 2).
- Produces: `Shell.toast(text, {ms=3200})` — single reusable `.shell-toast.glass` element, claim id `'toast'`, priority `90`, slots `['TR','TL','BR']`; auto-release; re-toast resets the timer. Phase 6's suggestion chips extend this element.

- [ ] **Step 1: Write the failing probe**

Create `tools/probes/toast.js`:

```js
(async function () {
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  await sleep(300);
  var out = {};
  out.api = !!(window.Shell && typeof window.Shell.toast === 'function');
  if (!out.api) return JSON.stringify({ pass: false, detail: out });

  // A toast claims TR, shows, and auto-releases after its ms.
  window.Shell.toast('probe toast', { ms: 700 });
  await sleep(120);
  var t = document.querySelector('.shell-toast');
  out.exists = !!t;
  out.inTR = !!(t && t.parentElement && t.parentElement.id === 'slot-TR');
  out.text = t && t.textContent;
  out.shown = !!(t && t.classList.contains('show'));
  out.glass = !!(t && t.classList.contains('glass'));

  await sleep(1100);
  out.releasedFromZone = !(t && t.parentElement && t.parentElement.classList &&
                           t.parentElement.classList.contains('slotzone'));

  // setHint with lockMs at Orb focus routes through the toast (the composer is invisible there).
  window.Shell.setFocus('orb');
  if (typeof setHint === 'function') {
    setHint('probe hint', 2000);
    await sleep(120);
    var t2 = document.querySelector('.shell-toast');
    out.hintToast = !!(t2 && /probe hint/.test(t2.textContent) &&
                       t2.parentElement && t2.parentElement.id === 'slot-TR');
  } else { out.hintToast = 'no setHint'; }

  var pass = out.exists && out.inTR && /probe toast/.test(out.text || '') && out.shown && out.glass &&
             out.releasedFromZone && out.hintToast === true;
  return JSON.stringify({ pass: pass, detail: out });
})()
```

- [ ] **Step 2: Run the probe to verify it fails**

Run: `node_modules/.bin/electron tools/probe_shell.js --probe=tools/probes/toast.js --wait=1800`
Expected: `RESULT: FAIL` — `api:false`.

- [ ] **Step 3: Toast CSS**

Append to `renderer/system-shell.css`:

```css
/* The shell toast: the single L3 transient chip (spec §9; Phase 6's suggestion chips
   extend it). Mono data-voice, a --core tick, cut from the shared glass. */
.shell-toast{ --e:3; font-family:var(--mono); font-size:11px; letter-spacing:.06em;
  color:var(--ink); padding:9px 14px 9px 12px; border-left:2px solid var(--core);
  max-width:340px; opacity:0; transform:translateY(-6px);
  transition:opacity .3s ease, transform .3s ease; }
.shell-toast.show{ opacity:1; transform:none; }
@media (prefers-reduced-motion: reduce){
  .shell-toast{ transition:opacity .2s linear; transform:none; }
}
```

- [ ] **Step 4: `Shell.toast` in system-shell.js**

Insert directly after the `var Slots = { … };` block (before `var Shell = {`):

```js
  // ---- Phase 5: the shell toast — the single L3 transient chip (spec §9) ----
  // One reusable element; a toast claims a corner at high priority and auto-releases.
  var toastEl = null, toastTimer = null;
  function toast(text, opts) {
    opts = opts || {};
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.className = 'shell-toast glass';
      toastEl.setAttribute('role', 'status');
      toastEl.setAttribute('aria-live', 'polite');
    }
    toastEl.textContent = String(text || '');
    Slots.claim('toast', { priority: 90, slots: ['TR', 'TL', 'BR'], el: toastEl });
    requestAnimationFrame(function () { if (toastEl) toastEl.classList.add('show'); });
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      toastTimer = null;
      if (toastEl) toastEl.classList.remove('show');
      Slots.release('toast');
    }, Math.max(600, +opts.ms || 3200));
  }
```

Then add `toast: toast,` to the `Shell` object literal, directly under `slots: Slots,`.

- [ ] **Step 5: setHint bridge in index.html**

Replace the whole `setHint` function:

```js
function setHint(text, lockMs){
  const h=document.querySelector('.hint'); if(!h) return;
  h.textContent=text;
  if(lockMs){ hintLocked=true; setTimeout(function(){ hintLocked=false; const h2=document.querySelector('.hint'); if(h2) h2.textContent=defaultHintText(); }, lockMs); }
}
```

with:

```js
function setHint(text, lockMs){
  const h=document.querySelector('.hint');
  if(h){
    h.textContent=text;
    if(lockMs){ hintLocked=true; setTimeout(function(){ hintLocked=false; const h2=document.querySelector('.hint'); if(h2) h2.textContent=defaultHintText(); }, lockMs); }
  }
  // Transient hints also surface as a shell toast when Chat isn't the focus — otherwise
  // "Opening camera…"/"Camera error" are written into an invisible composer (spec §9).
  if(lockMs && window.Shell && Shell.toast && Shell.state.focus!=='chat'){
    try{ Shell.toast(text, {ms:Math.min(lockMs,4000)}); }catch(_e){}
  }
}
```

- [ ] **Step 6: Run the probe to verify it passes**

Run: `node_modules/.bin/electron tools/probe_shell.js --probe=tools/probes/toast.js --wait=1800`
Expected: `RESULT: PASS`.

- [ ] **Step 7: Regression**

```bash
node_modules/.bin/electron tools/probe_shell.js --probe=tools/probes/slots.js --wait=1800
node_modules/.bin/electron tools/probe_shell.js --probe=tools/probes/interaction.js --wait=2600
```
Expected: 2× `RESULT: PASS`.

- [ ] **Step 8: Commit**

```bash
git add tools/probes/toast.js renderer/system-shell.js renderer/system-shell.css renderer/index.html
git commit -m "feat(shell): Shell.toast transient chip + setHint surfaces outside Chat (Phase 5)"
```

---

### Task 4: `lib/shell-slots.js` — satellite occupancy, pure core

**Files:**
- Create: `lib/shell-slots.js`
- Create: `tests/test-shell-slots.js`
- Modify: `package.json` (test chain)

**Interfaces:**
- Consumes: nothing (pure core; the Electron glue only touches `electron.BrowserWindow` when `publish` is called from the main process).
- Produces (for Task 5): `publish(electronMod)` — debounced (150ms) broadcast of `shell:satellites {slots:[…], sats:[…]}` to the main window; plus pure `pageOf(url)`, `cornerRegions(main, opt)`, `overlapArea(a,b)`, `occupiedSlots(main, satRects, opt)`, `computePublish(wins)` and constants `PAGES, MAIN_PAGE, REGION, RATIO`.

- [ ] **Step 1: Write the failing test**

Create `tests/test-shell-slots.js`:

```js
// tests/test-shell-slots.js
// Pure tests for satellite -> corner-slot occupancy (lib/shell-slots.js). node + assert.
const assert = require('assert');
const S = require('../lib/shell-slots');

const MAIN = { x: 0, y: 0, width: 1600, height: 900 };

// corner regions: sized by REGION (380x280), top pair inset 64px below the topbar
let r = S.cornerRegions(MAIN);
assert.deepStrictEqual(r.TL, { x: 0, y: 64, width: 380, height: 280 }, 'TL region');
assert.deepStrictEqual(r.BR, { x: 1220, y: 620, width: 380, height: 280 }, 'BR region');
assert.deepStrictEqual(r.CENTER, { x: 400, y: 225, width: 800, height: 450 }, 'CENTER region');

// ratio boundary: BR region area = 380*280 = 106400; 25% = 26600 = 190x140
let sat = { x: 1600 - 190, y: 900 - 140, width: 400, height: 400 };
assert.deepStrictEqual(S.occupiedSlots(MAIN, [sat]), ['BR'], 'exact 25% occupies BR');
sat = { x: 1600 - 189, y: 900 - 140, width: 400, height: 400 };
assert.deepStrictEqual(S.occupiedSlots(MAIN, [sat]), [], 'just under 25% leaves BR free');

// the default centered weather board (65% of the work area) covers CENTER, not the corners
const board = { x: 280, y: 158, width: 1040, height: 585 };
assert.deepStrictEqual(S.occupiedSlots(MAIN, [board]), ['CENTER'], 'centered board -> CENTER only');

// a full-cover satellite occupies all five
assert.deepStrictEqual(S.occupiedSlots(MAIN, [MAIN]).sort(),
  ['BL', 'BR', 'CENTER', 'TL', 'TR'], 'full cover -> everything');

// no overlap (other monitor) -> nothing
assert.deepStrictEqual(S.occupiedSlots(MAIN, [{ x: 2000, y: 0, width: 500, height: 500 }]), [],
  'off-shell satellite -> all free');

// computePublish: classification + main-window detection
const wins = [
  { url: 'file:///C:/app/renderer/index.html', bounds: MAIN, visible: true },
  { url: 'file:///C:/app/renderer/weather-board.html?x=1', bounds: board, visible: true },
  { url: 'file:///C:/app/renderer/unknown.html', bounds: board, visible: true },
  { url: 'file:///C:/app/renderer/overlay-card.html', bounds: { x: 0, y: 0, width: 10, height: 10 }, visible: false },
];
let p = S.computePublish(wins);
assert.deepStrictEqual(p, { slots: ['CENTER'], sats: ['weather'] }, 'classify + ignore unknown/invisible');

// no main window -> null (publish becomes a no-op)
assert.strictEqual(S.computePublish(wins.slice(1)), null, 'no main -> null');

// pageOf handles query strings and hashes
assert.strictEqual(S.pageOf('file:///a/b/weather-board.html?embed=1#x'), 'weather-board.html');

console.log('test-shell-slots: OK');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/test-shell-slots.js`
Expected: FAIL — `Cannot find module '../lib/shell-slots'`.

- [ ] **Step 3: Write the module**

Create `lib/shell-slots.js`:

```js
// lib/shell-slots.js
// Satellite occupancy for the Unified OS slot allocator (spec Phase 5): which corners of
// the MAIN window are physically covered by satellite windows (weather board, overlay
// card, bubble, HUD panel)? Pure geometry + classification up top (node-tested, zero
// Electron); the thin publish() glue at the bottom broadcasts `shell:satellites` to the
// main renderer, and hooks the involved windows so future moves re-publish themselves.
'use strict';

// Renderer page -> satellite name. Anything else (devtools, unknown pages) is ignored.
const PAGES = {
  'weather-board.html': 'weather',
  'overlay-card.html': 'card',
  'mini-overlay.html': 'mini',
  'overlay.html': 'overlay',
  'research-overlay.html': 'research',
};
const MAIN_PAGE = 'index.html';

const REGION = { w: 380, h: 280, topInset: 64 }; // corner probe boxes (topbar-aware)
const RATIO = 0.25;                              // >= this coverage occupies the slot

function pageOf(url) {
  const m = /\/([^\/?#]+\.html)(?:[?#]|$)/i.exec(String(url || ''));
  return m ? m[1].toLowerCase() : '';
}

function cornerRegions(main, opt) {
  const o = Object.assign({}, REGION, opt || {});
  const w = Math.min(o.w, main.width), h = Math.min(o.h, main.height);
  const top = main.y + o.topInset;
  return {
    TL: { x: main.x, y: top, width: w, height: h },
    TR: { x: main.x + main.width - w, y: top, width: w, height: h },
    BL: { x: main.x, y: main.y + main.height - h, width: w, height: h },
    BR: { x: main.x + main.width - w, y: main.y + main.height - h, width: w, height: h },
    CENTER: {
      x: main.x + Math.round(main.width * .25), y: main.y + Math.round(main.height * .25),
      width: Math.round(main.width * .5), height: Math.round(main.height * .5),
    },
  };
}

function overlapArea(a, b) {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

// A slot is occupied when ANY satellite rect covers >= ratio of its region's area.
function occupiedSlots(main, satRects, opt) {
  const o = opt || {};
  const ratio = typeof o.ratio === 'number' ? o.ratio : RATIO;
  const regions = cornerRegions(main, o);
  const out = [];
  Object.keys(regions).forEach((slot) => {
    const region = regions[slot];
    const area = region.width * region.height;
    if (area <= 0) return;
    const covered = (satRects || []).some((s) => s && overlapArea(region, s) / area >= ratio);
    if (covered) out.push(slot);
  });
  return out;
}

// wins: [{url, bounds, visible}] -> { slots, sats } | null when no main window is found.
function computePublish(wins) {
  let main = null;
  const sats = [];
  (wins || []).forEach((w) => {
    if (!w || !w.visible) return;
    const page = pageOf(w.url);
    if (page === MAIN_PAGE) { main = w; return; }
    const name = PAGES[page];
    if (name) sats.push({ name, bounds: w.bounds });
  });
  if (!main || !main.bounds) return null;
  return {
    slots: occupiedSlots(main.bounds, sats.map((s) => s.bounds)),
    sats: sats.map((s) => s.name),
  };
}

// ---------------------------------------------------------------------------
// Electron glue. Everything below touches BrowserWindow; nothing above does.
// ---------------------------------------------------------------------------
const hooked = new WeakSet(); // windows whose geometry/visibility already re-publish
let timer = null;
let electronRef = null;

function snapshot(electron) {
  return electron.BrowserWindow.getAllWindows().map((w) => {
    try {
      return { url: w.webContents.getURL(), bounds: w.getBounds(), visible: w.isVisible(), _w: w };
    } catch (_e) { return null; }
  }).filter(Boolean);
}

// Broadcast current occupancy to the main renderer (debounced — show/hide/move bursts
// coalesce). Idempotently hooks every known window so future changes re-publish alone.
function publish(electron) {
  electronRef = electron || electronRef;
  if (!electronRef) return;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    let wins;
    try { wins = snapshot(electronRef); } catch (_e) { return; }
    const payload = computePublish(wins);
    wins.forEach((w) => {
      const page = pageOf(w.url);
      if (page !== MAIN_PAGE && !PAGES[page]) return;
      if (!hooked.has(w._w)) {
        hooked.add(w._w);
        ['move', 'resize', 'show', 'hide', 'closed', 'minimize', 'restore'].forEach((ev) => {
          try { w._w.on(ev, () => publish(electronRef)); } catch (_e) {}
        });
      }
      if (payload && page === MAIN_PAGE) {
        try { w._w.webContents.send('shell:satellites', payload); } catch (_e) {}
      }
    });
  }, 150);
}

module.exports = {
  PAGES, MAIN_PAGE, REGION, RATIO,
  pageOf, cornerRegions, overlapArea, occupiedSlots, computePublish, publish,
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node tests/test-shell-slots.js`
Expected: `test-shell-slots: OK`

- [ ] **Step 5: Wire into the suite**

In `package.json`, in the `"test"` script, insert `node tests/test-shell-slots.js && ` immediately after `node tests/test-slot-allocator.js && `.

- [ ] **Step 6: Commit**

```bash
git add lib/shell-slots.js tests/test-shell-slots.js package.json
git commit -m "feat(shell): satellite->corner occupancy core (pure geometry + publish glue) (Phase 5)"
```

---

### Task 5: Wire it — kernel windows publish, the shell listens

**Files:**
- Modify: `lib/kernel/overlay.js` (publish triggers)
- Modify: `renderer/system-shell.js` (onSatellites listener)
- Modify: `preload.js` (**one 3-line hunk, surgically staged** — the file carries unrelated in-flight edits that must NOT enter this commit)

**Interfaces:**
- Consumes: `require('../shell-slots').publish(electron())` (Task 4); `Shell.slots.external` (Task 2).
- Produces: end-to-end flow — board/card show/hide/move → `shell:satellites {slots,sats}` → `window.bridge.onSatellites` → `Shell.slots.external(slots)` + `Shell.state.satellites = sats`.

- [ ] **Step 1: overlay.js publishes on its window lifecycle**

In `lib/kernel/overlay.js`:

(a) Directly after `function electron() { return _electron || (_electron = require('electron')); }` add:

```js
// Phase 5 (Unified OS): whenever our satellite windows show/hide/move, tell the main
// renderer which shell corners they cover (the slot allocator ghosts/re-anchors around
// them). publish() self-hooks move/resize/etc. on every window it sees, so after the
// first call the windows keep the occupancy fresh on their own.
function publishSlots() { try { require('../shell-slots').publish(electron()); } catch (_e) {} }
```

(b) In `renderPending()`, directly after `w.showInactive();` add:

```js
  publishSlots();
```

(c) In `hidePending()`, at the end of the function (after the `if (p && p.win …) p.win.hide();` line) add:

```js
  publishSlots();
```

(d) In `destroy()`, at the end of the function (after `boardWin = null;`) add:

```js
  publishSlots();
```

- [ ] **Step 2: the shell listens (system-shell.js)**

In `renderer/system-shell.js`, directly after the `window.Shell = Shell;` line, add:

```js
  // Phase 5: satellite windows (weather board, overlay card) report which shell corners
  // they physically cover; in-shell elements yield via the allocator. Guarded — the
  // offscreen probe harness stubs the bridge with a callable proxy that never calls back.
  try {
    if (window.bridge && typeof window.bridge.onSatellites === 'function') {
      window.bridge.onSatellites(function (p) {
        state.satellites = (p && p.sats) || [];
        Slots.external((p && p.slots) || []);
      });
    }
  } catch (_e) {}
```

- [ ] **Step 3: the preload line — build, verify, and stage the surgical patch**

`preload.js` in the worktree carries unrelated in-flight edits (docgen/3D/research). Its committed (HEAD) version does NOT have them. The new line goes in a region untouched by those edits (after `onOverlayMode`), so a patch built against HEAD applies cleanly to the index while the worktree keeps everything.

(a) Edit the **worktree** `preload.js`: directly after the line
`  onOverlayMode: (cb) => ipcRenderer.on('overlay:mode', (_e, mode) => cb(mode)),`
insert:

```js
  // Unified OS Phase 5: satellite windows -> which shell corners they cover (slot allocator).
  onSatellites: (cb) => ipcRenderer.on('shell:satellites', (_e, p) => cb(p)),
```

(b) Build the index-only patch mechanically (Git Bash):

```bash
cd /d/brain-ai/brain-ai
mkdir -p .git/scratch
git show HEAD:preload.js > .git/scratch/preload.head.js
python - <<'EOF'
lines = open('.git/scratch/preload.head.js', encoding='utf-8').read().split('\n')
anchor = next(i for i, l in enumerate(lines) if 'onOverlayMode:' in l)
ins = ["  // Unified OS Phase 5: satellite windows -> which shell corners they cover (slot allocator).",
       "  onSatellites: (cb) => ipcRenderer.on('shell:satellites', (_e, p) => cb(p)),"]
out = lines[:anchor+1] + ins + lines[anchor+1:]
open('.git/scratch/preload.mine.js', 'w', encoding='utf-8', newline='\n').write('\n'.join(out))
EOF
git diff --no-index -- .git/scratch/preload.head.js .git/scratch/preload.mine.js > .git/scratch/preload.patch || true
python - <<'EOF'
p = open('.git/scratch/preload.patch', encoding='utf-8').read()
p = p.replace('.git/scratch/preload.head.js', 'preload.js').replace('.git/scratch/preload.mine.js', 'preload.js')
open('.git/scratch/preload.patch', 'w', encoding='utf-8', newline='\n').write(p)
EOF
git apply --cached .git/scratch/preload.patch
```

(c) **Verify the staged hunk is exactly the two new lines:**

```bash
git diff --cached --stat -- preload.js
```
Expected: `preload.js | 2 ++` — `1 file changed, 2 insertions(+)`. If it shows anything else: `git restore --staged preload.js` and repeat (b).

```bash
git diff --cached -- preload.js
```
Expected: one hunk, `+` lines are exactly the comment + `onSatellites` line.

- [ ] **Step 4: Node + probe verification**

```bash
node tests/test-shell-slots.js && node tests/test-slot-allocator.js && node tests/test-kernel.js && node tests/test-overlay-card.js
node_modules/.bin/electron tools/probe_shell.js --probe=tools/probes/slots.js --wait=1800
node_modules/.bin/electron tools/probe_shell.js --probe=tools/probes/toast.js --wait=1800
```
Expected: all four node suites OK (kernel + overlay-card prove overlay.js still loads/behaves); both probes PASS (the guarded listener is inert under the stub bridge).

- [ ] **Step 5: Commit (the staged preload hunk + the clean files)**

```bash
git add lib/kernel/overlay.js renderer/system-shell.js
git commit -m "feat(shell): satellite windows report corner occupancy to the slot allocator (Phase 5)"
git show --stat HEAD
```
Expected in the shown stat: exactly `lib/kernel/overlay.js`, `renderer/system-shell.js`, `preload.js (+2)`. `git status` still shows `preload.js` modified (the unrelated in-flight edits stay in the worktree, uncommitted).

---

### Task 6: Full regression (verification only, no commit)

- [ ] **Step 1: Node suites**

```bash
node tests/test-shell-reducer.js && node tests/test-slot-allocator.js && node tests/test-shell-slots.js && node tests/test-nexus-feed.js && node tests/test-kernel.js && node tests/test-overlay-card.js
```
Expected: all OK.

- [ ] **Step 2: The full probe deck**

```bash
for p in engine-l0 material dock transcript motion fallbacks interaction select live-orb settings-focus slots toast; do
  r=$(timeout 90 node_modules/.bin/electron tools/probe_shell.js --probe=tools/probes/$p.js --wait=2600 2>/dev/null | grep -E '^RESULT:')
  printf '%-15s %s\n' "$p" "$r"
done
for f in overlay-card.html weather-board.html overlay.html mini-overlay.html; do
  r=$(timeout 60 node_modules/.bin/electron tools/probe_shell.js --file=$f --probe=tools/probes/satellite-material.js --wait=1800 2>/dev/null | grep -E '^RESULT:')
  printf '%-20s %s\n' "$f" "$r"
done
```
Expected: 12× `RESULT: PASS` + 4× `RESULT: PASS`.

- [ ] **Step 3: Manual spot-check (report to Farouk, not blocking)**

Ask for weather → the board opens over the shell → if it covers a corner, the dock ghosts there and hover-reveals; open the camera from Orb focus → the "Opening camera…" toast appears top-right.

---

## Self-Review (done at plan time)

- **Spec coverage:** §4.1 pure allocator → Task 1 (all rules incl. ghost-in-place, ties, filtering); §4.2 runtime + toast → Tasks 2–3 (claim/release/external/get, shell:slots event, toast claim id/priority/slots per spec); §4.3 zones/material → Task 2 Step 3 (+48px topbar inset, L3 z:30, hover-reveal); §4.4 dock → Task 2 Steps 5b/5d (CSS trim + DOMContentLoaded claim, probe `dock.js` regression); §4.5 setHint bridge → Task 3 Step 5 (lockMs-only, non-chat only, 4000ms clamp); §4.6 occupancy → Tasks 4–5 (pure core + publish, overlay.js triggers, one-line preload, guarded listener, `Shell.state.satellites`); §7 testing → Tasks 1–6 map one-to-one to the spec's test list.
- **Placeholder scan:** none — every step is complete code or an exact command with expected output. The only conditional (“if it shows anything else”) has an exact recovery command.
- **Type consistency:** `allocate(elements, external)` shape identical across Task 1 test/source and Task 2 runtime; `Shell.slots.{claim,release,external,get}` names match probe `slots.js`; toast claim `{id:'toast', priority:90, slots:['TR','TL','BR']}` matches spec §4.2 and probe `toast.js` (TR expectation); `shell:satellites` channel string identical in `lib/shell-slots.js` publish, preload line, and nothing else; `publish(electron())` signature matches Task 4's export; `computePublish` win shape `{url,bounds,visible}` matches Task 4 test and snapshot(); `sats` names (`weather` etc.) match PAGES.
- **Geometry check (test math):** BR region `1220,620,380×280`; 25% of `106400` = `26600` = exactly `190×140` ✓; 65% board on `1600×900` = `280,158,1040×585` → TL overlap `100×186=18600` (17.5%, free) / CENTER overlap `800×450` (100%, occupied) ✓.
