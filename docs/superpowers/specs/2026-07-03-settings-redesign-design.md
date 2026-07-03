# Caryl.ai Settings Redesign + Theming — Design Spec

**Date:** 2026-07-03
**Type:** Standalone sub-project (UX). Independent of the automation branch.
**Status:** Approved design, pre-implementation

## Context

The Settings panel is a single slide-out drawer with **13 flat `<h3>` sections** in one
long scroll (`renderer/index.html`): Engines & Models, Voice Input, AI Engine (Cloud),
Personality, Chats, Models, Appearance, Desktop Automation, Audio & Voice, Microphone &
Push-to-Talk, Memory & Neural Parameters, Engine Status, Setup. Two of them look like
model pickers ("Engines & Models" with the offline pickers up top; "Models" — the cloud
picker — far down), so users can't find where to choose their cloud model. The user's
directive: a clean, understandable Settings UI like Claude's (left-nav + right panel), plus
a **theming system** (multiple base themes + accent colors, independent).

Decisions locked with the user:

- **Layout:** modal with a left-nav of grouped pages + right panel (Claude-style structure),
  in Caryl's dark HUD identity.
- **AI Engines page:** per-capability rows (Chat / Vision / Voice-in / Voice-out), each with
  an Online/Offline switch and the model picker for the active side — the cloud model picker
  is finally visible per capability.
