# Unified OS — Phase 2: Chat Transcript & Peripheral Dock (Implementation Plan)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Retire the rounded chat bubbles for a data-physical transcript, and make "leaving Chat" condense the last exchange into a hairline ticker in the Orb's lower-left peripheral vision.

**Architecture:** Task 1 is a CSS-only restyle of the existing `.msg` classes (no `renderActs` markup change — lower risk). Task 2 adds a `#chat-dock` element inside `#view-orb`, an `updateChatDock()` updater called on activity render and on a new `shell:focus` event the runtime dispatches. Verified with the Phase 1 offscreen probe harness.

**Tech Stack:** Same as Phase 1 — vanilla renderer JS/CSS, `tools/probe_shell.js` offscreen probes.

## Global Constraints

Inherits Phase 1's Global Constraints (tokens, fonts, layer/z contract, fallbacks, offline). New for this phase:
- Chat prose uses `--read` (IBM Plex Sans); all meta/labels use `--mono`; timestamps are `font-variant-numeric: tabular-nums`.
- The transcript has **no rounded bubbles, no filled backgrounds** — hairlines, a `--core` tick (you) / leader tether (Caryl), and letter-spaced mono meta only.
- The peripheral dock lives at the Orb's lower-left, inset by `--gutter`, and only appears when focus is `orb` and history exists.

---

### Task 1: Data-physical transcript (CSS-only)

**Files:**
- Modify: `renderer/index.html` — replace the `.msg` CSS block (lines ~89–94).
- Create: `tools/probes/transcript.js`

**Interfaces:**
- Consumes: `--core --ink --dim --read --mono` (Phase 1). No JS API changes; `renderActs` markup is untouched (`.msg.user`, `.msg.ai`, `.msg .t`, `.msg.think`, `.msg.sys` classes stay).

- [ ] **Step 1: Write the failing probe**

Create `tools/probes/transcript.js`:

```js
(function () {
  var out = {};
  if (!window.Shell || typeof renderActs !== 'function') return JSON.stringify({ pass: false, detail: { noShellOrRender: true } });
  window.Shell.setFocus('chat');
  renderActs([
    { kind: 'heard', text: 'what time is it', time: '10:00' },
    { kind: 'said', text: 'It is ten past.', time: '10:01' },
    { kind: 'action', text: 'noted', time: '10:02' },
  ]);
  var box = document.getElementById('chat-scroll');
  var user = box.querySelector('.msg.user');
  var ai = box.querySelector('.msg.ai');
  var t = box.querySelector('.msg .t');
  if (!user || !ai || !t) return JSON.stringify({ pass: false, detail: { missing: { user: !!user, ai: !!ai, t: !!t } } });

  var ug = getComputedStyle(user), ag = getComputedStyle(ai), tg = getComputedStyle(t);
  var uAfter = getComputedStyle(user, '::after'), aBefore = getComputedStyle(ai, '::before');
  var CORE = 'rgb(88, 198, 255)';

  out = {
    userRadius: ug.borderTopLeftRadius, userBg: ug.backgroundColor, userFont: ug.fontFamily,
    userTick: uAfter.backgroundColor, aiLeader: aBefore.backgroundImage,
    tFont: tg.fontFamily, tNums: tg.fontVariantNumeric,
  };

  var pass =
    ug.borderTopLeftRadius === '0px' &&                    // bubbles retired
    (ug.backgroundColor === 'rgba(0, 0, 0, 0)' || ug.backgroundColor === 'transparent') &&
    /Plex Sans/.test(ug.fontFamily) &&                     // prose in --read
    uAfter.backgroundColor === CORE &&                     // your --core tick
    /gradient/.test(aBefore.backgroundImage) && /88, 198, 255/.test(aBefore.backgroundImage) && // Caryl leader tether
    /Plex Mono/.test(tg.fontFamily) &&                     // meta in --mono
    /tabular/.test(tg.fontVariantNumeric);                 // tabular timestamps

  return JSON.stringify({ pass: pass, detail: out });
})()
```

- [ ] **Step 2: Run the probe to verify it fails**

Run: `npx electron tools/probe_shell.js --probe=tools/probes/transcript.js`
Expected: `RESULT: FAIL` — bubbles still have `border-radius:14px`, filled backgrounds, Inter font.

- [ ] **Step 3: Replace the `.msg` CSS block**

In `renderer/index.html`, replace lines ~89–94:

```css
.msg{max-width:78%;padding:11px 15px;border-radius:14px;font-size:14.5px;line-height:1.5;white-space:pre-wrap;word-wrap:break-word}
.msg.user{align-self:flex-end;background:var(--accent-soft);border:1px solid var(--line)}
.msg.ai{align-self:flex-start;background:var(--panel);border:1px solid var(--line)}
.msg .t{display:block;font-size:10px;color:var(--faint);margin-top:6px;letter-spacing:.5px}
.msg.think{align-self:flex-start;background:transparent;color:var(--mut);font-style:italic;font-size:13px;border:0;padding:2px 6px;opacity:.8}
.msg.sys{align-self:center;color:var(--faint);font-size:11px;background:transparent;border:0;padding:0}
```

