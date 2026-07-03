# Caryl.ai

A fast, lightweight desktop AI companion (formerly BRAIN.AI). Electron app with hybrid
cloud/local intelligence: chat, vision, voice input, and voice output can each run on a
cloud OpenAI-compatible API or fully locally — in any combination. Your conversation
memory is stored locally on disk.

## 1. Install

You need [Node.js](https://nodejs.org) 18+ installed. Then, in this folder:

```bash
npm install
```

## 2. Get a free API key (Groq — recommended)

1. Go to **console.groq.com**, sign up (no credit card).
2. Open **API Keys** → **Create API Key**, copy it.

## 3. Run

```bash
npm start
```

Open **Settings** (gear icon) → **AI Engine (Cloud)** → pick your provider, paste your key,
click **Save & connect**. The model list loads automatically. Close settings and chat —
the reply streams into the thread, and your orb animates while it thinks.

History and settings persist on disk, so everything is still there next launch.

### Default models
- **Groq:** `llama-3.3-70b-versatile` (smart) or `llama-3.1-8b-instant` (fastest)
- **Gemini:** `gemini-2.5-flash`

## 4. Build a single .exe

```bash
npm run build
```

The portable executable lands in `dist/`. (Installer version: `npm run build:installer`.)

## Where your data lives

Settings and memory are JSON files in Electron's per-user data dir
(`%APPDATA%/Caryl.ai` on Windows; data from an old BRAIN.AI install is migrated
automatically on first launch — the old folder is never modified). Nothing is sent
anywhere except your chat text going to the API provider you chose, using your own key.

## Architecture

- `main.js` — Electron main process; IPC + streaming bridge + memory + overlay windows.
- `preload.js` — secure `window.bridge` (no Node in the renderer).
- `lib/engines.js` — per-capability hybrid routing: chat / vision / stt / tts each resolve
  to online (cloud API) or offline (local) independently; any combination works.
- `lib/migrate.js` — one-time BRAIN.AI → Caryl.ai userData migration (never deletes).
- `lib/downloads.js` — download-manager registry: every heavy asset (Ollama models,
  Whisper, Piper voices, wake-word models) is downloaded on demand; the installer ships
  code only.
- `lib/providers.js` — one OpenAI-compatible streaming client for every provider
  (Ollama's `/v1` endpoint plugs in the same way for offline chat).
- `lib/ollama.js` — local engine management (server, tags, pulls, VRAM-friendly swaps).
- `lib/memory.js` / `lib/offline-memory.js` — local conversation stores.
- `lib/config.js` — settings + provider presets (`%APPDATA%/Caryl.ai/settings.json`).
- `renderer/` — chat UI, floating overlay + bubble, onboarding wizard (`onboarding.html`).
- `automation.py` — Python sidecar: UIA-first desktop automation, VAD, faster-whisper STT.
