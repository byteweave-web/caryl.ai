# Unified OS — Phase 3: Settings as a Focus-Layer

**Date:** 2026-07-08 · **Branch:** `nexus-deck-orb-tab` · **Status:** approved by Farouk
**Parent spec:** `2026-07-07-unified-os-ui-design.md` (§ Phase 3). Builds on Phases 1–2 + Live Orb.

## 1. Problem

Settings is still a **web-app modal**: an opaque `.settings` panel (`background:var(--panel)`,
880×580, z50) centered over a dark `.scrim` (`rgba(0,0,0,.5)` blur, z40), toggled by an `.open`
class in `openSettings()`/`closeSettings()`. It bypasses the Unified OS shell entirely — no camera
pull-back, no glass, no shared motion spine. It reads as a box that pops *in front of* the app
instead of a HUD that lives *inside* the same deep-space environment as the Orb.

## 2. Goal

Settings becomes a **focus-layer**, identical in mechanism to Chat (an L2 glass layer over the live
engine): summoning it pulls the engine back (the shared camera move) and raises a **frosted glass**
Settings HUD; the live engine keeps rendering, dimmed and blurred, behind it. No modal, no scrim.

**Non-goals (locked with Farouk):** *shell treatment only* — every settings page, control, and its
two-pane nav/content layout keeps its current markup and behavior. No content reflow (that's a
possible later phase). Camera focuses (Phase 6) untouched.

## 3. Locked decisions (Farouk)

1. **Scope:** shell treatment only — reskin the container + rewire entry/exit; do not touch settings
   content/controls.
2. **Entry:** keep the **gear icon**; it routes through `Shell.setFocus('settings')`. Topbar tabs
   stay `Orb / Chat` (Settings is a summoned utility, not a co-equal mode — no third tab).
3. **Exit:** Esc or the nav **Close** button (or clicking the gear again) returns to the focus you
   were in *before* opening Settings (Orb or Chat). Clicking the Orb/Chat tab also dismisses it.
   No click-outside-to-close.

## 4. Key insight — the shell was built for this

`renderer/shell-reducer.js` already fully specifies `settings`; **no reducer or `system-shell.js`
change is required**. `deriveShell({focus:'settings'})` already returns:

| field | value | effect |
|---|---|---|
| `focusDepthTarget` | `1` | engine does the shared camera pull-back (scale/blur/dim, eased `--focus-depth`) |
| `glassDensityTarget` | `0.72` | denser than Chat's 0.62, for form legibility |
| `engineThrottle` | `false` | 0.72 < 0.92 occlusion → **engine keeps rendering** behind the glass |
| `marginaliaDim` | `0.5` | (orb marginalia is `display:none` when settings is up anyway) |
| `zTop` | focus band | — |

`system-shell.js` `apply()` already sets `data-focus`, the eased CSS vars, and dispatches the
`shell:focus` event. The only reason Settings doesn't already work as a focus-layer is that the
panel's visibility + material live in the old modal path, and there is no `#view-settings`.

## 5. Design

### 5.1 Visibility keyed off `data-focus` (retire `.open`)
Panel visibility moves from the `.settings.open` class to the shell's own signal:
```css
.settings{ /* … layout … */ opacity:0; pointer-events:none; /* hidden/inert by default */ }
:root[data-focus="settings"] .settings{ opacity:1; pointer-events:auto; /* + entrance transform */ }
```
This mirrors how the engine defocus already keys off `--focus-depth`/`data-focus`. The `.open` class
and its CSS are removed. `.settings` keeps `position:fixed` and a z-index clearly above the Chat
focus band (only one focus layer is ever up, so there is no real stacking conflict).

### 5.2 Modal chrome → shared glass (retire the scrim)
- `.settings` adopts the shared **`.glass`** material from `system-shell.css` (elevation `--e:3` for a
  modal-level lift) — the exact frosted / grain / chromatic-aberration treatment `#view-chat` uses —
  replacing its opaque `background:var(--panel)`. Its fill rides `--glass-density`
  (`rgb(12 16 26 / calc(.42 + .34*var(--glass-density)))` → ~0.66 alpha at density 0.72: legible, with
  the live engine faintly visible behind).
