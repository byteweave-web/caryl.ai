# Unified OS Phase 4 — Satellites Reskin: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** The four satellite windows (overlay HUD panel, mini-bubble, weather board, overlay card) adopt the shared deep-space material from `renderer/system-shell.css` — same tokens, glass, hairlines, typography, and fallback matrix — with zero layout/behavior change.

**Architecture:** Approach A (link + alias shim), refined by plan-time findings: each satellite's `theme.css` link is swapped **in-place** for `system-shell.css`, its local `:root` becomes a thin alias map onto shared tokens, the three big static panes (`#panel`, `#card`, `#days`) take the `.glass` class, and the small repeated tiles adopt the material **by tokens**. All four satellites already stamp `data-os` — no stamping work needed.

**Tech Stack:** Vanilla CSS/HTML (no new deps) · offscreen-Electron probe harness (gains a `--file=` arg).

**Spec:** `docs/superpowers/specs/2026-07-08-unified-os-phase4-satellites-reskin.md` (amended by Task 1).

## Global Constraints

- **No new npm dependencies.**
- **Never sweep-commit:** `git add` ONLY the files each task lists.
- **Do NOT touch:** `main.js`, `lib/kernel/overlay.js`, `system-shell.css`, `theme.css`, `renderer/index.html`, `research-overlay.html`, `onboarding.html`.
- **Same bones:** zero layout/behavior/markup changes beyond adding a `glass` class to three elements and the CSS edits below. The weather board's animated sky and the bubble's orb-pulse art are untouched.
- Material constants (from `system-shell.css`, verbatim): fill `rgb(12 16 26 / calc(.42 + .34*var(--glass-density)))` · blur `blur(22px) saturate(1.3)` · hairline `var(--hair)` · Win10 fallback fill `linear-gradient(180deg, rgba(18,24,36,.94), rgba(10,14,22,.96))` · `--core:#58C6FF`.
- Probe runs: `node_modules/.bin/electron tools/probe_shell.js --file=<name>.html --probe=tools/probes/satellite-material.js --wait=1800` — exit 0 + `RESULT: PASS`. The harness prints one pre-existing deprecation warning; ignore it. Do NOT run full `npm test` for these tasks (node suites + probes are the relevant gates).
- The satellites' `dataset.theme` stamping lines are left in place (they become inert once no `data-theme` CSS rules remain) — do not remove them.

---

### Task 1: Spec amendment + harness `--file` arg + failing probe

**Files:**
- Modify: `docs/superpowers/specs/2026-07-08-unified-os-phase4-satellites-reskin.md`
- Modify: `tools/probe_shell.js`
- Create: `tools/probes/satellite-material.js`

**Interfaces:**
- Produces: `probe_shell.js --file=<renderer-relative.html>` (defaults `index.html` — existing callers unchanged); probe `satellite-material.js` used by Tasks 2–5 as their gate.

- [ ] **Step 1: Amend the spec with plan-time findings**

Append to the spec file:

```markdown

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
```

- [ ] **Step 2: Harness `--file` arg**

In `tools/probe_shell.js` replace:
```js
const PROBE = path.resolve(arg('probe', ''));
const WAIT = parseInt(arg('wait', '1400'), 10);
```
with:
```js
const PROBE = path.resolve(arg('probe', ''));
const WAIT = parseInt(arg('wait', '1400'), 10);
const FILE = arg('file', 'index.html');   // renderer-relative page to load (satellites etc.)
```
and replace:
```js
  const file = path.resolve(__dirname, '..', 'renderer', 'index.html');
```
with:
```js
  const file = path.resolve(__dirname, '..', 'renderer', FILE);
```

- [ ] **Step 3: Write the probe**

Create `tools/probes/satellite-material.js`:
```js
(async function () {
  function sleep(ms){ return new Promise(function(r){ setTimeout(r, ms); }); }
  await sleep(500);  // let the satellite's async data-os stamp land
  var out = {};
  var cs = getComputedStyle(document.documentElement);
  out.core = cs.getPropertyValue('--core').trim();
  out.coreOk = /^#58c6ff$/i.test(out.core);                      // shared sheet actually loaded
  out.osStamped = !!document.documentElement.dataset.os;         // 'win10' under the stub bridge
  out.themeCssGone = !document.querySelector('link[href="theme.css"]');
  var acc = (cs.getPropertyValue('--accent') || cs.getPropertyValue('--card-accent') || '').trim();
  out.accent = acc;
  out.accentAliased = !!acc && /#58c6ff/i.test(acc);             // alias computed to --core's value
  var isBubble = /mini-overlay\.html$/i.test(location.pathname);
  out.glassEl = !!document.querySelector('.glass');
  out.glassOk = isBubble ? true : out.glassEl;                   // bubble exempt (orb art, no pane)
  var pass = out.coreOk && out.osStamped && out.themeCssGone && out.accentAliased && out.glassOk;
  return JSON.stringify({ pass: pass, detail: out });
})()
```

