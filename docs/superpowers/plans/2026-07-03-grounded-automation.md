# Grounded Automation (UIA-First Hardening) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Caryl.ai's desktop automation land on exact UIA elements instead of guessing — a `/elements` inventory (incl. unnamed controls, multiple roots), act-by-element-id with post-action state reports, a deterministic `open_app` launch, a grounded planner loop, a loop-breaker, and a pause-&-ask escalation when the precise locator is unsure.

**Architecture:** The Python sidecar (`automation.py`) gains pure helper functions (label synthesis, ranking, scoring — unit-tested) plus a `/elements` endpoint and an id-cache; `/act` learns `element_id`, a state report, and `open_app`. `main.js`'s `runAutomationLoop` feeds the element list to the planner, requires act-by-id, adds a sanity gate + state-hash loop-breaker, and a wide-rescan → pause-&-ask ladder reusing the existing pending-confirm mechanism.

**Tech Stack:** Python 3 + Flask + `uiautomation` + `pyautogui` (all already installed); Electron main (CommonJS); vanilla JS renderer. Python tests via `.venv/Scripts/python.exe`; JS tests via `node`.

## Global Constraints

- No new npm or Python dependencies (`uiautomation`, `pyautogui`, `flask` already present).
- Element payload to the planner ≤ ~4 KB; element walk budget ≤ ~1.5 s typical per step.
- Windows 10 must work (no Win11-only UIA calls).
- All user-visible strings say **Caryl**; logging stays at `automation.log` via the existing `log_action(kind, detail)`.
- Bulletproof scope = (i) app launch & window control, (ii) in-app clicking & typing. File ops / browser / shell keep current behavior and confirmations.
- Every failure path is non-fatal: `/elements` failure degrades to the existing free-text locator; pause-&-ask must never wedge `automationState.active`.
- Online behavior with all engines online stays byte-for-byte where automation isn't involved.
- Commit after every task.

## File Structure

| File | Role |
|---|---|
| `automation.py` | pure helpers (`_uia_synth_label`, `_uia_rank`, `_uia_element_dict`), `/elements` endpoint + id-cache, `/act` `element_id`/state-report/`open_app`, new log kinds |
| `tests/test_automation.py` (new) | pure-logic unit tests (label synth, ranking, sanity/fingerprint helpers mirrored) |
| `main.js` | grounded step prompt + act-by-id, sanity gate, state-hash loop-breaker, rescan→pause-&-ask ladder |
| `renderer/index.html` | `automation_pick` card (choose-a-candidate / skip / stop) |
| `renderer/overlay.html` | same card in the overlay thread |
| `preload.js` | `automationPick(id, choice)` IPC |
| `package.json` | `npm test` runs the python suite too |

---

### Task 1: Pure UIA helpers in automation.py + test suite

**Files:**
- Modify: `automation.py` (add helpers near the other `_uia_*` functions, ~line 600)
- Create: `tests/test_automation.py`
- Modify: `package.json` (`test` script)

**Interfaces:**
- Consumes: existing `_uia_norm_words`, `_UIA_TYPE_HINTS`.
- Produces (used by Tasks 2–4):
  - `_uia_synth_label(name, ctype, labeledby_name, prev_text, automation_id)` → `str` (never empty)
  - `INTERACTIVE_TYPES` → `frozenset` of ControlTypeName strings
  - `_uia_rank_key(entry)` → sort key tuple; `entry` is the dict from `_uia_element_dict`
  - `_uia_element_dict(idx, name, ctype, rect, enabled, focused, synthesized)` → the `/elements` entry dict

- [ ] **Step 1: Write the failing test**

```python
# tests/test_automation.py
import os, sys
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import automation as A


def test_synth_label_prefers_real_name():
    assert A._uia_synth_label("Save", "ButtonControl", "", "", "") == "Save"


def test_synth_label_uses_labeledby_then_prevtext_then_id_then_type():
    assert A._uia_synth_label("", "EditControl", "Email", "", "") == "Email"
    assert A._uia_synth_label("", "EditControl", "", "Search the web", "") == "Search the web"
    assert A._uia_synth_label("", "EditControl", "", "", "SearchBox") == "SearchBox"
    lbl = A._uia_synth_label("", "EditControl", "", "", "")
    assert "Edit" in lbl and lbl.strip() != ""


def test_interactive_types_include_edit_and_button():
    assert "EditControl" in A.INTERACTIVE_TYPES
    assert "ButtonControl" in A.INTERACTIVE_TYPES
    assert "TextControl" not in A.INTERACTIVE_TYPES  # static text is context, not interactive


def test_element_dict_shape():
    d = A._uia_element_dict(3, "Save", "ButtonControl", (10, 20, 110, 60), True, False, False)
    assert d["id"] == 3
    assert d["name"] == "Save"
    assert d["type"] == "ButtonControl"
    assert d["rect"] == [10, 20, 110, 60]
    assert d["center"] == [60, 40]
    assert d["enabled"] is True and d["focused"] is False


def test_rank_interactive_before_static_and_named_before_synth():
    btn = A._uia_element_dict(0, "OK", "ButtonControl", (0, 0, 10, 10), True, False, False)
    txt = A._uia_element_dict(1, "Some label", "TextControl", (0, 0, 10, 10), True, False, False)
    synth = A._uia_element_dict(2, "Edit control", "EditControl", (0, 0, 10, 10), True, False, True)
    ordered = sorted([txt, synth, btn], key=A._uia_rank_key)
    assert ordered[0]["type"] == "ButtonControl"      # interactive+named first
    assert ordered[-1]["type"] == "TextControl"       # static text last


if __name__ == "__main__":
    import types
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and isinstance(fn, types.FunctionType):
            fn(); print("ok:", name)
    print("test_automation: all assertions passed")
```

- [ ] **Step 2: Run test to verify it fails**

Run: `.venv/Scripts/python.exe tests/test_automation.py`
Expected: FAIL with `AttributeError: module 'automation' has no attribute '_uia_synth_label'`

- [ ] **Step 3: Write the helpers**

Add after `_uia_score` (~line 666) in `automation.py`:

