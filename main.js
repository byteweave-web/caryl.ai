//main.js
// Caryl.ai - main process.
// Pure Electron (Node). No Python AI runtime required for ONLINE mode - all "intelligence"
// comes from a cloud OpenAI-compatible API; this process is the secure bridge between the
// UI (renderer) and that API, plus local on-disk memory.
//
// [OFFLINE-INTEGRATION] The app is now switchable between two modes (Settings -> AI Mode):
//   - online  : the original cloud thin-client, byte-for-byte unchanged in behavior.
//   - offline : the same app, same UI, same features - but all intelligence runs on the
//               local machine through Ollama's OpenAI-compatible endpoint
//               (http://127.0.0.1:11434/v1). Chat, vision (see_screen / see_camera /
//               automation targeting), 3D building, document summaries, web-search
//               answers (local DuckDuckGo research, ported from the old agent.py), and
//               speech-to-text (faster-whisper inside the automation sidecar) all route
//               locally. Wake word + Piper TTS were already local and work unchanged.
//   Storage can be MERGED (both modes share the existing chats - default, zero risk) or
//   SEPARATE (offline mode gets its own chat store; online chats are untouched either way).
//   Local VISION can also be used in ONLINE mode (Settings toggle): screen/camera/automation
//   vision then run on a downloaded Ollama vision model while chat stays on the cloud.

const { app, BrowserWindow, ipcMain, shell, desktopCapturer, globalShortcut, protocol, dialog, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');

// Refuse to run as a second instance. Without this, launching `npm start` (or double-clicking
// the exe) while an old process is still alive - even a background one Task Manager doesn't
// clearly show - starts a SECOND app fighting the first over the same cache/userData folder
// (Chromium logs this as "disk_cache... Access is denied"), and you end up looking at whichever
// window happens to be on top, which may be the stale one that never picked up a fix. This
// makes that entire class of bug impossible: a second launch just focuses the existing window.
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
  process.exit(0);
}
app.on('second-instance', () => {
  try {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  } catch (_e) {}
});

// Register a tiny scheme so generated images on disk load in the renderer reliably.
protocol.registerSchemesAsPrivileged([{ scheme: 'brainimg', privileges: { standard: true, secure: true, supportFetchAPI: true, bypassCSP: true } }]);

// One-time data migration from the BRAIN.AI era. Must run before the first config read.
require('./lib/migrate').run(app);

const config = require('./lib/config');
const memory = require('./lib/memory');
const actions = require('./lib/actions');
const { streamChat, listModels } = require('./lib/providers');
// [OFFLINE-INTEGRATION] new modules (see each file's header comment)
const ollama = require('./lib/ollama');
const OfflineMemory = require('./lib/offline-memory');
const localSearch = require('./lib/local-search');
const enginesLib = require('./lib/engines');

// Ensure cfg.engines exists (one-time derivation from the pre-Caryl flags).
{
  const norm = enginesLib.normalizeEngines(config.get());
  if (norm.changed) config.set({ engines: norm.engines });
}

// The single question every feature path asks: which engine serves this capability NOW?
function engineOf(capability) {
  return enginesLib.resolveEngine(config.get(), capability);
}

// ===================== OS-aware shell (Win10 vs Win11) =====================
// Windows 11 = build 22000+. Stored once at boot, user-overridable in onboarding/Settings.
// Win11 gets real DWM acrylic blur on the overlay; Win10 gets solid fallbacks (native
// blur-behind doesn't exist there - a transparent tint would just show raw desktop).
function detectOsVariant() {
  if (process.platform !== 'win32') return 'other';
  const build = parseInt((os.release() || '').split('.')[2] || '0', 10);
  return build >= 22000 ? 'win11' : 'win10';
}

// What every window (current and future - research overlay, camera mode) asks before
// choosing between blur and solid treatments.
function shellStyle() {
  const cfg = config.get();
  const osVariant = cfg.osVariant || detectOsVariant();
  return { osVariant, blur: osVariant === 'win11' };
}

// ===================== [OFFLINE-INTEGRATION] Mode resolution =====================
// Everything below funnels through these helpers instead of reading cfg.baseUrl /
// cfg.apiKey / cfg.model directly, so ONE config key (cfg.mode) flips the whole app
// between the cloud and the local engine without touching any feature code paths.
//
// New config keys (all optional, all default to the original online behavior):
//   mode                 : 'online' (default) | 'offline'
//   offlineModel         : Ollama chat model tag for offline mode (default 'qwen2.5:7b')
//   offlineVisionModel   : Ollama vision model tag ('' = auto-detect best installed)
//   useLocalVision       : true = ONLINE mode also uses the local vision model for
//                          see_screen / see_camera / automation targeting (the one
//                          offline feature deliberately ported into online mode)
//   separateOfflineChats : true = offline mode uses its own chat store (offline-chats.json);
//                          false (default) = both modes share the existing chats

const DEFAULT_OFFLINE_MODEL = 'qwen2.5:7b';
let offlineMemory = null; // lazy - only ever created if the user opts into separate storage

function isOffline(cfg) {
  return enginesLib.resolveEngine(cfg || config.get(), 'chat') === 'offline';
}

// The active CHAT endpoint+model. Ollama speaks the OpenAI /v1 protocol, so the existing
// streamChat() works against it unchanged - only the baseUrl/apiKey/model differ.
function chatCfg(cfg) {
  cfg = cfg || config.get();
  if (isOffline(cfg)) {
    return { baseUrl: ollama.BASE_V1, apiKey: 'ollama', model: cfg.offlineModel || DEFAULT_OFFLINE_MODEL, temperature: cfg.temperature };
  }
  return { baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, model: cfg.model, temperature: cfg.temperature };
}

// The local vision model to use, if any: the user's explicit pick, else auto-detect
// (moondream/llava/minicpm-v/... - lightest first, same order as the old brain.py).
function localVisionModel(cfg) {
  cfg = cfg || config.get();
  return cfg.offlineVisionModel || ollama.cachedVisionModel();
}

// The active VISION endpoint+model for see_screen / see_camera / 3D describe /
// automation planning + targeting. Three cases:
//   offline mode                     -> local vision model (falls back to the chat model
//                                       if none is installed, so requests still answer)
//   online mode + useLocalVision on  -> local vision model IF Ollama is up and one exists,
//                                       else the provider's cloud vision model as before
//   online mode (default)            -> the original per-provider cloud vision map, unchanged
function visionCfg(cfg) {
  cfg = cfg || config.get();
  const lv = localVisionModel(cfg);
  if (enginesLib.resolveEngine(cfg, 'vision') === 'offline') {
    if (ollama.isUp() && lv) return { baseUrl: ollama.BASE_V1, apiKey: 'ollama', model: lv };
    if (isOffline(cfg)) {
      // fully-local setup: still answer via the chat model rather than silently failing
      return { baseUrl: ollama.BASE_V1, apiKey: 'ollama', model: lv || (cfg.offlineModel || DEFAULT_OFFLINE_MODEL) };
    }
    // hybrid (chat online, vision offline but not ready): visible cloud fallback, never dead air
    console.warn('[engines] vision=offline but not ready (' + enginesLib.engineReady(cfg, 'vision', { ollamaUp: ollama.isUp(), localVisionModel: lv }).reason + ') - using cloud vision');
  }
  const VISION = { groq: cfg.visionModel || 'qwen/qwen3.6-27b', gemini: 'gemini-2.5-flash', openai: 'gpt-4o-mini' };
  return { baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, model: VISION[cfg.provider] || cfg.visionModel || cfg.model };
}

// "Is the brain connected?" - online: an API key exists; offline: the Ollama server answers.
function aiReady(cfg) {
  cfg = cfg || config.get();
  return isOffline(cfg) ? ollama.isUp() : !!cfg.apiKey;
}

function noAiMsg(cfg) {
  return isOffline(cfg || config.get())
    ? 'Ollama isn\u2019t running - start it (or check Settings \u2192 AI Mode) and try again.'
    : 'No API key set - open Settings.';
}

// The ACTIVE chat store. Merged storage (default): the original lib/memory.js for both
// modes - untouched, zero risk to existing chats. Separate storage: offline mode swaps to
// its own OfflineMemory store; online mode ALWAYS keeps the original store, so flipping
// the toggle can never lose anything the user already has.
function mem() {
  const cfg = config.get();
  if (isOffline(cfg) && cfg.separateOfflineChats) {
    if (!offlineMemory) offlineMemory = new OfflineMemory(path.join(app.getPath('userData'), 'offline-chats.json'));
    return offlineMemory;
  }
  return memory;
}

// One-shot local-engine boot: ensure the server is running (with the perf flags from the
// old offline build), start the background health monitor, kick the one-time turbo-model
// build, and pre-warm the offline chat model. Idempotent and fully best-effort - a missing
// Ollama install just leaves aiReady() false with a clear message in chat.
let ollamaBooted = false;
async function ollamaBoot() {
  try {
    const cfg = config.get();
    await ollama.ensureRunning();
    ollama.startMonitor(30000);
    await ollama.refresh();
    if (!ollamaBooted && ollama.isUp()) {
      ollamaBooted = true;
      ollama.ensureTurboModels(app.getPath('userData')).catch(() => {});
    }
    if (isOffline(cfg) && ollama.isUp()) {
      ollama.warm(chatCfg(cfg).model).catch(() => {});
    }
  } catch (e) {
    console.warn('[ollama] boot:', (e && e.message) || e);
  }
}
// ===================== end mode resolution =====================

// ===================== REFINED helpers (this build) =====================
// Token estimator: rough chars/4 approximation. Good enough for budget decisions; the
// exact tiktoken count doesn't matter, only the relative size of history turns.
function estimateTokens(text) {
  return Math.ceil(String(text || '').length / 4);
}

// Build a token-budgeted context: take the last N turns, but if their combined token estimate
// exceeds cfg.tokenBudget, drop the OLDEST ones first. When a turn is dropped, summarize it
// (very short stub) and prepend a single system note so the model still knows the gist.
// REFINED: replaces the simple mem().recent(maxHistory) used everywhere, cutting token cost
// on long sessions without losing too much long-term recall.
function buildBudgetedHistory(cfg) {
  const all = mem().all();
  const budget = (cfg && cfg.tokenBudget) || 6000;
  const maxN = (cfg && cfg.maxHistory) || 12;
  if (!all.length) return [];
  const recent = all.slice(-maxN);
  // Walk from newest to oldest, accumulate until budget hit.
  const kept = [];
  let used = 0;
  for (let i = recent.length - 1; i >= 0; i--) {
    const t = estimateTokens(recent[i].content || '');
    if (used + t > budget && kept.length) break;
    kept.unshift({ role: recent[i].role, content: recent[i].content });
    used += t;
  }
  // If we dropped some, prepend a short summary of what came before.
  const droppedCount = recent.length - kept.length;
  if (droppedCount > 0 && cfg && cfg.summarizeOldHistory !== false) {
    const dropped = recent.slice(0, droppedCount);
    const gist = dropped.map((m) => (m.role === 'user' ? 'User asked: ' : 'Assistant replied: ') +
      String(m.content || '').replace(/\s+/g, ' ').slice(0, 80)).join(' | ');
    kept.unshift({ role: 'system', content: 'Earlier in this conversation (summarized): ' + gist });
  }
  return kept;
}

// Strip bloated tool results from a message before it's stored in memory, so future turns
// don't re-send full file dumps / screenshot descriptions on every request.
// REFINED: keeps the first 200 chars + a [truncated] marker when content looks like a tool dump.
function maybeStripToolResult(text) {
  const t = String(text || '');
  const cfg = config.get();
  if (!cfg.stripToolResultsFromHistory) return t;
  // Heuristics for "this is a tool dump, not a normal reply":
  //   - very long (>1500 chars) AND
  //   - has multiple newlines AND
  //   - doesn't look like normal prose (low sentence density)
  if (t.length < 1500) return t;
  const lines = t.split(/\r?\n/).filter(Boolean);
  if (lines.length < 12) return t;
  const sentenceEnds = (t.match(/[.!?]\s/g) || []).length;
  if (sentenceEnds > lines.length * 0.5) return t; // looks like normal prose
  return t.slice(0, 200).trim() + '\n[...truncated for context brevity...]';
}

// Screenshot cache: avoid recapturing the screen multiple times within cfg.screenshotCacheMs.
let _lastScreenshot = { dataUrl: null, ts: 0 };
async function captureScreenCached(thumbW, thumbH) {
  const cfg = config.get();
  const cacheMs = cfg.screenshotCacheMs || 0;
  const now = Date.now();
  if (_lastScreenshot.dataUrl && (now - _lastScreenshot.ts) < cacheMs) {
    return _lastScreenshot.dataUrl;
  }
  const dataUrl = await captureScreen(thumbW, thumbH);
  if (dataUrl) { _lastScreenshot.dataUrl = dataUrl; _lastScreenshot.ts = now; }
  return dataUrl;
}

// Bound the in-memory activity log so a long session doesn't leak.
function pushActivity(entry) {
  const cfg = config.get();
  const max = cfg.activityLogMax || 200;
  activity.push(entry);
  while (activity.length > max) activity.shift();
}

// Auto-pick a faster-whisper model based on available RAM (Windows).
// tiny.en for <=12GB, base.en for 12-24GB, small.en for >24GB.
function autoWhisperModel() {
  try {
    const totalGb = Math.round(os.totalmem() / (1024 * 1024 * 1024));
    if (totalGb <= 12) return 'tiny.en';
    if (totalGb <= 24) return 'base.en';
    return 'small.en';
  } catch (_e) {
    return 'tiny.en';
  }
}

// Lazy sidecar: ensure the Python process is up only when actually needed.
// REFINED: replaces the eager startAutomationSidecar() at app launch. Cuts ~80MB RAM + a
// Python cold-start from machines that never automate or use local voice.
let _sidecarStarting = null;
async function ensureSidecar() {
  if (automationReady) return true;
  if (_sidecarStarting) return _sidecarStarting;
  _sidecarStarting = (async () => {
    startAutomationSidecar();
    // Wait up to 30s for first /health (matches the old poll).
    const started = Date.now();
    while (Date.now() - started < 30000) {
      if (await recheckAutomationHealth()) { _sidecarStarting = null; return true; }
      await new Promise((r) => setTimeout(r, 500));
    }
    _sidecarStarting = null;
    return false;
  })();
  return _sidecarStarting;
}
// ===================== end REFINED helpers =====================

let mainWindow = null;
let overlayWindow = null;        // the floating Jarvis PANEL window (expanded HUD)
let miniOverlayWindow = null;    // the floating Jarvis BUBBLE window (collapsed) - a separate
                                  // window/file on purpose: sharing one transparent window for
                                  // both meant the bubble inherited the panel's backdrop-filter
                                  // blur, which on a near-empty 92px window doesn't fail
                                  // gracefully - it renders as a murky, poorly-defined smudge
                                  // instead of either a crisp blur or a clean solid. Two
                                  // independent windows, each styled for what it actually is,
                                  // fixes this outright: the panel keeps its real blur, the
                                  // bubble is a solid, opaque, gradient-shaded sphere that never
                                  // depends on blur working at all.
let overlayExpandedBounds = null; // remembered 65%-size bounds, restored from the bubble
let overlayMode = 'expanded';     // 'expanded' | 'bubble'
let overlayIgnoreBlur = false;    // suppress collapse-on-blur while a dialog is open
let overlayBubblePos = null;      // remembered bubble position - independent of the panel once dragged
let overlayThreadStart = 0;       // index into `activity` where the overlay's own mini-thread begins
let lastDocument = null;          // { name, text } of the most recently imported doc (for Q&A)
const OVERLAY_BUBBLE = 92;        // bubble diameter in px
let activeController = null; // AbortController for the in-flight chat stream (for Stop)

// --- UI state your renderer polls for (mirrors the old Flask /status + /activity) ---
let activity = [];          // [{ kind: 'heard'|'said'|'thought'|'action', text, time }]
let aiStatus = 'idle';      // idle | thinking | working
let streamingEntry = null;  // the 'said' entry currently being streamed into
let piperChain = Promise.resolve(); // serializes Piper synthesis so spoken chunks stay in generation order

// ===================== Desktop automation (sidecar + agent loop) =====================
// See automation.py for the full safety model. Short version: two permission flags
// (mouse / scripting) mirror the two Settings toggles and default OFF every launch; shell
// commands additionally need per-command user confirmation (see automationState.pendingConfirm
// below) regardless of the toggle; delete is a soft-delete into a .trash folder.
const AUTOMATION_PORT = 7842;
const VISION_WEBHOOK_PORT = 7843;
const AUTOMATION_MAX_STEPS = 12;
// REFINED: 90s -> 30s default cap. The cap is read from cfg.automationRateLimitCapMs at runtime
// so the user can tune it; this constant is just the fallback for old config files.
const AUTOMATION_RATE_LIMIT_SANITY_CAP_MS = 30000;
let automationProc = null;          // the python automation.py child process
let automationReady = false;        // last /health check succeeded
let automationPyautogui = false;    // last /health check reported pyautogui actually loaded
let automationUia = false;          // last /health check reported the UIA accessibility locator loaded
let visionWebhookServer = null;     // the tiny http server automation.py calls to resolve "the submit button" -> {x,y}
let automationState = null;         // { active, goal, history, stopRequested, pendingConfirm } while a plan is executing
let automationRestartAttempts = 0;  // resets to 0 once healthy; caps unbounded crash-loop respawning
let automationIntentionalStop = false; // true only while we're killing it ourselves (app quit) - skip auto-respawn then
let automationHealthTimer = null;   // keeps re-checking /health for the app's whole lifetime, not just at launch
const AUTOMATION_MAX_RESTARTS = 3;

function clockTime(ts) {
  return new Date(ts || Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// Show saved conversation history in the chat the moment the app opens.
// [OFFLINE-INTEGRATION] reads from mem() so the thread follows the active store when the
// user switches mode / flips the separate-storage toggle.
function rebuildActivityFromMemory() {
  activity = mem().all().map((m) => ({
    kind: m.role === 'user' ? 'heard' : 'said',
    text: m.content,
    time: clockTime(m.ts)
  }));
}

// Strip markdown and stray symbols so TTS doesn't read "asterisk", "slash", "hash", etc.
function cleanForSpeech(text) {
  let t = String(text || '');
  t = t.replace(/```[\s\S]*?```/g, ' ');          // drop code blocks (don't read code)
  t = t.replace(/`([^`]*)`/g, '$1');               // inline code -> its content
  t = t.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');  // images -> alt
  t = t.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');    // links -> text
  t = t.replace(/(\*\*|__)(.*?)\1/g, '$2');         // bold
  t = t.replace(/(\*|_)(.*?)\1/g, '$2');            // italic
  t = t.replace(/~~(.*?)~~/g, '$1');                // strikethrough
  t = t.replace(/^\s{0,3}#{1,6}\s*/gm, '');         // headings
  t = t.replace(/^\s{0,3}>\s?/gm, '');              // blockquotes
  t = t.replace(/^\s{0,3}[-*+]\s+/gm, '');          // bullet points
  t = t.replace(/^\s{0,3}\d{1,2}[.)]\s+/gm, '');    // numbered list markers ("1. ", "2) ") - else TTS reads them as "one", "two"...
  t = t.replace(/[*_`~#|]/g, ' ');                  // any leftover markdown chars
  t = t.replace(/[\\/]+/g, ' ');                    // slashes / backslashes
  t = t.replace(/\s{2,}/g, ' ').trim();             // collapse whitespace
  return t;
}

// Speak a line aloud. Uses Piper (local neural voice) when configured, otherwise the
// browser's built-in speechSynthesis. Any Piper failure silently falls back to browser.
function speak(text) {
  if (!text || !mainWindow || mainWindow.isDestroyed()) return;
  const cfg = config.get();
  if (cfg.tts_enabled === false) return;
  const spoken = cleanForSpeech(text);
  if (!spoken) return;
  if (enginesLib.resolveEngine(cfg, 'tts') === 'offline' && cfg.piperPath && cfg.piperModel) {
    // Chained onto piperChain (not fired in parallel): without this, a short LATER sentence
    // can finish synthesizing before a longer EARLIER one, so its audio reaches - and plays
    // in - the renderer first, and the reply comes out spoken in the wrong order.
    piperChain = piperChain
      .then(() => piperSynth(spoken, cfg))
      .then((wav) => {
        if (wav && mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('tts:audio', wav.buffer.slice(wav.byteOffset, wav.byteOffset + wav.byteLength));
        else if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('tts:speak', spoken);
      })
      .catch(() => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('tts:speak', spoken); });
    return;
  }
  mainWindow.webContents.send('tts:speak', spoken);
}

// Streaming speaker: feed it the cumulative answer text as it streams in; it emits each
// COMPLETE sentence (or line) the moment it lands, so the voice starts almost immediately
// instead of waiting for the whole reply. Ordering and the one-at-a-time playback that keeps
// the OS voice from scrambling sentences are handled in the renderer's speech queue.
//
// Usage:
//   const sp = makeSpeaker();
//   onToken: (d) => { ...; sp.feed(currentAnswerText); }   // pass the cumulative ANSWER so far
//   ...after the stream: sp.flush();                        // speaks any trailing partial line
function makeSpeaker() {
  let spokenLen = 0;   // how many chars of the answer we've already sent to speak()
  let lastSeen = '';   // last full answer string we were given

  function drain(text, force) {
    lastSeen = text;
    if (text.length < spokenLen) { spokenLen = 0; } // answer was reset/replaced - restart
    const pending = text.slice(spokenLen);
    if (!pending) return;

    if (force) {
      const tail = pending.trim();
      if (tail) { speak(tail); }
      spokenLen = text.length;
      return;
    }

    // Walk char by char (NOT a regex - a regex that excludes '.' fragments decimals like
    // "87.7" into "7", which mis-speaks and repeats). `cut` is the real prefix length we've
    // finished, so spokenLen always advances exactly. We break at sentence ends AND at line
    // breaks, so each spoken chunk is short (no long-utterance repeat bug) and there's a
    // natural breath between them.
    const isDigit = (c) => c >= '0' && c <= '9';
    const isSpace = (c) => c === ' ' || c === '\n' || c === '\r' || c === '\t';
    const isCloser = (c) => c === '"' || c === '\'' || c === ')' || c === ']' || c === '\u201d' || c === '\u2019';
    // Is the digit run ending just before `periodIdx` a numbered-list marker ("1.", "12.")
    // rather than a genuine sentence ending in a number? True only when that number sits at
    // the START of a line - "1. Make it obvious" (list item) vs "She scored a 9." (real
    // sentence, "9" is mid-line, not a marker).
    function isListMarker(periodIdx) {
      let start = periodIdx;
      while (start > 0 && isDigit(pending[start - 1])) start--;
      const digitRunLen = periodIdx - start;
      if (digitRunLen < 1 || digitRunLen > 2) return false; // real list markers are 1-2 digits
      let k = start - 1;
      while (k >= 0 && (pending[k] === ' ' || pending[k] === '\t')) k--; // skip indentation
      return k < 0 || pending[k] === '\n';
    }
    let cut = 0;
    for (let i = 0; i < pending.length; i++) {
      const ch = pending[i];
      if (ch === '\n') { cut = i + 1; continue; } // line break = chunk boundary (a breath)
      if (ch !== '.' && ch !== '!' && ch !== '?' && ch !== '\u2026') continue;
      // Decimal point inside a number ("87.7") - not a sentence end.
      if (ch === '.' && i > 0 && isDigit(pending[i - 1]) && i + 1 < pending.length && isDigit(pending[i + 1])) continue;
      // Numbered-list marker ("1. Make it obvious") - without this, the splitter chops "1."
      // off as its own tiny spoken utterance, leaving the item's actual text as a separate,
      // disconnected-sounding chunk right after a numeral spoken alone.
      if (ch === '.' && i > 0 && isDigit(pending[i - 1]) && isListMarker(i)) continue;
      let j = i + 1;
      while (j < pending.length && isCloser(pending[j])) j++;
      if (j >= pending.length) {
        // Ends at the buffer end (no following char yet). A '.' right after a digit might
        // still be growing into "87.7", so wait for more; otherwise speak it now.
        if (ch === '.' && i > 0 && isDigit(pending[i - 1])) break;
        cut = j;
      } else if (isSpace(pending[j])) {
        cut = j + 1; // punctuation followed by whitespace -> real boundary
      }
    }
    if (cut > 0) {
      const chunk = pending.slice(0, cut).trim();
      if (chunk) { speak(chunk); spokenLen += cut; }
    }
  }

  return {
    feed: (answerText) => drain(String(answerText || ''), false),
    flush: () => drain(lastSeen, true)
  };
}

// Run Piper: text in via stdin, a WAV file out, returned as a Buffer.
function piperSynth(text, cfg) {
  return new Promise((resolve, reject) => {
    const out = path.join(os.tmpdir(), 'brain_tts_' + Date.now() + '.wav');
    let proc;
    try {
      proc = spawn(cfg.piperPath, ['--model', cfg.piperModel, '--output_file', out], { windowsHide: true });
    } catch (e) { return reject(e); }
    let err = '';
    proc.stderr.on('data', (d) => { err += d.toString(); });
    proc.on('error', reject);
    proc.on('close', (code) => {
      fs.readFile(out, (e, buf) => {
        fs.unlink(out, () => {});
        if (e || !buf || !buf.length) return reject(new Error('piper produced no audio' + (err ? ': ' + err.slice(0, 200) : '')));
        resolve(buf);
      });
    });
    proc.stdin.write(text);
    proc.stdin.end();
  });
}

function joinUrl(base, suffix) {
  return String(base).replace(/\/+$/, '') + suffix;
}

// ---- One-click voice install (downloads Piper + the chosen voice, sets everything up) ----
const PIPER_WIN_URL = 'https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_windows_amd64.zip';
const VOICE_BASE = 'https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0';
const VOICE_CATALOG = {
  'lessac-high': { label: 'Lessac - US, clear (high)', dir: 'en/en_US/lessac/high', name: 'en_US-lessac-high' },
  'ryan-high': { label: 'Ryan - US male (high)', dir: 'en/en_US/ryan/high', name: 'en_US-ryan-high' },
  'amy-medium': { label: 'Amy - US female (medium)', dir: 'en/en_US/amy/medium', name: 'en_US-amy-medium' },
  'hfc_female-medium': { label: 'HFC Female - US (medium)', dir: 'en/en_US/hfc_female/medium', name: 'en_US-hfc_female-medium' },
  'alan-medium': { label: 'Alan - British male (medium)', dir: 'en/en_GB/alan/medium', name: 'en_GB-alan-medium' },
  'cori-high': { label: 'Cori - British female (high)', dir: 'en/en_GB/cori/high', name: 'en_GB-cori-high' }
};

function voiceProgress(msg) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('voice:progress', msg);
}