- [ ] **Step 4: Run the probe against all four — confirm RED, and index probes still green**

```bash
for f in overlay-card.html weather-board.html overlay.html mini-overlay.html; do
  r=$(timeout 60 node_modules/.bin/electron tools/probe_shell.js --file=$f --probe=tools/probes/satellite-material.js --wait=1800 2>/dev/null | grep -E '^RESULT:')
  printf '%-20s %s\n' "$f" "$r"
done
```
Expected: 4× `RESULT: FAIL` with `coreOk:false, themeCssGone:false` (the red this phase fixes).
Then run one default-file probe to prove backward compatibility:
`timeout 60 node_modules/.bin/electron tools/probe_shell.js --probe=tools/probes/engine-l0.js --wait=2000` → `RESULT: PASS`.

- [ ] **Step 5: Commit**
```bash
git add docs/superpowers/specs/2026-07-08-unified-os-phase4-satellites-reskin.md tools/probe_shell.js tools/probes/satellite-material.js
git commit -m "test(satellites): material probe + probe harness --file arg (Phase 4 red state)"
```

---

### Task 2: overlay-card.html

**Files:** Modify: `renderer/overlay-card.html`
**Interfaces:** Consumes `.glass`/tokens from system-shell.css; gate = satellite-material probe.

- [ ] **Step 1: Swap the stylesheet link**
Old: `<link rel="stylesheet" href="theme.css">` → New: `<link rel="stylesheet" href="system-shell.css">`

- [ ] **Step 2: Alias-shim the token block**
Replace:
```css
:root{
  --card-accent:var(--accent,#7fd1ff);
  --card-soft:var(--accent-soft,rgba(127,209,255,.14));
  --txt:#f2f6fa; --mut:#9fabb8; --faint:#66727e;
  --glass:rgba(10,14,20,.34);
  --mono:ui-monospace,'SF Mono','Cascadia Code',Consolas,monospace;
  --sans:'Inter',system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;
}
```
with:
```css
/* Alias shim (Unified OS Phase 4): material values resolve from system-shell.css; the old
   token names stay so every rule below keeps working untouched. --mono now comes shared. */
:root{
  --glass-density:0;
  --card-accent:var(--core);
  --card-soft:color-mix(in srgb, var(--core) 14%, transparent);
  --txt:var(--ink); --mut:var(--dim); --faint:#66727e;
  --sans:var(--read);
}
```

- [ ] **Step 3: Delete the retired fullLight overrides (4 rules)**
Delete these lines wherever they appear:
```css
html[data-theme="fullLight"]{--txt:#1a1d24;--mut:#5f6672;--faint:#9098a4;--glass:rgba(255,255,255,.55)}
```
```css
html[data-os="win10"][data-theme="fullLight"] #card{background:#f2f4f8}
```
```css
html[data-theme="fullLight"] .head .x{background:rgba(0,0,0,.07)}
```
```css
html[data-theme="fullLight"] .row{border-bottom-color:rgba(0,0,0,.06)}
```

- [ ] **Step 4: #card adopts .glass**
Markup: `<div id="card">` → `<div id="card" class="glass">`
Replace:
```css
#card{
  position:fixed;inset:8px;display:flex;flex-direction:column;
  background:var(--glass);
  -webkit-backdrop-filter:blur(28px) saturate(160%);backdrop-filter:blur(28px) saturate(160%);
  border-radius:22px;overflow:hidden;
  border:1px solid rgba(255,255,255,.14);
  box-shadow:0 24px 80px -20px rgba(0,0,0,.6), 0 0 0 1px rgba(255,255,255,.04) inset;
  opacity:0;transform:scale(.94) translateY(8px);
  transition:opacity .22s ease,transform .26s cubic-bezier(.2,.9,.3,1.2);
}
```
with:
```css
#card{ /* material (fill/blur/hairline/grain/shadow) comes from .glass */
  position:fixed;inset:8px;display:flex;flex-direction:column;
  --e:3;
  border-radius:22px;overflow:hidden;
  opacity:0;transform:scale(.94) translateY(8px);
  transition:opacity .22s ease,transform .26s cubic-bezier(.2,.9,.3,1.2);
}
```
And delete (covered by the `.glass` Win10 fallback):
```css
html[data-os="win10"] #card{background:#10141c;-webkit-backdrop-filter:none;backdrop-filter:none}
```

