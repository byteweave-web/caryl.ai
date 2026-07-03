// lib/downloads.js
// The one registry of every heavy on-demand asset. The installer ships code only; this
// module answers "what's installed?" and "start installing X" for the Engines & Models
// panel and onboarding. It orchestrates the EXISTING downloaders (ollama.pullModel, the
// wake-word ensure function, the Piper voice installer) rather than reimplementing them.
const fs = require('fs');
const path = require('path');

// deps injected once from main.js so this file needs no Electron imports of its own:
// { config, ollama, defaultOfflineModel, wakewordDir, wakewordFiles,
//   ensureWakeword(onProgress), sidecarGet(path), sidecarWarmStt(model) }
let D = null;
function init(deps) { D = deps; }

function fileOk(p) { try { return fs.statSync(p).size > 1000; } catch (_e) { return false; } }

async function status() {
  const cfg = D.config.get();
  const tags = D.ollama.isUp() ? await D.ollama.listTags().catch(() => []) : [];
  const chatModel = cfg.offlineModel || D.defaultOfflineModel;
  const visionModel = cfg.offlineVisionModel || 'moondream';
  const stt = await D.sidecarGet('/stt_status').catch(() => null); // null = sidecar not running
  const wwDir = D.wakewordDir();
  const wwSelected = cfg.wakeWordModel || 'hey_jarvis_v0.1.onnx';
  const wwInstalled = D.wakewordFiles().every((f) => fileOk(path.join(wwDir, f))) && fileOk(path.join(wwDir, wwSelected));
  const hasTag = (m) => tags.some((t) => String(t) === m || String(t).indexOf(m + ':') === 0 || String(t).indexOf(m) === 0);
  return [
    { id: 'ollama-runtime', label: 'Ollama runtime', sizeMB: 700,
      installed: D.ollama.isUp() || !!D.ollama.findExe(),
      detail: D.ollama.isUp() ? 'running' : (D.ollama.findExe() ? 'installed (not running)' : 'not installed') },
    { id: 'chat-model', label: 'Offline chat model (' + chatModel + ')', sizeMB: 4700,
      installed: hasTag(chatModel),
      detail: D.ollama.isUp() ? '' : 'needs Ollama running to check' },
    { id: 'vision-model', label: 'Offline vision model (' + visionModel + ')', sizeMB: 1700,
      installed: hasTag(visionModel),
      detail: D.ollama.isUp() ? '' : 'needs Ollama running to check' },
    { id: 'whisper-stt', label: 'Offline voice input (faster-whisper)', sizeMB: 75,
      installed: !!(stt && stt.available && (stt.cached || []).length),
      detail: stt ? (stt.available ? ((stt.cached || []).length ? 'model cached' : 'installed, no model cached yet') : 'python package missing') : 'sidecar not running' },
    { id: 'piper-voice', label: 'Offline voice output (Piper)', sizeMB: 110,
      installed: !!(cfg.piperPath && cfg.piperModel && fileOk(cfg.piperModel)),
      detail: cfg.piperModel ? path.basename(cfg.piperModel) : 'no voice installed' },
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