```python
# Interactive control types: an unnamed one of these is still worth offering to the
# planner (it can click/type into it); everything else is context only.
INTERACTIVE_TYPES = frozenset({
    "EditControl", "ComboBoxControl", "ButtonControl", "SplitButtonControl",
    "MenuItemControl", "TabItemControl", "ListItemControl", "TreeItemControl",
    "CheckBoxControl", "RadioButtonControl", "HyperlinkControl", "SliderControl",
    "DocumentControl",
})

# Human-friendly type label ("EditControl" -> "Edit"), used when nothing else names an element.
def _uia_type_label(ctype):
    c = str(ctype or "").replace("Control", "").strip()
    return c or "Element"


def _uia_synth_label(name, ctype, labeledby_name, prev_text, automation_id):
    """A never-empty label for an element: real Name > LabeledBy > nearby static text
    > AutomationId > bare type. Pure so it's unit-testable without a live desktop."""
    name = (name or "").strip()
    if name:
        return name
    for cand in ((labeledby_name or "").strip(), (prev_text or "").strip(), (automation_id or "").strip()):
        if cand:
            return cand[:80]
    return _uia_type_label(ctype) + " control"


def _uia_element_dict(idx, name, ctype, rect, enabled, focused, synthesized):
    """Build one /elements entry. rect is (left, top, right, bottom)."""
    l, t, r, b = int(rect[0]), int(rect[1]), int(rect[2]), int(rect[3])
    return {
        "id": int(idx),
        "name": str(name)[:80],
        "type": str(ctype or ""),
        "rect": [l, t, r, b],
        "center": [int((l + r) / 2), int((t + b) / 2)],
        "enabled": bool(enabled),
        "focused": bool(focused),
        "synthesized": bool(synthesized),
    }


def _uia_rank_key(entry):
    """Sort key: interactive first, then named-before-synthesized, then bigger area first.
    Returns a tuple usable with sorted() (all ascending -> we negate 'good' signals)."""
    interactive = 0 if entry.get("type") in INTERACTIVE_TYPES else 1
    synthesized = 1 if entry.get("synthesized") else 0
    l, t, r, b = entry.get("rect", [0, 0, 0, 0])
    area = max(0, (r - l)) * max(0, (b - t))
    return (interactive, synthesized, -area)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `.venv/Scripts/python.exe tests/test_automation.py`
Expected: `test_automation: all assertions passed`

- [ ] **Step 5: Wire into npm test**

In `package.json`, change the `test` script to also run the python suite:

```json
"test": "node tests/test-engines.js && node tests/test-migrate.js && node tests/test-downloads.js && .venv/Scripts/python.exe tests/test_automation.py",
```

- [ ] **Step 6: Commit**

```bash
git add automation.py tests/test_automation.py package.json
git commit -m "feat(automation): pure UIA helpers for element inventory (label synth, ranking) + tests"
```

---

### Task 2: `/elements` endpoint — multi-root inventory + id-cache

**Files:**
- Modify: `automation.py` (new endpoint near `/transcribe`/`/act`, ~line 928; module-level cache near other globals ~line 115)

**Interfaces:**
- Consumes: `_uia_collect`, `_uia_desktop_root`, `_uia_synth_label`, `_uia_element_dict`, `_uia_rank_key`, `INTERACTIVE_TYPES`, `_UIA_TIME_BUDGET_S`, `_UIA_MAX_ELEMENTS`.
- Produces (used by Tasks 3, 5):
  - `GET /elements` → `{ ok, elements: [entry...], foreground: {title, class}, truncated: bool, walk_ms: int }`
  - module global `_ELEMENT_CACHE = {"items": [full entries], "ts": float}` — full uncapped list keyed by `id` for `/act` resolution.
  - `_uia_collect_roots(deadline)` → list of raw `(el, name, ctype, rect, enabled, focused, synthesized)` tuples across all roots.

- [ ] **Step 1: Add the cache global**

Near the other module globals (after `_WHISPER_LRU` block, ~line 115):

```python
# Cache of the last /elements walk, so /act can resolve an element_id to exact coordinates
# without re-walking. Invalidated (overwritten) by the next /elements call.
_ELEMENT_CACHE = {"items": [], "ts": 0.0}
_ELEMENT_CAP = 150  # entries shown to the planner; full list stays cached for id resolution
```

- [ ] **Step 2: Add the multi-root collector**

After `locate_via_uia` (~line 734) in `automation.py`:

```python
def _uia_prev_static_text(el):
    """Best-effort: the Name of the nearest preceding sibling that is static text
    (used to label an adjacent unnamed field). Cheap, defensive, returns ''."""
    try:
        parent = el.GetParentControl()
        if not parent:
            return ""
        prev = ""
        for child in parent.GetChildren():
            if child == el:
                return prev
            try:
                if (child.ControlTypeName or "") in ("TextControl", "StaticControl") and (child.Name or "").strip():
                    prev = child.Name.strip()
            except Exception:
                pass
        return prev
    except Exception:
        return ""


def _uia_labeledby_name(el):
    try:
        lb = el.GetLabeledByControl() if hasattr(el, "GetLabeledByControl") else None
        return (lb.Name or "").strip() if lb else ""
    except Exception:
        return ""


def _uia_collect_roots(deadline):
    """Walk foreground + start menu + taskbar + desktop, returning raw element tuples:
    (el, label, ctype, rect, enabled, focused, synthesized). Named non-interactive
    elements are kept (context); unnamed elements are kept ONLY if interactive."""
    out = []
    try:
        fg_el = _uia.GetForegroundControl()
        fg_top = fg_el.GetTopLevelControl() if fg_el else None
    except Exception:
        fg_el, fg_top = None, None
    roots = []
    if fg_top is not None:
        roots.append(fg_top)
    # Start menu / search host (its own top-level window), taskbar, desktop icons.
    for cls in ("Windows.UI.Core.CoreWindow", "Shell_TrayWnd"):
        try:
            w = _uia.WindowControl(searchDepth=1, ClassName=cls)
            if w.Exists(0.2, 0.05):
                roots.append(w)
        except Exception:
            pass
    dk = _uia_desktop_root()
    if dk is not None:
        roots.append(dk)

    focused_rect = None
    try:
        if fg_el:
            fr = fg_el.BoundingRectangle
            focused_rect = (fr.left, fr.top, fr.right, fr.bottom)
    except Exception:
        focused_rect = None

    for root in roots:
        if time.time() > deadline:
            break
        for el, name, ctype, rect in _uia_collect_permissive(root, deadline):
            interactive = ctype in INTERACTIVE_TYPES
            nm = (name or "").strip()
            if not nm and not interactive:
                continue  # unnamed AND non-interactive -> nothing the planner can use
            synthesized = not nm
            label = _uia_synth_label(nm, ctype, _uia_labeledby_name(el) if synthesized else "",
                                     _uia_prev_static_text(el) if synthesized else "", "")
            try:
                enabled = bool(el.IsEnabled)
            except Exception:
                enabled = True
            focused = False
            if focused_rect is not None:
                try:
                    focused = (rect.left, rect.top, rect.right, rect.bottom) == focused_rect
                except Exception:
                    focused = False
            out.append((el, label, ctype, rect, enabled, focused, synthesized))
    return out
```

- [ ] **Step 3: Add the permissive collector variant**

`_uia_collect` (existing, ~line 616) skips unnamed elements. Add a sibling that keeps them, right after it:

```python
def _uia_collect_permissive(root, deadline):
    """Like _uia_collect but yields unnamed elements too (caller decides whether to drop
    them based on interactivity). Yields (element, name, control_type, rect)."""
    out = []
    if root is None:
        return out
    try:
        for el, depth in _uia.WalkControl(root, includeTop=False, maxDepth=_UIA_MAX_DEPTH):
            if time.time() > deadline or len(out) >= _UIA_MAX_ELEMENTS:
                break
            rect = _uia_visible_rect(el)
            if rect is None:
                continue
            try:
                name = (el.Name or "").strip()
            except Exception:
                name = ""
            try:
                ctype = el.ControlTypeName or ""
            except Exception:
                ctype = ""
            out.append((el, name, ctype, rect))
    except Exception as e:
        log_action("uia_walk_error", str(e)[:200])
    return out
