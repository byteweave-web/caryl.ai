# Unified OS — Phase 4: Satellites Reskin (Shared Glass)

**Date:** 2026-07-08 · **Branch:** `nexus-deck-orb-tab` · **Status:** approved by Farouk
**Parent spec:** `2026-07-07-unified-os-ui-design.md` (§ Hybrid window model: "Weather/mini-bubble/
notifications stay separate windows but share the stylesheet"). Follows Phases 1–3 + Live Orb.

## 1. Problem

The four satellite windows each carry a private, hand-rolled palette — none import
`renderer/system-shell.css`, so they are not "cut from the same glass" as the shell:

| File | Window | Today |
|---|---|---|
| `renderer/overlay.html` | `overlayWindow` (main.js:2520) | own cyan HUD tokens (`--accent:#7fd1ff`, own edge-highlight hairlines) |
| `renderer/mini-overlay.html` | `miniOverlayWindow` (main.js:2573) | own 3-token palette |
| `renderer/weather-board.html` | `boardWin` (lib/kernel/overlay.js:197) | iOS-Weather look, own `--glass` tint |
| `renderer/overlay-card.html` | kernel card (lib/kernel/overlay.js:169) | iOS-Weather look + a retired-theme `fullLight` override |

All four windows are transparent/frameless, always-on-top, capture-excluded, with
`backgroundMaterial:'acrylic'` on Win11 (except the bubble) — **the window plumbing is already
correct and is not touched by this phase.**

## 2. Goals / Non-goals

**Goal:** every satellite reads as the same physical object as the shell — same deep-space tokens
(`--core` cyan, `--ink`/`--dim` text ramp), same `.glass` material (fill/hairline/grain), same
typography (`--mono` IBM Plex Mono / `--read` IBM Plex Sans / `--disp` Big Shoulders), same
Win10/reduced-transparency fallback matrix.

**Non-goals (locked with Farouk):** *same material, same bones* — zero layout/behavior/feature
changes; the weather board **keeps its animated sky** (content, not chrome); the bubble keeps its
orb-pulse art (identity, not chrome). `research-overlay.html` and `onboarding.html` are **excluded**
(uncommitted WIP from other feature lines). No main-process/window-config changes. No font bundling
(same stacks + fallbacks as the shell itself).

## 3. Locked decisions (Farouk)

1. **Scope:** the 4 stable satellites above; research-overlay + onboarding excluded.
2. **Depth:** material/token/typography unification only, layouts untouched; sky stays.
3. **Approach A:** link `system-shell.css` + per-file **alias shim** (below) — no mass-renames.

## 4. Approach A — link + alias shim

Each satellite adds `<link rel="stylesheet" href="system-shell.css">` **before** its local
`<style>`, and its local `:root` token block becomes a thin alias map onto the shared tokens. The
hundreds of existing `var(--accent)` / `var(--card-accent)` usages keep working untouched.

### 4.1 Per-window token mapping

**overlay.html** (HUD panel):
- `--accent:#7fd1ff` → `--accent:var(--core)`; `--accent-dim`/`--accent-line` keep their
  `color-mix(… var(--accent) …)` derivations (they follow automatically).
- `--confirm:#5ad19a` → `--confirm:var(--good)`. Local `--bad` deleted (shared `--bad` is the
  same value and same name).
- `--txt` → `var(--ink)`; `--mut` → `var(--dim)`; `--faint` stays a local step tuned between
  `--dim` and the void (exact value is an implementation detail).
- `--mono`/`--sans` → shared `--mono`/`--read`.
- ⚠ **Name collision:** overlay.html locally defines `--void` as its *glass tint*
  (`rgba(7,10,15,.16)`) — the shared `--void` is the opaque page background `#05060B`. Blindly
  keeping a local `--void` alias would either shadow the shared token or, if deleted naively,
  paint the panel opaque. Resolution: the local `--void` token is **retired**; the panel surface
  adopts the **`.glass` class** (whose fill replaces the tint's job), and any other local `--void`
  usages move to an explicitly-named local token (e.g. `--tint`) if still needed.
- The panel's sharp square corners are kept (`border-radius:0` override on its `.glass` surface —
  it is "an instrument, not a card"). Its old `--edge-hi`/`--edge-lo` edge highlights are retired
  in favor of the material's `--hair`/`--hair-lit`.

**mini-overlay.html** (bubble): token aliases only — `--accent:var(--core)`,
`--confirm:var(--good)`, local `--mono` deleted (shared provides). No `.glass` adoption; the orb
art's own gradients/pulse CSS are identity and stay byte-identical apart from the token values
they already reference.

**weather-board.html**: `--card-accent` → `var(--core)`; `--card-soft` → a `--core`-derived wash
(`color-mix(in srgb, var(--core) 14%, transparent)`); `--glass:rgba(12,18,28,.38)` retired — the
tile column adopts the **`.glass` class**; text ramp → `--ink`/`--dim`/local faint;
`--mono`/`--sans` → shared `--mono`/`--read`. The animated sky scene is untouched. (Tiles sit over
in-window sky content, so `.glass`'s backdrop-filter genuinely blurs there — the best-case surface
for the material.)

**overlay-card.html**: same mapping as the board (`--card-accent`→`--core`, `--glass`→`.glass`
class, type→shared), keeps its rounded result-card shape (`.glass`'s 14px radius is close to
current; keep whichever reads correctly — implementation detail). The
`html[data-theme="fullLight"]{…}` override line is **deleted** (Full Light is retired; deep-space
is the one look, per parent spec).

### 4.2 Glass density
Satellites have no shell runtime easing `--glass-density`; each window sets a **fixed** density on
`:root` chosen to match its current visual weight (~0–0.3 — the material's base fill
`rgb(12 16 26 / calc(.42 + .34*d))` at d=0 is already close to the current `.34–.38` tints; exact
per-window value is an implementation detail, tuned by eye against the current look).

### 4.3 Fallback stamping (`data-os`)
Each satellite adds the same 3-line stamp `index.html` uses (index.html:709-711):
`bridge.getShellStyle()` → `document.documentElement.dataset.os = s.osVariant || 'win10'`, with
`win10` on absence/failure. This activates the `.glass` Win10 opaque-gradient and
reduced-transparency fallbacks identically to the shell. On Win11, the existing acrylic
`backgroundMaterial` provides the behind-window blur and the glass fill/hairline/grain compose
over it. (In-window `backdrop-filter` only blurs in-window content — the board's tiles-over-sky —
which is expected and correct.)

### 4.4 CSP / packaging (verified, no changes needed)
All four CSPs allow `style-src 'self'` (the stylesheet link) and `img-src … data:` (the grain
data-URI). `renderer/**` is already packaged whole.

## 5. Files touched

- `renderer/overlay.html`, `renderer/mini-overlay.html`, `renderer/weather-board.html`,
  `renderer/overlay-card.html` — link + alias shim + `.glass` adoption + `data-os` stamp.
- `tools/probe_shell.js` — gains a backward-compatible `--file=<renderer-relative>` arg (defaults
  to `index.html`).
- Create `tools/probes/satellite-material.js` — generic material probe (below).
- **No** changes to `main.js`, `lib/kernel/overlay.js`, `system-shell.css`, or the shell files.

## 6. Testing

- **Probe** `satellite-material.js`, run once per satellite via
  `probe_shell.js --file=<satellite>.html --probe=…`, asserts: shared sheet actually loaded
  (`--core` on `:root` computes to `#58C6FF`/`rgb(88,198,255)`); the local accent alias
  (`--accent` or `--card-accent`, when defined) computes to the same value as `--core`; at least
  one element carries `.glass` for the three glass-adopting windows (the bubble is exempt — the
  probe reads `location.pathname` and skips the `.glass` assertion for `mini-overlay.html`);
  `document.documentElement.dataset.os` is stamped (`win10` under the stub bridge).
- **Regression:** existing 10 probes (which all load `index.html` — the default keeps them
  byte-identical in behavior) + `node tests/test-shell-reducer.js` + `node tests/test-nexus-feed.js`
  stay green.
- **Manual:** open the bubble → expand the panel; run an automation → card appears; ask for
  weather → board appears — all four read as the shell's glass; on Win10 they render solid.

## 7. Edge cases

- **Stub/absent bridge** (probe harness, or a satellite opened standalone): stamp defaults to
  `win10` → opaque fallback, never broken glass.
- **Link order:** `system-shell.css` first, local `<style>` second — local aliases win where names
  overlap, and the overlay `--void` collision is resolved by retiring the local name (§4.1).
- **`prefers-reduced-transparency` / `prefers-reduced-motion`:** inherited from the shared sheet's
  media queries — no per-satellite handling.

## 9. Plan-time findings (amendments)

- **§4.3 is verify-only:** all four satellites already stamp `data-os` (overlay.html:221,
  mini-overlay.html:274, weather-board.html:268, overlay-card.html:79) and already carry
  Win10 fallback rules. No stamping is added.
- **theme.css is swapped out, in place.** It is linked AFTER each satellite's inline styles and
  defines `--accent`/`--txt`/`--mut`/`--faint` at bare `:root`, so it would silently defeat the
  alias shim (and already overrides satellites' local text tokens today). The multi-theme system
  is retired for the Unified OS, so each satellite's `<link href="theme.css">` becomes
  `<link href="system-shell.css">` at the same position. Safe: shared/local token names are
  disjoint except `--mono`, where shared-wins is desired. The satellites' `dataset.theme`
  stamping lines remain but become inert (after the card's fullLight rules are deleted, no
  satellite CSS reads `data-theme`).
- **`.glass` class scope refined:** the class goes on the three big static panes (`#panel`,
  `#card`, `#days`). The small repeated tiles (`.h-tile`, `.tile` — ~30 nodes at 66px) adopt the
  material **by tokens** (material fill formula, 22px blur, `--hair` border) without the class:
  per-tile grain pseudo-elements are invisible at that size and pure overhead. Their existing
  per-selector Win10 fallback rules are re-pointed to the material's fallback gradient.
