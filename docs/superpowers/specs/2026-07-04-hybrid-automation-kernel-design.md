# Hybrid Automation Kernel — Design Spec

**Date:** 2026-07-04
**Sub-project:** Kernel layer (sits **above** B). A = foundation (shipped), B = grounded UIA
automation (approved, pre-impl), C = smart audio, D = camera mode (both pending).
**Status:** Approved design, implementation started (registry + router first, test-driven).

## Context

Caryl.ai's entire task-dispatch surface today is [`lib/actions.js`](../../../lib/actions.js):
three LLM-callable tools — `open_app`, `open_url`, `web_search` — each of which either
shells out or opens a browser. There is no layer that decides *whether a task should touch
a GUI at all*. This sub-project adds that layer: a **Hybrid Automation Kernel** that
classifies each request and routes it to the cheapest correct execution path, enforcing
"logic/API over GUI" as a hard rule rather than a preference.

The Kernel is the **dispatcher**; Sub-project B's grounded UIA loop is the hardened
`HYBRID_UIA` **engine** it delegates to. They do not conflict and are loosely coupled at
the tool-dispatch boundary — the Kernel benefits automatically when B ships.

Decisions locked with the user (2026-07-04):

- **Framing/scope:** New layer above B. First spec = Router + TaskRegistry + Growth Loop +
  four built-in reference tasks. The WhatsApp/TikTok deep-integration **library is deferred**
  to its own follow-on spec.
- **Classification:** Deterministic matchers first; an LLM fallback for misses. A
  `PURE_LOGIC`/`API_NATIVE` match routes deterministically **and hard-blocks the GUI** for
  that turn.
- **Growth Loop:** Saves parameterized UIA macros (durable locators, not session ids) and
  templated calls to already-supported services. **No runtime code-gen of new API clients.**
  Saving is always user-confirmed after a successful run.
- **Reference set:** math (PURE_LOGIC, replaces GUI calculator), weather (API_NATIVE +
  overlay), system stats (PURE_LOGIC + overlay, local reads), UIA-delegate (HYBRID_UIA).
  Reminders deferred (scheduling/persistence/notifications).

## Task classes

| Class | Meaning | GUI allowed? | Reference task |
|---|---|---|---|
| `PURE_LOGIC` | Solved by internal computation | **No** (hard-blocked) | math, system stats |
| `API_NATIVE` | Solved by an API/webhook + optional overlay | **No** (hard-blocked) | weather |
| `HYBRID_UIA` | Needs the desktop; API-first then UIA fallback | Yes | delegate to B's loop |

## Architecture

```
User request (chat / voice text)
        │
        ▼
┌──────────────────────────── Kernel Router ────────────────────────────┐
│ 1. Deterministic match against TaskRegistry (pure scoring)             │
│      • PURE_LOGIC hit → run handler, GUI hard-blocked this turn         │
│      • API_NATIVE hit → run handler + overlay, GUI hard-blocked         │
│      • HYBRID_UIA hit → replay learned macro OR delegate to B's loop    │
│ 2. No confident match → LLM fallback (today's tool-call flow),          │
│      registered capabilities exposed as tools + generic HYBRID_UIA path │
└────────────────────────────────────────────────────────────────────────┘
        │ (on success of a task NOT already a registered recipe)
        ▼
   Growth Loop → "Save as a [UIA recipe / API integration]?" → Registry.record()
```

Everything new lives under `lib/kernel/` — small, single-purpose modules, each independently
testable, mirroring B's pure-function discipline. The Python sidecar stays the UIA executor;
the Kernel is pure JS in the Electron main process.

## K1. TaskRegistry — `lib/kernel/registry.js`

In-memory index + JSON persistence at `%APPDATA%/Caryl.ai/task-registry.json` (learned
entries only; built-ins are registered in code at startup and never written to disk).

**Entry schema:**

```
{
  id:            "weather.current",          // stable unique id
  title:         "Current weather",
  class:         "PURE_LOGIC" | "API_NATIVE" | "HYBRID_UIA",
  matchers:      [ {type:"keywords", any:[...], all:[...]}, {type:"regex", pattern:"..."} ],
  params:        [ {name:"location", required:false, extractor:"after:in|for"} ],
  handler:       "builtin:weather.current" | "macro:<id>" | "apiTemplate:<id>",
  source:        "builtin" | "learned",
  gui_forbidden: true,                        // derived: true for PURE_LOGIC & API_NATIVE
  created, lastUsed, useCount, successCount
}
```