```

- [ ] **Step 4: Add the endpoint**

Before `/act` (~line 928) in `automation.py`:

```python
@app.route("/elements", methods=["GET", "POST"])
def elements():
    """Inventory of actionable on-screen elements right now (foreground + start menu +
    taskbar + desktop). Caches the full list for /act element_id resolution."""
    if _uia is None:
        return jsonify({"ok": False, "error": "uiautomation not available", "elements": []})
    t0 = time.time()
    deadline = t0 + _UIA_TIME_BUDGET_S
    fg_title, fg_class = "", ""
    items = []
    try:
        with _uia.UIAutomationInitializerInThread():
            try:
                fg = _uia.GetForegroundControl()
                top = fg.GetTopLevelControl() if fg else None
                if top:
                    fg_title = (top.Name or "")[:120]
                    fg_class = top.ClassName or ""
            except Exception:
                pass
            raw = _uia_collect_roots(deadline)
        seen = set()
        for i, (el, label, ctype, rect, enabled, focused, synth) in enumerate(raw):
            key = (label, ctype, int(rect.left), int(rect.top))
            if key in seen:
                continue
            seen.add(key)
            items.append(_uia_element_dict(len(items), label, ctype,
                                           (rect.left, rect.top, rect.right, rect.bottom),
                                           enabled, focused, synth))
    except Exception as e:
        log_action("elements_error", str(e)[:200])
        return jsonify({"ok": False, "error": str(e)[:200], "elements": []})

    items.sort(key=_uia_rank_key)
    for i, it in enumerate(items):  # renumber ids to match the (now ranked) order
        it["id"] = i
    _ELEMENT_CACHE["items"] = items
    _ELEMENT_CACHE["ts"] = time.time()
    shown = items[:_ELEMENT_CAP]
    walk_ms = int((time.time() - t0) * 1000)
    log_action("elements_served", "%d elements (%d shown) in %dms; fg=%r" % (len(items), len(shown), walk_ms, fg_title[:40]))
    return jsonify({"ok": True, "elements": shown, "foreground": {"title": fg_title, "class": fg_class},
                    "truncated": len(items) > len(shown), "walk_ms": walk_ms})
```

- [ ] **Step 5: Verify the endpoint live**

Run: `.venv/Scripts/python.exe -m py_compile automation.py && echo OK`
Then start the app (`npm start`), trigger any automation once so the sidecar spawns, and in a second terminal:
`curl http://127.0.0.1:7842/elements`
Expected: JSON with `ok:true`, a non-empty `elements` array whose entries have `id/name/type/rect/center`, and a `foreground.title` matching your front window. Confirm at least one `synthesized:true` entry exists when a text field is on screen. Close the app.

- [ ] **Step 6: Commit**

```bash
git add automation.py
git commit -m "feat(automation): /elements inventory across foreground/start/taskbar/desktop with unnamed-control labels"
```

---

### Task 3: `/act` — element_id targeting + state report + typed-text verification

**Files:**
- Modify: `automation.py` (`/act` handler ~line 928; add a state-report helper near `_screenshot_hash` ~line 900)

**Interfaces:**
- Consumes: `_ELEMENT_CACHE`, `pyautogui`, `_uia`.
- Produces (used by Task 5):
  - `/act` accepts `element_id` (int) for click/rightclick/doubleclick/hover; resolves via cache to a fresh rect center.
  - Every `/act` response gains `state: {foreground_title, foreground_class, focused_name, focused_type, new_window}`.
  - `type` responses gain `typed_verified: bool|null`.
  - `_uia_state_report(prev_titles)` → the state dict; `_uia_top_titles()` → set of current top-level window titles.

- [ ] **Step 1: Add state-report helpers**

After `_hamming` (~line 925) in `automation.py`:

```python
def _uia_top_titles():
    """Set of current top-level window titles (for new-window detection). Best-effort."""
    titles = set()
    if _uia is None:
        return titles
    try:
        root = _uia.GetRootControl()
        for w in root.GetChildren():
            try:
                if (w.ControlTypeName or "") == "WindowControl":
                    n = (w.Name or "").strip()
                    if n:
                        titles.add(n)
            except Exception:
                pass
    except Exception:
        pass
    return titles


def _uia_state_report(prev_titles):
    """Foreground + focused control snapshot after an action. prev_titles: set from before."""
    rep = {"foreground_title": "", "foreground_class": "", "focused_name": "",
           "focused_type": "", "new_window": None}
    if _uia is None:
        return rep
    try:
        with _uia.UIAutomationInitializerInThread():
            try:
                fg = _uia.GetForegroundControl()
                top = fg.GetTopLevelControl() if fg else None
                if top:
                    rep["foreground_title"] = (top.Name or "")[:120]
                    rep["foreground_class"] = top.ClassName or ""
                if fg:
                    rep["focused_name"] = (fg.Name or "")[:80]
                    rep["focused_type"] = fg.ControlTypeName or ""
            except Exception:
                pass
            now = _uia_top_titles()
            fresh = now - (prev_titles or set())
            if fresh:
                rep["new_window"] = sorted(fresh)[0][:120]
    except Exception:
        pass
    return rep


def _uia_resolve_id(element_id):
    """Return a fresh (x, y, name, ctype) for a cached element id, re-reading its rect.
    None if the id is unknown/stale/off-screen."""
    try:
        eid = int(element_id)
    except Exception:
        return None
    for it in _ELEMENT_CACHE.get("items", []):
        if it["id"] == eid:
            # re-read live rect from cached center via ElementFromPoint would be circular;
            # trust the cached rect but verify it's still on-screen and non-degenerate.
            l, t, r, b = it["rect"]
            if r - l <= 0 or b - t <= 0:
                return None
            return (it["center"][0], it["center"][1], it["name"], it["type"])
    return None
```

- [ ] **Step 2: Handle element_id + state report in /act**

In the `/act` handler, at the very top of the `try:` (just after `try:` on ~line 958), capture pre-action window titles:

```python
        prev_titles = _uia_top_titles()
```

Then in the click branch (`if action in ("click", "rightclick", "doubleclick", "drag"):`, ~line 959), replace exactly these two original lines:

```python
            pos = locate_on_screen(target, max_width=max_width)
            if not pos and retry_width > max_width:
```