- **Theme model:** independent theme + accent. Base themes: **Full Dark, Full Light, Navy,
  Cyan HUD** (today's look). Accent swatch row including a new **White** accent. Any accent
  works on any theme.
- **Scope:** Settings-only redesign + theming. The chat window / overlay layouts are NOT
  re-laid-out; they inherit the new theme colors through shared CSS variables.
- Remaining specifics delegated to implementer ("do what fits best") — captured below.

## A. Modal shell & navigation

- The drawer (`#settings` + scrim) becomes a **centered modal**: a fixed 172px left nav +
  a scrollable right panel. Open/close reuses the existing `openSettings()` / scrim logic
  (just restyled); Esc and clicking the scrim close it.
- Right-panel content is split into **7 `data-page` panels**; a `showSettingsPage(id)`
  helper toggles `hidden` on all but the active one and highlights the nav item. Default
  page on open: `engines`.
- Left-nav items (icon + label), in order: AI engines, Voice and audio, Automation,
  Personality, Chats and memory, Appearance, About and setup.
- No new dependencies; all vanilla. Existing populate functions (`populateEngine`,
  `populateAiMode`, `loadModels`, `syncSettings`, etc.) are unchanged in behavior — they
  just target markup that now lives inside a page panel.

## B. The 7 pages (mapping from the 13 sections — nothing removed)

1. **AI engines** ← Engines & Models + AI Engine (Cloud) + Models
   - Four per-capability rows (Chat, Vision, Voice input, Voice output). Each row:
     capability name + active-engine subtitle; an Online/Offline segmented switch (drives
     `engines.<cap>` via the existing `setEngine`); and the **model dropdown for the active
     side** — cloud model list (`loadModels`, online) or local model list (Ollama tags /
     Whisper / Piper voice, offline). A missing local model shows a "Download" affordance.
   - Below the rows: cloud **API key** field (provider + key, from today's "AI Engine (Cloud)")
     and the **download manager** list (existing `refreshDownloadsList`).
2. **Voice and audio** ← Voice Input + Audio & Voice + Microphone & Push-to-Talk
   (wake word + curated picker, TTS on/off + voice, speech rate, VAD, system PTT + hotkey).
3. **Automation** ← Desktop Automation (mouse/scripting permissions + the "Preview & approve
   a plan first" toggle).
4. **Personality** ← Personality (assistant display name + system prompt).
5. **Chats and memory** ← Chats + Memory & Neural Parameters (chat list/new/switch/delete,
   memory budget, clear memory, separate-offline-chats).
6. **Appearance** ← Appearance + the new theme system (section C).
7. **About and setup** ← Engine Status + Setup (redo onboarding).

## C. Theme system (Appearance page)

### Engine

- A shared stylesheet **`renderer/theme.css`** defines every theme as a CSS-variable set
  under `html[data-theme="…"]`, and every accent under `html[data-accent="…"]`. Linked by
  all four renderer pages (`index.html`, `overlay.html`, `mini-overlay.html`,
  `onboarding.html`) so one definition themes the whole app.
- On boot, each page sets `document.documentElement.dataset.theme` and `.dataset.accent`
  from config (via the existing `getConfig`/status). Overlay + bubble re-apply on their
  status poll so a theme change takes effect on already-open windows without a relaunch;
  the main window applies instantly on pick.
- Variables the themes define (superset of today's `:root`): `--bg, --panel, --panel2,
  --txt, --mut, --faint, --line, --bad`. Accent defines `--accent` and derives
  `--accent-soft` (`color-mix(in srgb, var(--accent) 14%, transparent)`).

### Base themes (accent-independent)

| Theme key | `--bg` | `--panel` | `--txt` | `--mut` | `--line` |
|---|---|---|---|---|---|
| `cyanHud` (default, = today) | `#0b0d12` | `#12151d` | `#e8ecf3` | `#9aa4b5` | `rgba(255,255,255,.10)` |
| `fullDark` | `#0a0a0b` | `#161618` | `#ececec` | `#9a9a9a` | `rgba(255,255,255,.09)` |
| `navy` | `#0a1424` | `#12203a` | `#e9eef7` | `#8fa3c0` | `rgba(140,170,220,.14)` |
| `fullLight` | `#f5f6f8` | `#ffffff` | `#1a1d24` | `#5f6672` | `rgba(0,0,0,.10)` |

`--panel2` = a subtle raise of `--panel`; `--faint`/`--bad` follow each theme (light theme
flips `--faint` darker and keeps `--bad` a red that reads on white).

### Accents (`--accent`)

Swatch row: **Cyan `#7fd1ff`**, **Blue `#4c8dff`**, **White `#eef1f6`**, **Teal `#35d6b0`**,
**Amber `#f5b53d`**, **Violet `#a98bff`**. Default `cyan`.

- Buttons/orb use `--accent` with dark text (`#0a0b0d`), so light-colored accents (White)
  read correctly on the dark/navy themes.
- **Light-theme contrast guard:** on `fullLight`, a too-light accent (White) would vanish,
  so `html[data-theme="fullLight"][data-accent="white"]` remaps `--accent` to a slate
  `#5b6472` (text stays light). Other accents already read on light.

### Appearance page UI

- **Theme:** 4 selectable cards, each a small live preview (a mini bg/panel/accent swatch)
  with the theme name; the active one is ring-highlighted.
- **Accent:** a row of 6 circular swatches; the active one ringed. A White swatch shows a
  hairline border so it's visible on any theme.
- Picking either applies instantly (sets the `data-*` attribute + persists) — no reload.

## D. Persistence & safety

- New/*existing* config keys: `theme` (new, default `'cyanHud'`), `accentColor` (exists;
  repurposed as the accent **key** e.g. `'cyan'`, with a one-time migration: an old hex
  value maps to the nearest named accent, else `'cyan'`).
- Default `theme: 'cyanHud'` + `accent: 'cyan'` reproduce today's exact look, so nothing
  changes for existing users until they choose — zero visual regression on upgrade.
- Pure reorganization + additive theming: no feature/logic code paths change, so automation,
  voice, engines, etc. behave identically. All persistence rides the existing `config:set`.

## E. Error handling

- Unknown/missing `theme` or `accent` → fall back to `cyanHud` / `cyan` (CSS `:root` also
  carries the cyanHud values as the ultimate default, so a failed data-attribute never
  yields an unstyled page).
- `theme.css` failing to load → the per-page `:root` defaults keep the app usable.
- Reorg must preserve every existing element `id` and `onchange` handler so all populate/
  sync logic keeps working; the redesign moves markup, it does not rewrite behavior.

## F. Testing

- **Manual checklist (all verified before done):**
  1. All 7 nav pages open and show their controls; every old setting is reachable.
  2. AI engines page: with Chat = Online, the Chat model dropdown lists cloud models; flip
     to Offline → lists Ollama models. (The lost-model-picker fix.)
  3. Each of the 4 themes × a couple of accents applies instantly and looks correct across
     the main window, the overlay panel, and the bubble.
  4. White accent: readable on Dark/Navy/Cyan; on Light it uses the slate remap (still
     visible).
  5. Restart → chosen theme + accent persist. Fresh profile → cyanHud/cyan (looks like today).
  6. Light theme: text is readable everywhere in Settings (no white-on-white, no
     invisible borders).
- No automated tests (pure UI/CSS); the engines/config logic is already covered by the
  node suites, which must still pass (`npm test`).

## File map (planned)

| File | Change |
|---|---|
| `renderer/theme.css` | **new** — all `html[data-theme]` + `html[data-accent]` variable sets |
| `renderer/index.html` | modal shell + left nav + 7 `data-page` panels; Appearance theme/accent pickers; link theme.css; apply + persist theme/accent |
| `renderer/overlay.html`, `renderer/mini-overlay.html`, `renderer/onboarding.html` | link theme.css; apply `data-theme`/`data-accent` on boot (+ overlay re-applies on poll) |
| `lib/config.js` | add `theme` default `'cyanHud'`; `accentColor` default `'cyan'` |
| `main.js` | add `theme` + `accent` to `ui:status` (so overlays apply live); one-time hex→named accent migration |