**Responsibilities (all pure where possible, so they test without a live desktop):**

- `register(entry)` — validate + index a built-in or learned entry. Validation rejects
  malformed entries (missing id/class/handler, unknown class, bad matcher shape) with a
  clear error; a bad **learned** entry is quarantined (skipped + logged), never fatal.
- `load()` / `save()` — round-trip learned entries to disk. Load failure ⇒ built-ins only +
  warning; a per-entry parse/validation failure quarantines just that entry.
- `all()` / `byId(id)` / `byClass(class)` — read accessors.
- `record(entry)` — persist a new learned entry (used by the Growth Loop); de-dupes by id.
- `touch(id, {success})` — bump `lastUsed`/`useCount`/`successCount`.
- `gui_forbidden` is **derived** from class (PURE_LOGIC/API_NATIVE ⇒ true) at register time,
  never trusted from disk, so a tampered file can't unblock the GUI.

## K2. Router — `lib/kernel/router.js`

`classify(text, registry) → Match | null` where
`Match = { entry, class, params, confidence, guiBlocked }`.

- **Scoring (pure):** score each entry's matchers against the normalized request text.
  Keyword matchers score on `any`/`all` term hits; regex matchers score on match + capture.
  Best entry above a threshold wins; ties broken by higher `successCount` then specificity
  (more required terms = more specific).
- **Param extraction (pure):** apply each param's `extractor` to pull values (e.g.
  `location` from "weather **in** Paris"). Missing required params ⇒ the match is returned
  with `params.<name> = null` and a `needs: [names]` list so the caller can ask once.
- **GUI-block:** a `PURE_LOGIC`/`API_NATIVE` match sets `guiBlocked: true`. The caller
  stores this as a per-turn flag consumed by the GUI entrypoints (K-later).
- **No confident match ⇒ `null`** — caller proceeds to the existing LLM tool-call flow.
- Router does **no I/O** and holds no state — it takes text + a registry snapshot and
  returns a plain object. This keeps it fully unit-testable and is why it and the registry
  ship + get tested before any handler exists.

## K3. Handlers (later tasks, not this first slice)

- `handlers/math.js` — safe expression evaluator, **no `eval`**, hand-rolled
  tokenizer/shunting-yard (no new deps). Replaces the GUI calculator.
- `handlers/weather.js` — OpenWeather fetch + normalization (Node `https`/`fetch`, no dep).
- `handlers/systemStats.js` — CPU/RAM/battery/disk via Node `os` + cheap platform calls.
- `HYBRID_UIA` "handler" = delegate to the existing automation loop / learned-macro replay.

## K4. Overlay — `lib/kernel/overlay.js` + `renderer/overlay-card.html` (later task)

One data-driven card window renders both weather and system-stats from a payload
`{title, rows:[{label,value}], accent}`. Frameless, always-on-top, near the bubble,
`shellStyle()`-aware (Win11 acrylic / Win10 solid per caryl-conventions). **No browser.**

## K5. GUI-prohibition enforcement (the core principle)

Two layers, belt-and-suspenders:

1. **Runtime hard guard:** a `PURE_LOGIC`/`API_NATIVE` classification sets a per-turn
   `guiBlocked` flag; the GUI entrypoints (`open_app`, `web_search`/browser, the automation
   loop) **refuse** with a clear reason when invoked for that turn.
2. **Prompt-level steering:** when a logic/API handler exists for a request, the GUI tools
   aren't offered to the LLM in the first place.

A logic/API handler failure (bad key, network, parse error) returns an **honest error** — it
never silently falls back to a browser, which would defeat the prohibition.

## K6. Growth Loop — `lib/kernel/growth.js` (later task)

After a task that was **not** served by a registered recipe succeeds, capture the class used
plus either the UIA action trace or the API/tool calls, propose a save card
("I handled this via [Method]. Save as a permanent [API integration / UIA recipe]?"), and on
user confirm call `registry.record()`.

- **Durable locators:** UIA steps are stored as `{name, controlType, automationId,
  appContext}` — never B's session-volatile element ids (B invalidates its id→element cache
  each `/elements` call). Replay resolves locators fresh via B's `/elements` each run.