async function downloadFile(url, dest) {
  const res = await fetch(url);
  if (!res.ok) throw new Error('download failed (' + res.status + ')');
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(dest, buf);
}

function extractZip(zip, dest) {
  return new Promise((resolve, reject) => {
    const p = spawn('powershell', ['-NoProfile', '-Command', "Expand-Archive -Force -Path '" + zip + "' -DestinationPath '" + dest + "'"], { windowsHide: true });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error('could not unzip Piper'))));
  });
}

// ---- Image generation (Pollinations - free, no key) ----
const IMAGE_STYLES = {
  realistic: 'photorealistic, highly detailed, sharp focus, natural lighting, 8k',
  anime: 'anime style, vibrant colors, detailed anime artwork, studio quality',
  digital: 'digital art, concept art, trending on artstation, highly detailed',
  oil: 'oil painting, textured visible brushstrokes, classical fine art',
  render3d: '3D render, octane render, cinematic lighting, volumetric, detailed',
  cyberpunk: 'cyberpunk, glowing neon lights, futuristic, moody atmosphere',
  watercolor: 'watercolor painting, soft pastel colors, delicate, artistic',
  pixar: 'cute 3D animated movie style, Pixar-like, soft lighting, expressive',
  any: ''
};

async function generateImage(prompt) {
  const dir = path.join(app.getPath('userData'), 'images');
  fs.mkdirSync(dir, { recursive: true });
  const seed = Math.floor(Math.random() * 1e9);
  // enhance=true lets Pollinations rewrite the prompt with an LLM (the real quality lever);
  // 1920x1080 = full 1080p.
  const url = 'https://image.pollinations.ai/prompt/' + encodeURIComponent(prompt) +
    '?width=1920&height=1080&seed=' + seed + '&model=flux&enhance=true&nologo=true';
  const res = await fetch(url);
  if (!res.ok) throw new Error('image service error (' + res.status + ')');
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 800) throw new Error('image service returned nothing');
  const file = path.join(dir, 'img_' + Date.now() + '.jpg');
  fs.writeFileSync(file, buf);
  return file;
}

function findPiperExe(root) {
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_e) { continue; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (e.name.toLowerCase() === 'piper.exe') return full;
    }
  }
  return null;
}

// Resolve the user's Groq endpoint+key (Groq powers web search + voice regardless of chat provider).
function resolveGroqKey(cfg) {
  const pk = cfg.providerKeys || {};
  const k = pk.groq || (cfg.provider === 'groq' ? cfg.apiKey : '');
  return k ? { base: 'https://api.groq.com/openai/v1', key: k } : null;
}

// Split a reasoning-model reply into its hidden <think> reasoning and the actual answer.
// While the model is still inside <think> (no closing tag yet), answer is '' (still thinking).
function splitThinking(text) {
  const t = String(text || '');
  const closed = t.match(/<think>([\s\S]*?)<\/think>/i);
  if (closed) {
    return { thinking: closed[1].trim(), answer: t.replace(/<think>[\s\S]*?<\/think>/i, '').trim() };
  }
  if (/<think>/i.test(t)) {
    return { thinking: t.replace(/[\s\S]*?<think>/i, '').trim(), answer: '' };
  }
  return { thinking: '', answer: t.trim() };
}

// Grab a screenshot of the primary display as a data URL (for the vision model).
async function captureScreen(thumbW, thumbH) {
  try {
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: thumbW || 1280, height: thumbH || 800 } });
    if (!sources.length) return null;
    return sources[0].thumbnail.toDataURL();
  } catch (_e) {
    return null;
  }
}

// ---- Desktop automation: sidecar process, vision webhook, plan + step loop ----
// See automation.py's own top-of-file comment for the full safety model. The short version:
// this app will PROPOSE a plan and wait for the user to approve it before touching the mouse
// or keyboard at all, and it will PAUSE for individual confirmation before ever running a
// shell command, even mid-approved-plan. Nothing here runs unattended end-to-end.

// If a .venv sits next to main.js, use ITS python.exe explicitly rather than the bare
// "python" command. Bare "python" resolves to whatever's first on PATH, which is very often
// NOT the same interpreter packages just got pip-installed into (VS Code's debugger, a global
// install, and a project venv can all disagree about which "python" that is) - that mismatch
// is exactly what causes "works when I run it in the debugger, fails when the real app spawns
// it" bugs. Being explicit here removes the ambiguity for good.
function pythonExecutable() {
  const bases = [__dirname];
  // Packaged builds: main.js lives INSIDE app.asar where a venv can't exist - check the
  // resources folder (where extraResources land) first there.
  try { if (app.isPackaged) bases.unshift(process.resourcesPath); } catch (_e) {}
  for (const base of bases) {
    const venvPy = process.platform === 'win32'
      ? path.join(base, '.venv', 'Scripts', 'python.exe')
      : path.join(base, '.venv', 'bin', 'python');
    if (fs.existsSync(venvPy)) return venvPy;
  }
  return 'python';
}

// Where automation.py actually is. In dev it sits next to main.js; in a packaged build
// main.js is inside app.asar (which a spawned python can't read from), so automation.py is
// shipped via package.json "extraResources" into the resources folder instead.
function sidecarScriptPath() {
  try {
    if (app.isPackaged) {
      const packaged = path.join(process.resourcesPath, 'automation.py');
      if (fs.existsSync(packaged)) return packaged;
    }
  } catch (_e) {}
  return path.join(__dirname, 'automation.py');
}

function startAutomationSidecar() {
  const script = sidecarScriptPath();
  if (!fs.existsSync(script)) { console.warn('[automation] automation.py not found (looked at ' + script + ') - automation disabled'); return; }
  automationIntentionalStop = false;
  try {
    automationProc = spawn(pythonExecutable(), [script], { windowsHide: true, cwd: path.dirname(script) });
    automationProc.stdout.on('data', (d) => console.log('[automation.py]', d.toString().trim()));
    automationProc.stderr.on('data', (d) => console.error('[automation.py]', d.toString().trim()));
    automationProc.on('exit', (code) => {
      console.log('[automation] sidecar exited, code=' + code);
      automationProc = null; automationReady = false;
      if (automationIntentionalStop) return; // we killed it ourselves (app quitting) - don't respawn
      if (automationRestartAttempts >= AUTOMATION_MAX_RESTARTS) {
        console.error('[automation] sidecar exited ' + AUTOMATION_MAX_RESTARTS + ' times in a row - giving up. Check that Python and the packages in requirements_automation.txt are actually installed for the interpreter main.js is using.');
        return;
      }
      automationRestartAttempts++;
      console.log('[automation] respawning sidecar (attempt ' + automationRestartAttempts + ' of ' + AUTOMATION_MAX_RESTARTS + ')...');
      setTimeout(startAutomationSidecar, 2000);
    });
  } catch (e) {
    console.error('[automation] failed to spawn automation.py:', (e && e.message) || e);
    return;
  }
  (async function waitForFirstHealth() {
    const started = Date.now();
    // 30s, not 12s: cold-starting Python + Flask + pyautogui + pillow for the first time
    // (antivirus scanning a new/unsigned process, first-run import costs) can genuinely take
    // longer than a few seconds - the old 12s window was giving up before the sidecar was
    // even done starting, and then never checking again for the rest of the session.
    while (Date.now() - started < 30000) {
      if (await recheckAutomationHealth()) return;
      await new Promise((r) => setTimeout(r, 500));
    }
    console.warn('[automation] sidecar not healthy within 30s of launch - it may still come up on its own; automation_available will update automatically once it does (checked every 30s in the background)');
  })();
  if (!automationHealthTimer) automationHealthTimer = setInterval(recheckAutomationHealth, 30000);
}

// Called both by the startup poll above and by the ongoing 30s timer, so automationReady stays
// accurate for the app's whole lifetime instead of freezing at whatever it happened to be a few
// seconds after launch. Returns true/false.
async function recheckAutomationHealth() {
  try {
    const res = await fetch('http://127.0.0.1:' + AUTOMATION_PORT + '/health');
    if (!res.ok) { automationReady = false; return false; }
    const j = await res.json();
    const justBecameReady = !!j.ok && !automationReady;
    automationReady = !!j.ok;
    automationPyautogui = !!j.pyautogui;
    automationUia = !!j.uia;
    if (justBecameReady) {
      automationRestartAttempts = 0; // it's genuinely working now - don't count this against the crash budget
      console.log('[automation] sidecar ready (pyautogui=' + automationPyautogui + ', uia=' + automationUia + ')');
      if (!automationUia) {
        console.warn('[automation] UIA element location unavailable (' + (j.uia_error || 'unknown') + '). Clicks will rely on the vision model, which is far less precise. Fix: pip install uiautomation (into the same Python the sidecar uses), then restart Caryl.');
      }
      const cfg = config.get();
      try {
        await fetch('http://127.0.0.1:' + AUTOMATION_PORT + '/permissions', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mouse: !!cfg.allow_mouse_control, scripting: !!cfg.allow_system_scripting })
        });
      } catch (_e) { /* sidecar just stays default-off, which is safe */ }
    }
    return automationReady;
  } catch (_e) {
    automationReady = false;
    return false;
  }
}

function stopAutomationSidecar() {
  automationIntentionalStop = true;
  if (automationHealthTimer) { clearInterval(automationHealthTimer); automationHealthTimer = null; }
  try { if (visionWebhookServer) visionWebhookServer.close(); } catch (_e) {}
  try { if (automationProc) automationProc.kill(); } catch (_e) {}
  automationProc = null; automationReady = false;
}

async function sidecarCall(endpoint, body) {
  try {
    const res = await fetch('http://127.0.0.1:' + AUTOMATION_PORT + endpoint, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {})
    });
    const j = await res.json().catch(() => ({}));
    return Object.assign({ ok: false }, j);
  } catch (e) {
    return { ok: false, error: 'automation engine unreachable: ' + ((e && e.message) || e) };
  }
}

// Turns a plain-English target ("the submit button") into {x,y} using the SAME vision-model
// selection logic as see_screen/see_camera elsewhere in this file - just a raw, silent call
// (no chat activity, no speech) since this is an internal lookup, not a user-facing reply.
// [OFFLINE-INTEGRATION] routes through visionCfg(): offline mode (and the online local-vision
// toggle) resolve targets on a downloaded Ollama vision model; otherwise the cloud map as before.
async function locateElementOnScreen(dataUrl, target) {
  const cfg = config.get();
  if (!aiReady(cfg) || !dataUrl) return { x: null, y: null };
  const v = visionCfg(cfg);
  const sys = 'You are looking at a screenshot. Find the UI element described as: "' + String(target || '') +
    '". Return ONLY a JSON object: {"x": <pixel_x>, "y": <pixel_y>} where x and y are the CENTER pixel ' +
    'coordinates of that element, in the pixel coordinate space of the image itself. If you cannot find it, ' +
    'return {"x": null, "y": null}. No other text, no code fences.';
  let raw = '';
  try {
    await streamChat({
      baseUrl: v.baseUrl, apiKey: v.apiKey, model: v.model, temperature: 0,
      messages: [{ role: 'user', content: [{ type: 'text', text: sys }, { type: 'image_url', image_url: { url: dataUrl } }] }],
      onToken: (d) => { raw += d; }
    });
    const s = raw.indexOf('{'), e = raw.lastIndexOf('}');
    const obj = JSON.parse(raw.slice(s, e + 1));
    const nx = Number(obj.x), ny = Number(obj.y); // tolerate "x": "512" (weak models quote numbers)
    return {
      x: Number.isFinite(nx) ? Math.round(nx) : null,
      y: Number.isFinite(ny) ? Math.round(ny) : null
    };
  } catch (_e) {
    console.error('[automation] locateElementOnScreen failed for target "' + target + '":', (_e && _e.message) || _e);
    return { x: null, y: null };
  }
}

// A tiny local HTTP server (not Electron IPC - automation.py is a separate OS process and
// can't use IPC) that automation.py calls with a screenshot + target description, and gets
// back {x,y}. Synchronous request/response - no separate callback endpoint needed.
function startVisionWebhook() {
  const http = require('http');
  visionWebhookServer = http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/vision') { res.writeHead(404); res.end(); return; }
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 30 * 1024 * 1024) req.destroy(); }); // ~30MB cap - a full-res PNG screenshot fits comfortably
    req.on('end', async () => {
      try {
        const { image, target } = JSON.parse(body);
        const xy = await locateElementOnScreen(image, target);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(xy));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ x: null, y: null, error: (e && e.message) || String(e) }));
      }
    });
  });
  visionWebhookServer.on('error', (e) => console.error('[automation] vision webhook error:', (e && e.message) || e));
  visionWebhookServer.listen(VISION_WEBHOOK_PORT, '127.0.0.1', () => {
    console.log('[automation] vision webhook listening on 127.0.0.1:' + VISION_WEBHOOK_PORT);
  });
}

// Phase 1 of 2: the user described a goal (matched by automate_plan in the CAPABILITY
// prompt). Look at the actual screen and propose a short plan, then STOP and wait - nothing
// executes until the user approves it in chat (see automation_plan activity + approvePlan()).
// Shared by both the plan-proposal call and the per-step execution loop: judgment about
// bringing the right thing into view BEFORE trying to find something in it that may not be
// visible at all yet. Deliberately NOT a hardcoded "always minimize windows first" action -
// plenty of goals (typing into an already-focused app, clicking something already on screen)
// need none of this, and firing it unconditionally would be its own source of wrong clicks.
const WINDOW_MANAGEMENT_GUIDANCE =
  'Before trying to find something on screen, check whether it is actually visible in the CURRENT ' +
  'screenshot first - do not assume. If the goal needs an app that is not currently visible or in the ' +
  'foreground, the right move is to bring it forward yourself rather than guess at a taskbar icon that ' +
  'may not be there: press the OS launcher key alone (hotkey "win"), then type the app\u2019s name (type ' +
  'action, no target needed - the launcher\u2019s search box is already focused), then press enter (hotkey ' +
  '"enter"). If the goal is about files or icons on the desktop and the desktop itself is not what\u2019s ' +
  'currently visible (an editor, browser, or other window is covering it), use hotkey "win+d" to reveal ' +
  'the desktop before trying to locate anything on it. Only take a screenshot-grounded guess at a UI ' +
  'element once the right window or view is actually the thing in front. ' +
  'Two hard rules about win+d: (1) it is a TOGGLE - pressing it a second time brings every window it ' +
  'just hid RIGHT BACK, so never press win+d more than once for the same goal, and never press it again ' +
  'as a "retry". (2) BRAIN\u2019s own floating assistant orb/panel is excluded from these screenshots, so ' +
  'every window you actually see in a screenshot is real and belongs to the user - if a screenshot shows ' +
  'a bare desktop, the desktop IS showing, and a goal like "minimize/hide everything" is at that point ' +
  'already complete: reply with action "done" instead of pressing anything else.';

// Groq (and likely others) put the actual wait time right in the 429 error text, e.g. "Please
// try again in 922.5ms" - reading that directly is both faster and more correct than guessing a
// fixed backoff, since token-per-minute limits refill continuously rather than resetting on the
// minute. Falls back to null (caller uses its own fixed schedule) if the message doesn't match.
function extractRetryDelayMs(errMsg) {
  const m = /try again in\s*([\d.]+)\s*(ms|s)\b/i.exec(String(errMsg || ''));
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (!isFinite(n)) return null;
  return Math.ceil((m[2].toLowerCase() === 's' ? n * 1000 : n) * 1.2); // +20% safety margin
}
function isRateLimitError(errMsg) {
  return /\b429\b|rate.?limit/i.test(String(errMsg || ''));
}

const TARGET_PRECISION_GUIDANCE =
  'When naming a target, use the element\u2019s EXACT visible text/label/name as it appears on screen: ' +
  'target "Save" or "the Save button", "Recycle Bin", "New folder", "File menu" - named elements are ' +
  'located precisely through the Windows accessibility tree with zero guesswork, so a correct exact ' +
  'name virtually always hits. Extra positional words ("near the top", "next to X") add nothing and ' +
  'reduce match quality - use the name alone. ' +
  'When a target is a general area rather than a specific object, prefer these EXACT target strings ' +
  'which the automation engine handles DETERMINISTICALLY (no vision model needed, never fails): ' +
  '"desktop" (any empty spot on the desktop), "empty area" (any empty spot on screen), "screen center", ' +
  '"taskbar" (the bottom taskbar). Using these exact words is dramatically more reliable than a ' +
  'long description like "an empty area near the top-right of the desktop, away from any icons" - ' +
  'the vision model is genuinely bad at finding negative space, but the engine knows where the ' +
  'desktop center is without looking. So for "right-click the desktop", use target "desktop" - NOT ' +
  'a paragraph describing where empty space might be. ' +
  'For any other target that was not found last step (see history), do not repeat the exact same ' +
  'description - either describe it more specifically or try a different way to accomplish the same ' +
  'thing. Never choose the exact same action (same action + same target/keys/text) two steps in a ' +
  'row: if the last step did not visibly change anything, pick a genuinely different approach - and ' +
  'if the current screenshot shows the goal is already achieved, reply with action "done" instead ' +
  'of doing more. If your previous click or right-click opened a MENU or dialog (check the ' +
  'screenshot - it will be visible), the next step must act ON that menu (click one of its items, ' +
  'or press escape to dismiss it) - never repeat the click that opened it. ' +
  'STRICT rule for "done": only declare done when the CURRENT screenshot itself clearly shows the ' +
  'goal fully accomplished - having merely started (opened an app, pressed one key, opened a menu) ' +
  'is NOT done. If any part of the goal is still not visibly finished, do the next concrete action instead.';

// PATCH v2: concrete Windows recipes for the most common desktop-organization tasks. Without
// these the AI flails - it knows the GOAL ("organize my desktop icons") but not the STEPS, so
// it tries to click individual icons or describe vague "empty areas" the vision model can't
// locate. These recipes give it the exact, known-good sequence. The AI still has to recognize
// when a recipe applies (matched against the goal text) and execute it step by step - but the
// steps themselves are the kind any human Windows user would do without thinking.
const COMMON_WINDOWS_RECIPES =
  'KNOWN WINDOWS RECIPES - use these EXACT step sequences when the goal matches. They are ' +
  'grounded in how Windows actually works, not guesses:\n' +
  '1. "Organize / sort / arrange desktop icons" -> right-click the desktop (target "desktop"), ' +
  'then hover "Sort by" (target "Sort by"), then click "Name" (or "Date modified", "Size", ' +
  '"Item type" - pick the one the user named, default "Name"). For "auto-arrange", after ' +
  'right-clicking the desktop hover "View" then click "Auto arrange icons".\n' +
  '2. "Show/hide desktop icons" -> right-click the desktop (target "desktop"), hover "View", ' +
  'then click "Show desktop icons" (it is a toggle).\n' +
  '3. "Change wallpaper" -> right-click the desktop (target "desktop"), click "Personalize", ' +
  'then in the Settings window that opens click "Background" and pick one.\n' +
  '4. "Open File Explorer / Downloads / Documents" -> hotkey "win+e" (opens Explorer), then ' +
  'click the relevant item in the left sidebar. Do NOT try to click a desktop icon for it.\n' +
  '5. "Minimize all windows / show desktop" -> hotkey "win+d" (ONCE ONLY - it is a toggle).\n' +
  '6. "Open an app" -> hotkey "win" (opens Start menu search), type the app name, press enter.\n' +
  '7. "Close the current window" -> hotkey "alt+f4", or hotkey "ctrl+w" for a tab.\n' +
  '8. "Take a screenshot" -> hotkey "win+shift+s" (opens Snipping Tool).\n' +
  'When a recipe applies, follow its steps IN ORDER - do not invent your own steps. Only deviate ' +
  'if a step visibly fails (the expected menu/item does not appear) and you need to recover. ' +
  'Always use the EXACT target strings the recipe gives you ("desktop", "Sort by", "Name") - ' +
  'these are matched deterministically or are common UI labels the vision model recognizes easily.';

