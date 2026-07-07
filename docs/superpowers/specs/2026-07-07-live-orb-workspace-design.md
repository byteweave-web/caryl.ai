# Live Orb — Honest Voice + Work Choreography

**Date:** 2026-07-07 · **Branch:** `nexus-deck-orb-tab` · **Status:** approved by Farouk
**Parent spec:** `2026-07-07-unified-os-ui-design.md` (Unified OS System Shell)
**Inserted before:** Phase 3 (Settings-as-focus-layer) — this is a prerequisite fix + feature.

## 1. Problem

Two failures make the Orb read as a screensaver instead of the system's mind:

1. **Voice states are invisible.** Saying the wake word shows "Yes? I'm listening…" in the
   hint, but `#pill-state` / `#orb-state` stay `idle` and the deck core never glows. Root
   cause: the wake-word command capture (`onWakeDetected` → its own MediaRecorder) never
   sets the `recording` flag; only the mic-button/PTT path does. The 1 Hz `poll()` and the
   orb pump both read `recording`, so poll actively overwrites any listening state a beat
   later. While speaking, `orb.target` is a constant — no talking rhythm. While listening,
   the live mic RMS that `WakeWord.on('level')` already emits (for VAD) never reaches the orb.
2. **Pulses are fiction.** The deck's traveling packets come from a random ambient
   dispatcher plus a broadcast-to-ALL-agents on every TTS start. Meanwhile the REAL
   7-agent swarm (`lib/swarm/router.js`) emits `swarm:event` (`dispatch-start` /
   `dispatch-end` / `dispatch-rejected` / `dispatch-rate-limited`) that the old V4 overlay
   consumed — but the V5 deck (now the L0 engine) never got wired to it.

## 2. Goals

- The Orb is a **truthful, live work monitor**: glow = voice, packets = real sub-agent work.
- Wake word → visible `listening` state that **tracks the user's actual voice level**.
- TTS → the core **pulses like speech** (real envelope when possible).
- Task dispatched → **one packet core → that exact agent**; completion → **return packet
  agent → core**. Nothing else emits packets.
- Keep the standalone deck (`nexus-deck.html` without `?embed=1`) demo behavior untouched.

**Non-goals:** retiring `renderer/swarm-visual.js` (stays config-gated legacy); Phase 3+
of the Unified OS plan; giving PLANNER a live signal (no honest source exists yet — future:
chain-planning events from `dispatchChain`).

## 3. Locked decisions (user)

1. **Attentive tier: YES.** Conversation-mode-open / follow-up-grace-armed reads visibly
   different from cold idle.
2. **Strict pulse honesty.** Plain chat (LLM answers directly) = core brightens, ZERO
   packets. Packets fire only for real subsystem work.
3. Broadcast-on-speech and the random ambient dispatcher are dead in live mode.

## 4. Core state model

One mode, strict priority: `speaking > listening > busy > attentive > idle`.

| Mode | Real trigger | Core look | `#pill-state`/`#orb-state` |
|---|---|---|---|
| `idle` | nothing | dim ember breath | `idle` |
| `attentive` | `_conversationMode` open between turns, OR follow-up grace window armed | slightly lifted glow, slow breath | `attentive` |
| `listening` | wake capture (`_lwCapturing`) OR mic-button/PTT `recording` | swell **tracks live mic RMS** (floor-relative) | `listening` |
| `busy` | `ai_status` thinking/working, automation running | accretion spin-up (existing) | `thinking` / `working on it` |
| `speaking` | TTS actually playing (`ttsActive()`) | speech-like pulse: real envelope (Piper) or ~4.5 Hz LFO (speechSynthesis) | `speaking` |

## 5. Packet rules (strict)