- [ ] **Step 5: Verify + commit**
Run: the Task 1 Step 4 loop. Expected: `overlay-card.html RESULT: PASS`; other three still FAIL.
```bash
git add renderer/overlay-card.html
git commit -m "feat(satellites): overlay card cut from the shared glass (Phase 4)"
```

---

### Task 3: weather-board.html

**Files:** Modify: `renderer/weather-board.html`

- [ ] **Step 1: Swap the stylesheet link** (same one-line swap as Task 2 Step 1).

- [ ] **Step 2: Alias-shim the token block**
Replace:
```css
:root{
  --card-accent:var(--accent,#7fd1ff);
  --card-soft:var(--accent-soft,rgba(127,209,255,.14));
  --txt:#f2f6fa; --mut:#c3cbd4; --faint:#88919c;
  --glass:rgba(12,18,28,.38);
  --mono:ui-monospace,'SF Mono','Cascadia Code',Consolas,monospace;
  --sans:'Inter',system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;
}
```
with:
```css
/* Alias shim (Unified OS Phase 4): --glass IS the shared material fill now, so every tile
   below is cut from the same glass; big panes take the .glass class instead. */
:root{
  --glass-density:0;
  --card-accent:var(--core);
  --card-soft:color-mix(in srgb, var(--core) 14%, transparent);
  --txt:var(--ink); --mut:var(--dim); --faint:#88919c;
  --glass:rgb(12 16 26 / calc(.42 + .34*var(--glass-density)));
  --sans:var(--read);
}
```

- [ ] **Step 3: Tiles adopt material blur + hairline (tokens, no class)**
In the `.h-tile` rule, replace:
```css
  background:var(--glass);-webkit-backdrop-filter:blur(14px);backdrop-filter:blur(14px);
  border:1px solid rgba(255,255,255,.08);
```
with:
```css
  background:var(--glass);-webkit-backdrop-filter:blur(22px) saturate(1.3);backdrop-filter:blur(22px) saturate(1.3);
  border:1px solid var(--hair);
```
In the `.tile` rule, replace:
```css
.tile{padding:16px;border-radius:18px;background:var(--glass);
  -webkit-backdrop-filter:blur(14px);backdrop-filter:blur(14px);
  border:1px solid rgba(255,255,255,.08);min-height:118px}
```
with:
```css
.tile{padding:16px;border-radius:18px;background:var(--glass);
  -webkit-backdrop-filter:blur(22px) saturate(1.3);backdrop-filter:blur(22px) saturate(1.3);
  border:1px solid var(--hair);min-height:118px}
```
Re-point both tile Win10 fallbacks to the material's fallback gradient — replace:
```css
html[data-os="win10"] .h-tile{background:rgba(16,20,28,.92);-webkit-backdrop-filter:none;backdrop-filter:none}
```
with:
```css
html[data-os="win10"] .h-tile{background:linear-gradient(180deg, rgba(18,24,36,.94), rgba(10,14,22,.96));-webkit-backdrop-filter:none;backdrop-filter:none}
```
and replace:
```css
html[data-os="win10"] .tile{background:rgba(16,20,28,.92);-webkit-backdrop-filter:none;backdrop-filter:none}
```
with:
```css
html[data-os="win10"] .tile{background:linear-gradient(180deg, rgba(18,24,36,.94), rgba(10,14,22,.96));-webkit-backdrop-filter:none;backdrop-filter:none}
```

- [ ] **Step 4: #days adopts .glass**
Markup: `<div id="days"></div>` → `<div id="days" class="glass"></div>`
Replace:
```css
#days{margin:6px 24px 18px;padding:6px 16px;border-radius:18px;
  background:var(--glass);-webkit-backdrop-filter:blur(14px);backdrop-filter:blur(14px);
  border:1px solid rgba(255,255,255,.08)}
```
with:
```css
#days{margin:6px 24px 18px;padding:6px 16px;border-radius:18px}
```
And delete:
```css
html[data-os="win10"] #days{background:rgba(16,20,28,.92);-webkit-backdrop-filter:none;backdrop-filter:none}
```

