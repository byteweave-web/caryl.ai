# Caryl.ai Settings Redesign + Theming Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the cluttered 13-section Settings drawer into a clean left-nav modal with 7 pages (the cloud model picker finally visible per capability), and add an app-wide theming system: 4 base themes (Cyan HUD, Full Dark, Navy, Full Light) × 6 accents (incl. a new White), independently combinable.

**Architecture:** A shared `renderer/theme.css` defines every theme as CSS variables under `html[data-theme]` and every accent under `html[data-accent]`, linked by all four renderer pages so one pick restyles the whole app. On boot each page sets the two `data-*` attributes from config. The Settings drawer is restyled into a centered modal whose right panel holds 7 `data-page` sections; the existing `.sec` blocks are moved into their page unchanged (all ids/handlers preserved).

**Tech Stack:** Vanilla HTML/CSS/JS renderer, Electron main (CommonJS), JSON config. No new dependencies.

## Global Constraints

- No new npm/Python dependencies.
- Every existing settings element `id` and `onchange`/`onclick` handler is preserved — the redesign MOVES markup, it does not rewrite behavior.
- Default `theme: 'cyanHud'` + `accent: 'cyan'`; the cyanHud theme's bg/panel/text values match today's exact `:root` so only the accent unifies (main window adopts the cyan orb/overlay accent).
- Themes/accents apply app-wide: index, overlay, mini-overlay, onboarding all link `theme.css` and set the `data-*` attributes.
- All user-visible strings say Caryl; sentence case.
- `npm test` (node suites) must still pass — no engine/config logic changes beyond the theme default + accent migration.
- Commit after every task.

## File Structure

| File | Role |
|---|---|
| `renderer/theme.css` (new) | all `html[data-theme]` + `html[data-accent]` CSS-variable sets |
| `renderer/index.html` | link theme.css + apply data-*; modal shell + left nav + 7 pages; Appearance theme/accent pickers |
| `renderer/overlay.html`, `renderer/mini-overlay.html`, `renderer/onboarding.html` | link theme.css + apply data-* (overlay re-applies on poll) |
| `lib/config.js` | `theme` default `'cyanHud'`; `accentColor` default `'cyan'` |
| `main.js` | `theme`/`accent` in `ui:status`; one-time hex→named accent migration |

---

### Task 1: Theme engine (CSS + wiring, no picker UI yet)

**Files:**
- Create: `renderer/theme.css`
- Modify: `lib/config.js` (DEFAULTS), `main.js` (`ui:status` + boot migration), `renderer/index.html`, `renderer/overlay.html`, `renderer/mini-overlay.html`, `renderer/onboarding.html`

**Interfaces:**
- Produces (used by Tasks 2–3): `html[data-theme="cyanHud|fullDark|navy|fullLight"]` and `html[data-accent="cyan|blue|white|teal|amber|violet"]` variable contracts; config keys `theme`, `accentColor` (named); `ui:status.theme`, `ui:status.accent`; renderer boot helper `applyTheme(cfg)`.

- [ ] **Step 1: Create renderer/theme.css**

```css
/* Caryl.ai theme system. Base theme sets surfaces/text; accent sets --accent.
   :root carries the cyanHud defaults so the app is styled even before JS sets data-*. */
:root,
html[data-theme="cyanHud"] {
  --bg:#08090b; --panel:#0e1014; --panel2:#14171c; --glow:#14171c;
  --line:rgba(255,255,255,.08); --txt:#e7e9ee; --mut:#8b9099; --faint:#5a5f68;
  --track:#21252b; --ok:#5ad19a; --warn:#e0b15a; --bad:#e9637b;
}
html[data-theme="fullDark"] {
  --bg:#0a0a0b; --panel:#161618; --panel2:#1e1e21; --glow:#1e1e21;
  --line:rgba(255,255,255,.09); --txt:#ececec; --mut:#9a9a9a; --faint:#5c5c5c;
  --track:#242426; --ok:#5ad19a; --warn:#e0b15a; --bad:#e9637b;
}
html[data-theme="navy"] {
  --bg:#0a1424; --panel:#12203a; --panel2:#182a49; --glow:#182a49;
  --line:rgba(140,170,220,.14); --txt:#e9eef7; --mut:#8fa3c0; --faint:#5f728f;
  --track:#1c3355; --ok:#5ad19a; --warn:#e0b15a; --bad:#f07a90;
}
html[data-theme="fullLight"] {
  --bg:#f5f6f8; --panel:#ffffff; --panel2:#eef0f4; --glow:#ffffff;
  --line:rgba(0,0,0,.10); --txt:#1a1d24; --mut:#5f6672; --faint:#9098a4;
  --track:#dfe3ea; --ok:#1f9d63; --warn:#b5791a; --bad:#d1435f;
}

:root,
html[data-accent="cyan"]   { --accent:#7fd1ff; --accent-soft:rgba(127,209,255,.14); }
html[data-accent="blue"]   { --accent:#4c8dff; --accent-soft:rgba(76,141,255,.16); }
html[data-accent="white"]  { --accent:#eef1f6; --accent-soft:rgba(238,241,246,.14); }
html[data-accent="teal"]   { --accent:#35d6b0; --accent-soft:rgba(53,214,176,.16); }
html[data-accent="amber"]  { --accent:#f5b53d; --accent-soft:rgba(245,181,61,.16); }
html[data-accent="violet"] { --accent:#a98bff; --accent-soft:rgba(169,139,255,.16); }
/* Light theme + White accent would vanish -> remap to a visible slate. */
html[data-theme="fullLight"][data-accent="white"] { --accent:#5b6472; --accent-soft:rgba(91,100,114,.14); }
```

