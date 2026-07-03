// config.js
// BRAIN.AI - persisted settings (refined build).
// Stored as JSON in the OS user-data dir (survives app updates). All new keys are OPTIONAL
// and default to the original online behavior - existing settings.json files keep working.

const { app } = require('electron');
const fs = require('fs');
const path = require('path');

const FILE = path.join(app.getPath('userData'), 'settings.json');

// One code path, many providers - only the base URL + model change.
const PRESETS = {
  groq:       { baseUrl: 'https://api.groq.com/openai/v1',                         model: 'llama-3.3-70b-versatile' },
  gemini:     { baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-2.5-flash' },
  openai:     { baseUrl: 'https://api.openai.com/v1',                              model: 'gpt-4o-mini' },
  openrouter: { baseUrl: 'https://openrouter.ai/api/v1',                           model: 'meta-llama/llama-3.3-70b-instruct' }
};

const DEFAULTS = {
  provider: 'groq',
  baseUrl: PRESETS.groq.baseUrl,
  apiKey: '',
  model: PRESETS.groq.model,
  providerKeys: {},    // remembers each provider's API key
  providerModels: {},  // remembers each provider's chosen model
  temperature: 0.7,
  maxHistory: 12,      // REFINED: 20 -> 12. Smaller context window = fewer tokens per turn.
                       // Summarization (see lib/memory or main.js buildContext) recovers the
                       // lost long-term recall without paying for it on every request.
  tts_enabled: true,
  ttsEngine: 'browser',                   // 'browser' (built-in) or 'piper' (local neural)
  piperPath: '',
  piperModel: '',
  wakeWord: 'jarvis',
  open_mic_mode: false,                   // continuous listening on/off
  sttModel: 'whisper-large-v3',           // Groq speech-to-text (cloud)
  sttLanguage: 'en',
  visionModel: 'qwen/qwen3.6-27b',        // Groq multimodal (screen reading)
  // [OFFLINE-INTEGRATION] local-engine keys (all optional; safe defaults preserve online behavior)
  mode: 'online',                         // 'online' | 'offline'
  offlineModel: 'qwen2.5:7b',
  offlineVisionModel: '',
  useLocalVision: false,
  useLocalStt: false,
  offlineSttModel: '',                    // '' = auto-pick by RAM (tiny.en / base.en)
  separateOfflineChats: false,
  globalHotkey: 'CommandOrControl+Shift+Space',
  systemPrompt:
    'You are BRAIN, a sharp, friendly desktop AI companion. Be concise, warm, and ' +
    'genuinely helpful. Answer directly and admit when you are unsure.',

  // ===================== REFINED KEYS (this build) =====================
  //
  // All defaults below preserve the original behavior unless the user opts in. Existing
  // settings.json files that don't have these keys get them merged in on first load.

  // --- Token efficiency ---
  tokenBudget: 6000,                      // soft cap on estimated prompt tokens (history is truncated to fit)
  summarizeOldHistory: true,              // when history exceeds maxHistory, summarize the dropped turns into one system note
  stripToolResultsFromHistory: true,      // replace large tool outputs (file dumps, screenshot descriptions) with a short stub in memory
  visionJpegQuality: 60,                  // was effectively 80 via PIL; 60 is plenty for element location and ~30% smaller
  visionLocateMaxWidth: 1024,             // was 1280; 1024 keeps clicks accurate on most screens and saves bandwidth
  visionLocateRetryWidth: 1600,           // if first locate fails, retry at this wider width before giving up
  ocrFirstForText: true,                  // for "see_screen" of text-heavy screens, try a quick local OCR pass first; only fall back to the vision model if OCR finds nothing usable (saves a heavy multimodal call)

  // --- PC friendliness ---
  lazySidecar: true,                      // don't spawn automation.py at launch; spawn on first automation/transcribe/local-vision request
  statusPollMs: 2000,
  activityLogMax: 200,
  screenshotCacheMs: 1500,
  whisperAutoPickByRam: true,             // pick tiny.en (<12GB), base.en (12-24GB), small.en (>24GB) automatically
  whisperDeviceOverride: '',              // '' auto | 'cpu' | 'cuda' | 'metal'
  ollamaLazyStart: true,
  pollOllamaMs: 60000,

  // --- Voice input (the "random words from mic" fix) ---
  vadEnabled: true,                       // gate audio with a server-side energy/duration VAD (automation.py's /vad). Random words from silence/noise never reach Whisper.
  vadAggressiveness: 2,                   // 0=permissive .. 3=aggressive. 2 = good balance for a normal room.
  vadMinSpeechMs: 450,                    // drop clips shorter than this (Whisper hallucinates on <0.5s)
  vadMaxSilencePadMs: 300,                // trim leading/trailing silence down to this
  vadEnergyFloorDb: -45,                  // below this RMS (dBFS) = background noise, drop entirely
  whisperExtraHallucinationFilter: true,
  // In-window push-to-talk (single character key, works while BRAIN has focus) - this is the
  // ORIGINAL, already-wired PTT mechanism; keep its own key name so nothing that already
  // depends on it breaks.
  ptt_hotkey: '\\',
  // System-wide push-to-talk (works even when BRAIN is in the background) - built on a native
  // keyboard hook (uiohook-napi), since Electron's globalShortcut has no key-release event and
  // can't support "hold to talk" on its own. When OFF (default), the existing globalHotkey
  // behaves as a TOGGLE, same as always. When ON, that same combo (or pttHotkey if set) becomes
  // hold-to-talk instead, system-wide. Falls back to toggle mode automatically if the native
  // module can't load on this machine.
  pushToTalkMode: false,
  pttHotkey: '',                          // '' = reuse globalHotkey as the hold-to-talk combo

  // --- Automation reliability ---
  automationRateLimitCapMs: 30000,
  automationRateLimitBackoff: 'exp',      // 'fixed' (old) | 'exp' (1s,2s,4s,8s,16s capped)
  automationLocateRetries: 2,             // retry locate at higher res this many times before failing
  automationVerifyClicks: true,           // after a click, take a fresh screenshot and check for a visible state change; if none, retry once with a re-located target
  automationKeyboardFallback: true,       // if a click target can't be located after retries, try Tab/Enter shortcuts before giving up
  automationHighlightTarget: true,        // briefly draw a highlight box at the located coords before clicking
  automationHighlightMs: 450,
  automationStepSettleMs: 700,
  automationPerStepRetry: true,
  // existing keys (kept for back-compat with the original Settings UI toggles)
  allow_mouse_control: false,
  allow_system_scripting: false,
  memory_saving_enabled: true,
  local_wake_enabled: false,
  local_wake_threshold: 0.5,
  speech_rate: 195,
  memory_budget_gb: 5,
  assistantName: '',
  accentColor: '#7fd1ff',
  overlayPanelBounds: null,
  overlayBubblePos: null,
  mediaAllowed: false
};

let cache = null;

function load() {
  try {
    const saved = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    // Deep-ish merge: DEFAULTS as the base, saved keys override. New DEFAULTS keys appear
    // automatically for users upgrading from an older settings.json.
    cache = Object.assign({}, DEFAULTS, saved);
  } catch (_e) {
    cache = Object.assign({}, DEFAULTS);
  }
  return cache;
}

function get() {
  return cache || load();
}

function set(patch) {
  const next = Object.assign({}, get(), patch);
  cache = next;
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(next, null, 2));
  } catch (_e) { /* non-fatal */ }
  return next;
}

module.exports = { get, set, load, PRESETS, DEFAULTS };