with the data-physical transcript (spec §6.2 — hairlines, tick, leader tether, no bubbles):

```css
/* Unified OS transcript (spec §6.2): no bubbles. Prose in --read; a --core tick marks
   your turns, a --core leader tethers Caryl's turns back toward the gutter/Core. */
.msg{max-width:82%;padding:2px 0 10px;font-family:var(--read);color:var(--ink);
  font-size:14.5px;line-height:1.55;white-space:pre-wrap;word-wrap:break-word;
  position:relative;background:transparent;border:0;border-radius:0}
.msg.user{align-self:flex-end;text-align:right;padding-right:14px}
.msg.user::after{content:"";position:absolute;top:3px;right:0;width:2px;height:calc(100% - 12px);
  background:var(--core);box-shadow:0 0 8px var(--core);border-radius:1px}
.msg.ai{align-self:flex-start;padding-left:14px}
.msg.ai::before{content:"";position:absolute;top:3px;left:0;width:2px;height:calc(100% - 12px);
  background:linear-gradient(var(--core),transparent);opacity:.85;border-radius:1px}
.msg .t{display:block;font-family:var(--mono);font-size:9.5px;color:var(--dim);margin-top:6px;
  letter-spacing:.14em;text-transform:uppercase;font-variant-numeric:tabular-nums}
.msg.think{align-self:flex-start;background:transparent;color:var(--dim);font-family:var(--mono);
  font-size:12px;border:0;padding:2px 0 2px 14px;opacity:.75}
.msg.sys{align-self:center;color:var(--dim);font-family:var(--mono);font-size:10.5px;
  letter-spacing:.1em;background:transparent;border:0;padding:2px 0}
```

- [ ] **Step 4: Run the probe to verify it passes**

Run: `npx electron tools/probe_shell.js --probe=tools/probes/transcript.js`
Expected: `RESULT: PASS`.

- [ ] **Step 5: Commit**

```bash
git add renderer/index.html tools/probes/transcript.js
git commit -m "feat(shell): data-physical chat transcript — retire bubbles for tick/leader/hairline (Phase 2)"
```

---

### Task 2: Peripheral dock (minimize → Orb's lower-left)

**Files:**
- Modify: `renderer/system-shell.js` — dispatch a `shell:focus` event on every focus change.
- Modify: `renderer/index.html` — add `#chat-dock` inside `#view-orb`; add `.chat-dock` CSS; add `updateChatDock(acts)`; call it from `renderActs` and on `shell:focus`.
- Create: `tools/probes/dock.js`

**Interfaces:**
- Consumes: `window.Shell` (Phase 1), `renderActs`, `lastActs`, `esc` (index.html), `setView` (the funnel).
- Produces: `window.updateChatDock(acts?)` — repaints the dock from `acts` (or `lastActs`); a `shell:focus` CustomEvent (`detail.focus`) dispatched by the runtime.

- [ ] **Step 1: Write the failing probe**

Create `tools/probes/dock.js`:

```js
(function () {
  var out = {};
  if (!window.Shell || typeof renderActs !== 'function') return JSON.stringify({ pass: false, detail: { noShellOrRender: true } });
  var acts = [{ kind: 'heard', text: 'what time is it', time: '10:00' }, { kind: 'said', text: 'It is ten past.', time: '10:00' }];

  // Focus the Orb and render an exchange -> the dock should show it in the periphery.
  window.Shell.setFocus('orb');
  renderActs(acts);
  var dock = document.getElementById('chat-dock');
  out.dockExists = !!dock;
  if (!dock) return JSON.stringify({ pass: false, detail: out });
  out.onOrb_class = dock.className;
  out.onOrb_text = dock.textContent;
  var onOrb = dock.classList.contains('on') && /ten past/i.test(dock.textContent) && /caryl/i.test(dock.textContent);

  // Enter Chat -> the dock retracts (focus-driven via the shell:focus event).
  window.Shell.setFocus('chat');
  out.inChat_class = dock.className;
  var offChat = !dock.classList.contains('on');

  return JSON.stringify({ pass: onOrb && offChat, detail: out });
})()
```

- [ ] **Step 2: Run the probe to verify it fails**

Run: `npx electron tools/probe_shell.js --probe=tools/probes/dock.js`
Expected: `RESULT: FAIL` — `#chat-dock` does not exist yet.

- [ ] **Step 3: Dispatch a `shell:focus` event from the runtime**

In `renderer/system-shell.js`, inside `apply()`, immediately after the `root.setAttribute('data-focus', t.focus);` line, add:

```js
    try { document.dispatchEvent(new CustomEvent('shell:focus', { detail: { focus: t.focus } })); } catch (_e) {}
```

