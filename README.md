# BRAIN.AI

A fast, lightweight desktop AI companion. Pure Electron thin-client — no Python, no
Ollama, no local model. The intelligence comes from a cloud OpenAI-compatible API, so it
runs smoothly on any PC and replies in ~1–2 seconds. Your conversation memory is stored
locally on disk.

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
(`%APPDATA%/BRAIN.AI` on Windows). Nothing is sent anywhere except your chat text going to
the API provider you chose, using your own key.

## Architecture (for later)

- `main.js` — Electron main process; IPC + streaming bridge + memory.
- `preload.js` — secure `window.api` bridge (no Node in the renderer).
- `lib/providers.js` — one OpenAI-compatible streaming client for every provider. A future
  local "Ghost Mode" engine plugs in here by pointing `baseUrl` at a bundled local server.
- `lib/memory.js` — local conversation store (JSON now; swap to SQLite later, same API).
- `lib/config.js` — settings + provider presets.
- `renderer/` — the chat UI.

Deferred to later versions (kept out of v1 on purpose): voice, vision/screenshots, PC
automation, image generation, and the local engine.