// Pull a list of plain-English steps out of whatever the model returned. Tries strict JSON
// first, then a loose {"steps":[...]} match, then finally salvages a numbered/bulleted list
// out of prose - because weaker vision models often ignore "reply with JSON only" and just
// write a paragraph or a list. Returns [] if nothing usable is found.
function parsePlanSteps(raw) {
  const text = String(raw || '');
  const clip = (arr) => arr.slice(0, 6).map((x) => String(x).trim()).filter(Boolean);
  // 1) strict-ish JSON: first '{' to last '}'
  try {
    const s = text.indexOf('{'), e = text.lastIndexOf('}');
    if (s !== -1 && e > s) {
      const obj = JSON.parse(text.slice(s, e + 1));
      if (Array.isArray(obj.steps) && obj.steps.length) return clip(obj.steps);
    }
  } catch (_e) { /* fall through */ }
  // 2) a "steps": [ ... ] array anywhere, even wrapped in prose or code fences
  try {
    const m = /"steps"\s*:\s*\[([\s\S]*?)\]/.exec(text);
    if (m) {
      const items = m[1].split(',').map((x) => x.replace(/^\s*["'\u201C\u201D]?|["'\u201C\u201D]?\s*$/g, '').trim()).filter(Boolean);
      if (items.length) return clip(items);
    }
  } catch (_e) { /* fall through */ }
  // 3) prose salvage: numbered ("1. "/"2) ") or bulleted ("- "/"* ") lines become steps
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const listItems = [];
  for (const l of lines) {
    const m = /^(?:\d{1,2}[.)]|[-*\u2022])\s+(.*)$/.exec(l);
    if (m && m[1]) listItems.push(m[1].replace(/^["'\u201C]|["'\u201D]$/g, '').trim());
  }
  if (listItems.length >= 2) return clip(listItems);
  return [];
}

// Pull the step-decision object out of whatever the model returned. Weak local vision models
// routinely wrap the JSON in prose or code fences, add trailing commas, or skip JSON entirely -
// so try progressively harder before giving up:
//   1) first '{' .. last '}' parse (the original fast path)
//   2) balanced-brace scan: parse every {...} block, take the first with a usable "action"
//   3) light repair (strip code fences, drop trailing commas), then retry 1+2
//   4) field salvage: regex the known fields out of JSON-ish text
// Returns the parsed object or null.
function parseAutomationStep(raw) {
  const text = String(raw || '');
  const tryParse = (s) => { try { const o = JSON.parse(s); return (o && typeof o === 'object' && !Array.isArray(o)) ? o : null; } catch (_e) { return null; } };
  const firstToLast = (s) => {
    const a = s.indexOf('{'), b = s.lastIndexOf('}');
    return (a !== -1 && b > a) ? tryParse(s.slice(a, b + 1)) : null;
  };
  // Every top-level balanced {...} block, string-aware so braces inside quoted text don't break it.
  const blocks = (s) => {
    const out = [];
    let depth = 0, start = -1, inStr = false, esc = false;
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
      if (c === '"') { inStr = true; continue; }
      if (c === '{') { if (depth === 0) start = i; depth++; }
      else if (c === '}') { depth--; if (depth === 0 && start !== -1) { out.push(s.slice(start, i + 1)); start = -1; } if (depth < 0) depth = 0; }
    }
    return out;
  };
  const pickActionObj = (s) => {
    for (const b of blocks(s)) { const o = tryParse(b); if (o && typeof o.action === 'string' && o.action.trim()) return o; }
    return null;
  };

  let obj = firstToLast(text);
  if (obj && obj.action) return obj;
  obj = pickActionObj(text);
  if (obj) return obj;

  const repaired = text.replace(/```[a-z]*/gi, ' ').replace(/,\s*([}\]])/g, '$1');
  obj = firstToLast(repaired);
  if (obj && obj.action) return obj;
  obj = pickActionObj(repaired);
  if (obj) return obj;

  // Last resort: salvage fields out of malformed JSON-ish text (double- or single-quoted values).
  const grab = (key) => {
    let m = new RegExp('["\\x27]?' + key + '["\\x27]?\\s*[:=]\\s*"([^"]*)"', 'i').exec(text);
    if (!m) m = new RegExp('["\\x27]?' + key + '["\\x27]?\\s*[:=]\\s*\\x27([^\\x27]*)\\x27', 'i').exec(text);
    return m ? m[1].trim() : '';
  };
  const action = grab('action').toLowerCase();
  if (AUTOMATION_ACTIONS.indexOf(action) !== -1) {
    return {
      action,
      thought: grab('thought'),
      target: grab('target'),
      drag_to: grab('drag_to'),
      text: grab('text'),
      keys: grab('keys'),
      scroll_dir: grab('scroll_dir'),
      cmd: grab('cmd'),
      file_op: grab('file_op'),
      file_path: grab('file_path'),
      file_to: grab('file_to'),
      file_content: grab('file_content'),
      final_answer: grab('final_answer')
    };
  }
  return null;
}
const AUTOMATION_ACTIONS = ['open_app', 'click', 'rightclick', 'doubleclick', 'drag', 'type', 'hotkey', 'scroll', 'shell', 'files', 'done'];

// Two-stage step decision for weak vision models: (1) the vision model only DESCRIBES the
// screenshot - narrating images is the one thing even tiny local vision models do reliably
// (it's literally what they were doing instead of following the JSON schema); (2) the CHAT
// model - a far better instruction-follower - turns goal + history + that description into
// the JSON action. Clicks stay grounded either way: /act's locate() looks at the real
// screenshot when the action executes. Returns the parsed step object or null.
async function decideStepViaChatModel(cfg, goal, dataUrl, sysSchemaPrompt) {
  const v = visionCfg(cfg);
  let desc = '';
  try {
    await streamChat({
      baseUrl: v.baseUrl, apiKey: v.apiKey, model: v.model, temperature: 0,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'Describe this screenshot factually in 2-4 short sentences: which app or window is in front, what key UI elements and text are visible, and anything that looks selected or focused. No advice, no JSON - just the plain description.' },
          { type: 'image_url', image_url: { url: dataUrl } }
        ]
      }],
      onToken: (d) => { desc += d; }
    });
  } catch (_e) { /* no description - the chat model still decides from goal + history */ }
  desc = desc.trim().slice(0, 1200);
  const c = chatCfg(cfg);
  for (let attempt = 0; attempt < 2; attempt++) {
    let raw = '';
    try {
      await streamChat({
        baseUrl: c.baseUrl, apiKey: c.apiKey, model: c.model, temperature: 0.2,
        messages: [{
          role: 'user',
          content: sysSchemaPrompt + '\n\nYou cannot see the screen yourself. A vision model described the CURRENT screenshot as: "' +
            (desc || '(no description available)') + '". Decide the single next action from that description, the goal, and the step history above. ' +
            'If the description already shows the goal is complete, use action "done".'
        }],
        onToken: (d) => { raw += d; }
      });
    } catch (_e) { continue; }
    const obj = parseAutomationStep(raw);
    if (obj) return obj;
  }
  return null;
}

// Every automation prompt (planning AND per-step) opens with this, so the model never forgets
// that IT is the one acting. Without it, weaker/text models slip into "assistant giving advice"
// mode and produce nonsense like "open YouTube on your phone and watch a tutorial" - steps a
// PERSON would follow, not actions a program performs. This nails down that BRAIN itself drives
// the real mouse/keyboard on THIS machine.
const AUTOMATION_FRAMING =
  'You are Caryl, an assistant that DIRECTLY CONTROLS this Windows PC: you move the real mouse and ' +
  'type on the real keyboard to carry out the task YOURSELF, right now, on this computer. You are NOT ' +
  'giving the user advice or a list of instructions for them to follow. Absolutely never suggest ' +
  'watching a tutorial or video, using a phone or any other device, googling a how-to guide, or asking ' +
  'the user to do something manually - YOU perform every action here. Each step must be a concrete ' +
  'on-screen action on this PC: open an app, click a control, type text, press a keyboard shortcut, ' +
  'drag an item, or run a command.';

// Reject "plans" that are really off-target advice (watch a video, use your phone, have the user do
// it) - the exact failure mode where a non-vision or confused model answers the goal as a how-to
// question instead of a sequence of desktop actions. Legit steps like "open a browser and search"
// are NOT caught; only phone/tutorial/video/"ask the user" style content is.
function planLooksValid(steps) {
  if (!steps || !steps.length) return false;
  const bad = /(youtube|smart\s?phone|iphone|android device|mobile device|(pick up|grab|use|on|check|open .* on) (your|the|a) phone|your phone|tutorial|watch (a|an|the|this) video|video (tutorial|guide)|follow (the )?(instructions|steps) (in|from) (the |this )?video|ask the user to|have the user|instruct the user|tell the user to)/i;
  return !steps.some((s) => bad.test(String(s)));
}

// "Done" checkpoint: on a FRESH screenshot, ask whether the goal genuinely looks finished.
// Returns {complete:boolean, reason:string} or null when it couldn't get a clear answer
// (caller treats null as "accept done" - verification must never trap a run).
// Two-stage aware: when the run already proved its vision model won't emit JSON, the vision
// model only DESCRIBES the screenshot and the chat model gives the verdict from that.
async function verifyAutomationDone(cfg, goal, twoStage) {
  try {
    const shot = await captureScreen(1024, 640);
    if (!shot) return null;
    const question = 'The automation goal was: "' + goal + '". Look ONLY at this fresh screenshot of the screen RIGHT NOW. ' +
      'Does it show that goal fully accomplished? Reply with ONLY this JSON, nothing else: ' +
      '{"complete": true or false, "reason": "one short sentence of what you see that proves it"}';
    const parseVerdict = (raw) => {
      const t = String(raw || '');
      try {
        const s = t.indexOf('{'), e = t.lastIndexOf('}');
        if (s !== -1 && e > s) {
          const o = JSON.parse(t.slice(s, e + 1).replace(/,\s*([}\]])/g, '$1'));
          if (typeof o.complete === 'boolean') return { complete: o.complete, reason: String(o.reason || '') };
        }
      } catch (_e) { /* fall through */ }
      const m = /"?complete"?\s*[:=]\s*(true|false|yes|no)/i.exec(t);
      if (m) return { complete: /true|yes/i.test(m[1]), reason: '' };
      if (/^\s*(yes|complete|finished|done)\b/i.test(t)) return { complete: true, reason: '' };
      if (/^\s*(no|not)\b/i.test(t)) return { complete: false, reason: t.trim().slice(0, 160) };
      return null;
    };
    if (twoStage) {
      // vision describes -> chat judges (chat models follow the yes/no format far better)
      const v = visionCfg(cfg);
      let desc = '';
      try {
        await streamChat({
          baseUrl: v.baseUrl, apiKey: v.apiKey, model: v.model, temperature: 0,
          messages: [{ role: 'user', content: [
            { type: 'text', text: 'Describe this screenshot factually in 2-3 short sentences: which window is in front and what state things are in. No advice, no JSON.' },
            { type: 'image_url', image_url: { url: shot } }
          ] }],
          onToken: (d) => { desc += d; }
        });
      } catch (_e) { return null; }
      const c = chatCfg(cfg);
      let raw = '';
      try {
        await streamChat({
          baseUrl: c.baseUrl, apiKey: c.apiKey, model: c.model, temperature: 0,
          messages: [{ role: 'user', content: 'The automation goal was: "' + goal + '". A vision model described the CURRENT screen as: "' + desc.trim().slice(0, 900) + '". Based only on that description, is the goal fully accomplished? Reply with ONLY: {"complete": true or false, "reason": "one short sentence"}' }],
          onToken: (d) => { raw += d; }
        });
      } catch (_e) { return null; }
      return parseVerdict(raw);
    }
    const v = visionCfg(cfg);
    let raw = '';
    try {
      await streamChat({
        baseUrl: v.baseUrl, apiKey: v.apiKey, model: v.model, temperature: 0,
        messages: [{ role: 'user', content: [{ type: 'text', text: question }, { type: 'image_url', image_url: { url: shot } }] }],
        onToken: (d) => { raw += d; }
      });
    } catch (_e) { return null; }
    return parseVerdict(raw);
  } catch (_e) {
    return null;
  }
}

async function proposeAutomationPlan(cfg, goal) {
  activity.push({ kind: 'action', text: 'Looking at your screen to plan that out...', time: clockTime() });
  aiStatus = 'working';
  // REFINED: cached screenshot (same cache as the step loop, so a plan + immediate first step
  // share one capture).
  const dataUrl = await captureScreenCached();
  const sys = AUTOMATION_FRAMING + ' The user\u2019s goal: "' + goal + '". ' +
    (dataUrl ? 'A screenshot of their current screen is attached. ' : '') +
    'Propose a short, concrete plan: 2 to 6 steps, each a plain-English on-screen action YOU will perform ' +
    'on this PC (e.g. "Open the Downloads folder", "Right-click the desktop and choose Sort by"). ' +
    WINDOW_MANAGEMENT_GUIDANCE + ' ' + COMMON_WINDOWS_RECIPES + ' ' +
    'If the current screenshot does not show what the goal needs, make revealing it (per the guidance ' +
    'above) an explicit early step in the plan rather than skipping straight to acting on it. Do not ' +
    'include exact coordinates - just describe what to do; a vision model will locate each element on ' +
    'screen once this plan is approved and actually running. Each step is PLAIN English for a human to ' +
    'read - never include code, key syntax, or annotations like (hotkey \'win\') inside a step, and stay ' +
    'strictly on the stated goal (no extra tasks like changing settings or wallpapers the user never ' +
    'asked about). Do NOT describe the screenshot back to me. ' +
    'Output NOTHING except a single JSON object in exactly this shape - no prose, no code fences, no text ' +
    'before or after it: {"steps": ["step one", "step two", "step three"]}';

  // One planning attempt against a given engine/messages, with the same cold-start/rate-limit
  // retry loop used elsewhere. Returns { steps, lastRaw }.
  async function attemptPlan(engine, messages, tries) {
    let steps = [], lastRaw = '';
    for (let attempt = 0; attempt < (tries || 3) && !steps.length; attempt++) {
      let raw = '', callErr = null;
      try { await streamChat({ baseUrl: engine.baseUrl, apiKey: engine.apiKey, model: engine.model, temperature: 0.3, messages, onToken: (d) => { raw += d; } }); }
      catch (e) { callErr = e; }
      lastRaw = raw || ((callErr && callErr.message) || '');
      const parsed = parsePlanSteps(raw);
      // A well-formed but off-target plan (watch a video / use your phone / etc.) is worse than
      // none - discard it so we retry instead of surfacing nonsense for the user to approve.
      steps = planLooksValid(parsed) ? parsed : [];
      if (!steps.length && attempt < (tries || 3) - 1) {
        const errMsg = (callErr && callErr.message) || '';
        const suggested = extractRetryDelayMs(errMsg);
        if (suggested != null) await new Promise((res) => setTimeout(res, Math.max(suggested, 500)));
        else if (isRateLimitError(errMsg)) await new Promise((res) => setTimeout(res, 4000));
      }
    }
    return { steps, lastRaw };
  }

  // Attempt 1: look at the screen (if we got a screenshot) using the vision engine.
  let steps = [], lastRaw = '';
  if (dataUrl) {
    const engine = visionCfg(cfg);
    const messages = [{ role: 'user', content: [{ type: 'text', text: sys }, { type: 'image_url', image_url: { url: dataUrl } }] }];
    const r = await attemptPlan(engine, messages, 3);
    steps = r.steps; lastRaw = r.lastRaw;
  }

  // Attempt 2 (fallback): the vision model wouldn't produce a usable plan - either it can't see
  // (the configured model isn't multimodal) or it just narrates. Ask the CHAT model with text
  // only. It follows the JSON format far better; the per-step loop does the real on-screen seeing
  // later. Re-assert the framing hard here, since a text model with no image is the exact place
  // that drifts into "give the user a how-to" mode.
  if (!steps.length) {
    const textSys = sys + ' You cannot see the screen this time, so plan from the goal alone. Assume the ' +
      'needed app or view may not be in front yet and include bringing it forward (open it / press win+d ' +
      'for the desktop) as an early step. Remember: these are actions YOU will carry out on this PC by ' +
      'clicking and typing - never steps for the user to do, never a phone, video, or tutorial.';
    const r = await attemptPlan(chatCfg(cfg), [{ role: 'user', content: textSys }], 3);
    if (r.steps.length) steps = r.steps;
    if (!lastRaw) lastRaw = r.lastRaw;
  }

  aiStatus = 'idle';
  if (!steps.length) {
    // Surface whatever the model actually said (trimmed) instead of a generic dead-end -
    // if it was confused about what it was looking at, this is the clue that shows it.
    const hint = lastRaw.trim().slice(0, 140);
    const visionHint = (enginesLib.resolveEngine(cfg, 'vision') === 'online')
      ? ' If this keeps happening, your current model may not be able to see the screen - set a vision-capable model in Settings \u2192 Engines & Models (flip Vision to local with e.g. minicpm-v, or choose a multimodal cloud model).'
      : '';
    activity.push({ kind: 'action', text: '\u26A0 Could not put together a workable plan for that' + (hint ? ' - it said: "' + hint + '"' : '') + '.' + visionHint, time: clockTime() });
    return;
  }
  // Replace any still-pending plan card for the same goal instead of stacking a new card
  // under it every time - one goal, one card awaiting a decision.
  for (let i = activity.length - 1; i >= 0; i--) {
    if (activity[i].kind === 'automation_plan' && String(activity[i].goal || '').toLowerCase() === goal.toLowerCase()) activity.splice(i, 1);
  }
  const id = 'auto_' + Date.now();
  activity.push({ kind: 'automation_plan', id, goal, steps, time: clockTime() });
  const say = 'Here\u2019s my plan for that - take a look and let me know if I should go ahead.';
  mem().add('assistant', say + ' Plan: ' + steps.join('; '));
  speak(say);
}

// Phase 2 of 2: the user approved the plan. Reason -> act -> observe, one step at a time,
// checking for a stop request before every step and pausing for explicit confirmation before
// any shell command. Runs until the model says the goal is done, the user hits Stop, an action
// fails outright, or AUTOMATION_MAX_STEPS is reached (whichever comes first).
async function runAutomationLoop(goal) {
  // REFINED: lazy sidecar - if automation isn't up yet (because lazy mode skipped the eager
  // start), bring it up now. The user just approved a plan, so a few seconds of cold-start is
  // expected and acceptable; better than the old "not ready yet, try again later" dead-end.
  if (!automationReady) {
    activity.push({ kind: 'action', text: 'Starting the automation engine...', time: clockTime() });
    const up = await ensureSidecar();
    if (!up) {
      activity.push({ kind: 'action', text: '\u26A0 The automation engine couldn\u2019t start - check that Python and the packages in requirements_automation.txt are installed.', time: clockTime() });
      return;
    }
  }
  // Speaks (audible regardless of whether any BRAIN window is even visible - win+d minimizes
  // EVERYTHING, including this app's own window, so audio is the one channel that still gets
  // through) in addition to logging, for any message the user actually needs to notice: a
  // terminal stop/error, or a wait they might otherwise mistake for a hang. Routine per-step
  // progress stays visual-only on purpose - narrating every click would be exhausting to listen to.
  function announceAndStop(text) {
    activity.push({ kind: 'action', text, time: clockTime() });
    speak(text.replace(/^[^\w]+/, ''));
  }

  automationState = { active: true, goal, history: [], stopRequested: false, pendingConfirm: null, twoStage: false };
  activity.push({ kind: 'action', text: '\u25B6 Starting: ' + goal, time: clockTime() });
  speak('Starting now.');
  // Always the BUBBLE at run start (collapsing the panel if it's up), regardless of what's
  // focused right now: win+d mid-run minimizes the main window too, and the bubble is the one
  // window that reliably survives that, keeping status + a path to Stop reachable (click it to
  // expand the panel with the Stop button). Never the big panel here - it can't be minimized,
  // it covers most of the screen, and clicks aimed underneath it would land on it. See
  // showBubbleOnly for the full story.
  showBubbleOnly();
  // [OFFLINE-INTEGRATION] the per-step vision endpoint is resolved inside the loop via
  // visionCfg(cfg) (cfg is re-read each step), so a mid-run mode switch takes effect too.

  let stoppedEarly = false;
  let lastActionSig = '';        // signature of the previous step's chosen action...
  let repeatedActionCount = 0;   // ...and how many times in a row it has now been repeated
  let badActionStreak = 0;       // consecutive unusable/invalid actions (e.g. schema echoed back)
  let doneRejections = 0;        // times a premature "done" was caught and sent back to work
  let step = 0;
  for (; step < AUTOMATION_MAX_STEPS; step++) {
    if (automationState.stopRequested) { stoppedEarly = true; break; }

    const cfg = config.get();
    // REFINED: use the cached screenshot (cfg.screenshotCacheMs, default 1.5s). In a tight step
    // loop the same screen is often captured multiple times within a second (plan + verify +
    // next-step look); caching avoids redundant desktopCapturer calls + base64 encoding.
    const dataUrl = await captureScreenCached(1024, 640);
    if (!dataUrl) { announceAndStop('\u26A0 Could not capture the screen - stopping.'); break; }

    const sys = AUTOMATION_FRAMING + ' Goal: "' + goal + '". ' +
      'Steps taken so far: ' + (automationState.history.length ? JSON.stringify(automationState.history.slice(-5)) : '(none yet)') + '. ' +
      'Look at the attached CURRENT screenshot and decide the SINGLE next action, or declare the goal complete. ' +
      WINDOW_MANAGEMENT_GUIDANCE + ' ' + TARGET_PRECISION_GUIDANCE + ' ' + COMMON_WINDOWS_RECIPES + ' ' +
      'Reply with ONLY one JSON object - no other text, no code fences.\n' +
      'The "action" field MUST be exactly ONE of these words (pick one, never a list or the whole set): ' +
      'open_app, click, rightclick, doubleclick, drag, type, hotkey, scroll, shell, files, done.\n' +
      'Fields to include:\n' +
      '- "thought": one short sentence of reasoning about what you see and the next step\n' +
      '- "action": one single word from the list above\n' +
      '- "app": the application name to launch, e.g. "notepad", "chrome", "calc" (only for open_app)\n' +
      '- "target": plain-English description of the on-screen element to act on (for click/rightclick/doubleclick/drag/type)\n' +
      '- "drag_to": plain-English description of where to drop it (only for drag)\n' +
      '- "text": the text to type (only for type)\n' +
      '- "keys": a keyboard shortcut like "ctrl+s" or "win+d" (only for hotkey)\n' +
      '- "scroll_dir": "up" or "down" (only for scroll)\n' +
      '- "cmd": the exact shell command (only for shell, and only when there is genuinely no safer click/type/hotkey way)\n' +
      '- "file_op" ("list"/"read"/"write"/"move"/"rename"/"delete"), "file_path", "file_to", "file_content": only for files, paths relative to the BRAINFiles sandbox\n' +
      '- "final_answer": a short summary of what was accomplished (only for done)\n' +
      'Example of a VALID reply: {"thought":"Notepad isn\u2019t open yet, so I will launch it directly.","action":"open_app","app":"notepad"}\n' +
      'CRITICAL - launching apps: to open or start ANY application, ALWAYS use action "open_app" with its ' +
      'name in "app". NEVER try to find and click a taskbar icon, Start-menu tile, or desktop shortcut to ' +
      'launch something - open_app starts it directly and reliably, while hunting for an icon on screen is ' +
      'the single most common way this goes wrong (it clicks the wrong tile). So for "open Notepad", the ' +
      'first step is {"action":"open_app","app":"notepad"} - not pressing the Windows key, not clicking a ' +
      'search box, not clicking an icon. After the app is open, THEN use type/click/hotkey to work inside it.\n' +
      'Prefer click/type/hotkey over shell whenever the task can be done that way - shell needs the user to ' +
      'confirm every single time, so only reach for it when it is genuinely the right tool. If the last step ' +
      'in the history looks like it failed or the screen doesn\u2019t look like what you expected, say so in ' +
      '"thought" and adjust rather than repeating the same action blindly.';
    let raw = '';
    const v = visionCfg(cfg); // [OFFLINE-INTEGRATION] offline / local-vision runs step on the local model
    // A single transient hiccup (rate limit, brief network blip) shouldn't kill the whole run -
    // retry a couple of times with backoff before giving up, and when we DO give up, show the
    // real error instead of a generic message so it's actually diagnosable next time.
    // Once this run has flipped to twoStage (the vision model proved it won't produce JSON),
    // skip the direct ask entirely - re-attempting it every step just doubles the latency.
    let stepError = null;
    if (!automationState.twoStage) {
      for (let retry = 0; retry < 3; retry++) {
        if (automationState.stopRequested) { stoppedEarly = true; break; }
        raw = '';
        try {
          await streamChat({
            baseUrl: v.baseUrl, apiKey: v.apiKey, model: v.model, temperature: 0.2,
            messages: [{ role: 'user', content: [{ type: 'text', text: sys }, { type: 'image_url', image_url: { url: dataUrl } }] }],
            onToken: (d) => { raw += d; }
          });
          stepError = null;
          break;
        } catch (e) {
          const msg = (e && e.message) || String(e);
          const rateLimited = isRateLimitError(msg);
          const suggested = extractRetryDelayMs(msg);
          stepError = e;
          if (retry < 2) {
            // Honor Groq's own suggested wait and actually continue automatically once it's
            // passed - capped at the configured safety valve (default 30s, was 90s). Giving up
            // early just meant the run silently died and the user had to notice, remember, and
            // manually restart it from scratch - waiting it out and resuming on its own is what
            // actually works.
            // REFINED: when there's no suggested wait, use EXPONENTIAL backoff (1s, 2s, 4s, 8s)
            // capped at the configured ceiling instead of the old fixed 3s/1.2s/2.4s. Exponential
            // backoff is the standard pattern for rate limits - it recovers faster on transient
            // hiccups AND backs off harder on sustained limits, instead of hammering at 3s.
            const cfgCap = (config.get().automationRateLimitCapMs) || AUTOMATION_RATE_LIMIT_SANITY_CAP_MS;
            const backoffExp = Math.min(1000 * Math.pow(2, retry), cfgCap); // 1s, 2s, 4s, 8s, ...
            const wait = suggested != null
              ? Math.min(Math.max(suggested, 500), cfgCap)
              : (rateLimited ? backoffExp : 1200 * (retry + 1));
            if (rateLimited) {
              const waitText = '\u23F3 Rate limited - waiting ' + Math.ceil(wait / 1000) + 's, then continuing automatically...';
              activity.push({ kind: 'action', text: waitText, time: clockTime() });
              speak('Rate limited. Waiting about ' + Math.round(wait / 1000) + ' seconds, then I\u2019ll continue on my own.');
              maybeShowOverlay();
            }
            await new Promise((res) => setTimeout(res, wait));
          }
        }
      }
      if (stoppedEarly) break;
      if (stepError) {
        const msg = (stepError && stepError.message) || String(stepError);
        announceAndStop('\u26A0 Lost the connection mid-automation: ' + msg + ' - stopping.');
        break;
      }
    }

    // ---- Parse the step, surviving weak models instead of dying on them ----
    // 1) robust parse of whatever came back (JSON in prose, code fences, salvaged fields...)
    // 2) still nothing -> ONE corrective re-ask ("that was not the JSON; JSON only")
    // 3) still nothing -> flip this run to two-stage mode: vision model only DESCRIBES the
    //    screen, the chat model turns that + goal + history into the JSON action.
    let stepObj = automationState.twoStage ? null : parseAutomationStep(raw);
    if (!stepObj && !automationState.twoStage) {
      let raw2 = '';
      try {
        await streamChat({
          baseUrl: v.baseUrl, apiKey: v.apiKey, model: v.model, temperature: 0,
          messages: [
            { role: 'user', content: [{ type: 'text', text: sys }, { type: 'image_url', image_url: { url: dataUrl } }] },
            { role: 'assistant', content: raw.slice(0, 1500) || '(empty)' },
            { role: 'user', content: 'That was NOT the required JSON. Do not describe the screenshot. Reply again with ONLY the single JSON object in the exact schema above - nothing else.' }
          ],
          onToken: (d) => { raw2 += d; }
        });
      } catch (_e) { /* fall through to two-stage */ }
      stepObj = parseAutomationStep(raw2);
      if (!stepObj) {
        automationState.twoStage = true;
        activity.push({ kind: 'action', text: '\u26A0 The vision model won\u2019t return structured actions - switching to describe-then-decide (vision describes, chat model decides) for the rest of this run.', time: clockTime() });
      }
    }
    if (!stepObj && automationState.twoStage) {
      stepObj = await decideStepViaChatModel(cfg, goal, dataUrl, sys);
    }
    if (!stepObj || !stepObj.action) {
      announceAndStop('\u26A0 I couldn\u2019t get a valid next action from the model after several tries - stopping. (A stronger local vision model - try minicpm-v or llava:13b from Settings \u2192 AI Mode - fixes this.)');
      break;
    }

    // An action outside the schema (models sometimes invent "open"/"move", or echo the whole
    // "click|rightclick|..." option string as the value) shouldn't silently spin forever. Record
    // it so the model self-corrects and take the next step - but count consecutive failures: after
    // a few, switch to describe-then-decide (chat model follows the schema better), and if even
    // that keeps failing, stop cleanly instead of burning the whole step budget on garbage.
    stepObj.action = String(stepObj.action).toLowerCase().trim();
    if (AUTOMATION_ACTIONS.indexOf(stepObj.action) === -1) {
      badActionStreak++;
      const echoedSchema = stepObj.action.indexOf('|') !== -1 || stepObj.action.length > 24;
      const shownAction = echoedSchema ? 'the schema instead of choosing one' : ('"' + stepObj.action.slice(0, 40) + '"');
      activity.push({ kind: 'action', text: '\u26A0 The model returned ' + shownAction + ' rather than a real action - asking again.', time: clockTime() });
      automationState.history.push('INVALID action "' + stepObj.action.slice(0, 60) + '": you must set "action" to exactly ONE word from ' + AUTOMATION_ACTIONS.join(', ') + ' - not a list, not the placeholder text, just one.');
      if (badActionStreak >= 3) {
        if (!automationState.twoStage) {
          automationState.twoStage = true;
          badActionStreak = 0;
          activity.push({ kind: 'action', text: '\u26A0 Switching to describe-then-decide - the model keeps echoing the schema instead of picking an action.', time: clockTime() });
        } else {
          announceAndStop('\u25A0 The model keeps returning an invalid action instead of a real one, so I\u2019m stopping rather than looping. This usually means the current model isn\u2019t following instructions well - try a stronger model (Settings \u2192 AI Mode).');
          break;
        }
      }
      continue;
    }
    badActionStreak = 0; // a valid action clears the streak

    if (stepObj.action === 'done') {
      // ---- Trust but verify: models say "done" after one action all the time. ----
      // Take a FRESH screenshot and ask, as a separate yes/no question, whether the goal
      // actually looks complete. An explicit "no" sends the run back to work with the reason
      // in its history; an unclear/failed verification accepts done (never blocks forever).
      // Capped at 2 rejections so a verifier that's wrong can't trap the run either.
      if (doneRejections < 2) {
        const verdict = await verifyAutomationDone(cfg, goal, automationState.twoStage);
        if (verdict && verdict.complete === false) {
          doneRejections++;
          const why = (verdict.reason || 'the screen does not show the goal finished').slice(0, 160);
          activity.push({ kind: 'action', text: '\u21BB Not finished yet - ' + why + '. Continuing.', time: clockTime() });
          automationState.history.push('You declared "done" but a fresh screenshot check says the goal is NOT complete: ' + why + '. Do the next concrete action instead of stopping.');
          await new Promise((res) => setTimeout(res, 400));
          continue;
        }
      }
      const finalText = stepObj.final_answer || 'Done.';
      activity.push({ kind: 'said', text: finalText, time: clockTime() });
      mem().add('assistant', maybeStripToolResult(finalText));
      speak(finalText);
      automationState = null;
      return;
    }

    if (automationState.stopRequested) { stoppedEarly = true; break; }

    // ---- Anti-loop guard (belt-and-braces on top of the prompt guidance) ----
    // The model choosing the same exact action over and over means it is not making progress -
    // stop instead of silently burning the whole step budget on a loop. win+d additionally
    // gets its own tighter rule BEFORE execution, because it is a TOGGLE: a second press
    // UNDOES the first (all the windows come back), which is precisely how the old
    // "minimize -> still see a window -> minimize again" infinite loop happened. The first
    // repeat is intercepted (not executed) with an explanatory note the model reads back in
    // its own history next step; if it still insists on the same thing a third time, the
    // general three-strikes rule above it stops the run.
    const actionSig = [stepObj.action, stepObj.target || '', stepObj.keys || '', stepObj.text || '', stepObj.scroll_dir || '', stepObj.cmd || '', stepObj.file_op || '', stepObj.file_path || ''].join('|').toLowerCase().trim();
    if (actionSig === lastActionSig) repeatedActionCount++; else { lastActionSig = actionSig; repeatedActionCount = 0; }

    // PATCH v2: smart recovery for the #1 anti-loop trigger. The classic failure was the AI
    // repeating "rightclick 'an empty area near the top-right of the desktop, away from any
    // icons'" 3x and getting killed - even though "empty area" / "desktop" is a target the
    // engine can handle DETERMINISTICALLY (see automation.py locate_on_screen). The model
    // just kept using a long vague description instead of the exact word "desktop". So
    // before the hard stop kicks in: if the repeated target is a long-winded "empty area" /
    // "desktop" description, AUTO-SUBSTITUTE the deterministic target string "desktop" and
    // reset the loop counter, giving the run one more shot with a target that can't fail.
    // This turns "stopped after 3 identical failures" into "succeeded on the 4th try" for
    // the most common desktop-organization failure mode.
    if (repeatedActionCount >= 1 && stepObj.target) {
      const tLow = String(stepObj.target).toLowerCase();
      const isVagueDesktopish = (
        (tLow.includes('empty') && (tLow.includes('desktop') || tLow.includes('screen') || tLow.includes('area') || tLow.includes('space'))) ||
        (tLow.includes('desktop') && (tLow.includes('away') || tLow.includes('corner') || tLow.includes('spot') || tLow.includes('blank')))
      );
      if (isVagueDesktopish) {
        activity.push({ kind: 'action', text: '\u21BB Substituting the deterministic target "desktop" for the vague description "' + String(stepObj.target).slice(0, 60) + '...".', time: clockTime() });
        automationState.history.push('SUBSTITUTED target: the long description "' + String(stepObj.target).slice(0, 80) + '" was replaced with the exact word "desktop", which the engine locates deterministically (no vision model needed). Use the exact word "desktop" or "empty area" directly next time - do not write a paragraph describing where empty space might be.');
        stepObj.target = 'desktop';
        lastActionSig = [stepObj.action, stepObj.target || '', stepObj.keys || '', stepObj.text || '', stepObj.scroll_dir || '', stepObj.cmd || '', stepObj.file_op || '', stepObj.file_path || ''].join('|').toLowerCase().trim();
        repeatedActionCount = 0; // give the substituted target a fresh chance
      }
    }

    if (repeatedActionCount >= 2) {
      announceAndStop('\u25A0 I chose the exact same action three times in a row (' + stepObj.action + (stepObj.target ? ' "' + stepObj.target + '"' : '') + ') without progress, so I\u2019m stopping rather than looping. Ask me to continue if you want me to try a different way.');
      break;
    }
    const normKeys = String(stepObj.keys || '').toLowerCase().replace(/\s+/g, '');
    if (stepObj.action === 'hotkey' && (normKeys === 'win+d' || normKeys === 'windows+d') && repeatedActionCount >= 1) {
      activity.push({ kind: 'action', text: '\u26A0 Skipped a second win+d - pressing it again would bring every window back.', time: clockTime() });
      automationState.history.push('SKIPPED pressing win+d a second time: win+d is a toggle, so another press would RESTORE all the windows the first press hid. The desktop is already showing (BRAIN\u2019s own orb is excluded from your screenshots). If the goal was to reveal or clear the desktop, it is already done - reply with action "done".');
      await new Promise((res) => setTimeout(res, 300));
      continue;
    }

    if (stepObj.action === 'open_app') {
      // Launch apps deterministically via the same OS launcher the chat open_app uses - NOT by
      // finding and clicking an icon (which is how this run opened the wrong tile). No vision,
      // no permission gate (launching an app isn't mouse/keyboard scripting), just start it.
      const appName = String(stepObj.app || stepObj.target || '').trim();
      if (!appName) { automationState.history.push('open_app with no app name - skipped'); continue; }
      const r = await actions.run('open_app', { name: appName });
      if (r.ok) {
        activity.push({ kind: 'action', text: '\u2022 ' + (r.summary || ('Opened ' + appName)), time: clockTime() });
        automationState.history.push('opened app: ' + appName + ' (launched directly, not by clicking)');
        // Apps take a moment to draw their window; wait a bit longer than a normal step so the
        // NEXT screenshot shows the app ready, not a blank/loading frame.
        const settle = (config.get().automationStepSettleMs || 700) + 500;
        await new Promise((res) => setTimeout(res, Math.max(1200, settle)));
      } else {
        activity.push({ kind: 'action', text: '\u26A0 Couldn\u2019t open ' + appName + ' - ' + (r.summary || 'launch failed'), time: clockTime() });
        automationState.history.push('failed to open app "' + appName + '": ' + (r.summary || 'launch failed') + ' - try a different app name (e.g. "notepad", "chrome", "calc")');
      }
      continue;
    }

    if (stepObj.action === 'shell') {
      const cmd = String(stepObj.cmd || '').trim();
      if (!cmd) { automationState.history.push('tried to run an empty shell command - skipped'); continue; }
      const confirmId = 'autoconfirm_' + Date.now();
      activity.push({ kind: 'automation_confirm', id: confirmId, cmd, time: clockTime() });
      speak('I need you to confirm a command before I can continue.');
      popOverlayForConfirm(); // run is paused here, so the big focused panel is the right thing
      const approved = await new Promise((resolve) => { automationState.pendingConfirm = { id: confirmId, resolve }; });
      if (automationState) automationState.pendingConfirm = null;
      if (!approved) { announceAndStop('\u25A0 Shell command declined - stopping automation.'); stoppedEarly = true; break; }
      collapsePanelAfterConfirm(); // approved and continuing -> panel back down to the bubble before the next screenshot/click
      const r = await sidecarCall('/shell', { cmd, confirmed: true });
      if (r.ok) {
        activity.push({ kind: 'action', text: '\u2713 Ran: ' + cmd, time: clockTime() });
        automationState.history.push('ran shell: ' + cmd);
      } else {
        announceAndStop('\u26A0 Shell step failed: ' + (r.error || 'unknown error') + ' - stopping.');
        break;
      }
    } else if (stepObj.action === 'files') {
      const op = String(stepObj.file_op || '').trim();
      const filePath = String(stepObj.file_path || '').trim();
      if (op === 'delete') {
        // Soft-delete (see automation.py) makes this recoverable either way, but it's still
        // the one file operation that gets its own confirmation, same as shell.
        const confirmId = 'autoconfirm_' + Date.now();
        activity.push({ kind: 'automation_confirm', id: confirmId, cmd: 'Delete file: ' + filePath, time: clockTime() });
        speak('I need you to confirm a delete before I can continue.');
        popOverlayForConfirm(); // run is paused here, so the big focused panel is the right thing
        const approved = await new Promise((resolve) => { automationState.pendingConfirm = { id: confirmId, resolve }; });
        if (automationState) automationState.pendingConfirm = null;
        if (!approved) { announceAndStop('\u25A0 Delete declined - stopping automation.'); stoppedEarly = true; break; }
        collapsePanelAfterConfirm(); // approved and continuing -> panel back down to the bubble
      }
      const r = await sidecarCall('/files', { op, path: filePath, to: stepObj.file_to || '', content: stepObj.file_content || '' });
      if (r.ok) {
        activity.push({ kind: 'action', text: '\u2022 files.' + op + ': ' + filePath, time: clockTime() });
        automationState.history.push('files.' + op + ' ' + filePath + (r.trashed_as ? ' (trashed as ' + r.trashed_as + ')' : ''));
      } else {
        announceAndStop('\u26A0 File step failed: ' + (r.error || 'unknown error') + ' - stopping.');
        automationState.history.push('files.' + op + ' failed: ' + filePath + ' (' + (r.error || '') + ')');
        break;
      }
    } else {
      // REFINED: pass the new locate/verify/highlight options through to the sidecar.
      const cfgNow = config.get();
      const payload = {
        action: stepObj.action,
        target: stepObj.target || '',
        text: stepObj.text || '',
        keys: stepObj.keys || '',
        scroll_dir: stepObj.scroll_dir || 'down',
        drag_to: stepObj.drag_to || '',
        // Retry locate at a higher resolution if the first attempt at 1024 fails:
        max_width: cfgNow.visionLocateMaxWidth || 1024,
        retry_width: cfgNow.visionLocateRetryWidth || 1600,
        // Verify the click changed something on screen (catches "clicked but nothing happened"):
        verify: !!cfgNow.automationVerifyClicks,
        // Briefly highlight the target before clicking so the user sees what's about to happen:
        highlight_ms: cfgNow.automationHighlightTarget ? (cfgNow.automationHighlightMs || 450) : 0
      };
      const r = await sidecarCall('/act', payload);
      if (r.ok) {
        // REFINED: if verify was on and the click produced NO visible change, retry once with a
        // re-located target before recording success. This catches the case where the vision
        // model pointed at the wrong element (clicked but missed the actual button).
        if (cfgNow.automationVerifyClicks && r.verify === 'no_change' && cfgNow.automationPerStepRetry !== false && !stepObj._retried) {
          activity.push({ kind: 'action', text: '\u21BB That click didn\u2019t change anything - retrying once with a fresh look.', time: clockTime() });
          stepObj._retried = true;
          await new Promise((res) => setTimeout(res, 400));
          const r2 = await sidecarCall('/act', payload);
          if (r2.ok) {
            activity.push({ kind: 'action', text: '\u2022 ' + (r2.did || stepObj.action) + (r2.verify === 'no_change' ? ' (still no change)' : ''), time: clockTime() });
            automationState.history.push((r2.did || (stepObj.action + ' ' + (stepObj.target || ''))) + (r2.verify === 'no_change' ? ' [verify: still no_change]' : ''));
          } else if (/could not find/i.test(r2.error || '')) {
            activity.push({ kind: 'action', text: '\u26A0 ' + (r2.error || 'could not find that') + ' on retry.', time: clockTime() });
            automationState.history.push('missed on retry: ' + stepObj.action + ' "' + (stepObj.target || '') + '"');
            // REFINED: keyboard-nav fallback - if click can't find the target, try a Tab/Enter
            // combo for common "next button" scenarios. Only when enabled.
            if (cfgNow.automationKeyboardFallback) {
              activity.push({ kind: 'action', text: '\u2022 Trying keyboard fallback (Tab + Enter)...', time: clockTime() });
              const fb = await sidecarCall('/act', { action: 'hotkey', keys: ['enter'] });
              if (fb.ok) automationState.history.push('keyboard fallback: pressed Enter');
            }
          } else {
            announceAndStop('\u26A0 ' + (r2.error || 'that step failed') + ' - stopping.');
            break;
          }
        } else {
          activity.push({ kind: 'action', text: '\u2022 ' + (r.did || stepObj.action), time: clockTime() });
          automationState.history.push(r.did || (stepObj.action + ' ' + (stepObj.target || '')));
        }
      } else if (/could not find/i.test(r.error || '')) {
        // A missed click target isn't a reason to give up on the whole task - it's exactly the
        // kind of thing the model can see in its own history and adjust for (try a more specific
        // description, a keyboard shortcut instead, etc). Record it and keep going; the overall
        // step budget (AUTOMATION_MAX_STEPS) is what actually bounds a run that can't recover.
        activity.push({ kind: 'action', text: '\u26A0 ' + (r.error || 'could not find that') + ' - trying a different approach.', time: clockTime() });
        automationState.history.push('missed: ' + stepObj.action + ' "' + (stepObj.target || '') + '" (' + (r.error || '') + ') - try a more specific description or a different method next');
        // REFINED: keyboard fallback when the target simply can't be located.
        if (cfgNow.automationKeyboardFallback && stepObj.action === 'click') {
          const fb = await sidecarCall('/act', { action: 'hotkey', keys: ['enter'] });
          if (fb.ok) automationState.history.push('keyboard fallback (Enter) after missed click');
        }
      } else {
        announceAndStop('\u26A0 ' + (r.error || 'that step failed') + ' - stopping.');
        automationState.history.push('failed: ' + stepObj.action + ' ' + (stepObj.target || '') + ' (' + (r.error || '') + ')');
        break;
      }
    }
    // REFINED: 900ms -> 700ms default (cfg.automationStepSettleMs). Still enough for win+d /
    // window open animations on most machines; shaves dead time per step.
    await new Promise((res) => setTimeout(res, (config.get().automationStepSettleMs) || 700));
  }

  if (!stoppedEarly && step >= AUTOMATION_MAX_STEPS) {
    announceAndStop('\u25A0 Stopped after ' + AUTOMATION_MAX_STEPS + ' steps without finishing - ask me to continue if it needs more.');
  }
  automationState = null;
}

// Webcam frames live in the renderer (getUserMedia). When main needs one (e.g. the user said
// "look at me"), it asks the renderer and waits for the frame to come back.
let pendingCameraFrame = null;
function requestCameraFrame(timeoutMs = 9000) {
  return new Promise((resolve) => {
    if (!mainWindow || mainWindow.isDestroyed()) return resolve(null);
    if (pendingCameraFrame) { try { clearTimeout(pendingCameraFrame.timer); } catch (_e) {} }
    const timer = setTimeout(() => { pendingCameraFrame = null; resolve(null); }, timeoutMs);
    pendingCameraFrame = { resolve, timer };
    mainWindow.webContents.send('camera:capture');
  });
}
ipcMain.handle('camera:frame', (_e, dataUrl) => {
  if (pendingCameraFrame) {
    try { clearTimeout(pendingCameraFrame.timer); } catch (_e) {}
    const r = pendingCameraFrame.resolve; pendingCameraFrame = null;
    r(dataUrl && String(dataUrl).startsWith('data:') ? dataUrl : null);
  }
  return { ok: true };
});

// Send an image (screen OR camera) to the active vision model and stream the answer.
// Shared instruction for BOTH camera and screen vision calls. Vision models default to
// exhaustively cataloging everything in an image (headers, bullet lists, every object) unless
// told otherwise - and since these replies get read aloud by TTS, that turns a quick glance
// into a two-minute lecture. This tells the model to act like a person glancing over your
// shoulder: find what you actually asked about, answer just that, and stay brief unless you
// explicitly ask for more.
const VISION_STYLE =
  'You are looking at an image for someone whose device will read your answer OUT LOUD, so ' +
  'answer like a person glancing over their shoulder, not a written report.\n' +
  'First, work out exactly what they are asking about:\n' +
  '- If they asked about something SPECIFIC (a problem, an error, a piece of text, an object), find ' +
  'that exact thing and answer only it. Do not describe anything else in the scene.\n' +
  '- If the request is GENERAL ("what do you see", "can you see my screen"), use judgment: identify ' +
  'the single most important or most likely-relevant thing - what they are probably asking about or ' +
  'need to know - and give a brief, useful answer with just enough context. Do not itemize or list ' +
  'everything visible.\n' +
  'Default to 1-3 short spoken sentences. No markdown, headers, bold, or bullet lists - plain spoken ' +
  'text only. Only go longer, or describe multiple things, if they explicitly ask for more detail, ' +
  'a full description, everything you see, or a list.';

async function describeImageToChat(cfg, dataUrl, question) {
  const visMessages = [
    { role: 'system', content: VISION_STYLE },
    { role: 'user', content: [
      { type: 'text', text: question },
      { type: 'image_url', image_url: { url: dataUrl } }
    ] }
  ];
  const v = visionCfg(cfg); // [OFFLINE-INTEGRATION] cloud map online; local Ollama vision offline / when the toggle is on
  const ans = { kind: 'said', text: '', thinking: '', time: clockTime() };
  activity.push(ans);
  streamingEntry = ans;
  aiStatus = 'working';
  const speaker = makeSpeaker(); // speak sentences as they stream, not all at the end
  // Vision models sometimes return an EMPTY stream on a cold first call, then work fine right
  // after (same flakiness we saw on groq/compound search). Retry a couple of times before
  // ever falling back to "(no description)".
  let raw = '', rv = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    raw = '';
    ans.text = attempt ? '\u2026' : '';
    rv = await streamChat({
      baseUrl: v.baseUrl, apiKey: v.apiKey, model: v.model, temperature: cfg.temperature,
      messages: visMessages, signal: activeController ? activeController.signal : undefined,
      onToken: (d) => { raw += d; const sp = splitThinking(raw); ans.thinking = sp.thinking; ans.text = sp.answer || (sp.thinking ? '\u2026' : ''); if (sp.answer) speaker.feed(sp.answer); }
    });
    const got = (splitThinking(raw || (rv && rv.content) || '').answer || '').trim();
    if (got) break;
    if (activeController && activeController.signal && activeController.signal.aborted) break;
  }
  const sp = splitThinking(raw || (rv && rv.content) || '');
  const finalText = (sp.answer || '').trim() || '(no description)';
  ans.text = finalText;
  ans.thinking = sp.thinking;
  mem().add('assistant', maybeStripToolResult(finalText));
  speaker.feed(finalText); speaker.flush();
  return finalText;
}

// ---- 3D model from shapes (free, on-device rendering) ----
// Concisely describe the main object in a webcam frame so the builder can model it.
async function describeObjectForModel(cfg, dataUrl) {
  const q = 'Describe ONLY the main object in this image so a 3D modeler can recreate it: its overall shape, its distinct parts, rough proportions, and main colors. One concise paragraph, no preamble.';
  const v = visionCfg(cfg); // [OFFLINE-INTEGRATION]
  let raw = '';
  await streamChat({
    baseUrl: v.baseUrl, apiKey: v.apiKey, model: v.model, temperature: 0.3,
    messages: [{ role: 'user', content: [{ type: 'text', text: q }, { type: 'image_url', image_url: { url: dataUrl } }] }],
    signal: activeController ? activeController.signal : undefined,
    onToken: (d) => { raw += d; }
  });
  return (splitThinking(raw).answer || raw || '').trim();
}

// Ask the model to assemble the object from primitive shapes and return strict JSON.
const MODEL3D_PROMPT =
  'You are a 3D modeler. Build the requested object from simple 3D primitives.\n' +
  'Reply with ONLY a JSON object (no prose, no code fences). Schema:\n' +
  '{"name":"<short name>","parts":[{"shape":"box|sphere|cylinder|cone|torus","size":[..],"pos":[x,y,z],"rot":[x,y,z],"color":"#rrggbb"}]}\n' +
  'size by shape: box=[width,height,depth]; sphere=[radius]; cylinder=[radius,height]; cone=[radius,height]; torus=[radius,tube].\n' +
  'pos is the part center; rot is rotation in RADIANS (optional, default [0,0,0]); color is hex.\n' +
  'Rules: use 5 to 16 parts; keep it centered near origin and about 2-4 units tall; use realistic ' +
  'proportions and colors; assemble parts so the result clearly resembles the object ' +
  '(e.g. a chair = seat box + backrest box + 4 leg cylinders). Output ONLY the JSON.';

async function build3DStructure(cfg, description) {
  const ai = chatCfg(cfg); // [OFFLINE-INTEGRATION] 3D building runs on the active CHAT model (local in offline mode)
  let raw = '';
  await streamChat({
    baseUrl: ai.baseUrl, apiKey: ai.apiKey, model: ai.model, temperature: 0.45,
    messages: [{ role: 'system', content: MODEL3D_PROMPT }, { role: 'user', content: 'Build: ' + description }],
    signal: activeController ? activeController.signal : undefined,
    onToken: (d) => { raw += d; }
  });
  let txt = (splitThinking(raw).answer || raw || '').trim();
  txt = txt.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const s = txt.indexOf('{'), e = txt.lastIndexOf('}');
  if (s >= 0 && e > s) txt = txt.slice(s, e + 1);
  const obj = JSON.parse(txt);
  if (!obj || !Array.isArray(obj.parts) || !obj.parts.length) throw new Error('model had no parts');
  return obj;
}

// Build a model from a text description (used by the make_3d action and the camera button).
async function buildAndShowModel(cfg, description) {
  const obj = await build3DStructure(cfg, description);
  const id = 'm3d_' + Date.now();
  activity.push({ kind: 'model3d', id: id, name: obj.name || description, data: obj, time: clockTime() });
  mem().add('assistant', '[built a 3D model of: ' + (obj.name || description) + ']');
  speak('Here is your 3D model of ' + (obj.name || description) + '.');
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('model3d:show', { id: id, name: obj.name || description, data: obj });
  return id;
}

// ---- IPC: build a 3D model from a webcam frame (camera "Make 3D" button) ----
ipcMain.handle('model3d:fromImage', async (_e, dataUrl) => {
  const cfg = config.get();
  if (!dataUrl || !String(dataUrl).startsWith('data:') || !aiReady(cfg)) return { ok: false };
  activity.push({ kind: 'action', text: 'Building a 3D model of what you showed...', time: clockTime() });
  aiStatus = 'working';
  activeController = new AbortController();
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('model3d:loading', true);
  try {
    const desc = await describeObjectForModel(cfg, dataUrl);
    await buildAndShowModel(cfg, desc || 'the object shown');
    aiStatus = 'idle';
    return { ok: true };
  } catch (e) {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('model3d:loading', false);
    activity.push({ kind: 'action', text: '\u26A0 3D build failed: ' + ((e && e.message) || e), time: clockTime() });
    aiStatus = 'idle';
    return { ok: false };
  }
});

// ---- IPC: save a generated 3D model (renderer exports .glb bytes as base64) ----
ipcMain.handle('model3d:save', async (_e, name, b64) => {
  try {
    const buf = Buffer.from(String(b64 || ''), 'base64');
    if (!buf.length) return { ok: false, error: 'empty model' };
    let baseDir; try { baseDir = app.getPath('downloads'); } catch (_) { baseDir = app.getPath('home'); }
    const safe = String(name || 'model').replace(/[^a-z0-9_-]+/gi, '_').slice(0, 40) || 'model';
    const def = path.join(baseDir, 'brain-3d-' + safe + '-' + Date.now() + '.glb');
    const win = (mainWindow && !mainWindow.isDestroyed()) ? mainWindow : null;
    let target = null;
    try {
      const r = await dialog.showSaveDialog(win, { title: 'Save 3D model', defaultPath: def, filters: [{ name: 'glTF Binary', extensions: ['glb'] }] });
      if (r.canceled) return { ok: false, canceled: true };
      target = r.filePath || def;
    } catch (_d) { target = def; }
    fs.writeFileSync(target, buf);
    return { ok: true, path: target };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
});


ipcMain.handle('vision:camera', async (_e, dataUrl, question) => {
  if (!dataUrl || !String(dataUrl).startsWith('data:')) return { ok: false, error: 'no frame' };
  const cfg = config.get();
  if (!aiReady(cfg)) { activity.push({ kind: 'action', text: noAiMsg(cfg), time: clockTime() }); return { ok: false }; }
  activity.push({ kind: 'action', text: 'Looking through the camera...', time: clockTime() });
  aiStatus = 'working';
  activeController = new AbortController();
  const q = String(question || '').trim() ||
    'This is a photo from my webcam. Tell me what you see - identify any objects, people, or text clearly and naturally. Keep it concise.';
  mem().add('user', '[showed the camera something]');
  try { await describeImageToChat(cfg, dataUrl, q); aiStatus = 'idle'; return { ok: true }; }
  catch (e) { aiStatus = 'idle'; activity.push({ kind: 'action', text: '\u26A0 Camera vision failed: ' + ((e && e.message) || e), time: clockTime() }); return { ok: false }; }
});

// Resolve a speech-to-text endpoint. Only Groq and OpenAI expose /audio/transcriptions,
// so when chat is on Gemini/OpenRouter we fall back to the user's saved Groq (or OpenAI) key.
function resolveStt(cfg) {
  const pk = cfg.providerKeys || {};
  const groqKey = pk.groq || (cfg.provider === 'groq' ? cfg.apiKey : '');
  const openaiKey = pk.openai || (cfg.provider === 'openai' ? cfg.apiKey : '');
  if (groqKey) return { base: 'https://api.groq.com/openai/v1', key: groqKey, model: cfg.sttModel || 'whisper-large-v3' };
  if (openaiKey) return { base: 'https://api.openai.com/v1', key: openaiKey, model: 'whisper-1' };
  return null;
}

// [OFFLINE-INTEGRATION] Local speech-to-text: send the recorded audio to the automation
// sidecar's /transcribe endpoint (faster-whisper, fully on-device). Returns {ok, text} or
// {ok:false, error}. Used by stt:transcribe in offline mode; cloud STT is the fallback there
// only if a Groq/OpenAI key happens to be saved.
async function localTranscribe(buf, language, model) {
  try {
    const body = { audio_b64: buf.toString('base64'), language: language || 'en' };
    if (model && String(model).trim()) body.model = String(model).trim(); // '' = sidecar auto-picks tiny.en/tiny
    const res = await fetch('http://127.0.0.1:' + AUTOMATION_PORT + '/transcribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const j = await res.json().catch(() => ({}));
    if (j && j.ok) return { ok: true, text: (j.text || '').trim() };
    return { ok: false, error: (j && j.error) || ('sidecar replied ' + res.status) };
  } catch (e) {
    return { ok: false, error: 'automation sidecar unreachable: ' + ((e && e.message) || e) };
  }
}

// ---- IPC: generate the chosen-style image (called when the user taps a style button) ----
ipcMain.handle('image:generate', async (_e, id, styleKey) => {
  const idx = activity.findIndex((a) => a.kind === 'image_styles' && a.id === id);
  if (idx < 0) return { ok: false };
  const prompt = activity[idx].prompt;
  activity.splice(idx, 1); // remove the style picker
  const modifier = IMAGE_STYLES[styleKey] || '';
  activity.push({ kind: 'action', text: 'Creating the image...', time: clockTime() });
  aiStatus = 'working';
  try {
    const file = await generateImage(prompt + (modifier ? ', ' + modifier : ''));
    activity.push({ kind: 'image', src: 'brainimg://img/' + encodeURIComponent(file), text: prompt, time: clockTime() });
    activity.push({ kind: 'said', text: 'Here it is.', time: clockTime() });
    mem().add('assistant', '[generated an image of: ' + prompt + ']');
    speak('Here it is.');
    aiStatus = 'idle';
    return { ok: true };
  } catch (e) {
    // Note: image generation uses Pollinations (a free web service) in BOTH modes - it is the
    // one feature that always needs an internet connection, even in offline mode.
    activity.push({ kind: 'action', text: '\u26A0 Image failed: ' + ((e && e.message) || e), time: clockTime() });
    aiStatus = 'idle';
    return { ok: false, error: (e && e.message) || String(e) };
  }
});

// ---- IPC: save a generated image to a location the user chooses ----
ipcMain.handle('image:save', async (_e, src) => {
  try {
    const srcPath = decodeURIComponent(String(src || '').replace(/^brainimg:\/\/img\//, ''));
    if (!srcPath || !fs.existsSync(srcPath)) return { ok: false, error: 'image file not found' };
    let baseDir;
    try { baseDir = app.getPath('downloads'); } catch (_) { try { baseDir = app.getPath('pictures'); } catch (_) { baseDir = app.getPath('home'); } }
    const def = path.join(baseDir, 'brain-image-' + Date.now() + '.jpg');
    const win = (mainWindow && !mainWindow.isDestroyed()) ? mainWindow : null;
    let target = null;
    try {
      const result = await dialog.showSaveDialog(win, {
        title: 'Save image',
        defaultPath: def,
        filters: [{ name: 'JPEG image', extensions: ['jpg', 'jpeg'] }, { name: 'PNG image', extensions: ['png'] }],
        properties: ['createDirectory', 'showOverwriteConfirmation']
      });
      if (result.canceled) return { ok: false, canceled: true };
      target = result.filePath || def;
    } catch (_dlg) {
      target = def; // if the dialog can't open for any reason, fall back to Downloads
    }
    fs.copyFileSync(srcPath, target);
    return { ok: true, path: target };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
});

// ---- IPC: list installable voices ----
function piperVoicesDir() { return path.join(app.getPath('userData'), 'piper', 'voices'); }
function voiceOnnxPath(voiceId) {
  const v = VOICE_CATALOG[voiceId];
  return v ? path.join(piperVoicesDir(), v.name + '.onnx') : null;
}

ipcMain.handle('voice:list', () => {
  const cfg = config.get();
  return Object.keys(VOICE_CATALOG).map((id) => {
    const onnx = voiceOnnxPath(id);
    const downloaded = !!onnx && fs.existsSync(onnx) && fs.existsSync(onnx + '.json');
    const active = (cfg.ttsEngine === 'piper') && !!cfg.piperModel && cfg.piperModel === onnx;
    return { id, label: VOICE_CATALOG[id].label, downloaded, active };
  });
});

// ---- IPC: DOWNLOAD a voice (and the Piper engine if needed) WITHOUT switching to it ----
ipcMain.handle('voice:download', async (_e, voiceId) => {
  const v = VOICE_CATALOG[voiceId];
  if (!v) return { ok: false, error: 'Unknown voice.' };
  const base = path.join(app.getPath('userData'), 'piper');
  const voicesDir = path.join(base, 'voices');
  try {
    fs.mkdirSync(voicesDir, { recursive: true });
    const cfg = config.get();
    let piperExe = (cfg.piperPath && fs.existsSync(cfg.piperPath)) ? cfg.piperPath : findPiperExe(base);
    if (!piperExe) {
      const win = (mainWindow && !mainWindow.isDestroyed()) ? mainWindow : null;
      const ask = await dialog.showMessageBox(win, {
        type: 'question', buttons: ['Download', 'Cancel'], defaultId: 0, cancelId: 1, noLink: true,
        title: 'Caryl.ai', message: 'Download the natural-voice engine?',
        detail: 'First-time setup downloads the Piper voice engine (about 25 MB). After this, switching voices is instant.'
      });
      if (ask.response !== 0) { voiceProgress(''); return { ok: false, canceled: true }; }
      voiceProgress('Downloading the Piper engine (one time)...');
      const zip = path.join(base, 'piper.zip');
      await downloadFile(PIPER_WIN_URL, zip);
      voiceProgress('Unpacking the Piper engine...');
      await extractZip(zip, base);
      try { fs.unlinkSync(zip); } catch (_e) {}
      piperExe = findPiperExe(base);
      if (!piperExe) throw new Error('Piper engine did not unpack correctly.');
    }
    // Remember where the engine lives so "Use" works later - but DON'T switch TTS to it.
    if (piperExe && piperExe !== cfg.piperPath) config.set({ piperPath: piperExe });
    const onnx = path.join(voicesDir, v.name + '.onnx');
    if (!fs.existsSync(onnx)) {
      voiceProgress('Downloading the ' + v.label + ' voice...');
      await downloadFile(VOICE_BASE + '/' + v.dir + '/' + v.name + '.onnx', onnx);
    }
    if (!fs.existsSync(onnx + '.json')) {
      voiceProgress('Finishing up...');
      await downloadFile(VOICE_BASE + '/' + v.dir + '/' + v.name + '.onnx.json', onnx + '.json');
    }
    voiceProgress('');
    return { ok: true };
  } catch (e) {
    voiceProgress('');
    return { ok: false, error: (e && e.message) || String(e) };
  }
});

// ---- IPC: USE an already-downloaded voice (switch TTS to it) ----
ipcMain.handle('voice:use', async (_e, voiceId) => {
  const v = VOICE_CATALOG[voiceId];
  if (!v) return { ok: false, error: 'Unknown voice.' };
  const base = path.join(app.getPath('userData'), 'piper');
  const onnx = path.join(base, 'voices', v.name + '.onnx');
  if (!fs.existsSync(onnx) || !fs.existsSync(onnx + '.json')) {
    return { ok: false, error: 'Download this voice first.' };
  }
  const cfg = config.get();
  let piperExe = (cfg.piperPath && fs.existsSync(cfg.piperPath)) ? cfg.piperPath : findPiperExe(base);
  if (!piperExe) return { ok: false, error: 'Piper engine missing - download a voice first.' };
  config.set({ ttsEngine: 'piper', tts_enabled: true, piperPath: piperExe, piperModel: onnx, engines: Object.assign({}, enginesLib.normalizeEngines(config.get()).engines, { tts: 'offline' }) });
  speak('This is how I sound now.');
  return { ok: true };
});

// ---- IPC: one-click install (download Piper if needed + the voice, then configure) ----
ipcMain.handle('voice:install', async (_e, voiceId) => {
  const v = VOICE_CATALOG[voiceId];
  if (!v) return { ok: false, error: 'Unknown voice.' };
  const base = path.join(app.getPath('userData'), 'piper');
  const voicesDir = path.join(base, 'voices');
  try {
    fs.mkdirSync(voicesDir, { recursive: true });
    const cfg = config.get();
    // 1. Ensure the Piper program exists (reuse an existing one if already set up).
    let piperExe = (cfg.piperPath && fs.existsSync(cfg.piperPath)) ? cfg.piperPath : findPiperExe(base);
    if (!piperExe) {
      voiceProgress('Downloading the Piper engine (one time)...');
      const zip = path.join(base, 'piper.zip');
      await downloadFile(PIPER_WIN_URL, zip);
      voiceProgress('Unpacking the Piper engine...');
      await extractZip(zip, base);
      try { fs.unlinkSync(zip); } catch (_e) {}
      piperExe = findPiperExe(base);
      if (!piperExe) throw new Error('Piper engine did not unpack correctly.');
    }
    // 2. Download the voice (both files) if not already present.
    const onnx = path.join(voicesDir, v.name + '.onnx');
    if (!fs.existsSync(onnx)) {
      voiceProgress('Downloading the ' + v.label + ' voice...');
      await downloadFile(VOICE_BASE + '/' + v.dir + '/' + v.name + '.onnx', onnx);
    }
    if (!fs.existsSync(onnx + '.json')) {
      voiceProgress('Finishing up...');
      await downloadFile(VOICE_BASE + '/' + v.dir + '/' + v.name + '.onnx.json', onnx + '.json');
    }
    // 3. Configure automatically (the user never touches paths).
    config.set({ ttsEngine: 'piper', tts_enabled: true, piperPath: piperExe, piperModel: onnx, engines: Object.assign({}, enginesLib.normalizeEngines(config.get()).engines, { tts: 'offline' }) });
    voiceProgress('');
    speak('Voice installed. This is how I sound now.');
    return { ok: true };
  } catch (e) {
    voiceProgress('');
    return { ok: false, error: (e && e.message) || String(e) };
  }
});

// ---- IPC: test the configured voice, returning a precise reason if it fails ----
ipcMain.handle('tts:test', async () => {
  const cfg = config.get();
  if ((cfg.ttsEngine || 'browser') !== 'piper') {
    speak('Voice test. This is the built in voice.');
    return { ok: true, engine: 'browser' };
  }
  if (!cfg.piperPath) return { ok: false, error: 'The "Piper executable path" box is empty. Put the full path to piper.exe there.' };
  if (!cfg.piperModel) return { ok: false, error: 'The "Piper voice model" box is empty. Put the full path to the .onnx file there.' };
  if (!fs.existsSync(cfg.piperPath)) return { ok: false, error: 'piper.exe not found at: ' + cfg.piperPath };
  if (!fs.existsSync(cfg.piperModel)) return { ok: false, error: 'Voice model not found at: ' + cfg.piperModel + '  (check the path + filename)' };
  if (!fs.existsSync(cfg.piperModel + '.json')) return { ok: false, error: 'Config file missing: ' + cfg.piperModel + '.json  (the .onnx.json must sit in the same folder as the .onnx)' };
  try {
    const wav = await piperSynth('Piper voice test. One, two, three.', cfg);
    if (wav && wav.length && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('tts:audio', wav.buffer.slice(wav.byteOffset, wav.byteOffset + wav.byteLength));
      return { ok: true, engine: 'piper' };
    }
    return { ok: false, error: 'Piper ran but produced no audio.' };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
});

// ---- IPC: speech-to-text (audio -> VAD -> Whisper -> transcript) ----
// REFINED: the "random words from mic" fix. Before sending ANY audio to Whisper (local or
// cloud), we run a server-side VAD check via the sidecar's /vad endpoint. Clips that are
// silence, background noise, or shorter than the minimum speech duration are dropped with
// {ok:true, text:''} (NOT an error) so the renderer just discards them silently. Only audio
// that passes VAD reaches Whisper - which eliminates ~95% of the hallucinated "thank you" /
// "you" / lone-period outputs at the source.
//
// If the sidecar isn't running yet, we lazily start it (lazySidecar config) on the first
// voice input. If /vad itself fails (older sidecar without the endpoint, or PyAV missing),
// we gracefully fall back to sending the audio straight to Whisper - the existing
// anti-hallucination regex in automation.py is still the last line of defense.
ipcMain.handle('stt:transcribe', async (_e, arrayBuffer) => {
  const cfg = config.get();
  const lang = (cfg.sttLanguage || 'en').trim();
  const buf = Buffer.from(arrayBuffer);

  // REFINED: pre-Whisper VAD gate. Drop garbage before it ever reaches a model.
  if (cfg.vadEnabled !== false) {
    try {
      // Make sure the sidecar is up (lazy start if needed).
      if (!automationReady && cfg.lazySidecar !== false) await ensureSidecar();
      if (automationReady) {
        const vadRes = await fetch('http://127.0.0.1:' + AUTOMATION_PORT + '/vad', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            audio_b64: buf.toString('base64'),
            min_speech_ms: cfg.vadMinSpeechMs || 450,
            energy_floor_db: cfg.vadEnergyFloorDb || -45,
            max_silence_pad_ms: cfg.vadMaxSilencePadMs || 300
          })
        });
        if (vadRes.ok) {
          const v = await vadRes.json().catch(() => null);
          if (v && v.ok && v.has_speech === false) {
            // Silence / noise / too short - drop silently. This is the fix.
            console.log('[vad] dropped clip:', v.reason, '(rms=' + v.rms_db + 'dB, ' + v.duration_ms + 'ms)');
            return { ok: true, text: '', vad_dropped: true, vad_reason: v.reason };
          }
        }
      }
    } catch (_e) { /* VAD unavailable - fall through to Whisper with the raw audio */ }
  }

  // Pick the whisper model: explicit user override > RAM-based auto-pick.
  const whisperModel = (cfg.offlineSttModel || '').trim() || (cfg.whisperAutoPickByRam !== false ? autoWhisperModel() : '');

  // [OFFLINE-INTEGRATION] use local whisper when the whole app is offline OR the user turned on
  // "local voice input" for online mode.
  if (enginesLib.resolveEngine(cfg, 'stt') === 'offline') {
    let localErr = '';
    try {
      const local = await localTranscribe(buf, lang, whisperModel);
      if (local.ok) return local;
      localErr = local.error || 'unknown local STT error';
    } catch (e) {
      localErr = (e && e.message) || String(e);
    }
    if (!resolveStt(cfg)) {
      return {
        ok: false,
        error: 'Local voice input isn\u2019t ready (' + localErr + '). Fix: install faster-whisper for the sidecar\u2019s Python - ' +
          '.venv\\Scripts\\python.exe -m pip install faster-whisper - then restart Caryl. (Or save a free Groq key in Settings to use cloud voice as a fallback.)'
      };
    }
    // fall through to the cloud path below with the saved key
  }
  const stt = resolveStt(cfg);
  if (!stt) return { ok: false, error: 'Voice needs a free Groq key (or an OpenAI key). Add one in Settings -> AI Engine.' };
  try {
    const form = new FormData();
    form.append('file', new Blob([buf], { type: 'audio/webm' }), 'audio.webm');
    form.append('model', stt.model);
    if (lang && lang.toLowerCase() !== 'auto') form.append('language', lang); // stop wrong-language guesses
    const res = await fetch(joinUrl(stt.base, '/audio/transcriptions'), {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + stt.key },
      body: form
    });
    if (!res.ok) {
      let d = '';
      try { d = (await res.json()).error.message; } catch (_x) {}
      throw new Error('STT ' + res.status + (d ? ': ' + d : ''));
    }
    const j = await res.json();
    return { ok: true, text: (j.text || '').trim() };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
});

// ===================== Local wake word (openWakeWord) =====================
// Free, open-source, on-device "Hey Jarvis" detection. The three small ONNX models are
// downloaded once into userData; the renderer runs them via onnxruntime-web (loaded from CDN),
// so there's no native dependency and the portable build stays clean.
function wakewordDir() { return path.join(app.getPath('userData'), 'openwakeword'); }
const WAKEWORD_MODELS = {
  'melspectrogram.onnx': 'https://github.com/dscripka/openWakeWord/releases/download/v0.5.1/melspectrogram.onnx',
  'embedding_model.onnx': 'https://github.com/dscripka/openWakeWord/releases/download/v0.5.1/embedding_model.onnx',
  'hey_jarvis_v0.1.onnx': 'https://github.com/dscripka/openWakeWord/releases/download/v0.5.1/hey_jarvis_v0.1.onnx'
};

// Ensure the model files exist locally (download any that are missing). Reports progress.
ipcMain.handle('wakeword:ensure', async () => {
  const dir = wakewordDir();
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_e) {}
  const send = (msg) => { try { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('wakeword:progress', msg); } catch (_e) {} };
  try {
    const names = Object.keys(WAKEWORD_MODELS);
    for (let i = 0; i < names.length; i++) {
      const name = names[i];
      const dest = path.join(dir, name);
      if (fs.existsSync(dest) && fs.statSync(dest).size > 1000) continue; // already have it
      send('Downloading wake-word model ' + (i + 1) + ' of ' + names.length + '\u2026');
      await downloadFile(WAKEWORD_MODELS[name], dest);
    }
    send('');
    return { ok: true, dir };
  } catch (e) {
    send('');
    return { ok: false, error: (e && e.message) || String(e) };
  }
});

// Hand the renderer the raw bytes of a downloaded model so onnxruntime-web can build a session.
ipcMain.handle('wakeword:model', async (_e, name) => {
  if (!Object.prototype.hasOwnProperty.call(WAKEWORD_MODELS, name)) return { ok: false, error: 'unknown model' };
  try {
    const p = path.join(wakewordDir(), name);
    if (!fs.existsSync(p)) return { ok: false, error: 'model not downloaded' };
    const buf = fs.readFileSync(p);
    // return an ArrayBuffer slice so it transfers cleanly to the renderer
    return { ok: true, bytes: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
});


// A separate frameless, semi-transparent, always-on-top window that surfaces BRAIN's replies
// when the main app isn't focused. Click off it -> it shrinks to a draggable thumb bubble (its
// own separate window, mini-overlay.html); click the bubble -> the panel comes back at the same
// spot. TTS keeps playing from the main window (audio plays regardless of focus), so the panel
// only needs to show text + take input.
// Windows 11 (22H2+) gets a REAL native blur-behind via DWM's Acrylic material here - this is
// what actually blurs your live desktop/other windows, which plain CSS backdrop-filter cannot
// do from inside a transparent Electron window. Set ONCE at creation and never toggled off:
// the earlier version toggled it acrylic->none every time this window shrank to bubble size,
// and THAT toggle sequence is what left a residual light-square redraw artifact behind. Now
// that the bubble is a fully separate window, the panel never resizes to bubble dimensions at
// all, so there's no more off-toggle to trigger it. Purely additive: unsupported OS/build just
// silently keeps the plain CSS tint+blur you already have - never worse than before.
// A saved position from a previous session might be off-screen now (a monitor got
// unplugged, resolution changed, etc.) - only trust it if it's still genuinely reachable.
function isOnScreen(x, y, w, h) {
  try {
    return screen.getAllDisplays().some((d) => {
      const wa = d.workArea;
      return x + w > wa.x + 20 && x < wa.x + wa.width - 20 && y + h > wa.y + 20 && y < wa.y + wa.height - 20;
    });
  } catch (_e) { return false; }
}

function createOverlay() {
  if (overlayWindow && !overlayWindow.isDestroyed()) return overlayWindow;
  const disp = screen.getPrimaryDisplay();
  const wa = disp.workArea; // {x,y,width,height} excluding taskbar
  const defW = Math.round(wa.width * 0.65);
  const defH = Math.round(wa.height * 0.65);
  const defX = wa.x + Math.round((wa.width - defW) / 2);
  const defY = wa.y + Math.round((wa.height - defH) / 2);
  if (!overlayExpandedBounds) {
    const cfg = config.get();
    const saved = cfg.overlayPanelBounds;
    overlayExpandedBounds = (saved && isOnScreen(saved.x, saved.y, saved.width, saved.height))
      ? saved
      : { x: defX, y: defY, width: defW, height: defH };
  }
  const { x, y, width: w, height: h } = overlayExpandedBounds;

  overlayWindow = new BrowserWindow({
    x, y, width: w, height: h,
    frame: false, transparent: true, hasShadow: false, resizable: false, roundedCorners: false, // sharp on purpose - see CSS
    skipTaskbar: true, alwaysOnTop: true, show: false, fullscreenable: false,
    backgroundColor: '#00000000',
    backgroundMaterial: (process.platform === 'win32' && shellStyle().blur) ? 'acrylic' : undefined, // Win11 22H2+ only; Win10 renders solid via CSS data-os fallback
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: false,
      backgroundThrottling: false
    }
  });
  overlayWindow.setAlwaysOnTop(true, 'screen-saver');
  // Exclude this window from ALL screen capture - both desktopCapturer in this process (the
  // automation step loop + see_screen) and the sidecar's own pyautogui screenshots. On
  // Windows 10 2004+ this sets WDA_EXCLUDEFROMCAPTURE, which removes the window from captures
  // entirely (what's behind it shows instead). Without this, the automation vision model SEES
  // BRAIN's own always-on-top panel sitting over the desktop, concludes the desktop "isn't
  // visible yet", and presses win+d again - and since win+d is a TOGGLE, that second press
  // RESTORES every window the first press hid, which is exactly the infinite
  // minimize -> "still see a window" -> minimize loop this fixes. It also keeps the overlay
  // out of see_screen answers, where a mystery panel was never meant to appear.
  try { overlayWindow.setContentProtection(true); } catch (_e) { /* older Windows: worst case it captures as a black box */ }
  overlayWindow.loadFile(path.join(__dirname, 'renderer', 'overlay.html'));

  // Click off the expanded panel -> collapse to the bubble (unless a dialog is open).
  overlayWindow.on('blur', () => {
    if (overlayIgnoreBlur) return;
    if (overlayMode === 'expanded' && overlayWindow.isVisible()) collapseOverlay();
  });
  // Remember wherever it ends up - native title-bar drag, or our own repositioning - so it
  // reopens in the same spot next time, even across restarts.
  overlayWindow.on('moved', () => {
    overlayExpandedBounds = overlayWindow.getBounds();
    config.set({ overlayPanelBounds: overlayExpandedBounds });
  });
  overlayWindow.on('closed', () => { overlayWindow = null; });
  return overlayWindow;
}

// The bubble: its own small window, own file (mini-overlay.html), own styling, NO
// backgroundMaterial at all. Never resized between two identities, never shares a document
// with the panel - so it's always exactly the solid, opaque orb it's meant to be, independent
// of whatever the panel is doing. (Acrylic on a window this small would also just show a
// rectangular blur patch bleeding past the circular CSS orb - not wanted here either way.)
function createMiniOverlay() {
  if (miniOverlayWindow && !miniOverlayWindow.isDestroyed()) return miniOverlayWindow;
  if (!overlayBubblePos) {
    const cfg = config.get();
    const saved = cfg.overlayBubblePos;
    if (saved && isOnScreen(saved.x, saved.y, OVERLAY_BUBBLE, OVERLAY_BUBBLE)) overlayBubblePos = saved;
  }
  const startPos = overlayBubblePos || { x: 100, y: 100 }; // real position set in collapseOverlay() before it's ever shown anyway
  miniOverlayWindow = new BrowserWindow({
    x: startPos.x, y: startPos.y, width: OVERLAY_BUBBLE, height: OVERLAY_BUBBLE,
    frame: false, transparent: true, hasShadow: false, resizable: false, roundedCorners: false,
    skipTaskbar: true, alwaysOnTop: true, show: false, fullscreenable: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: false,
      backgroundThrottling: false
    }
  });
  miniOverlayWindow.setAlwaysOnTop(true, 'screen-saver');
  // Same capture exclusion as the panel (see createOverlay): the bubble stays on top through
  // win+d, so without this it shows up in every automation screenshot as an unexplained orb.
  try { miniOverlayWindow.setContentProtection(true); } catch (_e) {}
  miniOverlayWindow.loadFile(path.join(__dirname, 'renderer', 'mini-overlay.html'));
  // Remember wherever it ends up - dragging it, or our own repositioning - so it reopens in
  // the same spot next time, even across restarts, independent of where the panel now sits.
  miniOverlayWindow.on('moved', () => {
    const [px, py] = miniOverlayWindow.getPosition();
    overlayBubblePos = { x: px, y: py };
    config.set({ overlayBubblePos });
  });
  miniOverlayWindow.on('closed', () => { miniOverlayWindow = null; });
  return miniOverlayWindow;
}

function showOverlay() {
  const win = createOverlay();
  if (!win) return;
  const wasHidden = !win.isVisible() && (!miniOverlayWindow || !miniOverlayWindow.isVisible()); // a fresh pop-up, not just re-expanding from the bubble
  if (wasHidden) overlayThreadStart = Math.max(0, activity.length - 1); // start its mini-thread at the question that triggered it
  if (miniOverlayWindow && !miniOverlayWindow.isDestroyed()) miniOverlayWindow.hide();
  overlayMode = 'expanded';
  if (overlayExpandedBounds) win.setBounds(overlayExpandedBounds);
  win.setAlwaysOnTop(true, 'screen-saver');
  win.showInactive(); // appear on top WITHOUT stealing focus from whatever app you're in
}

function collapseOverlay() {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  overlayExpandedBounds = overlayWindow.getBounds(); // remember where to expand back to
  overlayMode = 'bubble';
  overlayWindow.hide();
  const mini = createMiniOverlay();
  const b = overlayExpandedBounds;
  // Use wherever the bubble was last left (a previous drag, or a past session) - only fall
  // back to "just off the panel's corner" the very first time this has ever happened.
  const pos = overlayBubblePos || { x: b.x + 24, y: b.y + 24 };
  mini.setBounds({ x: pos.x, y: pos.y, width: OVERLAY_BUBBLE, height: OVERLAY_BUBBLE });
  mini.setAlwaysOnTop(true, 'screen-saver');
  mini.showInactive();
}

function expandOverlay() {
  if (miniOverlayWindow && !miniOverlayWindow.isDestroyed()) miniOverlayWindow.hide();
  overlayMode = 'expanded';
  const win = createOverlay();
  if (overlayExpandedBounds) win.setBounds(overlayExpandedBounds);
  win.show();
  win.focus();
}

// Pop the overlay up when BRAIN answers while the main window isn't the focused app.
// Pop the panel up when BRAIN answers while the main window isn't focused - but only as the
// very first thing that happens. Once the bubble (or the panel) is already sitting there, later
// questions should NOT re-pop the panel every single time - the bubble already reacts on its
// own (its status poll drives the ring animation), so popping the panel too would be a jarring
// re-interruption for every message. Only a fully-closed overlay (both windows hidden - i.e.
// you explicitly hid it) counts as a fresh trigger again.
function maybeShowOverlay() {
  try {
    const mainFocused = mainWindow && !mainWindow.isDestroyed() && mainWindow.isFocused();
    if (mainFocused) return;
    const bubbleVisible = miniOverlayWindow && !miniOverlayWindow.isDestroyed() && miniOverlayWindow.isVisible();
    const panelVisible = overlayWindow && !overlayWindow.isDestroyed() && overlayWindow.isVisible();
    if (bubbleVisible || panelVisible) return; // already present in some form - let it react in place
    // Mid-automation, never auto-pop the big panel (see showBubbleOnly for why) - only the bubble.
    if (automationState && automationState.active) { showBubbleOnly(); return; }
    showOverlay(); // fully closed -> this is a fresh trigger
  } catch (_e) { /* ignore */ }
}

// ---- Automation HUD ----
// While an automation plan is executing, the big expanded PANEL must never be the thing
// floating over the screen: it covers ~65% of the display, it is always-on-top so win+d
// can't get rid of it, and (being a real window) a click the sidecar aims at something
// underneath it would land ON it. During a run we therefore only ever auto-show the small
// BUBBLE: it survives win+d (so status + a path to Stop stays reachable even after
// everything else is hidden - click it to expand the panel with the Stop button), it's tiny,
// and like the panel it's excluded from screenshots via content protection. The full panel
// is auto-popped only while the run is PAUSED waiting on an explicit user confirmation, and
// collapsed back down to the bubble the moment that confirmation is answered.
function showBubbleOnly() {
  try {
    const bubbleVisible = miniOverlayWindow && !miniOverlayWindow.isDestroyed() && miniOverlayWindow.isVisible();
    if (bubbleVisible) return;
    const panelVisible = overlayWindow && !overlayWindow.isDestroyed() && overlayWindow.isVisible();
    if (panelVisible) { collapseOverlay(); return; } // collapseOverlay remembers bounds + shows the bubble itself
    overlayThreadStart = Math.max(0, activity.length - 1); // fresh popup -> scope its mini-thread to this run
    const mini = createMiniOverlay();
    const wa = screen.getPrimaryDisplay().workArea;
    // Wherever the user last left the bubble; bottom-right corner the very first time ever.
    const pos = overlayBubblePos || { x: wa.x + wa.width - OVERLAY_BUBBLE - 24, y: wa.y + wa.height - OVERLAY_BUBBLE - 24 };
    mini.setBounds({ x: pos.x, y: pos.y, width: OVERLAY_BUBBLE, height: OVERLAY_BUBBLE });
    overlayMode = 'bubble';
    mini.setAlwaysOnTop(true, 'screen-saver');
    mini.showInactive();
  } catch (_e) { /* ignore */ }
}

// Pop the focused PANEL for a blocking confirmation (shell command / file delete). The run is
// paused on a promise at that moment, so a big focused window is exactly right - the user has
// to read the command text and click Run/Cancel. No-op when the main window is focused (the
// confirm card is already visible right there in the chat).
function popOverlayForConfirm() {
  try {
    const mainFocused = mainWindow && !mainWindow.isDestroyed() && mainWindow.isFocused();
    if (mainFocused) return;
    const bubbleVisible = miniOverlayWindow && !miniOverlayWindow.isDestroyed() && miniOverlayWindow.isVisible();
    const panelVisible = overlayWindow && !overlayWindow.isDestroyed() && overlayWindow.isVisible();
    if (panelVisible) return; // already up (user expanded it themselves) - the card renders there
    if (!bubbleVisible) overlayThreadStart = Math.max(0, activity.length - 1);
    expandOverlay(); // shows + focuses the panel (and hides the bubble)
  } catch (_e) { /* ignore */ }
}

// After a confirmation is answered and the run CONTINUES, get the big panel back out of the
// way (down to the bubble) before the next screenshot/click - see showBubbleOnly for why the
// panel must not sit over the screen mid-run. If the run stops instead, the panel is left up
// on purpose so the user can read the stop/decline message.
function collapsePanelAfterConfirm() {
  try {
    if (overlayWindow && !overlayWindow.isDestroyed() && overlayWindow.isVisible()) collapseOverlay();
  } catch (_e) { /* ignore */ }
}

ipcMain.handle('overlay:expand', () => {
  if (automationState && automationState.active) {
    // Mid-run: show the panel WITHOUT taking focus. A click on the bubble - whether from the
    // user or a stray automated click that happened to land on it - must not yank keyboard
    // focus away from whatever the automation is typing into. (Clicking the panel's own Stop
    // button afterwards focuses it naturally, which is fine: the user did that on purpose.)
    try {
      if (miniOverlayWindow && !miniOverlayWindow.isDestroyed()) miniOverlayWindow.hide();
      overlayMode = 'expanded';
      const win = createOverlay();
      if (overlayExpandedBounds) win.setBounds(overlayExpandedBounds);
      win.setAlwaysOnTop(true, 'screen-saver');
      win.showInactive();
    } catch (_e) { /* ignore */ }
    return { ok: true };
  }
  expandOverlay();
  return { ok: true };
});
ipcMain.handle('overlay:collapse', () => { collapseOverlay(); return { ok: true }; });
ipcMain.handle('overlay:hide', () => {
  if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.hide();
  if (miniOverlayWindow && !miniOverlayWindow.isDestroyed()) miniOverlayWindow.hide();
  return { ok: true };
});
let bubbleSaveTimer = null;
ipcMain.handle('overlay:moveBy', (event, dx, dy) => {
  // Move whichever window actually sent this (in practice always the bubble - the panel moves
  // via native OS drag on its title bar, not this IPC path) rather than assuming which one.
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || win.isDestroyed()) return { ok: false };
  const [x, y] = win.getPosition();
  win.setPosition(Math.round(x + (dx || 0)), Math.round(y + (dy || 0)));
  // Programmatic setPosition never fires 'moved' on Windows (that event needs a native
  // WM_EXITSIZEMOVE, which only title-bar drags produce) - so THIS is where the bubble's
  // position must be remembered. Debounced: one disk write per drag, not per pixel.
  if (miniOverlayWindow && !miniOverlayWindow.isDestroyed() && win === miniOverlayWindow) {
    const [px, py] = win.getPosition();
    overlayBubblePos = { x: px, y: py };
    clearTimeout(bubbleSaveTimer);
    bubbleSaveTimer = setTimeout(() => config.set({ overlayBubblePos }), 400);
  }
  return { ok: true };
});
// The overlay's own scoped view: only the question that triggered it, plus whatever's
// happened since - not the whole session's history. overlayThreadStart is set once per
// fresh pop-up (see showOverlay()) and stays put through bubble<->panel transitions.
ipcMain.handle('overlay:activity', () => ({ activity: activity.slice(overlayThreadStart) }));

// ===================== Document import + reading =====================
// Pull plain text out of a file. Text-like formats are read natively (zero deps). PDF uses
// pdfjs-dist IF it's installed (`npm install pdfjs-dist`); otherwise we say so clearly.
async function extractDocText(file) {
  const ext = path.extname(file).toLowerCase();
  const TEXTY = ['.txt', '.md', '.markdown', '.csv', '.tsv', '.json', '.log', '.rtf', '.js', '.ts', '.py', '.html', '.css', '.xml', '.yml', '.yaml'];
  if (TEXTY.indexOf(ext) !== -1) {
    return fs.readFileSync(file, 'utf8');
  }
  if (ext === '.pdf') {
    let pdfjs;
    try { pdfjs = require('pdfjs-dist/legacy/build/pdf.js'); }
    catch (_e) {
      if (_e && _e.code === 'MODULE_NOT_FOUND') {
        throw new Error('PDF support needs one quick install: run  npm install pdfjs-dist  in the project folder, then try again. (Text files like .txt/.md/.csv work right now.)');
      }
      // It IS installed but failed to load - surface the REAL reason instead of the generic
      // "please install" message, which is misleading once it's already installed. Common
      // cause: newer pdfjs-dist releases moved to a pure-ESM structure this CommonJS
      // require() can't load - if so, pin an older version: npm install pdfjs-dist@3.11.174
      throw new Error('PDF support is installed but failed to load (' + ((_e && _e.message) || _e) + '). Text files like .txt/.md/.csv work right now.');
    }
    const data = new Uint8Array(fs.readFileSync(file));
    const doc = await pdfjs.getDocument({ data, disableWorker: true }).promise;
    let out = '';
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const content = await page.getTextContent();
      out += content.items.map((it) => it.str).join(' ') + '\n\n';
    }
    return out;
  }
  throw new Error('Unsupported file type "' + ext + '". Supported now: text files (.txt, .md, .csv, .json, code) and .pdf (after installing pdfjs-dist).');
}

// Summarize an imported document, streaming + speaking like any other reply.
async function summarizeDocument(name, text) {
  const cfg = config.get();
  if (!aiReady(cfg)) { activity.push({ kind: 'action', text: noAiMsg(cfg), time: clockTime() }); return; }
  const ai = chatCfg(cfg); // [OFFLINE-INTEGRATION] summaries run on the active chat model (local in offline mode)
  const clipped = String(text || '').slice(0, 24000); // keep within the model's context window
  lastDocument = { name: name, text: clipped };        // remember for follow-up questions
  mem().add('user', '[Imported document: ' + name + ']');
  activity.push({ kind: 'heard', text: '\uD83D\uDCC4 Imported: ' + name, time: clockTime() });
  const ans = { kind: 'said', text: '', thinking: '', time: clockTime() };
  activity.push(ans); streamingEntry = ans; aiStatus = 'working';
  activeController = new AbortController();
  const sp = makeSpeaker();
  let raw = '';
  const sys = 'You are ' + (config.get().assistantName || 'Caryl') + '. The user just imported a document called "' + name + '". Give a clear, concise spoken-style summary (no markdown, no bullet symbols), then invite them to ask questions about it.';
  try {
    await streamChat({
      baseUrl: ai.baseUrl, apiKey: ai.apiKey, model: ai.model, temperature: cfg.temperature,
      messages: [{ role: 'system', content: sys }, { role: 'user', content: 'Here is the document:\n\n' + clipped }],
      signal: activeController.signal,
      onToken: (d) => { raw += d; const s = splitThinking(raw); ans.thinking = s.thinking; ans.text = s.answer || (s.thinking ? '\u2026' : ''); if (s.answer) sp.feed(s.answer); }
    });
    const s = splitThinking(raw);
    const finalText = (s.answer || '').trim() || 'I imported it but could not produce a summary.';
    ans.text = finalText; ans.thinking = s.thinking;
    mem().add('assistant', maybeStripToolResult(finalText));
    sp.feed(finalText); sp.flush();
  } catch (e) {
    if (!(e && e.name === 'AbortError')) { ans.kind = 'action'; ans.text = '\u26A0 ' + ((e && e.message) || e); }
  } finally { aiStatus = 'idle'; streamingEntry = null; activeController = null; }
}

// Shared by both the dialog-based Import button AND drag-and-drop onto the overlay.
async function importFilePath(file) {
  try {
    const text = await extractDocText(file);
    if (!text || !text.trim()) return { ok: false, error: 'No readable text found in that file.' };
    summarizeDocument(path.basename(file), text); // streams the summary into the thread + speaks it
    return { ok: true, name: path.basename(file) };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
}

// Give the assistant a name: saves it, and actually confirms it back in the chat + out loud
// (via the same speak() pipeline every reply uses) so the "calibration" moment is a REAL
// round-trip, not a cosmetic animation over nothing.
ipcMain.handle('assistant:setName', async (_e, rawName) => {
  const name = String(rawName || '').trim().slice(0, 40);
  if (!name) return { ok: false, error: 'Enter a name first.' };
  config.set({ assistantName: name });
  const line = 'Got it \u2014 I\u2019ll go by \u201C' + name + '\u201D from now on.';
  activity.push({ kind: 'said', text: line, time: clockTime() });
  mem().add('assistant', line);
  speak(line);
  return { ok: true, name };
});


ipcMain.handle('doc:import', async () => {
  const parent = (overlayWindow && !overlayWindow.isDestroyed()) ? overlayWindow : mainWindow;
  overlayIgnoreBlur = true; // opening the dialog blurs the overlay - don't let that collapse it
  let r;
  try {
    r = await dialog.showOpenDialog(parent, {
      title: 'Import a document',
      properties: ['openFile'],
      filters: [
        { name: 'Documents', extensions: ['pdf', 'txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'log', 'rtf'] },
        { name: 'All files', extensions: ['*'] }
      ]
    });
  } finally { setTimeout(() => { overlayIgnoreBlur = false; }, 400); }
  if (!r || r.canceled || !r.filePaths || !r.filePaths.length) return { ok: false, canceled: true };
  return importFilePath(r.filePaths[0]);
});

// Drag-and-drop straight onto the overlay's glass pane - the renderer resolves the dropped
// File to an absolute path via webUtils in preload, then hands it here.
ipcMain.handle('doc:importPath', async (_e, filePath) => {
  if (!filePath || typeof filePath !== 'string') return { ok: false, error: 'No file path received.' };
  return importFilePath(filePath);
});

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1080,
    height: 760,
    minWidth: 680,
    minHeight: 480,
    backgroundColor: '#0b0d12',
    show: false,
    title: 'Caryl.ai',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false // keep mic/recording alive when the window is in the background
    }
  });

  if (typeof mainWindow.removeMenu === 'function') mainWindow.removeMenu();
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());
  // DevTools only when explicitly asked for: `npm start -- --dev` or CARYL_DEV=1.
  // (An always-open detached DevTools costs real RAM on every user launch.)
  if (process.argv.includes('--dev') || process.env.CARYL_DEV === '1') {
    mainWindow.webContents.once('did-finish-load', () => { try { mainWindow.webContents.openDevTools({ mode: 'detach' }); } catch (_e) {} });
  }

  // Microphone + camera permission. We ask ONCE, remember the answer in settings.json, and
  // never prompt again on later launches. (The old code cached the answer only in memory, so
  // it re-asked every time the app started.)
  let _mediaAllowed = (config.get().mediaAllowed === true); // persisted across launches
  let _askingMedia = null;                                  // de-dupe concurrent prompts
  function ensureMediaPermission() {
    if (_mediaAllowed) return Promise.resolve(true);
    if (_askingMedia) return _askingMedia;                  // a prompt is already open
    _askingMedia = dialog.showMessageBox(mainWindow, {
      type: 'question', buttons: ['Allow', 'Block'], defaultId: 0, cancelId: 1, noLink: true,
      title: 'Caryl.ai', message: 'Allow Caryl to use your microphone and camera?',
      detail: 'Used for voice input and the camera vision feature. The camera only captures a frame when you ask it to. You will only be asked this once.'
    }).then((r) => {
      _mediaAllowed = (r.response === 0);
      config.set({ mediaAllowed: _mediaAllowed }); // remember for next launch
      _askingMedia = null;
      return _mediaAllowed;
    }).catch(() => { _askingMedia = null; return false; });
    return _askingMedia;
  }
  // Fires when the page REQUESTS a device (first getUserMedia of the session).
  mainWindow.webContents.session.setPermissionRequestHandler(async (_wc, permission, cb) => {
    if (permission === 'media') return cb(await ensureMediaPermission());
    return cb(permission === 'mediaKeySystem');
  });
  // Fires on every subsequent device access; returning true here means no re-prompt once
  // the user has allowed it (this is what stops the every-launch popup).
  mainWindow.webContents.session.setPermissionCheckHandler((_wc, permission) => {
    if (permission === 'media') return _mediaAllowed;
    return permission === 'mediaKeySystem';
  });

  // Surface any load/preload failure to the terminal (quietly).
  mainWindow.webContents.on('did-fail-load', (_e, code, desc, url) => {
    console.error('[RENDERER did-fail-load]', code, desc, url);
  });
  mainWindow.webContents.on('preload-error', (_e, file, err) => {
    console.error('[PRELOAD ERROR]', file, err && err.message);
  });
  // Toggle DevTools with F12 even though the menu is hidden.
  mainWindow.webContents.on('before-input-event', (_e, input) => {
    if (input.type === 'keyDown' && input.key === 'F12') mainWindow.webContents.toggleDevTools();
  });

  // External links open in the user's browser, never inside the app shell.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
}

// Register the system-wide voice hotkey (works even when BRAIN is in the background).
//
// Two mutually-exclusive modes, decided by cfg.pushToTalkMode:
//   TOGGLE (default): Electron's globalShortcut - press once to start, press again to stop.
//     This is all globalShortcut can do; it has no key-release event at all.
//   HOLD (push-to-talk): globalShortcut can't do this, so it needs a real keyboard hook -
//     uiohook-napi - to see the key go DOWN (start recording) and UP (stop recording). Loaded
//     lazily and defensively: if the native module isn't installed/couldn't build for this
//     machine, we log why and fall straight back to toggle mode rather than leaving voice
//     input dead.
let activeVoiceHotkey = '';
let pttEngineActive = false;   // true only when the uiohook hold-to-talk path is actually running
let pttUnavailableReason = ''; // set once if uiohook failed to load, so the UI can explain why
let _uiohook = null;
let _uiohookKeyMap = null;
let _uiohookPttCombo = null;   // { keycode, ctrl, alt, shift, meta } currently being listened for
let _uiohookHeld = false;

function loadUiohook() {
  if (_uiohook || pttUnavailableReason) return _uiohook;
  try {
    const mod = require('uiohook-napi');
    _uiohook = mod.uIOhook;
    _uiohookKeyMap = mod.UiohookKey;
    return _uiohook;
  } catch (e) {
    pttUnavailableReason = 'uiohook-napi not available: ' + ((e && e.message) || e);
    console.warn('[ptt] ' + pttUnavailableReason + ' - system-wide push-to-talk will fall back to toggle mode.');
    return null;
  }
}

// Same alias table as the automation hotkey normalizer, mapped onto UiohookKey names instead
// of pyautogui's - so "alt+space", "ctrl+shift+v", "win+`" etc. all parse the same way a user
// would expect regardless of which part of the app is reading the combo.
const PTT_KEY_ALIASES = {
  windows: 'Meta', win: 'Meta', super: 'Meta', cmd: 'Meta', command: 'Meta', commandorcontrol: 'Ctrl',
  control: 'Ctrl', ctrl: 'Ctrl', alt: 'Alt', shift: 'Shift',
  space: 'Space', spacebar: 'Space', enter: 'Enter', 'return': 'Enter', esc: 'Escape', escape: 'Escape',
  tab: 'Tab', backspace: 'Backspace', delete: 'Delete', backslash: 'Backslash', slash: 'Slash',
  up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight'
};
function parsePttCombo(str) {
  const uiohook = loadUiohook();
  if (!uiohook) return null;
  const parts = String(str || '').toLowerCase().split('+').map((s) => s.trim()).filter(Boolean);
  if (!parts.length) return null;
  const combo = { keycode: null, ctrl: false, alt: false, shift: false, meta: false };
  for (let p of parts) {
    const mapped = PTT_KEY_ALIASES[p] || (p.length === 1 ? p.toUpperCase() : p.charAt(0).toUpperCase() + p.slice(1));
    if (mapped === 'Ctrl') { combo.ctrl = true; continue; }
    if (mapped === 'Alt') { combo.alt = true; continue; }
    if (mapped === 'Shift') { combo.shift = true; continue; }
    if (mapped === 'Meta') { combo.meta = true; continue; }
    const code = _uiohookKeyMap[mapped] || _uiohookKeyMap[mapped.toUpperCase()] || (/^[A-Z]$/.test(mapped) ? _uiohookKeyMap[mapped] : null);
    if (code == null) return null; // unknown key name - caller falls back to toggle mode
    combo.keycode = code;
  }
  if (combo.keycode == null) return null; // modifiers alone aren't a valid combo
  return combo;
}

function stopPttEngine() {
  if (_uiohook && pttEngineActive) {
    try { _uiohook.removeAllListeners('keydown'); _uiohook.removeAllListeners('keyup'); _uiohook.stop(); } catch (_e) { /* best effort */ }
  }
  pttEngineActive = false;
  _uiohookPttCombo = null;
  _uiohookHeld = false;
}

function startPttEngine(comboStr) {
  const uiohook = loadUiohook();
  if (!uiohook) return false;
  const combo = parsePttCombo(comboStr);
  if (!combo) {
    pttUnavailableReason = 'couldn\u2019t understand the hold-to-talk combo "' + comboStr + '"';
    return false;
  }
  stopPttEngine();
  const matches = (e) => e.keycode === combo.keycode && !!e.ctrlKey === combo.ctrl && !!e.altKey === combo.alt && !!e.shiftKey === combo.shift && !!e.metaKey === combo.meta;
  uiohook.on('keydown', (e) => {
    if (!matches(e) || _uiohookHeld) return;
    _uiohookHeld = true;
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.webContents.send('mic:pttStart');
    }
  });
  uiohook.on('keyup', (e) => {
    // Release fires on the MAIN key OR any modifier lifting, since letting go of just Ctrl
    // while still holding the letter would otherwise leave recording stuck on forever. Checked
    // against both Left/Right variants where the library exposes them, since keyboards can fire
    // distinct keycodes per side.
    if (!_uiohookHeld) return;
    const modifierCodes = (names) => names.map((n) => _uiohookKeyMap[n]).filter((c) => c != null);
    const releasedMain = e.keycode === combo.keycode;
    const releasedModifier =
      (combo.ctrl && modifierCodes(['Ctrl', 'CtrlRight', 'CtrlLeft']).indexOf(e.keycode) !== -1) ||
      (combo.alt && modifierCodes(['Alt', 'AltRight', 'AltLeft']).indexOf(e.keycode) !== -1) ||
      (combo.shift && modifierCodes(['Shift', 'ShiftRight', 'ShiftLeft']).indexOf(e.keycode) !== -1) ||
      (combo.meta && modifierCodes(['Meta', 'MetaRight', 'MetaLeft']).indexOf(e.keycode) !== -1);
    if (!releasedMain && !releasedModifier) return;
    _uiohookHeld = false;
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('mic:pttStop');
  });
  try {
    uiohook.start();
    pttEngineActive = true;
    _uiohookPttCombo = combo;
    pttUnavailableReason = '';
    return true;
  } catch (e) {
    pttUnavailableReason = 'uiohook failed to start: ' + ((e && e.message) || e);
    pttEngineActive = false;
    return false;
  }
}

function registerVoiceHotkey() {
  const cfg = config.get();
  const candidates = [];
  if (cfg.globalHotkey) candidates.push(cfg.globalHotkey);
  ['CommandOrControl+Shift+Space', 'CommandOrControl+Shift+K', 'CommandOrControl+Alt+V', 'CommandOrControl+Shift+Backslash']
    .forEach((c) => { if (candidates.indexOf(c) < 0) candidates.push(c); });

  globalShortcut.unregisterAll();
  activeVoiceHotkey = '';
  for (const accel of candidates) {
    try {
      const ok = globalShortcut.register(accel, () => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          if (mainWindow.isMinimized()) mainWindow.restore();
          mainWindow.webContents.send('mic:toggle');
        }
      });
      if (ok && globalShortcut.isRegistered(accel)) { activeVoiceHotkey = accel; break; }
    } catch (_e) { /* try next */ }
  }
  console.log(activeVoiceHotkey ? '[voice hotkey] registered: ' + activeVoiceHotkey : '[voice hotkey] FAILED to register any hotkey');
  return activeVoiceHotkey;
}

// Picks TOGGLE (globalShortcut) or HOLD (uiohook) for the voice hotkey based on
// cfg.pushToTalkMode, and always leaves the app with a WORKING mode - if hold-to-talk can't
// start (native module missing, combo unparseable), it registers the normal toggle instead
// of leaving voice input silently broken.
function applyVoiceHotkeyMode() {
  const cfg = config.get();
  stopPttEngine();
  if (cfg.pushToTalkMode) {
    const combo = (cfg.pttHotkey && cfg.pttHotkey.trim()) || cfg.globalHotkey || 'CommandOrControl+Shift+Space';
    globalShortcut.unregisterAll(); // hold-to-talk owns the key via uiohook, not globalShortcut
    activeVoiceHotkey = '';
    const started = startPttEngine(combo);
    if (started) {
      activeVoiceHotkey = combo;
      console.log('[ptt] system-wide hold-to-talk active on: ' + combo);
      return;
    }
    console.warn('[ptt] falling back to toggle mode: ' + pttUnavailableReason);
  }
  registerVoiceHotkey();
}

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  stopPttEngine();
  stopAutomationSidecar();
  ollama.stopIfOurs();
});

app.whenReady().then(() => {
  // Serve generated images from disk via brainimg://img/<encoded-path>
  protocol.handle('brainimg', async (request) => {
    try {
      const p = decodeURIComponent(request.url.slice('brainimg://img/'.length));
      const data = await fs.promises.readFile(p);
      return new Response(data, { headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'max-age=86400' } });
    } catch (_e) {
      return new Response('not found', { status: 404 });
    }
  });
  if (!config.get().osVariant) config.set({ osVariant: detectOsVariant() }); // once; onboarding can override
  memory.init();
  rebuildActivityFromMemory();
  createWindow();
  createOverlay();   // pre-create the floating overlay (stays hidden until BRAIN replies unfocused)
  createMiniOverlay(); // pre-create the bubble too, so collapsing it the first time has no lag
  applyVoiceHotkeyMode();
  startVisionWebhook();
  // REFINED: lazy sidecar. Don't spawn automation.py at launch unless the user explicitly
  // opted out of lazy mode. The sidecar starts on the first automation/transcribe/local-vision
  // request via ensureSidecar(). This cuts ~80MB RAM + a Python cold-start from machines that
  // never use those features. The vision webhook still starts (it's a tiny in-process HTTP
  // server, ~0 cost) so it's ready when the sidecar comes up.
  const cfg0 = config.get();
  if (cfg0.lazySidecar === false) {
    startAutomationSidecar();
  } else {
    console.log('[automation] lazy mode - sidecar will start on first automation/voice/local-vision request');
  }
  // [OFFLINE-INTEGRATION] bring the local engine up at launch only when it's actually needed.
  // REFINED: even in offline mode, defer Ollama boot to first chat/vision/stt request when
  // cfg.ollamaLazyStart is on (default). The status badge will show "Ollama: offline" until
  // then, and the first request triggers ensureRunning() with a brief "Starting Ollama..."
  // message.
  if (enginesLib.resolveEngine(cfg0, 'chat') === 'offline' || enginesLib.resolveEngine(cfg0, 'vision') === 'offline') {
    if (cfg0.ollamaLazyStart === false) ollamaBoot();
    else console.log('[ollama] lazy mode - will boot on first chat/vision/stt request');
  }
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  // A drag within the last 400ms may still have a pending debounce - don't lose it.
  if (bubbleSaveTimer) { clearTimeout(bubbleSaveTimer); bubbleSaveTimer = null; }
  if (overlayBubblePos) config.set({ overlayBubblePos });
});

