// lib/ollama.js
// [OFFLINE-INTEGRATION] Local AI engine management for BRAIN.AI's offline mode.
//
// Ported from the old Python offline build (brain.py + speculative.py) into pure Node so
// the Electron main process can drive Ollama directly. Nothing here requires Electron -
// paths (like the userData dir for the turbo-model marker) are passed in by the caller.
//
// What this module does:
//   - find the ollama executable (PATH + common Windows install locations)
//   - start `ollama serve` ourselves WITH the perf/VRAM flags from the old offline build
//     (flash attention, q8 KV cache, single parallel request, warm keep-alive) - but only
//     if a server isn't already running; a user's own Ollama is left alone
//   - cached "is it up" state + installed model tags, refreshed by a background monitor
//     (NOT per status poll - the UI polls status ~1/s and must never hammer Ollama)
//   - auto-detect the best installed local VISION model (same candidate order as brain.py)
//   - warm / unload models on switch so only the selected model stays resident on a small GPU
//   - one-time speculative-decoding "turbo" model builds (FROM <target> + DRAFT <draft>),
//     ported from speculative.py - identical output to the big model, just faster.

const { spawn, spawnSync, execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOST = '127.0.0.1';
const PORT = 11434;
const BASE = 'http://' + HOST + ':' + PORT;
const BASE_V1 = BASE + '/v1'; // OpenAI-compatible endpoint - streamChat() talks to this

// Same env the old brain.py used when it launched the server itself. Applies ONLY to a
// server THIS app starts; an already-running Ollama keeps its own settings.
const PERF_ENV = {
  OLLAMA_FLASH_ATTENTION: '1',
  OLLAMA_KV_CACHE_TYPE: 'q8_0',
  OLLAMA_NUM_PARALLEL: '1',
  OLLAMA_MAX_LOADED_MODELS: '3', // brain + a small vision model + embed can coexist
  OLLAMA_KEEP_ALIVE: '30m'
};

// Vision model auto-detect order - lightest first so it can coexist with the chat model
// on a 6GB GPU. Copied from brain.py's VISION_MODEL_CANDIDATES (llama3.2-vision stays
// excluded: its 'mllama' architecture needs an Ollama update, not just a pull).
const VISION_CANDIDATES = [
  'moondream',
  'llava',
  'minicpm-v',
  'bakllava',
  'llava-llama3',
  'llava:7b',
  'llava:13b',
  'llava:34b'
];

// Speculative decoding turbo specs - ported from speculative.py.
// [turboName, targetModel, [draft candidates - same family / best first]]
const TURBO_SPECS = [
  ['qwen2.5-14b-turbo', 'qwen2.5:14b', ['qwen2.5:0.5b', 'qwen2.5:1.5b']],
  ['deepseek-r1-14b-turbo', 'deepseek-r1:14b', ['deepseek-r1:1.5b', 'qwen2.5:0.5b', 'qwen2.5:1.5b']]
];
const TURBO_MARKER = '.speculative_attempted';

// Curated models the app can offer to download for the user (via `ollama pull`), so they
// never have to touch a terminal. Kept small and sensible; sizes are approximate download
// sizes just for the UI. The user can still pull anything else themselves - this is only
// the "offer some good options" list the settings dropdown shows.
const CHAT_CATALOG = [
  { tag: 'qwen2.5:7b',      label: 'Qwen2.5 7B - balanced default',        size: '4.7 GB' },
  { tag: 'llama3.2:3b',     label: 'Llama 3.2 3B - small & fast',          size: '2.0 GB' },
  { tag: 'llama3.1:8b',     label: 'Llama 3.1 8B - solid all-rounder',     size: '4.9 GB' },
  { tag: 'qwen2.5:14b',     label: 'Qwen2.5 14B - smarter, needs more RAM', size: '9.0 GB' },
  { tag: 'gemma2:9b',       label: 'Gemma 2 9B - Google, capable',         size: '5.4 GB' },
  { tag: 'mistral:7b',      label: 'Mistral 7B - lean & quick',            size: '4.1 GB' },
  { tag: 'phi3.5',          label: 'Phi-3.5 - tiny but sharp',             size: '2.2 GB' },
  { tag: 'deepseek-r1:7b',  label: 'DeepSeek-R1 7B - reasoning',           size: '4.7 GB' }
];
const VISION_CATALOG = [
  { tag: 'moondream',       label: 'Moondream - tiny, fits small GPUs',    size: '1.7 GB' },
  { tag: 'llava',           label: 'LLaVA 7B - general vision',            size: '4.7 GB' },
  { tag: 'minicpm-v',       label: 'MiniCPM-V - strong OCR/detail',        size: '5.5 GB' },
  { tag: 'llava:13b',       label: 'LLaVA 13B - more accurate',           size: '8.0 GB' }
];

let _proc = null;            // the `ollama serve` process WE started (null if external/none)
let _up = false;             // cached: did the last health check succeed?
let _tags = [];              // cached: installed model tags from the last refresh
let _visionModel = null;     // cached: best installed vision model (from _tags)
let _monitor = null;         // background refresh timer

function _fetchTimeout(url, opts, ms) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms || 2500);
  return fetch(url, Object.assign({}, opts || {}, { signal: ac.signal }))
    .finally(() => clearTimeout(t));
}

