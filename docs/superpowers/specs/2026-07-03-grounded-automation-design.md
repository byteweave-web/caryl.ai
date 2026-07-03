# Grounded Automation (UIA-First Hardening) — Design Spec

**Date:** 2026-07-03
**Sub-project:** B of 4 (A = foundation, shipped; C = smart audio, D = camera mode pending)
**Status:** Approved design, pre-implementation

## Context

Caryl.ai's desktop automation is a step loop in `main.js` (screenshot → LLM picks the next
action → sidecar executes) with a Python sidecar (`automation.py`, Flask on 127.0.0.1:7842)
that already tries UIA (the `uiautomation` package) before falling back to vision-model
pixel guessing. `automation.log` shows the real failure modes this spec eliminates:

1. **Unnamed controls are invisible.** `_uia_collect` skips elements with an empty `Name`,
   so most text boxes (Notepad's editor, search fields) can never be found —
   `'text box' best=0.47 among 262 elements`.
2. **Wrong search root.** Only the foreground window is walked; the Start menu, taskbar,
   and desktop are separate windows — `'Notepad' best=0.00 among 3 elements` right after
   pressing Win.
3. **No loop-breaker.** The same `rightclick desktop → click View` cycle repeated ~10×
   over four minutes.
4. **No post-action verification.** Clicks are assumed to work; nothing checks that a menu
   opened or focus moved.
5. **Planner nonsense executes.** e.g. `type: empty area` — the target description typed
   as literal text.

Decisions locked with the user:

- **Bulletproof scope:** (i) app launching & window control, (ii) in-app clicking &
  typing. File/desktop operations and browser automation keep today's behavior (not
  hardened to the same bar in B).
- **Uncertainty policy:** smart retry (wider re-scan) → **pause & ask the user** with
  candidates. Vision never aims clicks at regular controls.
- **Approach:** UIA-grounded planning (element inventory + act-by-id) — approved as
  "Approach A", absorbing the deterministic app-launch recipe.

## B1. Element inventory — sidecar `GET/POST /elements`

New endpoint returning the actionable elements visible right now.

**Roots walked (in order, each with its own slice of the time budget):**

1. Foreground window (`GetForegroundWindow` → UIA element).
2. Start menu / search host when open (its own top-level window: class
   `Windows.UI.Core.CoreWindow`, names "Start"/"Search"; probe cheaply, skip if absent).
3. Taskbar (`Shell_TrayWnd`).
4. Desktop icon list (existing `_uia_desktop_root()` helper).

**Collection changes vs today:**

- **Unnamed interactive elements are kept.** Interactive set: Edit, ComboBox, Button,
  SplitButton, MenuItem, TabItem, ListItem, TreeItem, CheckBox, RadioButton, Hyperlink,
  Slider, Document. An unnamed element gets a synthesized label:
  `LabeledBy` target name → else nearest preceding static-text sibling → else
  `AutomationId` → else the bare type ("Edit control"). Synthesis is a pure function
  (testable without a live desktop).
- Non-interactive named elements (static text, panes) are still collected (they carry
  context) but ranked below interactive ones.
- **Ranking + cap:** interactive types first, then named before synthesized, then larger
  on-screen area. Cap ~150 entries for the planner payload; the FULL uncapped list is
  cached server-side for id resolution.

**Response entry:** `{ id, name, type, rect: [l,t,r,b], center: [x,y], enabled, focused }`
plus top-level `{ elements, foreground: {title, class}, truncated, walk_ms }`.

**Budgets:** total walk ≤ ~1.5 s typical (per-root sub-budgets; existing `_UIA_MAX_*`
constants stay authoritative). The id→element cache is invalidated by the next `/elements`
call; `/act` with a stale/unknown id returns a clear error instead of clicking anything.

## B2. Verified actions + state reports — sidecar `/act` changes

- **`element_id` support:** `click` / `rightclick` / `doubleclick` / `hover` accept
  `element_id`; the click lands on the cached element's clickable point (rect center),
  re-reading its current rect first (elements move). No fuzzy re-matching. Free-text
  `target` stays supported for compatibility and out-of-scope flows.