// ---- IPC: settings (used by the AI Engine section) ----
ipcMain.handle('config:get', () => config.get());
ipcMain.handle('shell:style', () => shellStyle());
ipcMain.handle('config:set', (_e, patch) => {
  const prev = config.get(); // [OFFLINE-INTEGRATION] snapshot so we can detect what changed
  const r = config.set(patch || {});
  if (patch && (patch.globalHotkey || ('pushToTalkMode' in patch) || ('pttHotkey' in patch))) applyVoiceHotkeyMode();
  // Translate legacy mode flags (old settings UI / old renderer versions) into engines,
  // and keep legacy flags in sync when engines is patched directly - both directions,
  // so either vocabulary keeps working during and after the transition.
  if (patch && !patch.engines && (('mode' in patch) || ('useLocalVision' in patch) || ('useLocalStt' in patch) || ('ttsEngine' in patch))) {
    config.set({ engines: enginesLib.deriveFromLegacy(config.get()) });
  }
  if (patch && patch.engines) {
    const e = enginesLib.normalizeEngines(config.get()).engines;
    config.set({
      mode: e.chat === 'offline' ? 'offline' : 'online',
      useLocalVision: e.vision === 'offline',
      useLocalStt: e.stt === 'offline',
      ttsEngine: e.tts === 'offline' ? 'piper' : 'browser'
    });
  }
  // React to mode / storage / engine changes made from the settings UI: the visible chat
  // thread follows the active store, which can swap when engines.chat flips.
  if (patch && (('mode' in patch) || ('separateOfflineChats' in patch) || ('engines' in patch))) {
    rebuildActivityFromMemory();
  }
  const now = config.get();
  const needsOllama = enginesLib.resolveEngine(now, 'chat') === 'offline' || enginesLib.resolveEngine(now, 'vision') === 'offline';
  const engineFlip = patch && (patch.engines || patch.mode === 'offline' || patch.useLocalVision === true);
  if (engineFlip && needsOllama) {
    ollamaBoot(); // fire-and-forget: make sure the local engine is up now that it's needed
  }
  if (patch && ('offlineModel' in patch) && isOffline(now) && prev.offlineModel !== now.offlineModel) {
    // Free the old model from VRAM and pre-warm the new one, so only the selected model
    // stays resident on a small GPU (ported from the old brain.py's switch_brain_model).
    ollama.switchModel(prev.offlineModel || DEFAULT_OFFLINE_MODEL, now.offlineModel || DEFAULT_OFFLINE_MODEL).catch(() => {});
  }
  return r;
});
ipcMain.handle('memory:clear', () => {
  mem().clear();
  rebuildActivityFromMemory();
  return true;
});
ipcMain.handle('memory:newChat', () => { mem().newChat(); rebuildActivityFromMemory(); return { ok: true }; });
ipcMain.handle('memory:listChats', () => mem().listChats());
ipcMain.handle('memory:switchChat', (_e, id) => { const ok = mem().switchChat(id); rebuildActivityFromMemory(); return { ok }; });
ipcMain.handle('memory:deleteChat', (_e, id) => { mem().deleteChat(id); rebuildActivityFromMemory(); return { ok: true }; });
ipcMain.handle('memory:list', () => mem().all().map((m, i) => ({ index: i, role: m.role, content: m.content })));
ipcMain.handle('memory:deleteMessage', (_e, index) => { const ok = mem().deleteMessage(index); rebuildActivityFromMemory(); return { ok }; });