- **Parameterization:** literals that look like arguments (a contact name, a message body)
  are proposed as params so the recipe generalizes.
- **API growth is bounded:** only templated calls to already-supported services are saved.
  A genuinely new API surfaces as a dev-facing proposal (logged/flagged) — never
  auto-authored or executed at runtime.
- Best-effort, cancellable, `finally`-guarded (mirrors B's confirm pattern); never wedges a
  run.

## Config & settings

- `openWeatherApiKey` — Settings → API Keys (alongside the AI provider key). Absent ⇒ weather
  path returns "add your OpenWeather key in Settings", **not** a browser fallback.
- `weatherUnits: "metric" | "imperial"` — default `metric`, with a toggle.
- `weatherDefaultLocation` — used when the request names no location; if empty and none
  given, ask once.
- Registry file: `%APPDATA%/Caryl.ai/task-registry.json` (learned entries only).

## Error handling

- Registry load/parse failure ⇒ boot with built-ins only, quarantine bad learned entries,
  log a warning, never crash.
- Overlay window failure ⇒ fall back to a normal chat message with the same data.
- Growth Loop is best-effort, cancellable, `finally`-guarded — never wedges a run.
- A stale/unresolvable learned macro on replay ⇒ don't blind-act; fall back to the
  LLM/automation path and flag the recipe for re-learning.

## Testing & acceptance

**Pure-logic tests** (`tests/test-kernel.js`, plain `node` + `assert`, no framework — mirrors
the existing node suites; wired into `npm test`):

- Router matching/scoring: correct entry chosen, threshold respected, ties broken
  deterministically, no-match ⇒ `null`.
- Param extraction: values pulled correctly; missing required ⇒ `needs` list.
- GUI-block: PURE_LOGIC/API_NATIVE matches set `guiBlocked: true`; HYBRID_UIA does not.
- Registry: register/validate (good + malformed), `record`/`load` round-trip, learned-entry
  quarantine on bad data, `gui_forbidden` derived from class (not trusted from disk),
  `touch` counters.

**Acceptance (manual, real desktop), added as later handlers land:** `"12.5% of 340"` →
pure-logic answer, no calculator app opens; `"weather in Tokyo"` → overlay card, no browser;
`"system stats"` → overlay card; a novel UIA task → runs, then offers to save; a saved recipe
replays deterministically.

## Constraints (inherited + Kernel-specific)

- No new npm or Python dependencies (math parser hand-rolled; weather/system-stats via Node
  built-ins).
- Overlays honor `shellStyle()` (Win11 acrylic / Win10 solid); Windows 10 must work.
- All user-visible strings say Caryl; reuse existing card/confirm/overlay infra + IPC
  patterns.
- Respects B7 frictionless execution: tasks run immediately; the save-proposal happens
  **after** success.
- Sits above B: `HYBRID_UIA` delegates to the automation loop and benefits when B ships.

## File map (planned)

| File | Change |
|---|---|
| `lib/kernel/registry.js` | TaskRegistry: schema, index, JSON persistence, pure matchers/validation |
| `lib/kernel/router.js` | `classify()` deterministic matcher + param extraction + GUI-block flag |
| `lib/kernel/handlers/{math,weather,systemStats}.js` | the three logic/API handlers |
| `lib/kernel/growth.js` | capture trace/params, propose-save, record learned recipe |
| `lib/kernel/overlay.js` + `renderer/overlay-card.html` | data-driven overlay card |
| `lib/actions.js` | GUI-block guard on `open_app`/`web_search`; register Router pre-LLM |
| `main.js` | wire Router before the LLM tool loop; expose learned recipes; save-proposal card |
| `preload.js` | overlay + save-proposal IPC (reuse confirm channel) |
| `lib/config.js` | `openWeatherApiKey`, `weatherUnits`, `weatherDefaultLocation` defaults |
| `tests/test-kernel.js` | pure-logic suite → wired into `npm test` |

## Build order

1. **`registry.js` + `router.js`, test-driven** (this slice) — the core infra, provable
   without a live desktop.
2. `handlers/math.js` + `handlers/systemStats.js` (pure logic) + overlay card.
3. `handlers/weather.js` + config keys.
4. Kernel wiring in `main.js`/`actions.js` (GUI-block guard, pre-LLM routing).
5. Growth Loop + save-proposal card.
