# Caryl.ai Foundation & OS-Aware Shell — Design Spec

**Date:** 2026-07-03
**Sub-project:** A of 4 (A = foundation; B = UIA automation hardening, C = smart audio/voice, D = advanced camera mode follow separately)
**Status:** Approved design, pre-implementation

## Context

The existing app is **BRAIN.AI** (`D:\brain-ai\brain-ai`): an Electron thin-client
(`main.js` ~204 KB) with a Python automation sidecar (`automation.py`), cloud
(Groq/Gemini/OpenAI/OpenRouter) and offline (Ollama) chat, openWakeWord wake-word
detection, Piper TTS, faster-whisper STT, screen/camera vision, and a floating
overlay/bubble UI. Settings persist as JSON via `lib/config.js` in
`%APPDATA%/BRAIN.AI/settings.json`.

The overall goal across sub-projects: rename to **Caryl.ai** and evolve into a highly
optimized, low-RAM assistant. This spec covers only Sub-project A.

Decisions locked with the user:

1. Build order: A first; pick the next sub-project after A ships.
2. Rename data policy: **migrate automatically** from the old data dir; never delete it.
3. Wake word: **curated reliable list** (pretrained openWakeWord models), not
   arbitrary trained names. Custom *display name / persona* stays free-form.
4. Onboarding: **full wizard minus engine selection** (engines are Settings-only).
5. Engine model: **per-capability hybrid routing** — chat, vision, STT, TTS each
   independently online or offline; any combination valid.
6. Download manager: **full**, in A — with the hard constraint that the installer
   stays lightweight (code only, zero bundled models/engines).
7. Local git repo initialized; baseline committed before any changes.

## A1. Rename & Data Migration

**Rename surface:**

- `package.json`: `name: "caryl-ai"`, `productName: "Caryl.ai"`,
  `appId: "com.farouk.caryl"`, artifact names `Caryl.ai-${version}.${ext}`,
  description updated.