// ---- IPC: status (polled ~1/s to drive the orb, pills, and badges) ----
ipcMain.handle('ui:status', () => {
  const cfg = config.get();
  const connected = aiReady(cfg); // [OFFLINE-INTEGRATION] online: key saved; offline: Ollama answering
  return {
    ollama_available: connected, // repurposed: "brain connected" (cloud key online / local server offline)
    ai_status: aiStatus,
    ai_speaking: false,          // no TTS in v1
    brain_model: chatCfg(cfg).model, // [OFFLINE-INTEGRATION] shows the ACTIVE mode's chat model
    assistant_name: cfg.assistantName || 'Caryl',
    accent_color: cfg.accentColor || '#7fd1ff',
    provider: isOffline(cfg) ? 'ollama' : cfg.provider,
    voice_hotkey: activeVoiceHotkey,
    local_wake_enabled: !!cfg.local_wake_enabled,
    local_wake_threshold: typeof cfg.local_wake_threshold === 'number' ? cfg.local_wake_threshold : 0.5,
    tts_engine: cfg.ttsEngine || 'browser',
    latest_volume: 0,
    vision_model: (enginesLib.resolveEngine(cfg, 'vision') === 'offline') ? (localVisionModel(cfg) || null) : null,
    ocr_available: false,
    embeddings_available: true,  // local memory is always on
    automation_available: automationReady && automationPyautogui,
    automation_running: !!(automationState && automationState.active),
    // echoed settings so the (inert) toggles reflect saved state
    allow_mouse_control: !!cfg.allow_mouse_control,
    allow_system_scripting: !!cfg.allow_system_scripting,
    tts_enabled: !!cfg.tts_enabled,
    screen_watch_enabled: false,
    proactive_thinking_enabled: false,
    memory_saving_enabled: cfg.memory_saving_enabled !== false,
    speech_rate: cfg.speech_rate || 195,
    ptt_hotkey: cfg.ptt_hotkey || '\\',
    push_to_talk_mode: !!cfg.pushToTalkMode,
    system_ptt_active: pttEngineActive,
    system_ptt_unavailable_reason: pttEngineActive ? '' : pttUnavailableReason,
    memory_usage: { count: mem().all().length, gb: 0, mb: 0, budget_gb: cfg.memory_budget_gb || 5, percent: 0 },
    // Per-capability hybrid routing (drives the Engines & Models card + onboarding)
    engines: enginesLib.normalizeEngines(cfg).engines,
    wake_word_model: cfg.wakeWordModel || 'hey_jarvis_v0.1.onnx',
    // [OFFLINE-INTEGRATION] extra fields for the AI Mode settings card (harmless elsewhere)
    mode: cfg.mode || 'online',
    ollama_up: ollama.isUp(),
    offline_model: cfg.offlineModel || DEFAULT_OFFLINE_MODEL,
    use_local_vision: !!cfg.useLocalVision,
    use_local_stt: !!cfg.useLocalStt,
    offline_stt_model: cfg.offlineSttModel || '',
    separate_offline_chats: !!cfg.separateOfflineChats
  };
});

