# BRAIN.AI - Offline + Online Merge: Install Instructions

Everything now lives in ONE app: your existing online build at `D:\brain-ai\brain-ai`,
with a switchable **Online (cloud API)** / **Offline (local Ollama)** mode. The online
mode's behavior, features, and UI are unchanged. Offline mode does everything the online
mode does - chat, screen/camera vision, desktop automation, 3D models, document import,
web-search answers, voice in/out, wake word, overlay - all running locally.

---

## 1. File placement (all paths inside `D:\brain-ai\brain-ai`)

REPLACE these 3 existing files with the new versions:

| New file          | Goes to                              |
|-------------------|--------------------------------------|
| `main.js`         | `D:\brain-ai\brain-ai\main.js`       |
| `preload.js`      | `D:\brain-ai\brain-ai\preload.js`    |
| `automation.py`   | `D:\brain-ai\brain-ai\automation.py` |

ADD these 3 new files:

| New file                 | Goes to                                      |
|--------------------------|----------------------------------------------|
| `lib\ollama.js`          | `D:\brain-ai\brain-ai\lib\ollama.js`          |
| `lib\offline-memory.js`  | `D:\brain-ai\brain-ai\lib\offline-memory.js`  |
| `lib\local-search.js`    | `D:\brain-ai\brain-ai\lib\local-search.js`    |

REPLACE one renderer file (the AI Mode section is now built in natively - no pasting):

| New file      | Goes to                                     |
|---------------|----------------------------------------------|
| `index.html`  | `D:\brain-ai\brain-ai\renderer\index.html` |

`renderer\overlay.html` and `renderer\mini-overlay.html` need NO changes - they already
work in both modes (everything they poll is mode-aware in the new main.js). Same for
`lib\config.js`, `lib\memory.js`, `lib\providers.js`, `lib\actions.js`, `wakeword.js` -
all untouched.

What the new index.html adds (all in your existing style, nothing else moved):
- Settings -> a new "AI Mode" card at the top: the Online/Offline switch, an Ollama
  status badge + "Start Ollama" button, the local vision model picker, the
  "local vision in Online mode" toggle, and the "keep offline chats separate" toggle.
- The topbar pill now reads "Cloud" or "Local" to show the active engine.
- The existing Models section automatically lists your installed Ollama models in
  Offline mode (and its error hints are mode-aware).

## 2. One pip install (local voice input)

Offline voice-to-text runs inside the automation sidecar via **faster-whisper**.
Install it into the SAME Python the sidecar uses:

```
D:\brain-ai\brain-ai\.venv\Scripts\python.exe -m pip install faster-whisper
```

(If you don't have a `.venv` there, just `python -m pip install faster-whisper`.)
Also add a line `faster-whisper` to `requirements_automation.txt` so packaged builds
install it too. First voice use downloads the tiny Whisper model (~75 MB) once, then
it's fully offline.

## 3. Ollama models

Ollama itself must be installed (ollama.com). The app auto-starts the server with the
same performance flags your old offline build used (flash attention, q8 KV cache, etc.).

Pull what you need (once, needs internet):

```
ollama pull qwen2.5:7b      # the offline chat brain (default)
ollama pull moondream       # lightest vision model (or: ollama pull llava)
ollama pull qwen2.5:0.5b    # optional - enables the auto-built 14b "turbo" models
```

**Important:** Ollama models are stored globally in `C:\Users\farou\.ollama` - they do
NOT live inside either project folder. Everything you already pulled for the old offline
app is instantly available to the new one. Nothing to move.

## 4. Moving the old offline folder - the answer

You do **not** need to move anything from `C:\Users\farou\OneDrive\Documents\AI app`
into `D:\brain-ai\brain-ai`. Every piece of the old offline build was reimplemented
inside the merged app:

| Old file           | Now lives in                                             |
|--------------------|----------------------------------------------------------|
| `brain.py`         | `main.js` (mode routing) + `lib\ollama.js` (server mgmt)  |
| `agent.py`         | `lib\local-search.js` + `offlineWebAnswer()` in main.js   |
| `speculative.py`   | `ensureTurboModels()` in `lib\ollama.js`                  |
| `memory_rag.py`    | replaced by the app's existing chat memory (+ optional separate offline store) |
| faster-whisper STT | `/transcribe` endpoint in `automation.py`                 |
| Piper TTS          | the app's existing voice system (already local)           |

So: archive the old folder as a backup (e.g. move the whole thing to
`D:\brain-ai\legacy-offline\`) or delete it when you're confident. Do NOT copy
`brain.py` / `agent.py` / etc. into the new app folder - they aren't used and would
just confuse packaging. The old `en_US-lessac-medium.onnx` voice is optional too: the
app's own voice installer (Settings) downloads voices on demand.

The old `companion_memory.db` (RAG memories) is not compatible with the chat-based
memory and isn't imported - keep it in the backup if you ever want to mine it.

## 5. Using it

- **Settings -> AI Mode -> Offline**: chat, vision, automation, 3D, docs, and web
  search all switch to local. The model picker now lists your installed Ollama models.
  The status badge / model pill shows the active local model.
- **Settings -> AI Mode -> Online**: byte-for-byte the original cloud behavior.
- **"Use the local vision model in Online mode too"**: the one offline feature ported
  into online mode, exactly as you asked - see_screen, see_camera, and automation
  targeting run on your downloaded Ollama vision model while chat stays on your cloud key.
  If Ollama is down or no vision model is installed, it silently falls back to the
  provider's cloud vision model, so nothing breaks.
- **"Keep Offline chats separate"**: OFF (default) = both modes share your existing
  chats. ON = offline mode gets its own store (`offline-chats.json` in the app's
  userData); your existing online chats are untouched either way, and flipping the
  toggle can never delete anything.
- Switching the offline model in the picker frees the old one from VRAM and pre-warms
  the new one (same 6GB-GPU discipline as the old build). If `qwen2.5:14b` + a small
  draft model are installed, the speculative-decoding `-turbo` models are auto-built
  once and show up in the picker.

## 6. What still needs internet, even in offline mode

- Image generation (Pollinations is a free web service - there is no local image model)
- Voice downloads, wake-word model download, Piper engine download (one time each)
- Web search itself (it fetches pages; the ANSWER is synthesized locally)

Everything else - chat, vision, automation, STT, TTS, wake word, 3D, docs, memory -
runs 100% on your machine in offline mode.

## 7. Quick test checklist

1. `npm start` -> app opens, everything behaves exactly as before (online mode).
2. Settings -> AI Mode -> Offline. Badge should flip to "Ollama: running" within ~10s
   (it auto-starts the server). Send a message -> local reply.
3. "What's on my screen?" -> answered by moondream/llava locally.
4. Hold the mic key, speak -> transcript appears (local faster-whisper).
5. "Search the web for ..." -> DuckDuckGo research + local answer + sources line.
6. Flip back to Online -> your cloud setup, unchanged.
