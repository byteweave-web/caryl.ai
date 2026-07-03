// lib/engines.js
// Per-capability hybrid engine routing: chat / vision / stt / tts each resolve to
// 'online' (cloud API) or 'offline' (local model) independently. Pure functions over a
// plain config object so this file is testable with node alone (no Electron import).
// main.js is the only consumer; it wraps these with its live config + ollama state.

const CAPABILITIES = ['chat', 'vision', 'stt', 'tts'];

// Map the pre-Caryl flags (mode / useLocalVision / useLocalStt / ttsEngine) onto the
// engines object, exactly preserving the old semantics. Used once at migration time and
// as the fallback for configs that predate `engines`.
function deriveFromLegacy(cfg) {
  cfg = cfg || {};
  const offline = (cfg.mode || 'online') === 'offline';
  return {
    chat: offline ? 'offline' : 'online',
    vision: (offline || cfg.useLocalVision === true) ? 'offline' : 'online',
    stt: (offline || cfg.useLocalStt === true) ? 'offline' : 'online',
    tts: cfg.ttsEngine === 'piper' ? 'offline' : 'online'
  };
}

function isValidEngines(engines) {
  return !!engines && CAPABILITIES.every((c) => engines[c] === 'online' || engines[c] === 'offline');
}

// Returns a guaranteed-valid engines object. changed=true means the caller should persist it.
function normalizeEngines(cfg) {
  cfg = cfg || {};
  if (isValidEngines(cfg.engines)) return { engines: cfg.engines, changed: false };
  return { engines: deriveFromLegacy(cfg), changed: true };
}

function resolveEngine(cfg, capability) {
  const { engines } = normalizeEngines(cfg);
  return engines[capability] === 'offline' ? 'offline' : 'online';
}

// Synchronous readiness check. ctx carries the live facts only main.js knows:
//   ollamaUp (bool), localVisionModel (string|''), piperConfigured (bool)
// STT offline readiness can't be known synchronously (sidecar probe is async), so it
// reports ready:true and the runtime path keeps its existing graceful fallback.
function engineReady(cfg, capability, ctx) {
  cfg = cfg || {}; ctx = ctx || {};
  const mode = resolveEngine(cfg, capability);
  if (mode === 'online') {
    if (capability === 'tts') return { ready: true, reason: '' }; // browser voice always exists
    return cfg.apiKey ? { ready: true, reason: '' } : { ready: false, reason: 'No API key saved (Settings → AI Engine).' };
  }
  // offline paths
  if (capability === 'chat') {
    return ctx.ollamaUp ? { ready: true, reason: '' } : { ready: false, reason: 'Ollama isn’t running.' };
  }
  if (capability === 'vision') {
    if (!ctx.ollamaUp) return { ready: false, reason: 'Ollama isn’t running.' };
    if (!ctx.localVisionModel) return { ready: false, reason: 'No local vision model installed.' };
    return { ready: true, reason: '' };
  }
  if (capability === 'tts') {
    return ctx.piperConfigured ? { ready: true, reason: '' } : { ready: false, reason: 'No Piper voice installed.' };
  }
  return { ready: true, reason: '' }; // stt (see note above) and unknowns
}

module.exports = { CAPABILITIES, deriveFromLegacy, normalizeEngines, resolveEngine, engineReady };