| Event | Visual |
|---|---|
| swarm `dispatch-start` | packet core → agent; agent activity/queue rise; ledger logs real line |
| swarm `dispatch-end` | **return packet** agent → core; small core acknowledge flash; agent decays to READY |
| swarm `dispatch-rate-limited` | brief core flicker in `--bad` + ledger line (it always follows a `dispatch-end`, which already returned the packet — the feed's ledger dedupe makes this a no-op on packets) |
| swarm `dispatch-rejected` (no `to`) | core flicker in `--bad` + ledger line; NO packet |
| automation run (status `automation_running` rising/falling edge) | dispatch/return on EXECUTOR |
| camera ask (renderer lifecycle: begin at `camSendInput()`/vision ask, end when the reply lands or fails) | dispatch/return on VISION |
| grounding / memory recall (stretch, §8) | dispatch/return on RESEARCHER / MEMORY |
| plain chat | core `busy` glow only — **no packets** |
| TTS start | core `speaking` pulse only — **no broadcast** |

## 6. Architecture

```
WakeWord.on('level') ──┐  (real mic RMS, already emitted for VAD)
mic-btn AnalyserNode ──┤  (only when wake stream absent)
Piper Audio analyser ──┼→ lib/nexusFeed.js (PURE, dual-exported like shell-reducer.js:
ttsActive()/synth ─────┤   state precedence · floor-relative level normalization ·
poll() ai_status ──────┤   task ledger begin/end/timeout · agent-name mapping)
bridge.onSwarmEvent ───┤              │ directives (node-tested)
camera/automation ─────┘              ▼
                      index.html thin wiring (~60 lines):
                        postMessage → iframe deck
                        + SINGLE WRITER for #pill-state / #orb-state text
                                      ▼
                      nexus-deck.html live surface v2:
                        driveState() v2 · dispatchTo(name) · returnPulse(name) ·
                        speaking LFO · attentive tier · truthful ledger
```

- `lib/nexusFeed.js` — the brain. No DOM. `window.NexusFeed` + CommonJS export.
- `index.html` — wiring only. Every writer of the state text (`poll`, `refreshSpeakingUI`,
  `_setVoiceStatus`) funnels through the feed's computed mode. `_setVoiceStatus` keeps its
  LED + `setHint` behavior; transient labels ("Asking for clarification…") go to the hint,
  NOT the state pill.
- Deck — renders what it's told. Standalone (no `?embed=1`) path untouched.

## 7. Transport contract (postMessage, host → deck iframe)

```js
// 22/s pump (existing 'caryl-orb', extended):
{ type:'caryl-orb', state:{
    mode : 'idle'|'attentive'|'listening'|'speaking'|'busy',
    level: 0..1,                    // best live audio truth for the mode
    levelSrc: 'mic'|'tts'|'none'    // deck adds talking-LFO only when speaking && levelSrc!=='tts'
}}
// event-driven (new):
{ type:'caryl-task', op:'dispatch'|'return'|'reject', agent:'VISION'|…, id:'t-123',
  ok?:boolean, label?:'camera ask' }
// deck → host, once, on boot (new):
{ type:'caryl-ready' }
```

Back-compat: the deck's `driveState` keeps accepting the legacy
`{level,speaking,busy,recording}` shape (maps it to a mode) so a stale host still drives
a sane core. Unknown `agent` names: `console.warn` + ignore.

## 8. Swarm event mapping

Router alphabet (TitleCase): `Orchestrator, Researcher, Executor, Coder, Memory, Vision,
Critic`. Deck roster (UPPERCASE): `EXECUTOR, PLANNER, CODER, CRITIC, VISION, RESEARCHER,
MEMORY`. Mapping = uppercase the router name; special cases:

- `Orchestrator` → **the Core itself**: no packet; ledger line only.
- `PLANNER` has no swarm counterpart — receives no live packets for now (§2 non-goals).

Exact event shapes consumed (from `lib/swarm/router.js`):
`{kind:'dispatch-start', to, task_id, action}` · `{kind:'dispatch-end', to, task_id,
action, ok, error?}` · `{kind:'dispatch-rejected', error}` (no `to`) ·
`{kind:'dispatch-rate-limited', to, task_id, action, error}`.

**Stretch (may ship as fast-follow):** tag main's status payload with
`active_subsystems:['research','memory']` set/cleared in the chat pipeline where grounding
/ memory recall already run, so RESEARCHER and MEMORY join honestly. Nothing else depends
on this; if the hook is messy, it moves to its own change.

## 9. Audio level sources

- **Listening:** `WakeWord.on('level')` RMS, normalized against the continuously-tracked
  ambient floor (`_lwAmbientFloor`) so the glow works identically in quiet and noisy rooms
  (requirement: floor-relative curve, clamped 0..1; exact curve is implementation detail,
  unit-tested). When the wake stream is off and the mic button records, a lightweight
  `AnalyserNode` taps the recorder's stream.
- **Speaking:** Piper plays via `new Audio(url)` → route through WebAudio
  (`createMediaElementSource` → analyser → destination) for the real envelope
  (`levelSrc:'tts'`). Browser `speechSynthesis` has no amplitude API → deck synthesizes a
  ~4.5 Hz talking LFO (`levelSrc:'none'`).

## 10. Error handling

- **Leaked tasks:** `dispatch` with no matching `end` auto-returns after **90 s** (feed-side
  timer) so agents never stay lit forever.
- **Deck not ready:** task directives queue in the feed until the single `caryl-ready`
  handshake, then replay; the 22/s pump is fire-and-forget (self-healing).
- **Reduced motion:** packets still travel (they carry meaning); LFO amplitude halved.
- **Duplicate/out-of-order events:** ledger keyed by `task_id`+agent; `end` without `start`
  logs but doesn't crash; repeated `start` for same key refreshes, doesn't stack.

## 11. Testing

- **Node** `tests/test-nexus-feed.js` (wired into `npm test`): mode precedence table ·
  level normalization vs floor · task ledger (dedupe, end-without-start, timeout
  auto-return) · router-name mapping incl. `Orchestrator`/unknown · reject/rate-limited paths.
- **Probes** (offscreen harness, repo's verify method): new `tools/probes/live-orb.js` —
  posts synthetic `caryl-orb`/`caryl-task` into the REAL embedded deck; asserts via a tiny
  `window.__deckProbe()` (mode, packet in flight + direction, `uActivity` rising,
  pill/orb-state text). Existing 8 probes stay green.
- **Manual script:** wake word → attentive → listening (glow follows voice) → thinking →
  speaking pulse → attentive; run an automation → EXECUTOR packet out, return on finish.