- All user-visible strings in `main.js`, `renderer/*.html`, tray tooltip, window
  titles, default `systemPrompt` ("You are Caryl…" — but see A5: the persona line uses
  the user's chosen display name, defaulting to "Caryl").
- `README.md` / `INSTRUCTIONS.md` headers updated.
- Internal variable names are NOT mass-renamed (no functional value, high diff noise).
  Only user-visible and identity-bearing strings change.

**Migration (one-time, on boot):**

In `lib/config.js` (or a tiny `lib/migrate.js` called before first `config.load()`):

1. If `%APPDATA%/Caryl.ai/settings.json` exists → do nothing (already migrated or
   fresh Caryl install).
2. Else if `%APPDATA%/BRAIN.AI` exists → recursively copy its contents (settings,
   chat stores, memory, downloaded wake-word models, voice files) into
   `%APPDATA%/Caryl.ai`, then write `migratedFrom: "BRAIN.AI"` + ISO date into the
   new settings.json.
3. The old `%APPDATA%/BRAIN.AI` directory is **never modified or deleted**.
4. Copy failures are non-fatal: log, fall back to fresh defaults, do NOT crash boot.

## A2. Hybrid Engine Routing + Download Manager

### Routing contract

New file **`lib/engines.js`** — the single source of truth for capability routing.
`main.js` (and later B/C/D code) call it instead of inspecting flags.

Persisted shape in settings.json:

```js
engines: {
  chat:   'online' | 'offline',   // cloud provider API  | Ollama chat model
  vision: 'online' | 'offline',   // provider vision     | Ollama vision model
  stt:    'online' | 'offline',   // Groq whisper API    | local faster-whisper
  tts:    'online' | 'offline'    // browser/webspeech   | local Piper
}
```

API (all synchronous reads over the config cache):

- `resolveEngine(capability)` → `'online' | 'offline'`
- `engineReady(capability)` → `{ ready: boolean, reason?: string }` (e.g. offline
  vision but no vision model installed; online chat but no API key)
- `setEngine(capability, mode)` → persists and emits a change event main.js already
  uses for its config-change side effects (Ollama warm-up etc.)

**Legacy migration:** on first load, if `engines` is absent, derive it once from the
old flags and persist:

- `mode === 'offline'` → `chat: 'offline'`, `vision: 'offline'`, `stt: 'offline'`
- `useLocalVision === true` → `vision: 'offline'`
- `useLocalStt === true` → `stt: 'offline'`
- `ttsEngine === 'piper'` → `tts: 'offline'`

Old flags stay in settings (untouched) for rollback, but all *reads* in main.js are
replaced by `resolveEngine()`. `isOffline(cfg)` becomes
`resolveEngine('chat') === 'offline'` internally so existing call sites keep working
during the transition, then call sites migrate to per-capability checks (vision paths
check `vision`, STT paths check `stt`, etc.).

### Settings — "Engines & Models" panel

Replaces the current "AI Mode" card in `renderer/index.html` Settings:

- Four rows (Chat / Vision / STT / TTS), each with an Online⇄Offline toggle, a status
  line (Online: provider + key state; Offline: which local model, installed or not),
  and a **Download** button when the offline dependency is missing.
- Toggling to Offline with a missing dependency does not silently fail: the row shows
  "model required" and offers the download. Until installed, `engineReady()` reports
  not-ready and runtime calls fall back to online with a visible notice (never a
  silent crash).
- The topbar pill shows a compact hybrid summary (e.g. "Chat ☁ · Vision 💻").

### Download manager

One place (inside the Engines & Models panel) that manages every heavy asset.
**Nothing heavy ships in the installer** — Electron app + JS + `automation.py` only.

| Asset | Source | Mechanism |
|---|---|---|
| Ollama runtime | ollama.com installer | Detect installed (existing `ollama.js` probe); if missing, "Install Ollama" button opens the official download (we do not bundle or silently install other vendors' software) |
| Ollama chat model (default `qwen2.5:7b`) | Ollama registry | `ollama pull` via existing server API, with streamed progress |
| Ollama vision model (default `moondream`) | Ollama registry | same |
| Whisper STT model (~75 MB) | faster-whisper auto-download | Triggered via sidecar `/transcribe` warm-up endpoint; progress reported |
| Piper engine + voices | existing in-app downloader | surfaced in the panel (already exists — reuse) |
| Wake-word ONNX models | existing in-app downloader | surfaced in the panel (already exists — reuse) |
| Python sidecar deps (`.venv`) | pip | Existing sidecar bootstrap; surfaced with install state + progress |

Each row: name, size estimate, installed/not state, progress bar during download,
and errors surfaced inline. Registry of assets + state lives in `lib/downloads.js`
(new), which wraps the existing downloaders rather than reimplementing them.

## A3. OS-Aware Shell (Win10 vs Win11)

- Detection in main.js at boot: `os.release()` build ≥ 22000 → Win11, else Win10.
  Stored as `osVariant: 'win11' | 'win10'` in settings; onboarding shows the detected
  value and lets the user override (override persists).
- **Win11 path:** unchanged — `backgroundMaterial: 'acrylic'` native blur on the
  overlay panel (already implemented and tuned; do not disturb).
- **Win10 path:** `backgroundMaterial` omitted; each overlay HTML root gets
  `data-os="win10"` (delivered via existing config-snapshot IPC), and CSS swaps
  translucent `backdrop-filter` backgrounds for **solid tinted** equivalents of the
  same palette. Applies to: overlay panel, mini bubble, and (later, D) the research
  overlay — D consumes this same mechanism.
- A single helper `shellStyle()` in main.js exposes `{ osVariant, blur: boolean }` to
  renderers so future windows (B/C/D) inherit correct treatment automatically.

## A4. Persistence Audit & Hardening

- **Bubble position bug:** position *is* already persisted (`overlayBubblePos`,
  main.js). The reported symptom (spawns in default spot) is a restore-path bug.
  Fix via systematic debugging; known suspects: `isOnScreen()` rejecting valid
  negative coordinates on multi-monitor setups, and the corner-default fallback in
  `toggleOverlay()` racing the saved value. Acceptance: drag bubble anywhere
  (including a second monitor), quit, relaunch → bubble reappears at exact X/Y.
- **Engines persistence:** the four engine toggles survive restart (this is the
  user's "vision offline before close → boots offline" requirement, generalized).
- **Audit:** sweep main.js for session-only `let` state that should persist
  (open-mic on/off, last overlay collapsed/expanded state, model picks) and move the
  agreed set into settings.json. Anything intentionally session-only gets a comment
  saying so.

## A5. First-Launch Onboarding Wizard

New renderer window/route, shown when `onboarded !== true` in settings; also
launchable from Settings ("Redo setup"). Completing the wizard sets `onboarded: true`.
Skipping (X / Esc) also sets it — the wizard never traps the user, and every choice
remains editable in Settings.

Steps:

1. **Welcome** — Caryl.ai identity reveal; if `migratedFrom` is set, a "your data
   came along" note.
2. **Name your assistant** — two fields:
   - *Wake word* (the acoustic trigger): choice among curated pretrained
     openWakeWord models — Jarvis, Alexa, Hey Mycroft, Hey Rhasspy. Selecting one
     downloads its ONNX model (small) via the existing wake-word downloader.
   - *Display name* (free text, default "Caryl"): used in UI, persona/system prompt,
     and spoken confirmations (`assistant:setName` round-trip already exists — reuse).
3. **Windows version** — shows auto-detected Win10/Win11 with a live preview pane
   rendering the blur (Win11) vs solid (Win10) overlay treatment; user can override.
4. **Permissions** — mic + camera grant (existing `mediaAllowed` flow, surfaced).
5. **Voice** — pick TTS voice; offline voices show as downloads (Piper voice
   installer reused inline). Default: online/browser voice, zero download.
6. **Wake-word calibration** — live mic meter + say-the-word test using the existing
   score stream from `wakeword.js`; slider maps to `local_wake_threshold`.
7. **Global hotkey** — capture + save (existing `globalHotkey` setting).

Explicitly **not** in the wizard: engine selection, API keys, model downloads beyond
the chosen wake-word model and (optionally) a TTS voice. All of that lives in
Settings → Engines & Models.

## A6. Low-RAM / Speed Hardening (cross-cutting)

Concrete items in scope for A:

1. **DevTools gate:** main.js currently opens detached DevTools on every launch
   (`webContents.openDevTools`) — gate behind `--dev` flag / `NODE_ENV`.
2. **Lazy module loading:** `pdfjs-dist`, onnxruntime (renderer), and any heavy
   `require`s load on first use, not at boot.
3. **Sidecar lifecycle:** Python sidecar keeps its existing spawn behavior, but the
   Whisper model unloads after an idle window (sidecar-side timer) so offline-STT RAM
   is only held while actively used.
4. **Mic/camera release:** verify streams stop when features are off (audit; wake
   word obviously holds the mic while enabled — that is by design).
5. **Dead-weight dependencies:** remove `@picovoice/porcupine-web` and
   `@picovoice/web-voice-processor` from package.json if the audit confirms they are
   unused (wake word actually runs on openWakeWord).

Out of scope for A (belongs to B/C/D): vision pipeline optimization, VAD, camera
redesign.

## Error handling principles (all of A)

- Migration, downloads, and OS detection are **non-fatal**: failures log, surface in
  UI where relevant, and fall back (fresh defaults / online engines / solid styling).
- No engine toggle may leave the app in a state where a capability silently does
  nothing: `engineReady()` gates every offline path with a visible fallback notice.
- Renames never touch user data files' *contents* (only the directory migration copies
  them).

## Testing

- **Unit-ish (node):** `lib/engines.js` (routing, legacy migration, ready-state
  logic) and `lib/migrate.js` (dir-copy idempotency, never-delete guarantee) get
  standalone test scripts runnable via `node` (no framework dependency added).
- **Manual checklist (each item verified before A is called done):**
  1. Fresh machine sim (empty userData): onboarding appears, completes, `onboarded`
     persists, app usable online-only with zero downloads.
  2. Upgrade sim (`%APPDATA%/BRAIN.AI` present, Caryl dir empty): data migrated, old
     dir intact, chats/history visible.
  3. Each engine toggle: flip, restart, state restored; offline toggle without model
     → download prompt, not silence.
  4. Bubble drag → quit → relaunch → exact position (primary + secondary monitor).
  5. Win10 fallback: force `osVariant: 'win10'` → overlays render solid, no acrylic.
  6. RAM: idle footprint measured before/after A (DevTools gate + lazy loads should
     reduce it; number recorded in the PR/commit notes).

## File map (planned)

| File | Change |
|---|---|
| `package.json` | rename, artifact names, drop dead deps |
| `lib/migrate.js` | **new** — one-time data-dir migration |
| `lib/engines.js` | **new** — per-capability routing contract |
| `lib/downloads.js` | **new** — asset registry wrapping existing downloaders |
| `lib/config.js` | new defaults (`engines`, `osVariant`, `onboarded`, display name) |
| `main.js` | rename strings, engine call-site migration, OS detect, DevTools gate, bubble-restore fix, wizard window |
| `renderer/index.html` | rename strings, Engines & Models panel, onboarding entry |
| `renderer/onboarding.html` | **new** — wizard |
| `renderer/overlay.html`, `renderer/mini-overlay.html` | `data-os` solid-fallback CSS |
| `README.md`, `INSTRUCTIONS.md` | rename + new architecture notes |