- The `.settings .nav` opaque `background:var(--panel2)` strip is softened to **transparent** so the
  single glass pane reads through both columns; its existing right hairline stays as the divider.
  (This is the one internal tweak — it's container chrome, not a control.)
- The **`.scrim` element is removed entirely** (markup + CSS + its `onclick`). The pulled-back, dimmed
  engine is the backdrop now.
- Entrance motion: a centered rise + fade tied to the focus transition (the OS's 420ms
  `cubic-bezier(.2,.8,.2,1)` spine), so Settings arrives as one camera move with the engine rather than
  a separate modal pop. Win10 / reduced-transparency inherit the `.glass` opaque fallback for free
  (Settings simply reads as a solid panel there — graceful, consistent with the rest of the shell).

### 5.3 Entry/exit wiring (the only JS change)
- `openSettings()` (still the gear's handler) is unchanged in what it **populates** (every
  `populate*`/`sync`/`load` call stays). It gains two lines: record `_focusBeforeSettings =
  (window.Shell && Shell.state.focus) || 'orb'` **before** switching, and end with
  `Shell.setFocus('settings')` instead of toggling `.open`+scrim. Guard against re-entry when focus is
  already `settings` (don't overwrite `_focusBeforeSettings`).
- `closeSettings()` → `Shell.setFocus(_focusBeforeSettings || 'orb')` (drops the `.open`/scrim
  toggling). Used by the nav **Close** button and Esc.
- Esc handler condition changes from `.settings.classList.contains('open')` to
  `window.Shell && Shell.state.focus === 'settings'`.
- Orb/Chat tabs already route through `setView → Shell.setFocus`, so they dismiss Settings for free
  (the panel hides when `data-focus` leaves `settings`); `_focusBeforeSettings` going stale is
  harmless.
- Fallback: if `window.Shell` is missing (runtime failed to load), `openSettings`/`closeSettings`
  fall back to the legacy `.open` toggle so Settings still opens. (Defensive; the shell always loads.)

## 6. Files touched

- `renderer/index.html` — settings CSS block (glass + `data-focus` visibility, remove `.open`/scrim
  rules, transparent nav), remove the `.scrim` element, rewire `openSettings`/`closeSettings`/Esc,
  add the `_focusBeforeSettings` var. No settings-content markup changes.
- `tools/probes/settings-focus.js` — new verification probe.
- No change to `shell-reducer.js`, `system-shell.js`, or `system-shell.css`.

## 7. Error handling / edge cases

- **Shell missing:** legacy `.open` fallback (above) keeps Settings usable.
- **Re-entry:** opening Settings while already in Settings is a no-op for `_focusBeforeSettings`
  (guarded), so Close can't strand you.
- **Open from Chat:** `_focusBeforeSettings='chat'` → Close returns to Chat, not Orb.
- **Tab dismiss while in Settings:** handled by the existing tab→setFocus path; no special-casing.
- **Win10 / reduced-transparency / reduced-motion:** inherited from `.glass` + the spine's existing
  media-query fallbacks; Settings degrades to an opaque, still-legible panel with opacity-only motion.

## 8. Testing

- **Probe `tools/probes/settings-focus.js`** (offscreen harness): from Orb, drive entry (call
  `openSettings()` / `Shell.setFocus('settings')`) and assert: `data-focus==='settings'`;
  `--focus-depth` eased toward 1 and `--glass-density` toward 0.72; the `.settings` panel computes
  visible (`opacity>0`) + `pointer-events:auto`; **no `.scrim` element covers the engine** and the
  engine is **not** throttled (`deckSetActive`/render still on); the topbar/gear stays hittable. Then
  drive exit and assert the panel hides and focus restores to the prior layer. Also verify entry from
  Chat restores to Chat.
- **Existing suite:** all current probes (engine-l0, material, dock, transcript, motion, fallbacks,
  interaction, select, live-orb) + `node tests/test-shell-reducer.js` must stay green. The reducer's
  settings row is already asserted there; add a focus-depth assertion for `settings` if not present.
- **Manual:** gear → engine pulls back + glass Settings rises → change a setting → Esc → back to Orb;
  Chat → gear → Close → back to Chat.