- [ ] **Step 2: config defaults**

In `lib/config.js` DEFAULTS, add:

```js
  theme: 'cyanHud',                        // base theme (see renderer/theme.css)
  // accentColor holds a NAMED accent ('cyan'|'blue'|'white'|'teal'|'amber'|'violet').
  // NOTE: default set below; old hex values are migrated to a name in main.js at boot.
  accentColor: 'cyan',
```

- [ ] **Step 3: One-time hex→named accent migration + status fields in main.js**

Near the top of `main.js`, after the `engines` normalization block (the `{ const norm = enginesLib.normalizeEngines(...) }` block), add:

```js
// One-time: older builds stored accentColor as a hex string. Map it to the nearest named
// accent so the new picker + theme.css work. Runs once (leaves named values untouched).
{
  const NAMED = { cyan: '#7fd1ff', blue: '#4c8dff', white: '#eef1f6', teal: '#35d6b0', amber: '#f5b53d', violet: '#a98bff' };
  const a = config.get().accentColor;
  if (typeof a === 'string' && a.charAt(0) === '#') {
    const hex = a.toLowerCase();
    let best = 'cyan', bestD = 1e9;
    const rgb = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
    try {
      const [r0, g0, b0] = rgb(hex.length === 7 ? hex : '#7fd1ff');
      for (const k of Object.keys(NAMED)) { const [r, g, b] = rgb(NAMED[k]); const d = (r - r0) ** 2 + (g - g0) ** 2 + (b - b0) ** 2; if (d < bestD) { bestD = d; best = k; } }
    } catch (_e) { best = 'cyan'; }
    config.set({ accentColor: best });
  }
}
```

In the `ui:status` return object, add (near `accent_color`):

```js
    theme: cfg.theme || 'cyanHud',
    accent: cfg.accentColor || 'cyan',
```

- [ ] **Step 4: Link theme.css + apply on boot in all four renderers**

In each of `renderer/index.html`, `renderer/overlay.html`, `renderer/mini-overlay.html`, `renderer/onboarding.html`, add this `<link>` **immediately after the closing `</style>` of the page's inline style block**. It must come AFTER the inline style so theme.css's `:root` (cyanHud defaults) wins over each file's duplicated inline `:root` variables pre-JS, and its `html[data-theme]`/`html[data-accent]` rules (higher specificity) win once JS sets the attributes:

```html
<link rel="stylesheet" href="theme.css">
```

Note: theme.css only defines the shared palette vars (`--bg,--panel,--panel2,--txt,--mut,--faint,--line,--track,--ok,--warn,--bad,--accent,--accent-soft,--glow`); each file's other bespoke vars (e.g. the overlay's `--void`, `--edge-hi`) are untouched, so only the shared surfaces + accent get themed.

Then add a shared apply helper. In `index.html`, replace the existing shell-style boot line
(`window.bridge.getShellStyle().then(...)` added earlier) region by ALSO applying theme —
add right after it:

```html
<script>
window.bridge.getConfig().then(function (c) {
  document.documentElement.dataset.theme = (c && c.theme) || 'cyanHud';
  document.documentElement.dataset.accent = (c && c.accentColor) || 'cyan';
}).catch(function () { document.documentElement.dataset.theme = 'cyanHud'; document.documentElement.dataset.accent = 'cyan'; });
</script>
```