- [ ] **Step 5: Verify + commit**
Probe loop: board now PASS (card still PASS; overlay/mini still FAIL).
```bash
git add renderer/weather-board.html
git commit -m "feat(satellites): weather board tiles cut from the shared glass, sky untouched (Phase 4)"
```

---

### Task 4: overlay.html (HUD panel — the `--void` collision file)

**Files:** Modify: `renderer/overlay.html`

- [ ] **Step 1: Swap the stylesheet link** (same one-line swap).

- [ ] **Step 2: Alias-shim the token block (retiring the local `--void`)**
Replace:
```css
:root{
  --accent:#7fd1ff;
  --accent-dim:color-mix(in srgb, var(--accent) 16%, transparent);
  --accent-line:color-mix(in srgb, var(--accent) 55%, transparent);
  --confirm:#5ad19a;
  --bad:#e9637b;
  --txt:#f2f6fa; --mut:#9fabb8; --faint:#66727e;
  --void:rgba(7,10,15,.16);          /* the glass tint itself - deliberately slight */
  --edge-hi:rgba(255,255,255,.5);    /* top edge highlight */
  --edge-lo:rgba(255,255,255,.04);   /* bottom edge, near-gone */
  --mono:ui-monospace,'SF Mono','Cascadia Code','JetBrains Mono',Consolas,monospace;
  --sans:'Inter',system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;
}
```
with:
```css
/* Alias shim (Unified OS Phase 4): accent/status/text/hairline resolve from
   system-shell.css. The local --void tint and --edge-hi/lo highlights are retired —
   #panel now wears the shared .glass material (fill + hairline + grain). --bad and
   --mono are deleted, not aliased: the shared sheet provides both names. */
:root{
  --glass-density:.2;
  --accent:var(--core);
  --accent-dim:color-mix(in srgb, var(--accent) 16%, transparent);
  --accent-line:color-mix(in srgb, var(--accent) 55%, transparent);
  --confirm:var(--good);
  --txt:var(--ink); --mut:var(--dim); --faint:#66727e;
  --line:var(--hair);
  --sans:var(--read);
}
```
(Note: `--line` was previously supplied by theme.css — 5 usages in this file — so the alias
line is REQUIRED, not optional.)

- [ ] **Step 3: #panel adopts .glass**
Markup: `  <div id="panel">` → `  <div id="panel" class="glass">`
Replace:
```css
#panel{
  position:fixed;inset:0;display:flex;flex-direction:column;
  background:var(--void);
  -webkit-backdrop-filter:blur(26px) saturate(150%);backdrop-filter:blur(26px) saturate(150%);
  border-radius:3px;overflow:hidden;
  /* Corners are sharp ON PURPOSE, not a bug we couldn't fix: a HUD reads as an instrument,
     not a soft app window, and the corner brackets below make that a deliberate signature
     rather than an accident. */
  box-shadow:
    0 30px 100px -24px rgba(0,0,0,.65),
    0 10px 34px -12px rgba(0,0,0,.5),
    0 46px 130px -30px rgba(127,209,255,.07);
  transition:box-shadow .25s ease;
}
```
with:
```css
#panel{ /* material (fill/blur/hairline/grain/shadow) comes from .glass */
  position:fixed;inset:0;display:flex;flex-direction:column;
  --e:3;
  border-radius:3px;overflow:hidden;
  /* Corners are sharp ON PURPOSE, not a bug we couldn't fix: a HUD reads as an instrument,
     not a soft app window, and the corner brackets below make that a deliberate signature
     rather than an accident. */
  transition:box-shadow .25s ease;
}
```

