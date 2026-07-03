// lib/downloads.js
// The one registry of every heavy on-demand asset. The installer ships code only; this
// module answers "what's installed?" and "start installing X" for the Engines & Models
// panel and onboarding. It orchestrates the EXISTING downloaders (ollama.pullModel, the
// wake-word ensure function, the Piper voice installer) rather than reimplementing them.
const fs = require('fs');
const os = require('os');
const path = require('path');

// deps injected once from main.js so this file needs no Electron imports of its own:
// { config, ollama, defaultOfflineModel, wakewordDir, wakewordFiles,
//   ensureWakeword(onProgress), sidecarGet(path), sidecarWarmStt(model),
//   ollamaModelsDir?(), hfHubDir?() } - the last two default to the real cache locations
//   and exist so tests can point at temp dirs.
let D = null;
function init(deps) { D = deps; }

function fileOk(p) { try { return fs.statSync(p).size > 1000; } catch (_e) { return false; } }

// ---- Disk-level truth for "is it installed?" ----
// Ollama and the Python sidecar are lazy-started, so at panel-open they're usually DOWN.
// Asking only the live services made every installed model show "Download" on each launch
// (and pressing Download just started the service and rediscovered it). The disk doesn't
// need anything running.

function ollamaModelsDir() {
  if (D.ollamaModelsDir) return D.ollamaModelsDir();
  return process.env.OLLAMA_MODELS || path.join(os.homedir(), '.ollama', 'models');
}
function hfHubDir() {
  if (D.hfHubDir) return D.hfHubDir();
  if (process.env.HF_HUB_CACHE) return process.env.HF_HUB_CACHE;
  if (process.env.HF_HOME) return path.join(process.env.HF_HOME, 'hub');
  return path.join(os.homedir(), '.cache', 'huggingface', 'hub');
}

// A pulled Ollama model leaves a manifest file at manifests/registry.ollama.ai/library/<name>/<tag>.
function ollamaModelOnDisk(model) {
  const parts = String(model || '').split(':');
  const p = path.join(ollamaModelsDir(), 'manifests', 'registry.ollama.ai', 'library', parts[0], parts[1] || 'latest');
  try { return fs.statSync(p).size > 0; } catch (_e) { return false; }
}

// faster-whisper caches via huggingface_hub: models--Systran--faster-whisper-<size>/snapshots/<rev>/.
function whisperOnDisk() {
  try {
    return fs.readdirSync(hfHubDir()).some((d) => {
      if (d.indexOf('models--Systran--faster-whisper-') !== 0) return false;
      try { return fs.readdirSync(path.join(hfHubDir(), d, 'snapshots')).length > 0; } catch (_e) { return false; }
    });
  } catch (_e) { return false; }
}

async function status() {
  const cfg = D.config.get();
  // Actively probe Ollama first: its cached up-state is stale at panel-open (lazy start),
  // which made installed models flash "Download" until some later action refreshed it. A
  // real refresh here means the FIRST render is accurate.
  let up = D.ollama.isUp();
  if (!up) { try { const r = await D.ollama.refresh(); up = !!(r && r.up); } catch (_e) {} }
  const tags = up ? await D.ollama.listTags().catch(() => []) : [];
  const chatModel = cfg.offlineModel || D.defaultOfflineModel;
  const visionModel = cfg.offlineVisionModel || 'moondream';
  const stt = await D.sidecarGet('/stt_status').catch(() => null); // null = sidecar not running
  const wwDir = D.wakewordDir();
  const wwSelected = cfg.wakeWordModel || 'hey_jarvis_v0.1.onnx';
  const wwInstalled = D.wakewordFiles().every((f) => fileOk(path.join(wwDir, f))) && fileOk(path.join(wwDir, wwSelected));
  const hasTag = (m) => tags.some((t) => String(t) === m || String(t).indexOf(m + ':') === 0 || String(t).indexOf(m) === 0);
  return [
    { id: 'ollama-runtime', label: 'Ollama runtime', sizeMB: 700,
      installed: up || !!D.ollama.findExe(),
      detail: up ? 'Running' : (D.ollama.findExe() ? 'Starts when needed' : '') },
    { id: 'chat-model', label: 'Offline chat model (' + chatModel + ')', sizeMB: 4700,
      installed: hasTag(chatModel) || ollamaModelOnDisk(chatModel),
      detail: '' },
    { id: 'vision-model', label: 'Offline vision model (' + visionModel + ')', sizeMB: 1700,
      installed: hasTag(visionModel) || ollamaModelOnDisk(visionModel),
      detail: '' },
    { id: 'whisper-stt', label: 'Offline voice input (faster-whisper)', sizeMB: 75,
      installed: !!(stt && stt.available && (stt.cached || []).length) || whisperOnDisk(),
      detail: (stt && !stt.available) ? 'Python package missing' : '' },
    { id: 'piper-voice', label: 'Offline voice output (Piper)', sizeMB: 110,
      installed: !!(cfg.piperPath && cfg.piperModel && fileOk(cfg.piperModel)),
      detail: cfg.piperModel ? path.basename(cfg.piperModel) : '' },
    { id: 'wakeword-models', label: 'Wake-word models', sizeMB: 6,
      installed: wwInstalled, detail: wwSelected }
  ];
}

// Returns {ok} / {ok:false,error} / {ok:true,external:true} (= caller opens a browser page,
// e.g. the Ollama installer - we never silently install other vendors' software).
async function start(id, onProgress) {
  const cfg = D.config.get();
  const send = (msg) => { try { onProgress(msg); } catch (_e) {} };
  if (id === 'ollama-runtime') return { ok: true, external: true };
  if (id === 'chat-model' || id === 'vision-model') {
    const model = id === 'chat-model' ? (cfg.offlineModel || D.defaultOfflineModel) : (cfg.offlineVisionModel || 'moondream');
    if (!D.ollama.isUp()) return { ok: false, error: 'Ollama isn’t running - install/start it first.' };
    await D.ollama.pullModel(model, send);
    return { ok: true };
  }
  if (id === 'whisper-stt') {
    send('Preparing local voice input… (first time downloads ~75 MB)');
    const r = await D.sidecarWarmStt(cfg.offlineSttModel || 'base.en').catch((e) => ({ ok: false, error: String((e && e.message) || e) }));
    return r && r.ok ? { ok: true } : { ok: false, error: (r && r.error) || 'sidecar unavailable' };
  }
  if (id === 'wakeword-models') {
    const r = await D.ensureWakeword(send);
    return r && r.ok ? { ok: true } : { ok: false, error: (r && r.error) || 'download failed' };
  }
  if (id === 'piper-voice') return { ok: false, error: 'use-voice-installer' }; // panel routes to the existing voice installer UI
  return { ok: false, error: 'unknown asset: ' + id };
}

module.exports = { init, status, start };
