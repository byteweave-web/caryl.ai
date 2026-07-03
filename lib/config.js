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
  systemPrompt:
    'You are Caryl, a sharp, friendly desktop AI companion. Be concise, warm, and ' +
    'genuinely helpful. Answer directly and admit when you are unsure.'
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