// ---- IPC: activity (polled to render the chat thread) ----
ipcMain.handle('ui:activity', () => ({ activity }));

// ---- IPC: stop the current stream ----
ipcMain.handle('chat:stop', () => {
  if (activeController) activeController.abort();
  return { ok: true };
});

// ---- IPC: model discovery / selection ----
ipcMain.handle('ui:getModels', async () => {
  const cfg = config.get();
  // [OFFLINE-INTEGRATION] offline mode lists the LOCAL Ollama models in the same picker UI.
  if (isOffline(cfg)) {
    try {
      return { models: await ollama.listTags(), current: cfg.offlineModel || DEFAULT_OFFLINE_MODEL };
    } catch (e) {
      return { models: [], current: cfg.offlineModel || DEFAULT_OFFLINE_MODEL, error: (e && e.message) || String(e) };
    }
  }
  if (!cfg.apiKey) return { models: [], current: cfg.model };
  try {
    return { models: await listModels(cfg), current: cfg.model };
  } catch (e) {
    return { models: [], current: cfg.model, error: e.message || String(e) };
  }
});
ipcMain.handle('ui:setModel', (_e, model) => {
  if (model) {
    const cfg = config.get();
    if (isOffline(cfg)) {
      // [OFFLINE-INTEGRATION] in offline mode the picker sets the OFFLINE model. Free the old
      // one from VRAM and pre-warm the new one so the next message doesn't pay a cold load.
      const prev = cfg.offlineModel || DEFAULT_OFFLINE_MODEL;
      config.set({ offlineModel: model });
      if (prev !== model) ollama.switchModel(prev, model).catch(() => {});
      return { ok: true };
    }
    const pm = Object.assign({}, cfg.providerModels || {});
    pm[cfg.provider] = model;
    config.set({ model, providerModels: pm });
  }
  return { ok: true };
});

