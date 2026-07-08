// Settings, stored as JSON in the OS user-data dir (survives app updates).
const { app } = require('electron');
const fs = require('fs');
const path = require('path');

const FILE = path.join(app.getPath('userData'), 'settings.json');

// One code path, many providers - only the base URL + model change. This is also the
// hook for a future local "Ghost Mode": point baseUrl at a bundled local server.
const PRESETS = {
  groq:       { baseUrl: 'https://api.groq.com/openai/v1',                         model: 'llama-3.3-70b-versatile' },
  gemini:     { baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-2.5-flash' },
  openai:     { baseUrl: 'https://api.openai.com/v1',                              model: 'gpt-4o-mini' },
  openrouter: { baseUrl: 'https://openrouter.ai/api/v1',                           model: 'meta-llama/llama-3.3-70b-instruct' }
};

const DEFAULTS = {
  // NOTE: `engines` (per-capability hybrid routing, see lib/engines.js) is deliberately
  // NOT defaulted here: main.js derives it from the legacy flags (mode/useLocalVision/...)
  // on first boot. A default here would mask a legacy offline config as "already online".
  onboarded: false,                        // first-launch wizard completed (or skipped)
  osVariant: '',                           // '' = not yet detected; 'win10' | 'win11' | 'other'
  wakeWordModel: 'hey_jarvis_v0.1.onnx',   // which openWakeWord classifier to run
  provider: 'groq',
  baseUrl: PRESETS.groq.baseUrl,
  apiKey: '',
  model: PRESETS.groq.model,
  providerKeys: {},   // remembers each provider's API key: { groq:'...', gemini:'...' }
  providerModels: {}, // remembers each provider's chosen model
  temperature: 0.7,
  maxHistory: 20, // how many past turns to send as context
  tts_enabled: true,
  ttsEngine: 'browser',                    // 'browser' (built-in) or 'piper' (local neural)
  piperPath: '',                           // full path to piper executable (piper.exe)
  piperModel: '',                          // full path to a piper voice .onnx model
  wakeWord: 'jarvis',                      // open-mic activation word
  open_mic_mode: false,                    // continuous listening on/off
  sttModel: 'whisper-large-v3',            // Groq speech-to-text
  sttLanguage: 'en',                       // force transcription language ('auto' to detect)
  visionModel: 'qwen/qwen3.6-27b',         // Groq multimodal (screen reading)
  globalHotkey: 'CommandOrControl+Shift+Space', // system-wide voice toggle (works in background)
  automationRequirePlanApproval: false, // false = run requested tasks directly; true = propose a plan and wait
  theme: 'cyanHud',                        // base theme (see renderer/theme.css)
  // accentColor holds a NAMED accent ('cyan'|'blue'|'white'|'teal'|'amber'|'violet').
  // Old hex values are migrated to the nearest name in main.js at boot.
  accentColor: 'cyan',
  systemPrompt:
    'You are Caryl, a sharp, friendly desktop AI companion. Be concise, warm, and ' +
    'genuinely helpful. Answer directly and admit when you are unsure.',
  // Hybrid Automation Kernel - API_NATIVE weather. No key => the weather task returns a
  // "add your key in Settings" message (never a browser fallback, per the logic/API rule).
  openWeatherApiKey: '',
  weatherUnits: 'metric',                  // 'metric' (°C, m/s) or 'imperial' (°F, mph)
  weatherDefaultLocation: '',              // used when a request names no city
  weatherCardScale: 0.65,                  // weather board size: 0.65..1.0 of the work area
  weatherBoardBounds: null,                // last dragged/resized board bounds (validated on use)
  // 7-Agent swarm visualization. Setting false hides all 6 background sub-agent
  // orbs (the main owl/center orb is unaffected — the user explicitly wanted
  // the central orb kept "along side" the sub-agents).
  swarmShowOrbs: true,
  // REFINED (D3): coder auto-apply gate. Even though `coder:apply` IPC requires
  // `confirmed:true` per-request, a session-long auto-apply toggle lets power
  // users skip the per-patch modal for trusted Coder proposals.
  coderAutoApply: false,
  // D3: Real 3D generation via Meshy.ai / Tripo3D / a custom REST endpoint.
  // Settings-stored defaults; environment variables MESHY_API_KEY and
  // TRIPO_API_KEY take precedence at runtime when present (CI / headless).
  threeDProvider: 'meshy',          // 'meshy' | 'tripo' | 'custom'
  meshApiKey: '',
  tripoApiKey: '',
  threeDCustomUrl: '',              // POST endpoint for the custom provider
  threeDCustomKey: '',              // bearer token for the custom provider
  threeDCustomTemplate: '',         // optional JSON template; {{image_data_url}} substitution
  threeDFormat: 'glb',              // 'glb' | 'obj' | 'fbx' — what the renderer expects
  threeDModelPoly: 'high',          // Meshy only: 'low' | 'high'
  // D4: Honest-mode toggle for the camera's health / diet analyzer. Off by
  // default — enables the "Estimate calories" and "Physique check" buttons.
  healthHonestMode: true,
  // D5: Real-time research overlay. When false the renderer never auto-opens
  // the floating blue glass window from swarm:events; the user can still open
  // it manually. The window itself is created lazily by main.js.
  researchOverlayAutoOpen: true,

  // ===== Smart Audio & Voice Interaction (4) =====
  // (1) Continuous Listening State - after wake word fires, mic stays open through
  // the whole conversation; auto-rearms after each TTS reply; tears down on
  // close-phrase or cumulative silence past conversationTimeoutMs. Skip wake
  // word on every follow-up turn until the user closes the conversation.
  continuousListening: true,
  conversationTimeoutMs: 10000,           // cumulative non-speech before close
  // Verbatim close phrases that end a conversation even while VAD still hears
  // breathing. Tight on purpose - "thanks" with comma continues, "thanks." ends.
  conversationClosePhrases: ['thanks.', 'thank you.', 'thanks!', 'thank you!',
                             "that's all.", "that's all!", "that's it.",
                             "that's it!", 'stop listening.', 'goodbye.',
                             'good night.', 'end conversation.', 'finish.',
                             'done.', "we're done."],
  // (2) Context-Aware Filtering - when in conversation mode, ambiguous short
  // transcripts trigger a spoken "Were you speaking to me?" instead of being
  // piped to the chat. Heuristic flags pronouns/imperative/int length.
  contextAwareFiltering: true,
  // Words whose presence at the start of a transcript marks the turn as
  // clearly-directed. Anything else with length < addressMaxLenChars counts
  // as "ambiguous" - that's the small class the assistant politely clarifies.
  addressStartsWith: ['caryl','jarvis','hey','what','how','why','when','where','who',
                      'can','could','would','will','do','does','did','is','are','am',
                      'should','tell','show','open','close','turn','stop','start',
                      'play','pause','search','find','send','message','call','remind',
                      'schedule','set','make','create','delete','remove','add','book',
                      'order','buy','read','write','run','launch','quit'],
  addressMaxLenChars: 28,
  // (3) Noise Rejection - dynamic ambient RMS floor in the sidecar /vad, plus
  // tighter Whisper segment filters (no_speech_prob / avg_logprob). All on by
  // default; flipping them off restores the previous behavior exactly.
  dynamicNoiseFloor: true,                // adaptive /vad floor from 30 ms frames
  noiseFloorMarginDb: 10,                 // peak must exceed floor by this much
  whisperNoSpeechProbMax: 0.65,           // drop segments where whisper is unsure
  whisperAvgLogprobMin: -1.0,             // drop segments with low-avg logprob
  // (4) Speaker Recognition (Optional / opt-in) - wake-word fire is gated on
  // cosine similarity between the live Google speech embedding and the saved
  // print. Enrollment happens automatically during onboarding's wake-word
  // step - this toggle controls whether the print is REQUIRED (off = ignore).
  speakerRecognition: false,
  speakerMatchThreshold: 0.70,            // cosine sim gate; expose as Settings slider
  userVoicePrint: null,                   // [96] Float32Array, private, mean-pool centroid
  voiceEnrollmentDone: false,             // onboarding step captured >= 3 enrollment takes

  // ===== Anti-abuse / rate-limit safeguards =====
  // When Gemini's anti-abuse layer flags our traffic as automated, the IP
  // gets blocked with "unusual traffic from your computer network". To
  // keep that page from appearing we:
  //   1. Send every outbound request with a real User-Agent (already done
  //      in lib/providers.js).
  //   2. Drop a 60-90s cool-down on the host when a 429 or the page-block
  //      message comes back (so we don't pile on more requests during the
  //      bad window).
  //   3. Short-circuit swarm Critic retries on rate-limit-shaped errors
  //      (saves 1-2 extra Gemini calls per failed dispatch).
  //   4. Cap the swarm's default maxRetries at 2 (was 3).
  // Toggles the user can flip if they want to opt out / dial down further:
  antiAbuseEnabled: true,                 // master switch — if false, providers.js skips cooldown gate
  geminiRpmCap: 30,                       // token-bucket refill rate per minute (Gemini free tier is 60 RPM)
  geminiUnusualTrafficCooldownMs: 90000,  // 90s cool-down on full anti-abuse page trip
  geminiSoftCooldownMs: 30000,            // 30s cool-down on plain 429
  swarmMaxRetriesDefault: 2,              // was 3 — capped to reduce bursty retry loops
};

let cache = null;

function load() {
  try {
    cache = Object.assign({}, DEFAULTS, JSON.parse(fs.readFileSync(FILE, 'utf8')));
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