In `onboarding.html` add the same script block right after its `<script src="wakeword.js">` line (it already uses `window.bridge`).

In `overlay.html` and `mini-overlay.html`, they poll status; inside their existing status-poll apply function (search for where `s.accent_color` is used, near `assistant_name`), add:

```js
      if (s.theme && document.documentElement.dataset.theme !== s.theme) document.documentElement.dataset.theme = s.theme;
      if (s.accent && document.documentElement.dataset.accent !== s.accent) document.documentElement.dataset.accent = s.accent;
```

and ALSO set a safe default at their boot (top of their bootstrap IIFE):

```js
  document.documentElement.dataset.theme = document.documentElement.dataset.theme || 'cyanHud';
  document.documentElement.dataset.accent = document.documentElement.dataset.accent || 'cyan';
```

- [ ] **Step 5: Make index.html body background theme-aware**

In `renderer/index.html` inline `<style>`, the `body` rule hardcodes the radial inner color `#14171c`. Change it to use the theme var:

```css
body{
  margin:0;background:radial-gradient(1200px 700px at 70% -10%, var(--glow) 0%, var(--bg) 55%);
  color:var(--txt);font-family:'Inter',system-ui,-apple-system,Segoe UI,Roboto,sans-serif;
  -webkit-font-smoothing:antialiased;overflow:hidden;
}
```

- [ ] **Step 6: Verify**

Run: `npm test` (node suites still pass), then `npm start`. In `%APPDATA%/Caryl.ai/settings.json` set `"theme":"navy"` and relaunch → whole app (window + overlay + bubble) is navy. Try `"fullLight"` → light, text readable. Try `"theme":"cyanHud","accentColor":"white"` → near-white accent. Delete both keys → cyanHud + cyan. No console errors.

- [ ] **Step 7: Commit**

```bash
git add renderer/theme.css lib/config.js main.js renderer/index.html renderer/overlay.html renderer/mini-overlay.html renderer/onboarding.html
git commit -m "feat(ui): app-wide theming engine (4 themes x 6 accents) via shared theme.css + data attributes"
```

---

### Task 2: Appearance page — theme cards + accent swatches (live apply)

**Files:**
- Modify: `renderer/index.html` (the existing Appearance `.sec` ~line 361, and JS near `syncSettings`)

**Interfaces:**
- Consumes: Task 1 `data-theme`/`data-accent` + config keys.
- Produces (used by Task 3, which relocates this markup into the Appearance page): `setTheme(key)`, `setAccent(key)`, `renderAppearance(cfg)`; DOM ids `theme-cards`, `accent-swatches`.

- [ ] **Step 1: Add the picker markup**

Inside the existing Appearance section (the `<div class="sec">` whose `<h3>Appearance</h3>` is ~line 361), just under its `<h3>`/`.sub`, insert:

```html
      <div class="l" style="margin:6px 0 6px">Theme</div>
      <div id="theme-cards" style="display:grid;grid-template-columns:repeat(2,1fr);gap:8px;margin-bottom:14px"></div>
      <div class="l" style="margin:2px 0 6px">Accent</div>
      <div id="accent-swatches" style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:6px"></div>
```

- [ ] **Step 2: Add the picker JS**

Near the other populate functions (e.g. after `populateExtras` — search `function populateExtras`), add:

```js
const CARYL_THEMES = [
  { key: 'cyanHud', name: 'Cyan HUD', bg: '#08090b', panel: '#14171c' },
  { key: 'fullDark', name: 'Full Dark', bg: '#0a0a0b', panel: '#1e1e21' },
  { key: 'navy', name: 'Navy', bg: '#0a1424', panel: '#182a49' },
  { key: 'fullLight', name: 'Full Light', bg: '#f5f6f8', panel: '#ffffff' }
];
const CARYL_ACCENTS = [
  { key: 'cyan', hex: '#7fd1ff' }, { key: 'blue', hex: '#4c8dff' }, { key: 'white', hex: '#eef1f6' },
  { key: 'teal', hex: '#35d6b0' }, { key: 'amber', hex: '#f5b53d' }, { key: 'violet', hex: '#a98bff' }
];
function currentTheme() { return document.documentElement.dataset.theme || 'cyanHud'; }
function currentAccent() { return document.documentElement.dataset.accent || 'cyan'; }
async function setTheme(key) {
  document.documentElement.dataset.theme = key;
  await window.bridge.setConfig({ theme: key });
  renderAppearance();
}
async function setAccent(key) {
  document.documentElement.dataset.accent = key;
  await window.bridge.setConfig({ accentColor: key });
  renderAppearance();
}
function renderAppearance() {
  const tc = document.getElementById('theme-cards');
  if (tc) tc.innerHTML = CARYL_THEMES.map(function (t) {
    const on = t.key === currentTheme();
    return '<button onclick="setTheme(\'' + t.key + '\')" style="text-align:left;border:1.5px solid ' + (on ? 'var(--accent)' : 'var(--line)') + ';background:' + t.bg + ';border-radius:10px;padding:9px 11px;cursor:pointer">' +
      '<div style="display:flex;gap:5px;margin-bottom:7px"><span style="width:14px;height:14px;border-radius:4px;background:' + t.panel + ';border:1px solid rgba(255,255,255,.15)"></span><span style="width:14px;height:14px;border-radius:4px;background:var(--accent)"></span></div>' +
      '<div style="font-size:12px;color:#e7e9ee">' + t.name + (on ? ' ✓' : '') + '</div></button>';
  }).join('');
  const sc = document.getElementById('accent-swatches');
  if (sc) sc.innerHTML = CARYL_ACCENTS.map(function (a) {
    const on = a.key === currentAccent();
    return '<button onclick="setAccent(\'' + a.key + '\')" title="' + a.key + '" aria-label="' + a.key + ' accent" style="width:26px;height:26px;border-radius:50%;background:' + a.hex + ';cursor:pointer;border:2px solid ' + (on ? 'var(--txt)' : 'rgba(255,255,255,.25)') + '"></button>';
  }).join('');
}
```

- [ ] **Step 3: Render on settings open**

In `openSettings()` (search `function openSettings`), append `renderAppearance();` to the call chain (after `populateExtras();`).

- [ ] **Step 4: Verify**

Run: `npm start` → open Settings → Appearance. Click each theme card: the whole app restyles instantly and the card ring + ✓ follow; click accents: orb/buttons recolor instantly. Reopen Settings after each — selection persisted. Relaunch app → last theme+accent retained.

- [ ] **Step 5: Commit**

```bash
git add renderer/index.html
git commit -m "feat(ui): Appearance theme cards + accent swatches with live apply + persistence"
```

---

### Task 3: Modal shell + left nav + 7 pages

**Files:**
- Modify: `renderer/index.html` (settings CSS ~lines 77–89; settings markup ~lines 192–468; add `showSettingsPage` JS)

**Interfaces:**
- Consumes: all existing `.sec` blocks (unchanged inner markup) + Task 2's Appearance pickers.
- Produces: `showSettingsPage(id)`; nav ids `data-nav="engines|voice|automation|personality|chats|appearance|about"`.

- [ ] **Step 1: Replace the drawer CSS with modal + nav CSS**

Replace the `.settings` / `.settings header` / `.settings .body` rules (~lines 79–85) with:

```css
.settings{position:fixed;top:50%;left:50%;transform:translate(-50%,-48%) scale(.98);opacity:0;pointer-events:none;
  width:880px;max-width:95vw;height:580px;max-height:90vh;background:var(--panel);border:1px solid var(--line);
  border-radius:16px;display:flex;overflow:hidden;z-index:50;transition:opacity .18s,transform .18s}
.settings.open{opacity:1;pointer-events:auto;transform:translate(-50%,-50%) scale(1)}
.settings .nav{width:176px;flex:0 0 176px;border-right:1px solid var(--line);background:var(--panel2);
  padding:14px 8px;display:flex;flex-direction:column;gap:2px;overflow-y:auto}
.settings .nav .navlabel{font-size:11px;color:var(--faint);padding:4px 10px 8px;letter-spacing:.4px;text-transform:uppercase}
.settings .nav button{display:flex;align-items:center;gap:8px;width:100%;text-align:left;border:0;background:transparent;
  color:var(--mut);padding:8px 11px;border-radius:9px;font-size:13px;font-weight:500;transition:.12s}
.settings .nav button:hover{color:var(--txt);background:var(--accent-soft)}
.settings .nav button.active{background:var(--accent-soft);color:var(--txt)}
.settings .main{flex:1;overflow-y:auto;padding:6px 26px 30px;position:relative}
.settings .page{display:none}
.settings .page.active{display:block}
.settings .page .sec:first-child{border-top:0}
```

- [ ] **Step 2: Rebuild the settings markup as nav + 7 pages**

Replace the opening of the settings block — from `<aside class="settings" id="settings">` through its `<div class="body">` open tag — with:

```html
<aside class="settings" id="settings">
  <nav class="nav">
    <div class="navlabel">Settings</div>
    <button data-nav="engines" class="active" onclick="showSettingsPage('engines')">AI engines</button>
    <button data-nav="voice" onclick="showSettingsPage('voice')">Voice and audio</button>
    <button data-nav="automation" onclick="showSettingsPage('automation')">Automation</button>
    <button data-nav="personality" onclick="showSettingsPage('personality')">Personality</button>
    <button data-nav="chats" onclick="showSettingsPage('chats')">Chats and memory</button>
    <button data-nav="appearance" onclick="showSettingsPage('appearance')">Appearance</button>
    <button data-nav="about" onclick="showSettingsPage('about')">About and setup</button>
    <div style="flex:1"></div>
    <button onclick="closeSettings()" style="color:var(--faint)">Close</button>
  </nav>
  <div class="main">
    <section class="page active" data-page="engines"></section>
    <section class="page" data-page="voice"></section>
    <section class="page" data-page="automation"></section>
    <section class="page" data-page="personality"></section>
    <section class="page" data-page="chats"></section>
    <section class="page" data-page="appearance"></section>
    <section class="page" data-page="about"></section>
```

Then MOVE each existing `<div class="sec">…</div>` block (identified by its `<h3>`) into the matching `<section>` — inner markup unchanged — in this mapping, then delete the now-empty old `<div class="body">` wrapper and its stray close tags so the structure is `nav` + `main` only:

| Page | `.sec` blocks to move in (by their h3) |
|---|---|
| engines | Engines & Models; AI Engine (Cloud); Models |
| voice | Voice Input; Audio & Voice; Microphone & Push-to-Talk |
| automation | Desktop Automation |
| personality | Personality |
| chats | Chats; Memory & Neural Parameters |
| appearance | Appearance (now incl. the Task 2 pickers) |
| about | Engine Status; Setup |

Preserve every inner `id` and handler exactly. The old `<div class="body">` opening/closing tags are removed (the `.page` sections replace it).

- [ ] **Step 3: Add showSettingsPage + default page on open**

Near `openSettings()`, add:

```js
function showSettingsPage(id){
  document.querySelectorAll('#settings .page').forEach(function(p){ p.classList.toggle('active', p.dataset.page===id); });
  document.querySelectorAll('#settings .nav button[data-nav]').forEach(function(b){ b.classList.toggle('active', b.dataset.nav===id); });
  document.querySelector('#settings .main').scrollTop = 0;
}
```

In `openSettings()`, append `showSettingsPage('engines');` at the end so it always opens on the AI engines page.

- [ ] **Step 4: Verify (the spec's manual checklist)**

Run: `npm start` → open Settings.
1. All 7 nav items switch pages; the active item highlights; content scrolls independently.
2. Every previous setting is present and functional (toggles flip, model list loads, downloads list renders, wake-word picker works, redo-setup button present).
3. AI engines page: with Chat = Online, the Models dropdown lists your Groq cloud models; flip Chat to Offline → lists Ollama models. (The lost-picker fix.)
4. Appearance page shows theme cards + accent swatches and they still apply live.
5. Esc / clicking the scrim closes the modal; reopening returns to the AI engines page.
No console errors (`npm start -- --dev` to watch).

- [ ] **Step 5: Commit**

```bash
git add renderer/index.html
git commit -m "feat(ui): settings modal with left-nav and 7 pages (unified AI engines; cloud model picker visible)"
```

---

### Task 4: Docs + final verification

**Files:**
- Modify: `README.md`, `INSTRUCTIONS.md`

- [ ] **Step 1: Run the node suites**

Run: `npm test`
Expected: all suites pass (this change touches no engine/config logic beyond the theme default + accent migration).

- [ ] **Step 2: Full theme sweep**

`npm start`: for each theme (Cyan HUD, Full Dark, Navy, Full Light) × two accents (incl. White), confirm the main window, an opened overlay panel, and the bubble all render correctly and text stays readable. On Full Light specifically, verify no white-on-white text and that the White accent uses the slate remap.

- [ ] **Step 3: Docs**

README.md: under the architecture list add
`- renderer/theme.css — app-wide theme + accent variables (Settings → Appearance).`
INSTRUCTIONS.md: add a line that Settings is now a left-nav modal (AI engines, Voice and audio, Automation, Personality, Chats and memory, Appearance, About and setup) and that Appearance offers 4 themes × 6 accents.

- [ ] **Step 4: Commit**

```bash
git add README.md INSTRUCTIONS.md
git commit -m "docs: settings redesign + theming notes"
```