- [ ] **Step 4: Add the dock element**

In `renderer/index.html`, replace the orb marginalia block (~lines 270–272):

```html
      <div class="orb-meta">
        <div class="orb-state" id="orb-state">idle</div>
        <div class="orb-caption" id="orb-caption"></div>
      </div>
```

with (adds the dock as a sibling so it only paints while the Orb view is active):

```html
      <div class="orb-meta">
        <div class="orb-state" id="orb-state">idle</div>
        <div class="orb-caption" id="orb-caption"></div>
      </div>
      <div class="chat-dock" id="chat-dock" onclick="setView('chat')" title="Resume conversation"></div>
```

- [ ] **Step 5: Add the dock CSS**

In `renderer/index.html`'s inline `<style>`, after the `.orb-caption{...}` rule (~line 85–88), add:

```css
/* Chat's peripheral vision (spec §6.3): the last exchange as a hairline ticker in the
   Orb's lower-left. Appears only while the Orb is in focus and history exists. */
.chat-dock{position:absolute;left:var(--gutter,30px);bottom:var(--gutter,30px);max-width:340px;
  font-family:var(--mono);font-size:11px;line-height:1.65;color:var(--dim);
  border-left:2px solid var(--core);padding:6px 0 6px 12px;cursor:pointer;text-align:left;
  opacity:0;transform:translateY(6px);transition:opacity .3s ease,transform .3s ease;pointer-events:none}
.chat-dock.on{opacity:.85;transform:none;pointer-events:auto}
.chat-dock .who{color:var(--core);letter-spacing:.12em;text-transform:uppercase;font-size:9px;margin-right:6px}
.chat-dock .txt{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
```

- [ ] **Step 6: Add `updateChatDock` and wire it**

In `renderer/index.html`, add this function next to `renderActs` (after the `renderActs` function definition):

```js
// The Chat peripheral dock: while the Orb is in focus, show the last exchange as a
// hairline ticker (spec §6.3). Reads the acts it's given, else the live lastActs.
function updateChatDock(acts){
  const dock=document.getElementById('chat-dock'); if(!dock) return;
  acts=acts||lastActs||[];
  const focus=document.documentElement.dataset.focus||'orb';
  const lastUser=acts.slice().reverse().find(function(a){return a.kind==='heard';});
  const lastAI=acts.slice().reverse().find(function(a){return a.kind==='said';});
  if(focus==='orb' && (lastUser||lastAI)){
    dock.innerHTML=(lastUser?'<div class="txt"><span class="who">you</span>'+esc(lastUser.text)+'</div>':'')+
                   (lastAI?'<div class="txt"><span class="who">caryl</span>'+esc(lastAI.text)+'</div>':'');
    dock.classList.add('on');
  } else {
    dock.classList.remove('on');
  }
}
document.addEventListener('shell:focus', function(){ try{ updateChatDock(); }catch(_e){} });
window.updateChatDock = updateChatDock;
```

Then call it at the very end of `renderActs`, just before its closing brace (after the `const cf=...` camera-caption block):

```js
  try { updateChatDock(acts); } catch(_e) {}
```

- [ ] **Step 7: Run the probe to verify it passes**

Run: `npx electron tools/probe_shell.js --probe=tools/probes/dock.js`
Expected: `RESULT: PASS` — dock shows the exchange on the Orb, retracts in Chat.

- [ ] **Step 8: Regression + commit**

Run: `npx electron tools/probe_shell.js --probe=tools/probes/motion.js` → Expected `PASS` (focus + composer guard still hold).
Run: `npx electron tools/probe_shell.js --probe=tools/probes/transcript.js` → Expected `PASS`.

```bash
git add renderer/system-shell.js renderer/index.html tools/probes/dock.js
git commit -m "feat(shell): Chat peripheral dock — last exchange in the Orb's lower-left (Phase 2)"
```

---

## Self-Review

**Spec coverage:** §6.2 data-physical transcript ✓ (Task 1: bubbles retired, `--read` prose, `--core` tick/leader, mono tabular meta). §6.3 minimize → peripheral vision ✓ (Task 2: `#chat-dock` in the Orb BL, focus-driven show/hide, click-to-resume; `orb-caption` last-reply behavior already exists from Phase 0). Re-expand-from-corner animation is the `.chat-dock` transition + the existing Chat pull-back — acceptable for this phase.

**Placeholder scan:** No TBD/TODO; every step has complete CSS/JS.

**Type consistency:** `updateChatDock(acts)` signature is identical across its definition, the `renderActs` call site (`updateChatDock(acts)`), and the `shell:focus` handler (`updateChatDock()` → falls back to `lastActs`). The `shell:focus` event name matches between the runtime dispatch (Task 2 Step 3) and the `document.addEventListener('shell:focus', …)` handler (Step 6). `#chat-dock` id matches across the element (Step 4), CSS (Step 5), and both probes.