// ---- IPC: legacy toggles/sliders (persisted but inert in this cloud build) ----
ipcMain.handle('ui:setFlag', (_e, payload) => {
  const path = (payload && payload.path) || '';
  const body = (payload && payload.body) || {};
  const FLAG = {
    '/toggle_mouse_control': 'allow_mouse_control',
    '/toggle_system_scripting': 'allow_system_scripting',
    '/toggle_tts': 'tts_enabled',
    '/toggle_memory_saving': 'memory_saving_enabled',
    '/toggle_local_wake': 'local_wake_enabled'
  };
  if (FLAG[path] && typeof body.enabled === 'boolean') {
    config.set({ [FLAG[path]]: body.enabled });
    if (path === '/toggle_mouse_control' || path === '/toggle_system_scripting') {
      const cfg = config.get();
      sidecarCall('/permissions', { mouse: !!cfg.allow_mouse_control, scripting: !!cfg.allow_system_scripting });
    }
  }
  if (path === '/set_wake_threshold' && typeof body.value === 'number') { config.set({ local_wake_threshold: Math.max(0.05, Math.min(0.95, body.value)) }); return { ok: true }; }
  if (path === '/set_speech_rate' && body.rate) config.set({ speech_rate: body.rate });
  if (path === '/set_memory_budget' && body.gb) config.set({ memory_budget_gb: body.gb });
  if (path === '/set_ptt_hotkey' && body.hotkey) { config.set({ ptt_hotkey: body.hotkey }); return { hotkey: body.hotkey }; }
  return { ok: true };
});

// ---- IPC: desktop automation - plan approval, stop, and per-command shell confirmation ----
ipcMain.handle('automation:approvePlan', (_e, id) => {
  // Only ever ONE run at a time: two loops sharing automationState (and the mouse!) would
  // interleave into chaos. This is reachable - a second plan can be proposed and approved
  // while an earlier run is still going.
  if (automationState && automationState.active) {
    activity.push({ kind: 'action', text: '\u26A0 An automation run is already in progress - stop it first, then approve this plan again.', time: clockTime() });
    return { ok: false, error: 'automation already running' };
  }
  const idx = activity.findIndex((a) => a.kind === 'automation_plan' && a.id === id);
  if (idx < 0) return { ok: false };
  const goal = activity[idx].goal;
  activity.splice(idx, 1);
  runAutomationLoop(goal); // fire and forget - it pushes its own activity entries as it goes
  return { ok: true };
});
ipcMain.handle('automation:cancelPlan', (_e, id) => {
  const idx = activity.findIndex((a) => a.kind === 'automation_plan' && a.id === id);
  if (idx >= 0) activity.splice(idx, 1);
  activity.push({ kind: 'action', text: '\u25A0 Plan cancelled.', time: clockTime() });
  return { ok: true };
});
ipcMain.handle('automation:stop', () => {
  if (automationState) {
    automationState.stopRequested = true;
    if (automationState.pendingConfirm) { automationState.pendingConfirm.resolve(false); }
  }
  return { ok: true };
});
ipcMain.handle('automation:confirmShell', (_e, id, approve) => {
  const idx = activity.findIndex((a) => a.kind === 'automation_confirm' && a.id === id);
  if (idx >= 0) activity.splice(idx, 1);
  if (automationState && automationState.pendingConfirm && automationState.pendingConfirm.id === id) {
    automationState.pendingConfirm.resolve(!!approve);
  }
  return { ok: true };
});
ipcMain.handle('automation:setPermissions', (_e, perms) => {
  config.set({ allow_mouse_control: !!(perms && perms.mouse), allow_system_scripting: !!(perms && perms.scripting) });
  return sidecarCall('/permissions', { mouse: !!(perms && perms.mouse), scripting: !!(perms && perms.scripting) });
});

// Pull a JSON action out of a model reply, tolerating code fences. Returns the action
// object only if it has an "action" field; otherwise null (meaning: it's a normal chat).
function parseAction(text) {
  let t = String(text || '').trim();
  if (t.startsWith('```')) t = t.replace(/^```(json)?/i, '').replace(/```$/, '').trim();
  if (!t.startsWith('{')) return null;
  const s = t.indexOf('{');
  const e = t.lastIndexOf('}');
  if (s < 0 || e <= s) return null;
  try {
    const o = JSON.parse(t.slice(s, e + 1));
    return o && o.action ? o : null;
  } catch (_e) {
    return null;
  }
}

// True only if the user's own words clearly reference making a picture. Backs up the prompt
// so generate_image can never fire on things like "imagine if" or "make a plan".
function hasImageIntent(s) {
  return /\b(image|images|picture|pictures|pic|pics|photo\w*|draw\w*|sketch\w*|paint\w*|art|artwork|illustrat\w*|wallpaper|logo|logos|poster|portrait|render\w*|avatar|icon|banner|graphic|graphics|selfie|mockup|visuali[sz]e)\b/i.test(String(s || ''));
}

// True when the user's message is plainly NOT a task: greetings, thanks, acknowledgments,
// single filler words, or bare punctuation. Backs up the prompt the same way hasImageIntent()
// does for generate_image - a weak model that pattern-matches its own history will happily
// re-emit automate_plan in reply to "thank you" or "." (this literally happened: hallucinated
// voice transcripts like "Thank you." kept re-proposing the previous plan over and over).
function looksLikeSmallTalk(s) {
  const t = String(s || '').trim();
  if (!t) return true;
  if (!/[a-z0-9]/i.test(t)) return true; // punctuation-only ("." "?" "!!")
  const COURTESY = /^(hey|heyy+|hi|hii+|hello|yo|sup|ok(ay)?|k|kk|cool|nice|great|good(\s+(job|work|one|stuff))?|perfect|awesome|amazing|lol|haha+|hmm+|uh+|um+|oh|ah|wow|yes|yeah|yep|no|nope|nah|sure|right|alright|thanks?|thank\s*(you|u)|thx|ty|tysm|so\s+thank\s+(you|u)|thank\s+you\s+so\s+much|bye|goodbye|good\s*night|good\s*morning|you)$/i;
  return COURTESY.test(t.replace(/[.!?,\s]+$/g, '').trim());
}

// [OFFLINE-INTEGRATION] OFFLINE mode's web_search: a keyless local research pass ported from
// the old offline build's agent.py. Searches DuckDuckGo's HTML endpoint (no API key), reads
// the top pages, then streams a grounded answer synthesized by the LOCAL model - the only
// thing that leaves the machine is the page fetches themselves. Sources are listed in the
// activity feed the way the old build reported them.
async function offlineWebAnswer(cfg, query) {
  activity.push({ kind: 'action', text: 'Searching the web: ' + query, time: clockTime() });
  aiStatus = 'working';
  const notes = [];
  const sources = [];
  try {
    const results = await localSearch.searchWeb(query, 3);
    if (results.length) activity.push({ kind: 'action', text: 'Found ' + results.length + ' results, reading the top pages\u2026', time: clockTime() });
    for (const r of results) {
      if (activeController && activeController.signal && activeController.signal.aborted) break;
      const txt = await localSearch.fetchReadable(r.url, 2800);
      if (txt && txt.length > 120) {
        notes.push({ url: r.url, text: txt });
        try { sources.push(new URL(r.url).hostname.replace(/^www\./, '')); } catch (_e) { sources.push(r.url); }
      }
      if (notes.length >= 3) break;
    }
  } catch (_e) { /* handled by the empty-notes message below */ }

  const ans = { kind: 'said', text: '', thinking: '', time: clockTime() };
  activity.push(ans);
  streamingEntry = ans;
  const sSearch = makeSpeaker();
  let finalText = '';
  if (!notes.length) {
    finalText = 'I could not pull anything useful off the web for that - I may have no internet right now, or the sites blocked the request.';
    ans.text = finalText;
  } else {
    const corpus = notes.map((n, i) => '[Source ' + (i + 1) + ': ' + (sources[i] || n.url) + ']\n' + n.text).join('\n\n').slice(0, 12000);
    const prompt = 'You researched the web to answer: "' + query + '".\n\n' +
      'Here is what the pages you read actually say:\n' + corpus + '\n\n' +
      'Answer the question directly and conversationally, based ONLY on what these sources say - do not invent facts. ' +
      'If the sources disagree or it is uncertain, say so. Lead with the answer, then the key supporting detail. ' +
      'Plain spoken text only: no markdown, no asterisks, no bullet symbols. Be reasonably brief.';
    const ai = chatCfg(cfg);
    let raw = '';
    try {
      await streamChat({
        baseUrl: ai.baseUrl, apiKey: ai.apiKey, model: ai.model, temperature: cfg.temperature,
        messages: [{ role: 'user', content: prompt }],
        signal: activeController ? activeController.signal : undefined,
        onToken: (d) => { raw += d; const sp = splitThinking(raw); ans.thinking = sp.thinking; ans.text = sp.answer || (sp.thinking ? '\u2026' : ''); if (sp.answer) sSearch.feed(sp.answer); }
      });
    } catch (_e) { /* keep whatever streamed */ }
    const sp = splitThinking(raw);
    finalText = (sp.answer || '').trim() || 'I read a few pages but could not put a solid answer together - try rephrasing it.';
    ans.text = finalText;
    ans.thinking = sp.thinking;
  }
  mem().add('assistant', maybeStripToolResult(finalText));
  sSearch.feed(finalText); sSearch.flush();
  if (sources.length) {
    activity.push({ kind: 'action', text: 'Sources: ' + Array.from(new Set(sources)).slice(0, 5).join(', '), time: clockTime() });
  }
}