function findExe() {
  // 1) PATH
  try {
    const cmd = process.platform === 'win32' ? 'where' : 'which';
    const r = spawnSync(cmd, ['ollama'], { encoding: 'utf8', windowsHide: true, timeout: 4000 });
    if (r.status === 0 && r.stdout) {
      const first = r.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
      if (first && fs.existsSync(first)) return first;
    }
  } catch (_e) { /* fall through */ }
  // 2) common Windows install locations (same list as brain.py)
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA || '';
    const candidates = [
      path.join(local, 'Programs', 'Ollama', 'ollama.exe'),
      'C:\\Program Files\\Ollama\\ollama.exe',
      path.join(local, 'Ollama', 'ollama.exe')
    ];
    for (const c of candidates) {
      try { if (c && fs.existsSync(c)) return c; } catch (_e) {}
    }
  }
  return null;
}

async function serverUp(timeoutMs) {
  try {
    const res = await _fetchTimeout(BASE + '/api/version', {}, timeoutMs || 1500);
    return res.ok;
  } catch (_e) {
    return false;
  }
}

// Refresh the cached up-state, installed tags, and auto-detected vision model.
async function refresh() {
  _up = await serverUp();
  if (!_up) return { up: false, models: _tags };
  try {
    const res = await _fetchTimeout(BASE + '/api/tags', {}, 4000);
    if (res.ok) {
      const j = await res.json();
      const names = [];
      for (const m of (j && j.models) || []) {
        const tag = m && (m.name || m.model);
        if (tag) names.push(tag);
      }
      _tags = names.sort();
      _visionModel = pickVisionModel(_tags);
    }
  } catch (_e) { /* keep last known tags */ }
  return { up: _up, models: _tags };
}

// Pick the best installed vision model, matching by base name (before the ':').
function pickVisionModel(tags) {
  const list = tags || _tags || [];
  const baseOf = (t) => String(t).split(':')[0].toLowerCase();
  for (const cand of VISION_CANDIDATES) {
    const candBase = cand.split(':')[0].toLowerCase();
    // exact tag match first (e.g. 'llava:13b'), then base-name match (any tag of 'moondream')
    const exact = list.find((t) => String(t).toLowerCase() === cand.toLowerCase());
    if (exact) return exact;
    const byBase = list.find((t) => baseOf(t) === candBase);
    if (byBase) return byBase;
  }
  return null;
}

// All installed models that look like vision models (for the settings dropdown).
function visionModels(tags) {
  const list = tags || _tags || [];
  const bases = VISION_CANDIDATES.map((c) => c.split(':')[0].toLowerCase());
  return list.filter((t) => bases.indexOf(String(t).split(':')[0].toLowerCase()) !== -1);
}

// Start the server ourselves (with perf flags) if nothing is answering yet.
async function ensureRunning() {
  if (await serverUp()) { _up = true; return { ok: true, external: _proc === null }; }
  const exe = findExe();
  if (!exe) {
    _up = false;
    return { ok: false, error: 'Ollama is not installed (or not on PATH). Install it from ollama.com, then try again.' };
  }
  try {
    const env = Object.assign({}, process.env, PERF_ENV);
    _proc = spawn(exe, ['serve'], { env, windowsHide: true, stdio: 'ignore' });
    _proc.on('exit', () => { _proc = null; });
    console.log('[ollama] starting server with optimized flags (flash attention, q8 KV cache, single request, warm models)...');
  } catch (e) {
    _proc = null;
    return { ok: false, error: 'Could not launch the Ollama server: ' + ((e && e.message) || e) };
  }
  // wait up to ~30s for it to come up (same window as brain.py)
  for (let i = 0; i < 60; i++) {
    if (await serverUp()) {
      await new Promise((r) => setTimeout(r, 500)); // grace so the API is fully ready
      _up = true;
      console.log('[ollama] server is up.');
      return { ok: true, external: false };
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return { ok: false, error: 'The Ollama server did not respond within 30s - it may still be starting.' };
}

// Stop the server ONLY if this app started it (a user's own Ollama is left alone).
function stopIfOurs() {
  if (_proc) {
    try { _proc.kill(); } catch (_e) {}
    _proc = null;
  }
  if (_monitor) { clearInterval(_monitor); _monitor = null; }
}

// Keep _up/_tags/_visionModel fresh in the background so ui:status (polled ~1/s) can
// read cached values without ever making a network call itself.
function startMonitor(intervalMs) {
  if (_monitor) return;
  _monitor = setInterval(() => { refresh().catch(() => {}); }, Math.max(5000, intervalMs || 30000));
}

async function listTags() {
  await refresh();
  return _tags.slice();
}

// Pre-load `model` into VRAM so the first real message doesn't pay a cold load.
async function warm(model) {
  if (!model) return;
  try {
    await _fetchTimeout(BASE + '/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'hi' }],
        stream: false,
        keep_alive: '15m',
        options: { num_predict: 1, num_ctx: 4096 }
      })
    }, 120000);
    console.log('[ollama] warmed ' + model + ' - first reply will be fast.');
  } catch (e) {
    console.warn('[ollama] warm-up skipped for ' + model + ': ' + ((e && e.message) || e));
  }
}