- [ ] **Step 4: Delete the superseded rules**
Delete (covered by the `.glass` Win10 fallback):
```css
html[data-os="win10"] #panel{
  background:#10141c;
  -webkit-backdrop-filter:none;backdrop-filter:none;
}
```
Delete (the razor-edge gradient — replaced by the material's `--hair` border + `--hair-lit` inset):
```css
#panel::before{ /* the razor-thin gradient edge */
  content:'';position:absolute;inset:0;border-radius:inherit;padding:1px;pointer-events:none;
  background:linear-gradient(180deg, var(--edge-hi), var(--edge-lo) 55%, var(--edge-lo));
  -webkit-mask:linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
  mask:linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
  -webkit-mask-composite:xor; mask-composite:exclude;
}
```
(`#panel.dragging`'s box-shadow override still wins over `.glass` — ID beats class.)

- [ ] **Step 5: Sanity-grep for orphans, verify, commit**
Run: `grep -nE "var\(--void\)|var\(--edge-hi\)|var\(--edge-lo\)|var\(--bad\)|var\(--mono\)" renderer/overlay.html | grep -vE "^\s*[0-9]+:\s*/\*"`
Expected: NO `--void`/`--edge-hi`/`--edge-lo` matches (retired); `var(--bad)`/`var(--mono)` matches are fine (shared sheet supplies them).
Probe loop: overlay now PASS (mini still FAIL).
```bash
git add renderer/overlay.html
git commit -m "feat(satellites): HUD panel cut from the shared glass — void tint + edge gradient retired (Phase 4)"
```

---

### Task 5: mini-overlay.html (bubble — aliases only)

**Files:** Modify: `renderer/mini-overlay.html`

- [ ] **Step 1: Swap the stylesheet link** (same one-line swap).

- [ ] **Step 2: Alias-shim the token block**
Replace:
```css
:root{
  --accent:#7fd1ff;
  --confirm:#5ad19a;
  --mono:ui-monospace,'SF Mono','Cascadia Code','JetBrains Mono',Consolas,monospace;
}
```
with:
```css
/* Alias shim (Unified OS Phase 4): accent/confirm resolve from system-shell.css; --mono now
   comes shared. The orb art below is identity, not chrome — untouched. (#bubble's own --ink
   and --glow are element-scoped numbers/colors that deliberately shadow nothing.) */
:root{
  --accent:var(--core);
  --confirm:var(--good);
}
```

- [ ] **Step 3: Verify + commit**
Probe loop: ALL FOUR now PASS (bubble path skips the `.glass` assertion).
```bash
git add renderer/mini-overlay.html
git commit -m "feat(satellites): bubble aliases onto the shared tokens (Phase 4)"
```

---

### Task 6: Full regression (verification only, no commit)

- [ ] **Step 1: All four satellite probes** (Task 1 Step 4 loop) → 4× PASS.
- [ ] **Step 2: The 11 index-page probes + node suites**
```bash
node tests/test-shell-reducer.js && node tests/test-nexus-feed.js
for p in engine-l0 material dock transcript motion fallbacks interaction select live-orb settings-focus; do
  r=$(timeout 90 node_modules/.bin/electron tools/probe_shell.js --probe=tools/probes/$p.js --wait=2600 2>/dev/null | grep -E '^RESULT:')
  printf '%-15s %s\n' "$p" "$r"
done
```
Expected: both suites pass; 10× `RESULT: PASS` (index.html untouched; the harness default keeps them identical).
- [ ] **Step 3: Manual spot-check** (report to Farouk, not blocking): bubble → expand panel; run automation → card; ask weather → board — all read as the shell's glass.

---

## Self-Review (done at plan time)

- **Spec coverage:** §4.1 mappings → Tasks 2–5 (every token row present, incl. overlay's `--line` theme-dependency discovered at plan time); `--void` collision → Task 4 Steps 2–4; fullLight removal → Task 2 Step 3; §4.2 density → per-file `--glass-density` (card/board 0, panel .2 — panel's old tint was lightest); §4.3 stamping → verified pre-existing (spec amended, Task 1); §5 files → matches; §6 probe → Task 1 (incl. bubble exemption by pathname + `themeCssGone`); §7 link-order edge case → resolved by the in-place swap + disjoint-names analysis (documented in the spec amendment).
- **Placeholder scan:** none — every step is an exact old→new block or exact command + expected output.
- **Consistency:** `--glass-density` defined in every file that references it (card/board/overlay; bubble doesn't reference it); probe asserts only what Tasks 2–5 deliver; `.glass` recipients = exactly `#panel`/`#card`/`#days`; deleted names (`--void`, `--edge-hi/lo`, local `--bad`/`--mono`/`--glass`(card)) each verified against remaining usages (Task 4 Step 5 grep; card's `--glass` had exactly one usage — the #card rule being replaced).
- **Cascade check:** shared sheet linked after local `<style>` — shared/local names disjoint except `--mono` (shared-wins desired); aliases reference names the shared sheet does not define, so they cannot be overridden.