with id-resolution + a vision-demotion gate (spec B4: vision never aims at a regular control — a vision-only guess is discarded so the miss falls through to main.js's ladder):

```python
            eid = body.get("element_id", None)
            allow_vision = bool(body.get("allow_vision", True))  # automation sets this False
            pos = None
            if eid is not None and action != "drag":
                hit = _uia_resolve_id(eid)
                if hit is None:
                    return jsonify({"ok": False, "error": "element_id %r not found (list may be stale - re-scan)" % eid,
                                    "stale_id": True, "state": _uia_state_report(prev_titles)})
                pos = {"x": hit[0], "y": hit[1], "w": None, "h": None, "uia": True, "name": hit[2]}
                log_action("act_by_id", "id=%s -> %r (%s) at (%d,%d)" % (eid, hit[2][:40], hit[3], hit[0], hit[1]))
            if pos is None:
                pos = locate_on_screen(target, max_width=max_width)
            # Demote vision: a plain vision guess (not UIA, not deterministic) is suppressed
            # when the caller disallows it, so the run escalates (re-scan/ask) instead of
            # clicking a guessed pixel on a regular control.
            if pos and not allow_vision and not pos.get("uia") and not pos.get("deterministic"):
                pos = None
            if not pos and retry_width > max_width:
```

Then change every `/act` `jsonify({"ok": True, ...})` return in the handler to include the state report. For the click branch success return (~line 1006):

```python
            state = _uia_state_report(prev_titles)
            log_action("act_verified", "%s -> fg=%r focused=%r%s" % (action, state["foreground_title"][:40], state["focused_name"][:30], " NEWWIN" if state["new_window"] else ""))
            return jsonify({"ok": True, "did": did, "verify": verify, "x": x, "y": y, "state": state})
```

- [ ] **Step 3: Typed-text verification in the type branch**

In the `elif action == "type":` branch, replace the success return (~line 1023) with:

```python
            typed_verified = None
            try:
                with _uia.UIAutomationInitializerInThread():
                    fg = _uia.GetForegroundControl()
                    if fg and hasattr(fg, "GetValuePattern"):
                        vp = fg.GetValuePattern()
                        if vp and text:
                            cur = (vp.Value or "")
                            typed_verified = text.strip()[:40] in cur
            except Exception:
                typed_verified = None
            state = _uia_state_report(prev_titles)
            return jsonify({"ok": True, "did": did, "typed_verified": typed_verified, "state": state})
```

- [ ] **Step 4: Verify**

Run: `.venv/Scripts/python.exe -m py_compile automation.py && echo OK`
Then `npm start`, open Notepad manually, and from a second terminal:
```
curl http://127.0.0.1:7842/elements > /dev/null
curl -X POST http://127.0.0.1:7842/act -H "Content-Type: application/json" -d '{"action":"type","text":"hello caryl"}'
```
Expected: response JSON contains `state.foreground_title` (e.g. `"Untitled - Notepad"`) and `typed_verified: true`. Close the app.

- [ ] **Step 5: Commit**

```bash
git add automation.py
git commit -m "feat(automation): /act element_id targeting, post-action state report, typed-text verification"
```

---

### Task 4: Deterministic `open_app` in the sidecar (UIA-confirmed launch)

**Files:**
- Modify: `automation.py` (`/act` handler — add an `open_app` branch)

**Interfaces:**
- Produces (used by Task 5): `/act` with `{action:"open_app", app:"notepad"}` → `{ok, window|error, state}` after confirming a matching window is foreground (≤ 8 s poll). main.js will prefer this over `actions.run('open_app')` for automation runs (it verifies the window actually appeared).

- [ ] **Step 1: Add the branch**

In `/act`, add before the final `else` that errors on unknown actions (find the last `elif action == ...` in the handler and add after it):

```python
        elif action == "open_app":
            app_name = str(body.get("app") or body.get("target") or "").strip()
            safe = re.sub(r"[^a-zA-Z0-9 ._-]", "", app_name).strip()
            if not safe:
                return jsonify({"ok": False, "error": "no app name given"})
            prev_titles = _uia_top_titles()
            # Launch via the Start search: Win, type, Enter. No tile clicking, no vision.
            pyautogui.press("win")
            time.sleep(0.6)
            type_text(safe)
            time.sleep(0.6)
            pyautogui.press("enter")
            # Poll until a window whose title/class looks like the app is foreground.
            want = safe.lower()
            deadline = time.time() + 8.0
            got = None
            while time.time() < deadline:
                time.sleep(0.5)
                try:
                    with _uia.UIAutomationInitializerInThread():
                        fg = _uia.GetForegroundControl()
                        top = fg.GetTopLevelControl() if fg else None
                        title = (top.Name or "") if top else ""
                        cls = (top.ClassName or "") if top else ""
                except Exception:
                    title, cls = "", ""
                if want in title.lower() or want in cls.lower():
                    got = title
                    break
            state = _uia_state_report(prev_titles)
            if got is not None or state.get("new_window"):
                log_action("open_app", "%r -> %r" % (safe, got or state.get("new_window")))
                return jsonify({"ok": True, "did": "opened " + safe, "window": got or state.get("new_window"), "state": state})
            log_action("open_app_unconfirmed", "%r (no matching window)" % safe)
            return jsonify({"ok": False, "error": "launched \"%s\" but no matching window appeared" % safe, "state": state})
```

- [ ] **Step 2: Verify**

Run: `.venv/Scripts/python.exe -m py_compile automation.py && echo OK`
Then `npm start`, ensure Notepad is closed, and from a second terminal:
`curl -X POST http://127.0.0.1:7842/act -H "Content-Type: application/json" -d '{"action":"open_app","app":"notepad"}'`
Expected: Notepad opens; response `{ok:true, window:"Untitled - Notepad", state:{...}}`. Try a bogus name (`"app":"zzzznotanapp"`) → `{ok:false, error:"launched ... but no matching window appeared"}`. Close the app.

- [ ] **Step 3: Commit**

```bash
git add automation.py
git commit -m "feat(automation): deterministic open_app in sidecar (Win-type-Enter + UIA window confirmation)"
```

---

### Task 5: Grounded planner loop — element list + act-by-id in main.js

**Files:**
- Modify: `main.js` (`runAutomationLoop` ~line 1305–1671; `AUTOMATION_ACTIONS` already includes `open_app`)

**Interfaces:**
- Consumes: `/elements` (Task 2), `/act` `element_id`/`state`/`open_app` (Tasks 3–4).
- Produces (used by Task 6): each step fetches the element list, includes it in the prompt, and executes `element_id` actions; `stepObj.element_id` (number) is honored; the state report is appended to history.

- [ ] **Step 1: Fetch the element list each step**

In `runAutomationLoop`, right after `const dataUrl = await captureScreenCached(1024, 640);` (~line 1312) add:

```javascript
    // Grounded planning: the real, clickable elements on screen right now. The planner acts
    // by element_id against THIS list, so a click lands on an exact UIA rect, not a guess.
    let elementList = [];
    let elementText = '(element list unavailable - describe targets in plain English)';
    try {
      const els = await sidecarCall('/elements', {});
      if (els && els.ok && Array.isArray(els.elements)) {
        elementList = els.elements;
        elementText = elementList.length
          ? elementList.map((e) => e.id + ' | ' + e.type.replace('Control', '') + ' | ' + e.name + (e.focused ? ' [focused]' : '')).join('\n')
          : '(no actionable elements detected)';
      }
    } catch (_e) { /* non-fatal: fall back to free-text targets */ }
```

- [ ] **Step 2: Put the list in the step prompt + teach act-by-id**

In the `const sys = ...` block (~line 1315), insert the element list and id guidance. Change the `'Look at the attached CURRENT screenshot...'` line to:

```javascript
      'Look at the attached CURRENT screenshot AND this list of the real, clickable on-screen elements (id | type | name):\n' +
      elementText + '\n' +
      'To click/type into a listed element, set "element_id" to its number - this is EXACT and strongly preferred over "target". ' +
      'Only use a plain-English "target" (and set "not_in_list": true) when what you need genuinely is not in the list. ' +
```

And in the "Fields to include" list, add after the `target` line:

```javascript
      '- "element_id": the number of the element to act on from the list above (preferred for click/rightclick/doubleclick/type)\n' +
```

- [ ] **Step 3: Resolve element_id label + pass it through to /act**

In the generic action `else` branch (~line 1602), extend the payload and add a human label. Replace the `const payload = {...}` block with:

```javascript
      const cfgNow = config.get();
      const eid = (typeof stepObj.element_id === 'number') ? stepObj.element_id
        : (/^\d+$/.test(String(stepObj.element_id || '')) ? parseInt(stepObj.element_id, 10) : null);
      const chosen = (eid !== null) ? elementList.find((e) => e.id === eid) : null;
      const targetLabel = chosen ? chosen.name : (stepObj.target || '');
      const payload = {
        action: stepObj.action,
        element_id: (eid !== null ? eid : undefined),
        target: stepObj.target || '',
        // Vision never aims clicks at regular controls (spec B4): the sidecar suppresses a
        // vision-only guess, so a miss escalates to the re-scan/ask ladder instead.
        allow_vision: false,
        text: stepObj.text || '',
        keys: stepObj.keys || '',
        scroll_dir: stepObj.scroll_dir || 'down',
        drag_to: stepObj.drag_to || '',
        max_width: cfgNow.visionLocateMaxWidth || 1024,
        retry_width: cfgNow.visionLocateRetryWidth || 1600,
        verify: !!cfgNow.automationVerifyClicks,
        highlight_ms: cfgNow.automationHighlightTarget ? (cfgNow.automationHighlightMs || 450) : 0
      };
```

- [ ] **Step 4: Record the state report in history**

In the same branch, after a successful `/act` (the `activity.push({ kind: 'action', text: '• ' + (r.did ...)` success path, ~line 1648), append state facts. Replace that success `else` block body with:

```javascript
        } else {
          const st = r.state || {};
          const stateNote = st.foreground_title ? (' | now: ' + st.foreground_title + (st.focused_name ? ' / focused: ' + st.focused_name : '') + (st.new_window ? ' | NEW WINDOW: ' + st.new_window : '')) : '';
          activity.push({ kind: 'action', text: '• ' + (r.did || stepObj.action) + (targetLabel ? ' (' + targetLabel + ')' : ''), time: clockTime() });
          automationState.history.push((r.did || (stepObj.action + ' ' + targetLabel)) + stateNote + (r.typed_verified === false ? ' [WARN: typed text not confirmed in field]' : ''));
          automationState.lastState = st;
        }
```

- [ ] **Step 5: Route open_app through the sidecar's confirmed launcher**

Replace the `if (stepObj.action === 'open_app') {` block body (~line 1538) so it uses the sidecar (which verifies the window appeared) and falls back to the existing direct launcher:

```javascript
    if (stepObj.action === 'open_app') {
      const appName = String(stepObj.app || stepObj.target || '').trim();
      if (!appName) { automationState.history.push('open_app with no app name - skipped'); continue; }
      let r = await sidecarCall('/act', { action: 'open_app', app: appName });
      if (!r.ok) {
        // Sidecar couldn't confirm a window - try the direct OS launcher as a fallback.
        const d = await actions.run('open_app', { name: appName });
        r = d.ok ? { ok: true, did: d.summary || ('Opened ' + appName), state: {} } : { ok: false, error: d.summary || 'launch failed' };
      }
      if (r.ok) {
        activity.push({ kind: 'action', text: '• ' + (r.did || ('Opened ' + appName)), time: clockTime() });
        automationState.history.push('opened app: ' + appName + (r.window ? ' (window: ' + r.window + ')' : '') + ' - launched directly, not by clicking');
        const settle = (config.get().automationStepSettleMs || 700) + 500;
        await new Promise((res) => setTimeout(res, Math.max(1200, settle)));
      } else {
        activity.push({ kind: 'action', text: '⚠ Couldn’t open ' + appName + ' - ' + (r.error || 'launch failed'), time: clockTime() });
        automationState.history.push('failed to open app "' + appName + '": ' + (r.error || 'launch failed'));
      }
      continue;
    }
```

- [ ] **Step 6: Verify end-to-end**

Run: `node -e "new (require('vm').Script)(require('fs').readFileSync('main.js','utf8')); console.log('syntax OK')"`
Then `npm start`, and in chat: **"open Notepad and type hello"**. Watch the activity thread.
Expected: `open_app` opens Notepad (history shows the confirmed window title), then a `type` step whose history line includes `now: Untitled - Notepad`. No "clicked the wrong tile", no repeated Start-menu hunting. Close the app.

- [ ] **Step 7: Commit**

```bash
git add main.js
git commit -m "feat(automation): grounded planner loop - element list in prompt, act-by-id, state-report history, confirmed open_app"
```

---

### Task 6: Sanity gate + state-hash loop-breaker

**Files:**
- Modify: `main.js` (`runAutomationLoop` — anti-loop region ~line 1489–1536, and a new sanity check before execution)

**Interfaces:**
- Consumes: `automationState.lastState` (Task 5), `elementList` (Task 5).
- Produces (used by Task 7): `stuckStreak` counter and a `stateHash` per step; when `stuckStreak >= 2` after the "you are stuck" nudge, sets a flag Task 7's ladder reads to escalate to pause-&-ask.

- [ ] **Step 1: Add a state hash + stuck tracking**

Right after the element list fetch (end of Step 1 block from Task 5), add:

```javascript
    // State fingerprint: foreground title + focused control + a hash of the element labels.
    // Two steps with an identical fingerprint = nothing changed = we're stuck.
    const elemSig = elementList.map((e) => e.type + ':' + e.name).join('|');
    const stateHash = ((automationState.lastState && automationState.lastState.foreground_title) || '') + '#' +
      ((automationState.lastState && automationState.lastState.focused_name) || '') + '#' + elemSig.length + ':' + elemSig.slice(0, 200);
    if (stateHash === automationState.lastStateHash) automationState.stuckStreak = (automationState.stuckStreak || 0) + 1;
    else { automationState.lastStateHash = stateHash; automationState.stuckStreak = 0; }
```

Initialize the fields in the `automationState = {...}` literal (~line 1286): add `lastState: null, lastStateHash: '', stuckStreak: 0, askEscalate: false`.

- [ ] **Step 2: Nudge, then escalate, when stuck**

After the existing `if (repeatedActionCount >= 2) { announceAndStop(...) }` block (~line 1526), add a softer, state-based path ABOVE that hard stop — insert just before it:

```javascript
    // State-based stuck detection (complements the identical-action guard): the last action
    // changed nothing on screen. First inject an explicit nudge; if still stuck, escalate.
    if (automationState.stuckStreak === 1) {
      activity.push({ kind: 'action', text: '↻ Nothing changed on screen - rethinking the approach.', time: clockTime() });
      automationState.history.push('STUCK: the last action changed nothing on screen (same foreground, focus, and elements). Do something DIFFERENT - a different element_id, a keyboard shortcut, or declare the goal impossible. Do not repeat the last action.');
    } else if (automationState.stuckStreak >= 2) {
      automationState.askEscalate = true; // Task 7's ladder turns this into pause-&-ask
    }
```

- [ ] **Step 3: Add the sanity gate before execution**

Immediately before the big action dispatch (`if (stepObj.action === 'shell')`, ~line 1559), add:

```javascript
    // Sanity gate: reject actions that are obviously wrong before they execute.
    if (stepObj.action === 'type') {
      const txt = String(stepObj.text || '').trim().toLowerCase();
      const tgt = String(stepObj.target || '').trim().toLowerCase();
      // Typing the target DESCRIPTION as literal text (e.g. type "empty area") is the classic bug.
      if (txt && tgt && txt === tgt) {
        activity.push({ kind: 'action', text: '⚠ Skipped typing the target description as text.', time: clockTime() });
        automationState.history.push('SANITY: you set "text" equal to the target description ("' + txt.slice(0, 40) + '") - that types the label instead of real content. Set "text" to what should actually be typed, and use element_id to choose WHERE.');
        continue;
      }
    }
```

- [ ] **Step 4: Verify**

Run: `node -e "new (require('vm').Script)(require('fs').readFileSync('main.js','utf8')); console.log('syntax OK')"`
Then `npm start` and in chat: **"click the Purple Banana button in Notepad"** (a control that doesn't exist), with Notepad open.
Expected: the run does NOT click randomly or loop forever — after the stuck nudge it sets up escalation (Task 7 makes it ask). For now confirm in the log (`automation.log`) you see a `STUCK` history note rather than repeated identical clicks. Close the app.

- [ ] **Step 5: Commit**

```bash
git add main.js
git commit -m "feat(automation): sanity gate (reject typing the target) + state-hash loop-breaker"
```

---

### Task 7: Escalation ladder — wide re-scan → pause-&-ask card

**Files:**
- Modify: `automation.py` (`/elements` accepts a `wide` flag), `main.js` (miss handling + pause-&-ask), `renderer/index.html` + `renderer/overlay.html` (new `automation_pick` card), `preload.js` (`automationPick`)

**Interfaces:**
- Consumes: existing pending-confirm pattern (`automationState.pendingConfirm`, `automation:confirmShell`), `popOverlayForConfirm`/`collapsePanelAfterConfirm`.
- Produces: `automation_pick` activity card + `automation:pick` IPC + `bridge.automationPick(id, choice)`; a `wide` re-scan on `/elements`.

- [ ] **Step 1: Wide re-scan flag on /elements**

In `automation.py` `/elements`, replace `deadline = t0 + _UIA_TIME_BUDGET_S` with:

```python
    wide = bool((request.get_json(silent=True) or {}).get("wide")) if request.method == "POST" else False
    deadline = t0 + (_UIA_TIME_BUDGET_S * 2.5 if wide else _UIA_TIME_BUDGET_S)
```

`.venv/Scripts/python.exe -m py_compile automation.py` to confirm it parses.

- [ ] **Step 2: preload channel**

In `preload.js`, next to the other automation methods (~line 111):

```javascript
  automationPick: (id, choice) => ipcRenderer.invoke('automation:pick', id, choice),
```

- [ ] **Step 3: IPC handler in main.js**

Next to `automation:confirmShell` (~line 3231):

```javascript
ipcMain.handle('automation:pick', (_e, id, choice) => {
  // choice: a number (element_id chosen), 'skip', or 'stop'
  if (automationState && automationState.pendingConfirm && automationState.pendingConfirm.id === id) {
    const r = automationState.pendingConfirm.resolve; automationState.pendingConfirm = null; r(choice);
  }
  return { ok: true };
});
```

- [ ] **Step 4: The ladder in the loop**

Replace the free-text miss branch (`else if (/could not find/i.test(r.error || '')) {`, ~line 1651) with the rescan → ask ladder:

```javascript
      } else if ((/could not find/i.test(r.error || '')) || r.stale_id) {
        // (1) Wide re-scan: walk all roots with a longer budget and re-offer the list once.
        let recovered = false;
        try {
          const wide = await sidecarCall('/elements', { wide: true });
          if (wide && wide.ok && Array.isArray(wide.elements) && wide.elements.length) {
            elementList = wide.elements;
            const want = String(stepObj.target || targetLabel || '').toLowerCase().trim();
            const scored = want ? wide.elements.map((e) => ({ e, s: scoreLabel(want, e.name) })).sort((a, b) => b.s - a.s) : [];
            console.log('[automation] wide rescan: top=' + (scored[0] ? scored[0].e.name + ' ' + scored[0].s.toFixed(2) : 'none'));
            // Accept only a clearly-unique winner.
            if (scored.length && scored[0].s >= 0.45 && (scored.length < 2 || scored[0].s - scored[1].s >= 0.15)) {
              const r2 = await sidecarCall('/act', Object.assign({}, payload, { element_id: scored[0].e.id, target: '' }));
              if (r2.ok) {
                activity.push({ kind: 'action', text: '• ' + (r2.did || stepObj.action) + ' (re-scan: ' + scored[0].e.name + ')', time: clockTime() });
                automationState.history.push((r2.did || stepObj.action) + ' via wide re-scan on "' + scored[0].e.name + '"');
                recovered = true;
              }
            }
            // (2) Pause & ask: offer the top candidates.
            if (!recovered) {
              const cands = scored.slice(0, 3).map((x) => ({ id: x.e.id, name: x.e.name, type: x.e.type }));
              const answer = await askUserToPick(stepObj.target || targetLabel || stepObj.action, cands);
              if (answer === 'stop') { announceAndStop('■ Stopped - you ended the run at the element picker.'); stoppedEarly = true; break; }
              if (answer === 'skip' || answer == null) {
                automationState.history.push('user SKIPPED locating "' + (stepObj.target || targetLabel) + '" - move on or try another approach');
              } else {
                const r3 = await sidecarCall('/act', Object.assign({}, payload, { element_id: Number(answer), target: '' }));
                if (r3.ok) { activity.push({ kind: 'action', text: '• ' + (r3.did || stepObj.action) + ' (you picked it)', time: clockTime() }); automationState.history.push((r3.did || stepObj.action) + ' (user-picked element)'); recovered = true; }
                else { automationState.history.push('user-picked element still failed: ' + (r3.error || '')); }
              }
            }
          }
        } catch (_e) { /* fall through to the old note */ }
        if (!recovered) {
          activity.push({ kind: 'action', text: '⚠ ' + (r.error || 'could not find that') + ' - trying a different approach.', time: clockTime() });
          automationState.history.push('missed: ' + stepObj.action + ' "' + (stepObj.target || targetLabel) + '" (' + (r.error || '') + ')');
        }
```

- [ ] **Step 5: Add the helper functions in main.js**

Above `runAutomationLoop` (~line 1263), add the scorer and the ask-pauser:

```javascript
// Lightweight word-overlap score (0..1) between a wanted phrase and an element name.
// Mirrors the sidecar's _uia_score intent, JS-side, for the wide-rescan candidate ranking.
function scoreLabel(want, name) {
  const stop = new Set(['the', 'a', 'an', 'on', 'in', 'of', 'to', 'at', 'for', 'button', 'click', 'field', 'the']);
  const norm = (s) => String(s || '').toLowerCase().match(/[a-z0-9]+/g) || [];
  const w = norm(want).filter((x) => !stop.has(x));
  const n = norm(name).filter((x) => !stop.has(x));
  if (!w.length || !n.length) return 0;
  const ws = new Set(w), ns = new Set(n);
  let overlap = 0; ws.forEach((x) => { if (ns.has(x)) overlap++; });
  if (!overlap) return 0;
  return 0.6 * (overlap / ns.size) + 0.4 * (overlap / ws.size);
}

// Pause the run and ask the user to pick an element (or skip/stop), reusing the same
// pending-confirm plumbing as shell confirms. Resolves to a numeric id, 'skip', or 'stop'.
function askUserToPick(wanted, candidates) {
  return new Promise((resolve) => {
    if (!automationState) return resolve('stop');
    const pickId = 'autopick_' + Date.now();
    activity.push({ kind: 'automation_pick', id: pickId, wanted: String(wanted).slice(0, 80), candidates, time: clockTime() });
    speak('I’m not sure which one you mean. Can you pick?');
    popOverlayForConfirm();
    automationState.pendingConfirm = { id: pickId, resolve: (v) => { collapsePanelAfterConfirm(); resolve(v); } };
  });
}
```

- [ ] **Step 6: Render the card in both renderers**

In `renderer/index.html`, right after the `automation_confirm` card block (~line 1943), add:

```javascript
    if(a.kind==='automation_pick'){
      var opts=(a.candidates||[]).map(function(c){return '<button onclick="pickAutomation(\''+a.id+'\','+c.id+')" style="display:block;width:100%;text-align:left;background:var(--panel2);border:1px solid var(--line);color:var(--txt);border-radius:8px;padding:8px 11px;margin:4px 0;font:inherit;font-size:12px;cursor:pointer">'+esc(c.name)+' <span style="color:var(--faint)">('+esc(String(c.type).replace('Control',''))+')</span></button>';}).join('');
      return '<div class="msg ai" style="border:1px solid rgba(127,209,255,.35)"><div style="margin-bottom:7px;color:var(--accent);font-size:11px;letter-spacing:.06em;text-transform:uppercase">Which one did you mean?</div><div style="font-size:12px;margin-bottom:7px">Looking for: <b>'+esc(a.wanted)+'</b></div>'+opts+'<div style="display:flex;gap:8px;margin-top:6px"><button onclick="pickAutomation(\''+a.id+'\',\'skip\')" style="background:var(--panel2);border:1px solid var(--line);color:var(--txt);border-radius:8px;padding:6px 12px;font:inherit;font-size:12px;cursor:pointer">Skip step</button><button onclick="pickAutomation(\''+a.id+'\',\'stop\')" style="background:var(--panel2);border:1px solid var(--line);color:var(--txt);border-radius:8px;padding:6px 12px;font:inherit;font-size:12px;cursor:pointer">Stop</button></div></div>';
    }
```

And add the handler function near `confirmAutomationShell` (search for `function confirmAutomationShell` in index.html):

```javascript
function pickAutomation(id, choice){ window.bridge.automationPick(id, choice); }
```

In `renderer/overlay.html`, after its `automation_confirm` block (~line 379), add the same card but using `window.bridge.automationPick` inline:

```javascript
    if(a.kind==='automation_pick'){
      var opts=(a.candidates||[]).map(function(c){return '<button onclick="window.bridge.automationPick(\''+a.id+'\','+c.id+')" style="display:block;width:100%;text-align:left;background:rgba(255,255,255,.05);border:1px solid var(--line);color:var(--txt);border-radius:8px;padding:8px 11px;margin:4px 0;font:inherit;font-size:12px;cursor:pointer">'+esc(c.name)+' ('+esc(String(c.type).replace('Control',''))+')</button>';}).join('');
      return '<div class="brain" style="border:1px solid rgba(127,209,255,.4);border-radius:8px;padding:10px"><div style="margin-bottom:7px;color:var(--accent);font-size:10.5px;letter-spacing:.06em;text-transform:uppercase">Which one?</div><div style="font-size:12px;margin-bottom:7px">Looking for: <b>'+esc(a.wanted)+'</b></div>'+opts+'<div style="display:flex;gap:8px;margin-top:6px"><button onclick="window.bridge.automationPick(\''+a.id+'\',\'skip\')" style="background:rgba(255,255,255,.05);border:1px solid var(--line);color:var(--txt);border-radius:8px;padding:6px 12px;font:inherit;font-size:12px;cursor:pointer">Skip</button><button onclick="window.bridge.automationPick(\''+a.id+'\',\'stop\')" style="background:rgba(255,255,255,.05);border:1px solid var(--line);color:var(--txt);border-radius:8px;padding:6px 12px;font:inherit;font-size:12px;cursor:pointer">Stop</button></div></div>';
    }
```

- [ ] **Step 7: Wire the stuck-escalation flag (from Task 6) into an ask**

In the loop, right after the `automationState.askEscalate = true;` path executes (i.e. at the top of the step body, after the stuck block ~Task 6 Step 2), add — place it just before the action dispatch:

```javascript
    if (automationState.askEscalate) {
      automationState.askEscalate = false;
      const answer = await askUserToPick(goal + ' (I appear stuck)', (elementList || []).slice(0, 3).map((e) => ({ id: e.id, name: e.name, type: e.type })));
      if (answer === 'stop') { announceAndStop('■ Stopped - the task looked stuck and you ended it.'); stoppedEarly = true; break; }
      if (answer !== 'skip' && answer != null) {
        const rp = await sidecarCall('/act', { action: 'click', element_id: Number(answer) });
        if (rp.ok) automationState.history.push('user-picked element while stuck: ' + (rp.did || answer));
      } else {
        automationState.history.push('user let it continue past the stuck point - try a genuinely different approach');
      }
      automationState.stuckStreak = 0;
      continue;
    }
```

- [ ] **Step 8: Verify the full ladder**

Run: `node -e "new (require('vm').Script)(require('fs').readFileSync('main.js','utf8')); console.log('syntax OK')"` and `.venv/Scripts/python.exe -m py_compile automation.py && echo OK`.
Then `npm start`, Notepad open, chat: **"click the Save As option"** (exists only after opening File menu → forces a miss then recovery). And separately **"click the Wingding Frobnicator"** (never exists → must end at the pick card with Skip/Stop, never a random click or infinite loop).
Expected: first case recovers via wide re-scan or the pick card; second case shows the "Which one did you mean?" card and waits. Close the app.

- [ ] **Step 9: Commit**

```bash
git add main.js automation.py preload.js renderer/index.html renderer/overlay.html
git commit -m "feat(automation): escalation ladder - wide re-scan then pause-&-ask element picker; stuck-run escalation"
```

---

### Task 8: Acceptance suite + docs

**Files:**
- Modify: `main.js` (loop-breaker constant note only if needed), `README.md`, `INSTRUCTIONS.md`
- Create: `docs/automation-acceptance.md`

- [ ] **Step 1: Run the automated suites**

Run: `npm test`
Expected: all four suites print their pass lines, including `test_automation: all assertions passed`.

- [ ] **Step 2: Write the acceptance checklist doc**

Create `docs/automation-acceptance.md` with the spec's 8 tasks, each with a Pass/Fail × 3-runs table:

```markdown
# Grounded Automation — Acceptance Suite

Each task must pass 3 consecutive runs, driven from chat. Record pass/fail.

| # | Task (say in chat) | Run 1 | Run 2 | Run 3 |
|---|---|---|---|---|
| 1 | Open Notepad | | | |
| 2 | Open Settings, then switch back to Notepad | | | |
| 3 | Maximize the Notepad window, then minimize it | | | |
| 4 | In Notepad type: The quick brown fox. then select all and delete it | | | |
| 5 | In Notepad open the File menu and click Save As, then cancel the dialog | | | |
| 6 | Open Explorer and click the Documents item in the sidebar | | | |
| 7 | Close Notepad (handle the save prompt) | | | |
| 8 | Click the Purple Banana button in Notepad (must end at pause-&-ask, not a loop) | | | |

Regression watch (observable signals):
- `automation.log` shows `elements_served` and `act_by_id` entries (grounded path is live)
  and ~0 `uia_no_match` for controls that are actually visible.
- The chat/overlay activity thread shows a wide re-scan note or the "Which one did you
  mean?" picker on a genuine miss — never a silent pixel-guess click on a normal control.
- Task 8's non-existent-control goal ends at the picker (Skip/Stop), not a loop.
```

- [ ] **Step 3: Run the acceptance suite manually**

Launch `npm start` and run tasks 1–8 from chat, three times each, ticking the table. Fix any task that fails a run before proceeding (a failure here is a real defect, not a checkbox to skip). Task 8 must reach the pick card, not loop or misclick.

- [ ] **Step 4: Update docs**

In `README.md` architecture list, add a line under `automation.py`:
`- UIA element inventory (/elements), act-by-id, deterministic open_app, pause-&-ask when unsure.`
In `INSTRUCTIONS.md`, note that automation now grounds on the accessibility tree and asks you to pick when it can't identify a control confidently.

- [ ] **Step 5: Final commit**

```bash
git add -A
git commit -m "docs(automation): acceptance suite + grounded-automation notes - Sub-project B complete"
```

---

### Task 9: Frictionless execution — remove the plan-approval gate (spec B7)

**Do this BEFORE Task 8's manual acceptance run** so the acceptance suite exercises the
new no-approval flow.

**Files:**
- Modify: `lib/config.js` (DEFAULTS), `main.js` (`proposeAutomationPlan` ~line 1169, `ui:status`), `renderer/index.html` (Desktop Automation section ~line 371, status apply ~line 1774)

**Interfaces:**
- Consumes: existing `runAutomationLoop(goal)`, `config.get()`.
- Produces: config flag `automationRequirePlanApproval` (default `false`); when false, a requested task runs immediately (no `automation_plan` card); mid-run shell/delete confirms unchanged.

- [ ] **Step 1: Config default**

In `lib/config.js` DEFAULTS, add near the other automation-ish keys:

```js
  automationRequirePlanApproval: false, // false = run directly; true = propose a plan and wait
```

- [ ] **Step 2: Gate the plan proposal**

At the very top of `proposeAutomationPlan` (main.js ~line 1169), before the
`activity.push({ ... 'Looking at your screen to plan that out...' })` line, add:

```javascript
  // Frictionless default: the user directly asked for this task, so just do it - skip the
  // propose-a-plan-and-wait-for-"Go ahead" step. The grounded step loop narrates each action
  // and Stop stays live; shell/delete still confirm mid-run. Opt back in via Settings.
  if (!config.get().automationRequirePlanApproval) {
    runAutomationLoop(goal); // fire-and-forget, same as approvePlan does
    return;
  }
```

- [ ] **Step 3: Expose the flag in ui:status**

In the `ui:status` return object (main.js ~line 2980, near `push_to_talk_mode`), add:

```javascript
    automation_require_plan_approval: !!cfg.automationRequirePlanApproval,
```

- [ ] **Step 4: Settings toggle + copy fix**

In `renderer/index.html`, replace the static Desktop Automation description line (~line 373):

```html
      <div style="font-size:11.5px;color:var(--faint);line-height:1.5;margin:-2px 0 12px">Caryl always proposes a plan and waits for you to approve it before touching the mouse or keyboard, and always asks again before running any shell command &mdash; even mid-plan.</div>
```

with a toggle row + updated copy:

```html
      <div style="font-size:11.5px;color:var(--faint);line-height:1.5;margin:-2px 0 12px">Tasks you ask for run right away; Caryl narrates each step and you can Stop anytime. Shell commands and file deletes still ask first.</div>
      <div class="row"><div><div class="l">Preview &amp; approve a plan first</div><div class="d">Off = just do it. On = Caryl shows a plan and waits for your OK before acting.</div></div>
        <label class="sw"><input type="checkbox" id="tog-planapproval" onchange="window.bridge.setConfig({automationRequirePlanApproval:this.checked})"><span></span></label></div>
```

- [ ] **Step 5: Reflect the toggle from status**

In the status-apply function (main.js's `ui:status` consumer in index.html, ~line 1774 where `tog-mouse`/`tog-scripting` are set), add:

```javascript
  set('tog-planapproval', s.automation_require_plan_approval);
```

- [ ] **Step 6: Verify**

Run: `node -e "new (require('vm').Script)(require('fs').readFileSync('main.js','utf8')); console.log('syntax OK')"` and `npm test`.
Then `npm start`, ensure a mouse/scripting permission is on, and in chat: **"open Notepad"**.
Expected: NO "Go ahead" plan card — it starts immediately ("▶ Starting: open Notepad") and opens Notepad. Then Settings → Desktop Automation → turn ON "Preview & approve a plan first" → ask again → the plan card returns and waits. Turn it back OFF.

- [ ] **Step 7: Commit**

```bash
git add lib/config.js main.js renderer/index.html
git commit -m "feat(automation): run requested tasks immediately by default; plan-approval now an opt-in toggle"
```