// ---- IPC: send a message (prompt-based actions: open apps / urls / search, then reply) ----
ipcMain.handle('ui:sendText', async (_event, text) => {
  const cfg = config.get();
  const msg = String(text || '').trim();
  if (!msg) return { ok: false };
  if (!aiReady(cfg)) {
    // [OFFLINE-INTEGRATION] mode-aware "not connected" message (key online, server offline)
    activity.push({ kind: 'action', text: isOffline(cfg) ? noAiMsg(cfg) : 'No API key set - open Settings -> AI Engine and paste your key.', time: clockTime() });
    return { ok: false, error: isOffline(cfg) ? 'ollama not running' : 'no api key' };
  }
  const ai = chatCfg(cfg); // [OFFLINE-INTEGRATION] the active chat endpoint (cloud online, Ollama offline)

  mem().add('user', msg);
  activity.push({ kind: 'heard', text: msg, time: clockTime() });
  maybeShowOverlay(); // if you asked from another app (e.g. voice hotkey), pop the overlay up

  // REFINED: token-budgeted history. Instead of blindly sending the last N turns, drop the
  // oldest turns when their combined estimate exceeds cfg.tokenBudget (default 6000), with a
  // short summary of what was dropped so long-term recall isn't totally lost. Cuts the per-
  // request token cost on long sessions significantly.
  const history = buildBudgetedHistory(cfg);
  // Action protocol injected on top of the user's persona prompt. Works on ANY model
  // (no provider tool-calling needed): the model replies with a small JSON object to act.
  const CAPABILITY =
    'You can take real actions on this computer. When the user asks you to OPEN AN APP, OPEN A ' +
    'WEBSITE, or SEARCH THE WEB, reply with ONLY a single JSON object and nothing else, in one ' +
    'of these exact shapes:\n' +
    '{"action":"open_app","target":"chrome","say":"Opening Chrome."}\n' +
    '{"action":"open_url","target":"youtube.com","say":"Opening YouTube."}\n' +
    '{"action":"web_search","target":"best calisthenics parks","say":"Searching that now."}\n' +
    '{"action":"see_screen","query":"what the user is asking about the screen"}\n' +
    '{"action":"see_camera","query":"what the user wants to know about what the camera sees"}\n' +
    '{"action":"close_camera"}\n' +
    '{"action":"generate_image","target":"a red fox in a snowy forest, cinematic","say":"Creating that now."}\n' +
    '{"action":"make_3d","target":"a red coffee mug"}\n' +
    'open_app and open_url are ONLY for a bare open with nothing else requested. If the user also ' +
    'wants you to type, write, click, or do anything else inside the app after opening it, that is a ' +
    'multi-step task - use automate_plan (described below) with the whole request as the goal, not ' +
    'open_app. ' +
    'Use see_screen when the user asks what is ON THEIR SCREEN, to READ or LOOK AT something ' +
    'on screen, or about what they are currently viewing. ' +
    'Do NOT use see_screen or see_camera for questions about AUDIO or HEARING - "can you hear ' +
    'me", "do you hear me well", "how do I sound", "did you hear that" are about your ' +
    'microphone/audio input, not vision. These have no action - just answer directly in plain ' +
    'text (e.g. confirm you can hear them fine, or ask them to repeat it) and never reach for ' +
    'see_screen or see_camera to "demonstrate" perception when the question was about sound. ' +
    'Use see_camera when the user asks you to LOOK AT THEM, look through the CAMERA or WEBCAM, ' +
    'see what they are HOLDING UP or SHOWING you, or identify a real object in front of them ' +
    '(e.g. "look at me", "what am I holding", "can you see this", "identify this"). ' +
    'Use close_camera when the user asks you to CLOSE, STOP, EXIT, or TURN OFF the camera or webcam. ' +
    'Use make_3d when the user asks you to MAKE, BUILD, CREATE, or GENERATE a 3D MODEL of ' +
    'something - put the object in "target" (e.g. "a wooden chair", "a toy car"). If they refer ' +
    'to something they are showing on the camera ("make a 3D model of this"), set target to "this". ' +
    'Use generate_image ONLY when the user EXPLICITLY asks you to create a visual image, ' +
    'picture, photo, drawing, artwork, wallpaper, or logo (e.g. "draw me a cat", "generate an ' +
    'image of a city at night", "make a picture of a sunset") - put a detailed visual ' +
    'description in "target". Do NOT use generate_image for writing, planning, lists, code, ' +
    'summaries, explanations, recipes, advice, or stories, and NOT when words like "imagine", ' +
    '"create", "make", "draw", or "paint" are meant figuratively (e.g. "imagine if...", ' +
    '"create a plan", "draw a conclusion", "paint a picture with words"). If the user did not ' +
    'clearly ask for an actual picture, reply normally in plain text. The "say" value is a short spoken ' +
    'confirmation (not needed for see_screen). Never wrap the JSON in code fences or extra ' +
    'text, and never claim you are unable to open apps, sites, see the screen, or make images. For ANY ' +
    'other message, reply normally in plain text and never output JSON.' +
    '\n\nWrite all normal replies as plain spoken text: no markdown, asterisks, bullet ' +
    'points, headings, or code blocks unless explicitly asked - your words are read aloud. ' +
    'Answer exactly what was asked, at the length it actually needs - a quick question gets a ' +
    'quick answer. Do not pad replies with extra background, caveats, or related facts the user ' +
    'did not ask for. Only go longer, or cover more ground, if the user explicitly asks for detail, ' +
    'a full explanation, everything, or a list.';
  // Always taught to the model, regardless of current sidecar/permission state - gating this on
  // live readiness used to mean a slow sidecar cold-start (or a health check that hadn't caught
  // up yet) made the model silently forget automate_plan exists for that whole reply and fall
  // back to something else (like see_screen) with no explanation. Now it always recognizes an
  // automation request as one; the readiness/permission checks happen in the dispatch below,
  // where they can actually tell the user what's missing instead of silently substituting.
  const AUTOMATION_CAPABILITY =
    '\n\n{"action":"automate_plan","goal":"a short description of the multi-step desktop task"}\n' +
    'Use automate_plan whenever the user\u2019s CURRENT message asks for a task that takes MORE THAN ONE ' +
    'step to finish - multiple clicks, typing text into something, or any "do X and then Y" request ' +
    '(e.g. "organize my downloads folder", "fill out this form for me", "reply to the latest email", ' +
    '"open Notepad and type hello world", "open Word and write a paragraph", "open Paint and draw a ' +
    'circle"). Set "goal" to their request in THEIR OWN words - do not add sides, directions, counts, ' +
    'or any detail they did not actually say, and do not try to plan the actual steps yourself; that ' +
    'happens separately once you can see their screen. ' +
    'IMPORTANT: open_app / open_url are ONLY for a BARE "open X" with nothing else asked (just "open ' +
    'Notepad", just "open youtube.com"). The moment the request ALSO asks to TYPE, WRITE, CLICK, ' +
    'SEARCH INSIDE, or otherwise DO something after opening - even something small like typing one ' +
    'phrase - it is a multi-step task, so use automate_plan with the WHOLE request as the goal (e.g. ' +
    'goal "open Notepad and type hello world"), NOT open_app. Do NOT use see_screen for a request that ' +
    'is actually asking you to DO something on screen (typing, organizing, filling in, clicking ' +
    'through) rather than just describe it. CRITICAL: greetings, thanks, acknowledgments, single ' +
    'words, or stray punctuation ("hey", "thank you", "ok", ".", "nice") are NEVER automation requests ' +
    '- reply to those in plain friendly text, and NEVER re-propose or restart an earlier plan unless ' +
    'the user explicitly asks you to retry, continue, or do it again.';
  const docContext = lastDocument
    ? [{ role: 'system', content: 'The user has imported a document named "' + lastDocument.name + '". When their question relates to it, answer using ONLY the document\'s actual contents below - do not add outside knowledge, invented details, or embellishment that is not actually in it, even if it would normally be true (e.g. for a book excerpt, do not add plot points or facts you know about the book from elsewhere - stick to what this text actually says). If something isn\'t covered in the document, say so rather than filling the gap. Document:\n\n' + lastDocument.text }]
    : [];
  const nameContext = cfg.assistantName
    ? [{ role: 'system', content: 'The user has named you "' + cfg.assistantName + '". Refer to yourself by that name (e.g. if asked your name, answer with it).' }]
    : [];
  const messages = [{ role: 'system', content: CAPABILITY + AUTOMATION_CAPABILITY + '\n\n' + cfg.systemPrompt }, ...nameContext, ...docContext, ...history];

  aiStatus = 'thinking';
  const said = { kind: 'said', text: '', time: clockTime() };
  activity.push(said);
  streamingEntry = said;
  activeController = new AbortController();

  let full = '';
  let actionMode = null; // null = undecided, true = buffering a JSON action, false = chat
  const speaker = makeSpeaker(); // speaks sentences as they stream in (no end-of-reply delay)

  try {
    await streamChat({
      baseUrl: ai.baseUrl, apiKey: ai.apiKey, model: ai.model, temperature: cfg.temperature,
      messages, signal: activeController.signal,
      onToken: (d) => {
        full += d;
        aiStatus = 'working';
        if (actionMode === null) {
          const t = full.replace(/^\s+/, '');
          if (t.length >= 1) actionMode = (t[0] === '{' || t.startsWith('```'));
        }
        // Stream chat live; if it's a JSON action, buffer silently (don't show raw JSON).
        if (actionMode === false) {
          const sp = splitThinking(full);
          said.text = sp.answer || (sp.thinking ? '\u2026' : '');
          said.thinking = sp.thinking;
          if (sp.answer) speaker.feed(sp.answer); // speak each finished sentence right away
        }
      }
    });

    const action = parseAction(full);
    if (action) {
      // Replace the placeholder bubble with the action result(s).
      const idx = activity.indexOf(said);
      if (idx >= 0) activity.splice(idx, 1);

      if (action.action === 'see_screen') {
        // Vision: screenshot the display, ask the multimodal model about it.
        activity.push({ kind: 'action', text: 'Looking at your screen...', time: clockTime() });
        aiStatus = 'working';
        const dataUrl = await captureScreen();
        if (!dataUrl) {
          activity.push({ kind: 'action', text: '\u26A0 Could not capture the screen.', time: clockTime() });
        } else {
          const q = String(action.query || msg || 'What is on my screen?');
          const visMessages = [
            { role: 'system', content: VISION_STYLE },
            { role: 'user', content: [
              { type: 'text', text: q },
              { type: 'image_url', image_url: { url: dataUrl } }
            ] }
          ];
          // [OFFLINE-INTEGRATION] pick the ACTIVE vision endpoint: the per-provider cloud map
          // online, a downloaded Ollama vision model offline / when the local-vision toggle is on.
          const v = visionCfg(cfg);
          const ans = { kind: 'said', text: '', thinking: '', time: clockTime() };
          activity.push(ans);
          streamingEntry = ans;
          const sScreen = makeSpeaker();
          // Same cold-start flakiness as web_search/camera vision: retry a couple of times
          // before ever surfacing "(no description)".
          let raw = '', rv = null;
          for (let attempt = 0; attempt < 3; attempt++) {
            raw = '';
            ans.text = attempt ? '\u2026' : '';
            rv = await streamChat({
              baseUrl: v.baseUrl, apiKey: v.apiKey, model: v.model, temperature: cfg.temperature,
              messages: visMessages, signal: activeController.signal,
              onToken: (d) => {
                raw += d;
                const sp = splitThinking(raw);
                ans.thinking = sp.thinking;
                ans.text = sp.answer || (sp.thinking ? '\u2026' : ''); // show "..." while reasoning
                if (sp.answer) sScreen.feed(sp.answer);
              }
            });
            const got = (splitThinking(raw || (rv && rv.content) || '').answer || '').trim();
            if (got) break;
            if (activeController.signal && activeController.signal.aborted) break;
          }
          const sp = splitThinking(raw || (rv && rv.content) || '');
          const finalText = (sp.answer || '').trim() || '(no description)';
          ans.text = finalText;
          ans.thinking = sp.thinking;
          mem().add('assistant', maybeStripToolResult(finalText));
          sScreen.feed(finalText); sScreen.flush();
        }
      } else if (action.action === 'automate_plan') {
        const goal = String(action.goal || action.target || '').trim();
        if (looksLikeSmallTalk(msg)) {
          // The model tried to (re-)start an automation off a greeting/thanks/"." - the user
          // asked for nothing. Same recovery as the generate_image no-intent path: answer
          // normally in plain text instead. This is what stops the plan-card spam loop.
          const ans = { kind: 'said', text: '', thinking: '', time: clockTime() };
          activity.push(ans);
          streamingEntry = ans;
          aiStatus = 'thinking';
          let raw = '';
          const sAuto = makeSpeaker();
          await streamChat({
            baseUrl: ai.baseUrl, apiKey: ai.apiKey, model: ai.model, temperature: cfg.temperature,
            messages: [{ role: 'system', content: cfg.systemPrompt + '\nReply in plain conversational text. Do not output JSON or any action, and do not restart or mention any previous automation plan.' }, ...history],
            signal: activeController.signal,
            onToken: (d) => { raw += d; const sp = splitThinking(raw); ans.thinking = sp.thinking; ans.text = sp.answer || (sp.thinking ? '\u2026' : ''); if (sp.answer) sAuto.feed(sp.answer); }
          });
          const sp = splitThinking(raw);
          const finalText = (sp.answer || '').trim() || 'You\u2019re welcome!';
          ans.text = finalText;
          ans.thinking = sp.thinking;
          mem().add('assistant', maybeStripToolResult(finalText));
          sAuto.feed(finalText); sAuto.flush();
        } else if (!goal) {
          activity.push({ kind: 'said', text: 'What would you like me to do?', time: clockTime() });
        } else if (!automationReady) {
          // REFINED: lazy sidecar - try to bring it up on demand instead of dead-ending.
          activity.push({ kind: 'action', text: 'Starting the automation engine...', time: clockTime() });
          const up = await ensureSidecar();
          if (!up) {
            activity.push({ kind: 'action', text: '\u26A0 The automation engine couldn\u2019t start - check that Python and the packages in requirements_automation.txt are installed.', time: clockTime() });
          } else if (!cfg.allow_mouse_control && !cfg.allow_system_scripting) {
            activity.push({ kind: 'action', text: '\u26A0 Desktop automation needs a permission turned on first - Settings \u2192 Desktop Automation.', time: clockTime() });
          } else {
            await proposeAutomationPlan(cfg, goal);
          }
        } else if (!cfg.allow_mouse_control && !cfg.allow_system_scripting) {
          activity.push({ kind: 'action', text: '\u26A0 Desktop automation needs a permission turned on first - Settings \u2192 Desktop Automation.', time: clockTime() });
        } else {
          await proposeAutomationPlan(cfg, goal);
        }
      } else if (action.action === 'make_3d') {
        let desc = String(action.target || '').trim();
        const vague = !desc || /^(this|it|that|the object|this object|this thing|what i'?m showing|what i am showing)$/i.test(desc);
        activity.push({ kind: 'action', text: 'Building a 3D model...', time: clockTime() });
        aiStatus = 'working';
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('model3d:loading', true);
        try {
          if (vague) {
            const frame = await requestCameraFrame();
            if (frame) desc = await describeObjectForModel(cfg, frame);
          }
          if (!desc) {
            if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('model3d:loading', false);
            activity.push({ kind: 'said', text: 'What would you like me to model in 3D?', time: clockTime() });
          } else {
            await buildAndShowModel(cfg, desc);
          }
        } catch (e) {
          if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('model3d:loading', false);
          activity.push({ kind: 'action', text: '\u26A0 3D build failed: ' + ((e && e.message) || e), time: clockTime() });
        }
      } else if (action.action === 'close_camera') {
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('camera:close');
        const say = 'Camera closed.';
        activity.push({ kind: 'said', text: say, time: clockTime() });
        mem().add('assistant', say);
        speak(say);
      } else if (action.action === 'see_camera') {
        // Webcam vision: ask the renderer for a frame, then describe it.
        activity.push({ kind: 'action', text: 'Looking through the camera...', time: clockTime() });
        aiStatus = 'working';
        const dataUrl = await requestCameraFrame();
        if (!dataUrl) {
          activity.push({ kind: 'action', text: '\u26A0 Could not get a camera image (no webcam, or permission denied).', time: clockTime() });
        } else {
          const q = String(action.query || msg || 'What do you see through the camera? Identify any objects, people, or text. Be concise and natural.');
          await describeImageToChat(cfg, dataUrl, q);
        }
      } else if (action.action === 'web_search') {
        const query = String(action.target || action.query || msg || '').trim();
        if (isOffline(cfg)) {
          // [OFFLINE-INTEGRATION] offline mode: local DuckDuckGo research + local synthesis
          // (ported from the old agent.py) instead of Groq's server-side compound search.
          await offlineWebAnswer(cfg, query);
        } else {
          // Search the web and ANSWER (no browser). Uses Groq's compound system (server-side search).
          const groq = resolveGroqKey(cfg);
          if (!groq) {
            // No Groq key -> fall back to opening the browser so it still does something.
            const result = await actions.run('web_search', { target: query });
            activity.push({ kind: 'action', text: result.summary, time: clockTime() });
            const say = String(action.say || 'Opening a search for that.').trim();
            activity.push({ kind: 'said', text: say, time: clockTime() });
            mem().add('assistant', say);
            speak(say);
          } else {
            activity.push({ kind: 'action', text: 'Searching the web: ' + query, time: clockTime() });
            aiStatus = 'working';
            const ans = { kind: 'said', text: '', thinking: '', time: clockTime() };
            activity.push(ans);
            streamingEntry = ans;
            const sSearch = makeSpeaker();
            // groq/compound runs the search on Groq's servers and SOMETIMES finishes the first
            // stream with no content (search step still warming up) - that's the intermittent
            // "(no results)" you saw, which then works on a second try. So retry automatically
            // a few times before giving up, instead of surfacing an empty answer.
            let raw = '', rv = null;
            for (let attempt = 0; attempt < 3; attempt++) {
              raw = '';
              ans.text = attempt ? '\u2026' : ''; // show the thinking dots on a retry
              rv = await streamChat({
                baseUrl: groq.base, apiKey: groq.key, model: 'groq/compound', temperature: cfg.temperature,
                messages: [
                  { role: 'system', content: 'Search the web and answer concisely in a natural, spoken style. No markdown tables, no long lists - a short clear answer.' },
                  { role: 'user', content: query }
                ],
                signal: activeController.signal,
                onToken: (d) => { raw += d; const sp = splitThinking(raw); ans.thinking = sp.thinking; ans.text = sp.answer || (sp.thinking ? '\u2026' : ''); }
              });
              const got = (splitThinking(raw || (rv && rv.content) || '').answer || '').trim();
              if (got) break;            // got a real answer - stop retrying
              if (activeController && activeController.signal && activeController.signal.aborted) break; // user pressed Stop
            }
            const sp = splitThinking(raw || (rv && rv.content) || '');
            const finalText = (sp.answer || '').trim() || 'I could not get a result for that. Please try again.';
            ans.text = finalText;
            ans.thinking = sp.thinking;
            mem().add('assistant', maybeStripToolResult(finalText));
            sSearch.feed(finalText); sSearch.flush();
          }
        }
      } else if (action.action === 'generate_image') {
        const prompt = String(action.target || action.query || msg || '').trim();
        if (hasImageIntent(msg)) {
          // Explicit image request -> offer style choices first; the renderer triggers generation.
          activity.push({ kind: 'image_styles', id: 'imgreq_' + Date.now() + Math.floor(Math.random() * 1000), prompt: prompt, time: clockTime() });
          speak('What style would you like?');
        } else {
          // The model tried to make an image, but the user never actually asked for one.
          // Answer normally in plain text instead (no actions).
          const ans = { kind: 'said', text: '', thinking: '', time: clockTime() };
          activity.push(ans);
          streamingEntry = ans;
          aiStatus = 'thinking';
          let raw = '';
          const sImg = makeSpeaker();
          await streamChat({
            baseUrl: ai.baseUrl, apiKey: ai.apiKey, model: ai.model, temperature: cfg.temperature,
            messages: [{ role: 'system', content: cfg.systemPrompt + '\nReply in plain conversational text. Do not output JSON or any action.' }, ...history],
            signal: activeController.signal,
            onToken: (d) => { raw += d; const sp = splitThinking(raw); ans.thinking = sp.thinking; ans.text = sp.answer || (sp.thinking ? '\u2026' : ''); if (sp.answer) sImg.feed(sp.answer); }
          });
          const sp = splitThinking(raw);
          const finalText = (sp.answer || '').trim() || 'Sure - what would you like?';
          ans.text = finalText;
          ans.thinking = sp.thinking;
          mem().add('assistant', maybeStripToolResult(finalText));
          sImg.feed(finalText); sImg.flush();
        }
      } else {
        // open_app / open_url
        const result = await actions.run(action.action, action);
        activity.push({ kind: 'action', text: result.summary, time: clockTime() });
        const say = String(action.say || result.summary || 'Done.').trim();
        activity.push({ kind: 'said', text: say, time: clockTime() });
        mem().add('assistant', say);
        speak(say);
      }
    } else {
      const sp = splitThinking(full || said.text || '');
      const finalText = (sp.answer || '').trim();
      said.text = finalText;
      said.thinking = sp.thinking;
      mem().add('assistant', maybeStripToolResult(finalText));
      speaker.feed(finalText); // make sure the tail is up to date...
      speaker.flush();         // ...then speak any leftover partial sentence
    }
    return { ok: true };
  } catch (err) {
    if (err && err.name === 'AbortError') {
      if (said.text && said.text.trim()) mem().add('assistant', said.text);
      else { const i = activity.indexOf(said); if (i >= 0) activity.splice(i, 1); }
      return { ok: true, stopped: true };
    }
    const emsg = (err && err.message) || String(err);
    said.kind = 'action';
    said.text = '\u26A0 ' + emsg;
    return { ok: false, error: emsg };
  } finally {
    aiStatus = 'idle';
    streamingEntry = null;
    activeController = null;
  }
});

// ---- [OFFLINE-INTEGRATION] IPC: Ollama info for the AI Mode settings card ----
ipcMain.handle('ollama:models', async () => {
  try {
    const models = await ollama.listTags();
    return { ok: true, up: ollama.isUp(), models, vision: ollama.visionModels(models), picked: ollama.cachedVisionModel() };
  } catch (e) {
    return { ok: false, up: false, models: [], vision: [], picked: null, error: (e && e.message) || String(e) };
  }
});
ipcMain.handle('ollama:ensure', async () => {
  const r = await ollama.ensureRunning();
  await ollama.refresh().catch(() => {});
  if (r.ok) ollama.startMonitor(30000);
  return { ok: !!r.ok, up: ollama.isUp(), error: r.error || null, models: ollama.cachedTags() };
});

// The curated "offer to download" lists shown in the AI Mode dropdowns.
ipcMain.handle('ollama:catalog', () => ({ chat: ollama.CHAT_CATALOG, vision: ollama.VISION_CATALOG }));

// Download a local model in-app via `ollama pull`, streaming progress to the renderer so the
// settings UI can show a live percentage. Only one pull runs at a time (guarded in the UI).
let _ollamaPulling = false;
ipcMain.handle('ollama:pull', async (_e, model) => {
  const tag = String(model || '').trim();
  if (!tag) return { ok: false, error: 'No model was given.' };
  if (_ollamaPulling) return { ok: false, error: 'A download is already in progress - let it finish first.' };
  _ollamaPulling = true;
  const send = (msg) => { try { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('ollama:pull-progress', msg); } catch (_e2) {} };
  send({ model: tag, status: 'starting', percent: 0 });
  try {
    const r = await ollama.pullModel(tag, (p) => send(Object.assign({ model: tag }, p)));
    send(Object.assign({ model: tag, done: true }, r.ok ? { status: 'success', percent: 100 } : { status: 'error', error: r.error }));
    return r;
  } catch (e) {
    const err = (e && e.message) || String(e);
    send({ model: tag, done: true, status: 'error', error: err });
    return { ok: false, error: err };
  } finally {
    _ollamaPulling = false;
  }
});