- **State report on every `/act` response:** `state: { foreground_title,
  foreground_class, focused_name, focused_type, new_window: title|null }` (new_window =
  a top-level window that wasn't foreground before the action). Cheap: two focused-element
  reads + one foreground probe, no full walk.
- **Typed-text verification:** after a `type` action, if the focused element exposes a
  readable value (ValuePattern), report `typed_verified: true|false` in the response.
- **`open_app` action (deterministic launch primitive):** input `{action: "open_app",
  app: "notepad"}` → press Win → type the app name → Enter → poll (≤ 8 s) until the
  foreground window's title or process name matches the request (case-insensitive
  substring) → `{ok: true, window: title}` or honest `{ok: false, error}`. No Start-tile
  clicking, no vision.

## B3. Grounded planner loop — main.js

- **Each step:** call `/elements`; render the capped list as compact text
  (`17 | Button | Save`), ≤ ~4 KB, included in the step prompt next to the screenshot.
- **Action schema gains ids:** `{"action":"click","element_id":17}` (also rightclick /
  doubleclick / hover). `open_app` becomes a first-class planner action. Free-text
  targets remain legal only with `"not_in_list": true`, signalling the escalation path.
- **History gets ground truth:** after each action, the history line records the state
  report — `clicked 'File' (MenuItem); foreground now 'Untitled - Notepad'; focused:
  'Edit'` — never assumptions.
- **Sanity gate before execution:** reject and re-prompt (with the reason in history) when
  (a) a `type` action's text case-insensitively equals a recent target description or an
  element label, (b) an action is identical to the previous one and the previous state
  report showed no change, (c) `element_id` is unknown/stale.

## B4. Escalation ladder + loop-breaker

**Free-text target miss (locator below threshold):**