// Drop a model from VRAM now (keep_alive: 0) - used on model switch so only the
// selected model stays resident on a small GPU.
async function unload(model) {
  if (!model) return;
  try {
    await _fetchTimeout(BASE + '/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, prompt: '', stream: false, keep_alive: 0 })
    }, 15000);
  } catch (_e) { /* best effort */ }
}

// Free the old model, warm the new one (ported from brain.py's switch_brain_model).
async function switchModel(oldModel, newModel) {
  if (oldModel && oldModel !== newModel) await unload(oldModel);
  await warm(newModel);
}

// Download (pull) a model through Ollama's own API so the user never needs a terminal.
// Streams NDJSON progress lines; `onProgress({status, percent, completedBytes, totalBytes})`
// is called as they arrive. Resolves {ok:true} on success or {ok:false, error} on failure.
async function pullModel(model, onProgress) {
  const tag = String(model || '').trim();
  if (!tag) return { ok: false, error: 'No model was given.' };
  if (!(await serverUp())) {
    const r = await ensureRunning();
    if (!r.ok) return { ok: false, error: r.error || 'Ollama is not running.' };
  }
  const emit = (o) => { try { if (typeof onProgress === 'function') onProgress(o); } catch (_e) {} };
  try {
    const res = await fetch(BASE + '/api/pull', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: tag, stream: true })
    });
    if (!res.ok || !res.body) {
      return { ok: false, error: 'Ollama pull failed (HTTP ' + res.status + ').' };
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let lastErr = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const raw of lines) {
        const line = raw.trim();
        if (!line) continue;
        let j;
        try { j = JSON.parse(line); } catch (_e) { continue; }
        if (j.error) { lastErr = j.error; continue; }
        const total = Number(j.total) || 0;
        const completed = Number(j.completed) || 0;
        const percent = total > 0 ? Math.min(100, Math.round((completed / total) * 100)) : null;
        emit({ status: j.status || '', percent, completedBytes: completed, totalBytes: total });
      }
    }
    if (lastErr) return { ok: false, error: lastErr };
    await refresh().catch(() => {});
    emit({ status: 'success', percent: 100, completedBytes: 0, totalBytes: 0 });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
}

// One-time speculative-decoding turbo builds (ported from speculative.py). Best-effort:
// any failure is logged and ignored; a marker file prevents retrying every launch.
async function ensureTurboModels(markerDir) {
  try {
    const marker = path.join(markerDir || os.tmpdir(), TURBO_MARKER);
    if (fs.existsSync(marker)) return;
    const tags = await listTags();
    if (!tags.length) return; // Ollama unreachable / nothing installed - try again next boot
    const exe = findExe();
    if (!exe) return;
    let attempted = false;
    for (const [name, target, drafts] of TURBO_SPECS) {
      if (tags.indexOf(name) !== -1) continue;      // already built
      if (tags.indexOf(target) === -1) continue;    // target model not installed
      const draft = drafts.find((d) => tags.indexOf(d) !== -1);
      if (!draft) {
        console.log('[ollama] turbo skip \'' + name + '\': have ' + target + ' but no draft installed (want one of ' + drafts.join(', ') + ')');
        continue;
      }
      attempted = true;
      const tmp = path.join(os.tmpdir(), 'brain_turbo_' + Date.now() + '.Modelfile');
      try {
        fs.writeFileSync(tmp, 'FROM ' + target + '\nDRAFT ' + draft + '\n');
        console.log('[ollama] building \'' + name + '\' (target=' + target + ', draft=' + draft + ')...');
        await new Promise((resolve) => {
          execFile(exe, ['create', name, '-f', tmp], { timeout: 600000, windowsHide: true }, (err, _out, errout) => {
            if (!err) console.log('[ollama] \'' + name + '\' ready - pick it in the model list for faster ' + target + ' output.');
            else console.log('[ollama] could not build \'' + name + '\': ' + String(errout || err.message || err).slice(0, 300));
            resolve();
          });
        });
      } catch (e) {
        console.log('[ollama] turbo create failed for \'' + name + '\': ' + ((e && e.message) || e));
      } finally {
        try { fs.unlinkSync(tmp); } catch (_e) {}
      }
    }
    if (attempted) { try { fs.writeFileSync(marker, 'done'); } catch (_e) {} }
  } catch (e) {
    console.warn('[ollama] ensureTurboModels: ' + ((e && e.message) || e));
  }
}

module.exports = {
  BASE,
  BASE_V1,
  VISION_CANDIDATES,
  CHAT_CATALOG,
  VISION_CATALOG,
  pullModel,
  findExe,
  serverUp,
  refresh,
  ensureRunning,
  stopIfOurs,
  startMonitor,
  listTags,
  pickVisionModel,
  visionModels,
  warm,
  unload,
  switchModel,
  ensureTurboModels,
  isUp: () => _up,
  cachedTags: () => _tags.slice(),
  cachedVisionModel: () => _visionModel
};
