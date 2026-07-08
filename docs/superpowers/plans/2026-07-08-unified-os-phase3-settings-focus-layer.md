# Unified OS Phase 3 — Settings as a Focus-Layer: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Convert the Settings panel from an opaque modal+scrim into a frosted-glass focus-layer that rides the shell's shared camera pull-back — summoned by the gear through `Shell.setFocus('settings')`, dismissed back to the prior focus (Orb/Chat).

**Architecture:** Zero new machinery — `renderer/shell-reducer.js` already fully specifies the `settings` focus (depth 1, density 0.72, engine-not-throttled) and `renderer/system-shell.js` already sets `data-focus` + the eased CSS vars. This plan only (a) keys the panel's visibility off `:root[data-focus="settings"]` instead of a `.open` class, (b) dresses `.settings` in the shared `.glass` material and retires the `.scrim`, and (c) rewires ~4 JS sites through `Shell.setFocus`.

**Tech Stack:** Vanilla JS/CSS (no new deps) · offscreen-Electron probe harness · node+assert.

**Spec:** `docs/superpowers/specs/2026-07-08-unified-os-phase3-settings-focus-layer.md`.

## Global Constraints

- **No new npm dependencies.**
- **Never sweep-commit:** the working tree carries unrelated changes. `git add` ONLY the files each step lists: `renderer/index.html`, `tools/probes/settings-focus.js`, `tests/test-shell-reducer.js`.
- **Do NOT touch** `renderer/shell-reducer.js`, `renderer/system-shell.js`, `renderer/system-shell.css` (the reducer already returns the right values; changing it is out of scope).
- **Shell treatment only:** do NOT change any settings page/control markup. The ONLY internal tweak allowed is softening the `.settings .nav` background to transparent (container chrome, not a control).
- **Keep the legacy `.open` fallback** in `openSettings`/`closeSettings`/Esc/sync so Settings still opens if `window.Shell` ever fails to load.
- **Verification:** run probes via `node_modules/.bin/electron tools/probe_shell.js --probe=tools/probes/<name>.js --wait=<ms>` (exit 0 + `RESULT: PASS`). The harness prints one pre-existing `console-message … deprecated` warning — ignore it. Do NOT run the full `npm test` (its trailing Python step fails on a pre-existing unrelated `automation.py:458` SyntaxError in the user's WIP); run `node tests/test-shell-reducer.js` + the probes instead.
- Spine motion values (from `system-shell.css`, reuse verbatim): 420ms `cubic-bezier(.2,.8,.2,1)`. Glass density for settings = `0.72`. Glass fill alpha = `calc(.42 + .34*var(--glass-density))`.

---

### Task 1: Convert Settings to a glass focus-layer

**Files:**
- Create: `tools/probes/settings-focus.js`
- Modify: `renderer/index.html` (settings CSS ~132-137, `.nav` ~138, scrim element ~310, `.settings` aside tag ~311, `openSettings` ~747, Esc handler ~758, `closeSettings` ~918, sync-if-open ~2618)
- Modify: `tests/test-shell-reducer.js` (settings block ~22-25)

**Interfaces:**
- Consumes: `window.Shell.setFocus(name)` + `Shell.state.focus` (system-shell.js), `window.ShellReducer.deriveShell` (shell-reducer.js), the `.glass` material + `--focus-depth`/`--glass-density` (system-shell.css).
- Produces: Settings reachable as `data-focus="settings"`; no `#scrim` element; `_focusBeforeSettings` restore behavior.

- [ ] **Step 1: Write the failing probe**

Create `tools/probes/settings-focus.js`:

```js
(async function () {
  function sleep(ms){ return new Promise(function(r){ setTimeout(r, ms); }); }
  var root = document.documentElement, out = {};
  if(!window.Shell){ return JSON.stringify({ pass:false, detail:{ error:'Shell missing' } }); }

  // The dark modal scrim must be gone — the pulled-back engine is the backdrop now.
  out.scrimGone = !document.getElementById('scrim');

  // Enter Settings as a focus-layer.
  Shell.setFocus('orb'); await sleep(120);
  Shell.setFocus('settings');
  await sleep(650);   // let the 420ms spine ease --focus-depth / --glass-density
  var cs = getComputedStyle(root);
  out.dataFocus    = root.getAttribute('data-focus');
  out.focusDepth   = parseFloat(cs.getPropertyValue('--focus-depth'));
  out.glassDensity = parseFloat(cs.getPropertyValue('--glass-density'));
  var panel = document.getElementById('settings'), pcs = getComputedStyle(panel);
  out.panelOpacity = parseFloat(pcs.opacity);
  out.panelPE      = pcs.pointerEvents;
  // Engine keeps rendering behind the glass (0.72 < 0.92 occlusion).
  out.engineThrottled = !!(window.ShellReducer && window.ShellReducer.deriveShell({focus:'settings'}).engineThrottle);
  // The topbar gear stays hittable while Settings is up.
  var gear = document.querySelector('.topbar .iconbtn'); var gr = gear.getBoundingClientRect();
  var gh = document.elementFromPoint(gr.left+gr.width/2, gr.top+gr.height/2);
  out.gearHittable = !!(gh && (gh===gear || gear.contains(gh)));

  // Exit restores the prior focus (orb) and hides the panel.
  Shell.setFocus('orb'); await sleep(650);
  out.exitDataFocus   = root.getAttribute('data-focus');
  out.exitPanelOpacity = parseFloat(getComputedStyle(panel).opacity);

  var pass = out.scrimGone && out.dataFocus==='settings'
    && out.focusDepth > 0.8 && Math.abs(out.glassDensity - 0.72) < 0.12
    && out.panelOpacity > 0.9 && out.panelPE === 'auto'
    && out.engineThrottled === false && out.gearHittable === true
    && out.exitDataFocus === 'orb' && out.exitPanelOpacity < 0.1;
  return JSON.stringify({ pass: pass, detail: out });
})()
```

- [ ] **Step 2: Run the probe — confirm it FAILS**

Run: `node_modules/.bin/electron tools/probe_shell.js --probe=tools/probes/settings-focus.js --wait=2600`
Expected: `RESULT: FAIL`, with detail showing `scrimGone:false` (the `#scrim` element still exists) and `panelOpacity:0` (the panel's visibility is still gated on the old `.open` class, which `Shell.setFocus` doesn't set). That's the red state this task fixes.

- [ ] **Step 3: CSS — retire scrim + modal chrome, add glass + data-focus visibility**

In `renderer/index.html`, replace this block (the scrim + settings rules):

```
.scrim{position:fixed;inset:0;background:rgba(0,0,0,.5);backdrop-filter:blur(2px);opacity:0;pointer-events:none;transition:.2s;z-index:40}
.scrim.open{opacity:1;pointer-events:auto}
.settings{position:fixed;top:50%;left:50%;transform:translate(-50%,-48%) scale(.98);opacity:0;pointer-events:none;
  width:880px;max-width:95vw;height:580px;max-height:90vh;background:var(--panel);border:1px solid var(--line);
  border-radius:16px;display:flex;overflow:hidden;z-index:50;transition:opacity .18s,transform .18s}
.settings.open{opacity:1;pointer-events:auto;transform:translate(-50%,-50%) scale(1)}
```

with (scrim rules deleted entirely; `.settings` becomes a glass focus-layer keyed off `data-focus`):

```
/* Settings is a focus-layer (spec Phase 3): a glass HUD over the pulled-back engine, not a
   modal. Visibility + entrance ride the shell's data-focus and the 420ms spine; the .glass
   material (system-shell.css) supplies fill/blur/border, fill riding --glass-density. */
.settings{position:fixed;top:50%;left:50%;transform:translate(-50%,-48%) scale(.98);opacity:0;pointer-events:none;
  --e:3;width:880px;max-width:95vw;height:580px;max-height:90vh;
  display:flex;overflow:hidden;z-index:50;
  transition:opacity 420ms cubic-bezier(.2,.8,.2,1),transform 420ms cubic-bezier(.2,.8,.2,1)}
:root[data-focus="settings"] .settings{opacity:1;pointer-events:auto;transform:translate(-50%,-50%) scale(1)}
@media (prefers-reduced-motion: reduce){ .settings{transition:opacity 200ms linear} }
```

(Removed `background`/`border`/`border-radius` so the `.glass` class supplies them; added `--e:3` elevation.)

- [ ] **Step 4: CSS — soften the nav to transparent**

Replace:

```
.settings .nav{width:176px;flex:0 0 176px;border-right:1px solid var(--line);background:var(--panel2);
  padding:14px 8px;display:flex;flex-direction:column;gap:2px;overflow-y:auto}
```

with (transparent fill + hairline divider so the single glass pane reads through both columns):

```
.settings .nav{width:176px;flex:0 0 176px;border-right:1px solid var(--hair);background:transparent;
  padding:14px 8px;display:flex;flex-direction:column;gap:2px;overflow-y:auto}
```

- [ ] **Step 5: Markup — remove the scrim, glass-ify the panel**

Delete this line entirely:

```
<div class="scrim" id="scrim" onclick="closeSettings()"></div>
```

Change the settings aside's class from `class="settings"` to `class="settings glass"`:

```
<aside class="settings glass" id="settings">
```

- [ ] **Step 6: JS — route entry through the shell (`openSettings`)**

Replace:

```
function openSettings(){ document.getElementById('settings').classList.add('open'); document.getElementById('scrim').classList.add('open'); populateEngine(); populateWeather(); populateAiMode(); populateVoiceInputCard();
  /* install_learn_my_voice:openSettings-hook */
  try { populateLearnMyVoiceCard(); } catch (_e) {}
 syncSettings(); loadModels(); loadMics(); populateExtras(); renderAppearance(); showSettingsPage('engines'); }
```

with:

```
let _focusBeforeSettings = 'orb';
function openSettings(){
  // Enter the Settings focus-layer (spec Phase 3). Remember where we came from so Close/Esc
  // restores it (Orb or Chat). Population below is unchanged. Legacy .open toggle only if the
  // shell runtime somehow isn't loaded.
  if(window.Shell){ if(Shell.state.focus !== 'settings') _focusBeforeSettings = Shell.state.focus || 'orb'; Shell.setFocus('settings'); }
  else { document.getElementById('settings').classList.add('open'); }
  populateEngine(); populateWeather(); populateAiMode(); populateVoiceInputCard();
  /* install_learn_my_voice:openSettings-hook */
  try { populateLearnMyVoiceCard(); } catch (_e) {}
  syncSettings(); loadModels(); loadMics(); populateExtras(); renderAppearance(); showSettingsPage('engines');
}
```

- [ ] **Step 7: JS — route exit through the shell (`closeSettings`)**

Replace:

```
function closeSettings(){ document.getElementById('settings').classList.remove('open'); document.getElementById('scrim').classList.remove('open'); }
```

with:

```
function closeSettings(){
  // Restore the focus we came from (Orb or Chat). Legacy fallback if the shell isn't loaded.
  if(window.Shell){ Shell.setFocus(_focusBeforeSettings || 'orb'); }
  else { document.getElementById('settings').classList.remove('open'); }
}
```

- [ ] **Step 8: JS — update the two remaining `.open` readers**

Esc handler — replace:

```
  if(e.key==='Escape' && document.getElementById('settings').classList.contains('open')) closeSettings();
```

with:

```
  if(e.key==='Escape' && ((window.Shell && Shell.state.focus==='settings') || document.getElementById('settings').classList.contains('open'))) closeSettings();
```

Keep-Settings-fresh sync — replace:

```
  if(document.getElementById('settings').classList.contains('open')) syncSettings();
```

with:

```
  if((window.Shell && Shell.state.focus==='settings') || document.getElementById('settings').classList.contains('open')) syncSettings();
```

- [ ] **Step 9: Verify no stray `.open`/`#scrim` references remain**

Run: `grep -nE "getElementById\('scrim'\)|settings.*classList.*'open'|class=\"scrim\"|\.scrim" renderer/index.html`
Expected: no matches. (If any line still adds/removes/reads the settings `.open` class or references `#scrim`, fix it before continuing — the `.open` class and scrim are fully retired except for the two `window.Shell`-guarded legacy fallbacks in `openSettings`/`closeSettings`, which use `classList.add/remove('open')`, not `.contains`/`#scrim`.)

- [ ] **Step 10: Reducer test — assert settings pulls the engine back**

In `tests/test-shell-reducer.js`, in the settings block, after:

```
r = S.deriveShell({ focus: 'settings' });
assert.strictEqual(r.glassDensityTarget, S.DENSITY.settings, 'settings denser');
assert.strictEqual(r.engineThrottle, false, 'settings not throttled by default');
```

add:

```
assert.strictEqual(r.focusDepthTarget, 1, 'settings pulls the engine back');
```

- [ ] **Step 11: Run the probe — confirm it now PASSES**

Run: `node_modules/.bin/electron tools/probe_shell.js --probe=tools/probes/settings-focus.js --wait=2600`
Expected: `RESULT: PASS`, detail showing `scrimGone:true`, `dataFocus:"settings"`, `focusDepth`≈1, `glassDensity`≈0.72, `panelOpacity`≈1, `panelPE:"auto"`, `engineThrottled:false`, `gearHittable:true`, `exitDataFocus:"orb"`, `exitPanelOpacity`≈0.

- [ ] **Step 12: Full regression suite**

Run `node tests/test-shell-reducer.js` (expect OK) and all 10 probes:
```bash
for p in engine-l0 material dock transcript motion fallbacks interaction select live-orb settings-focus; do
  r=$(timeout 90 node_modules/.bin/electron tools/probe_shell.js --probe=tools/probes/$p.js --wait=2600 2>/dev/null | grep -E '^RESULT:')
  printf '%-15s %s\n' "$p" "$r"
done
```
Expected: reducer OK; all 10 `RESULT: PASS`. (The existing probes don't open Settings, so they should be unaffected; `interaction`/`select`/`engine-l0` also prove the page still boots after the CSS/JS edits.)

- [ ] **Step 13: Commit**

```bash
git add renderer/index.html tools/probes/settings-focus.js tests/test-shell-reducer.js
git commit -m "feat(shell): Settings becomes a glass focus-layer (Phase 3) — retire the modal + scrim

The gear now routes through Shell.setFocus('settings'): the engine does the shared
camera pull-back and a frosted .glass Settings HUD rises over it (density 0.72, engine
still rendering behind). Visibility keys off data-focus instead of an .open class; the
dark scrim is gone; Close/Esc restore the prior focus (Orb or Chat). Legacy .open
fallback retained for a missing shell runtime. Guarded by tools/probes/settings-focus.js."
```

---

## Self-Review (done at plan time)

- **Spec coverage:** §5.1 visibility → Step 3 (`[data-focus="settings"]`) + Steps 6-8 (retire `.open`); §5.2 glass+scrim → Steps 3-5; §5.3 wiring → Steps 6-8; §6 files → matches (only index.html + probe + reducer test; reducer/runtime/css untouched); §7 edge cases → legacy fallback (Steps 6-7), re-entry guard (Step 6 `if focus!=='settings'`), open-from-chat (`_focusBeforeSettings`), tab-dismiss (free via existing setView); §8 testing → Steps 1-2/11/12 + reducer assertion Step 10.
- **Placeholder scan:** none — every step carries exact old→new strings or full file content + exact commands and expected output.
- **Type/name consistency:** `_focusBeforeSettings` defined in Step 6, read in Step 7; `Shell.state.focus`/`Shell.setFocus` used consistently; probe asserts the same field names it reads; the `.glass` class (Step 5) matches the CSS assumption in Step 3 (no bg/border on `.settings`, glass supplies them).
- **Scope check:** single cohesive task (CSS+JS are interdependent — a half-conversion doesn't run), TDD-bracketed by the probe; no settings-content markup touched.