1. **Wide re-scan:** all roots, extended budget (~4 s), threshold relaxed only if the top
   candidate is unique with a clear margin (top ≥ 0.45 and ≥ 0.15 above #2).
2. **Pause & ask:** reuse the existing pending-confirm mechanism (same pattern as shell
   confirms — promise pause, card in chat + overlay pop). Card shows the wanted target and
   up to 3 best candidates (name/type); user picks one, skips the step, or stops the run.
   Timeout behaves like the existing confirm timeout (declines safely).

**Loop-breaker (planner level):** keep fingerprints of recent actions
(action+target/element_id) and a state hash (foreground title + focused control +
element-list hash):

- 3 identical fingerprints in the last 4 steps, **or** 2 consecutive steps with an
  unchanged state hash → inject an explicit history notice: "You are stuck: the last
  actions changed nothing. Do something different or declare the task impossible."
- Still stuck after 2 more steps → pause & ask (same card: continue / stop).

**Vision demotion:** vision-model pixel aiming survives only as an explicit
`vision_click` action, and only when the focused window hosts a Document/browser control
(web content, where UIA truly can't see). For everything else the ladder above applies.
Vision keeps its existing roles in `verifyAutomationDone` and screen descriptions.

## B7. Frictionless execution — no plan-approval gate

The user directly requests a desktop task ("open Notepad, write a paragraph, save it"),
so making them then click "Go ahead" on a plan card is redundant friction. New behavior:

- A directly-requested automation task **runs immediately** — the `automation_plan` card
  and its approval wait are skipped. Caryl says "Starting now" and begins the grounded
  step loop, narrating each step in the activity thread.
- **Mid-run confirmations stay:** shell commands and file deletes keep their existing
  `automation_confirm` cards (irreversible/dangerous ops). This is the safety boundary the
  user chose.
- **Stop stays live:** the bubble/panel Stop button halts any run instantly (unchanged).
- **Reversible:** a new config flag `automationRequirePlanApproval` (default **false**) and
  a Settings → Desktop Automation toggle "Preview & approve a plan first". When true, the
  old propose-plan-then-approve flow returns unchanged.

This removes the separate plan-proposal LLM call on the default path (also faster): the
grounded step loop already decides and narrates each action, so a static preview adds
latency without adding safety once dangerous ops are individually confirmed.

## B8. UIA-only automation — no vision model in the loop (user directive, post-acceptance)

Live acceptance runs exposed that the step planner ran on the VISION engine; with vision
routed to a small local model (moondream) it cannot emit JSON actions, degrading every
run (describe-then-decide, typed digits instead of clicks, duplicate open_app, stray
win+d). The user's directive: automation is **UIA-first only** — remove vision from
automation entirely, keep vision as a chat ability the user invokes explicitly
("can you see my screen?" → "summarize the paragraph").

- The step planner is the **chat model**, text-only: it observes the world through the
  `/elements` inventory (id | type | name + foreground title) and the post-action state
  reports in its history. No screenshots are captured or sent during automation.
- The describe-then-decide (twoStage) machinery and `decideStepViaChatModel` are removed.
- Done-verification is text-based: fresh `/elements` + foreground title → chat model
  verdict (same JSON verdict shape as before).
- The opt-in plan preview (B7 toggle) also plans via the chat model, text-only.
- The sidecar's vision fallback stays fully suppressed for automation (`allow_vision:
  false`, from B4); `see_screen`/`see_camera` chat features are untouched.
- Sidecar `hotkey` and `scroll` responses gain the same `state` report as click/type
  (the text-only planner depends on state reports for observability).

## B5. Error handling principles

- `/elements` failure (UIA missing, walk error) degrades to today's behavior (free-text
  locator + ladder) with a logged warning — never a crashed run.
- Every pause-&-ask path must be cancellable and must never leave `automationState.active`
  wedged (finally-blocks like the existing confirm flow).
- Sidecar endpoints stay non-fatal: any exception → JSON error, run continues or stops
  cleanly with the reason in chat.
- All new log kinds are structured like existing ones: `elements_served`, `act_verified`,
  `open_app`, `stuck_break`, `escalate_rescan`, `escalate_ask`, `sanity_reject`.

## B6. Testing & acceptance

**Pure-logic tests** (`tests/test_automation.py`, plain `assert`, run with
`.venv/Scripts/python.exe`, no framework — mirrors the node tests):
label synthesis for unnamed elements, ranking/cap ordering, scorer changes,
fingerprint/stuck detection helpers (extracted as pure functions), sanity-gate rules.
Wire into `npm test` alongside the node suites.

**Acceptance suite — "zero margin of error" bar.** Each task must pass **3 consecutive
runs** on the real desktop, driven from chat:

1. "Open Notepad" (from any starting state).
2. "Open Settings, then switch back to Notepad" (launch + window switching).
3. "Maximize the Notepad window, then minimize it."
4. "In Notepad, type: The quick brown fox. — then select all and delete it."
   (unnamed Edit control targeting + typed-text verification).
5. "In Notepad, open the File menu and click Save As, then cancel the dialog."
   (menu navigation + dialog controls).
6. "Open Explorer and click the Documents item in the sidebar." (named control in a
   real app).
7. "Close Notepad" (window control, handling the save prompt via its named buttons).
8. Stuck-recovery drill: a goal referencing a control that doesn't exist ("click the
   Purple Banana button in Notepad") must end with pause-&-ask (not a loop, not a wrong
   click).

**Regression watch:** after acceptance, `uia_no_match` for named controls in the log
should be ~0; every miss must show a following `escalate_rescan`/`escalate_ask`, never a
blind vision click on a regular control.

## Constraints (inherited + B-specific)

- No new npm or Python dependencies (`uiautomation` already present).
- Element payload to the planner ≤ ~4 KB; walk budget ≤ ~1.5 s typical per step.
- Windows 10 must work (UIA APIs used are Win10+; no Win11-only calls).
- All user-visible strings say Caryl; log stays at `automation.log` (rotating handler).
- Existing out-of-scope flows (file ops, browser goals, shell commands, plan approval,
  permission gates) keep their current behavior and safety confirmations.

## File map (planned)

| File | Change |
|---|---|
| `automation.py` | `/elements` endpoint, multi-root collection, label synthesis, `element_id` + state report + `open_app` in `/act`, new log kinds |
| `main.js` | grounded step prompt + id actions, sanity gate, escalation ladder, loop-breaker, pause-&-ask card wiring |
| `renderer/index.html` | pause-&-ask card (pattern of the existing shell-confirm card); Desktop Automation "preview & approve" toggle |
| `renderer/overlay.html` | same card in the overlay thread |
| `preload.js` | confirm-answer IPC for the new card (reuse/extend existing automation confirm channel) |
| `tests/test_automation.py` | new pure-logic test suite |
| `package.json` | `npm test` gains the python suite |
