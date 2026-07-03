// tests/test-downloads.js - registry shape + routing, with all deps mocked.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const downloads = require('../lib/downloads');

const wwDir = path.join(os.tmpdir(), 'caryl-dl-test-' + Date.now());
fs.mkdirSync(wwDir, { recursive: true });

let pulled = null;
downloads.init({
  config: { get: () => ({ offlineModel: 'qwen2.5:7b', wakeWordModel: 'hey_jarvis_v0.1.onnx' }) },
  ollama: {
    isUp: () => false,
    findExe: () => null,
    listTags: async () => [],
    pullModel: async (m) => { pulled = m; }
  },
  defaultOfflineModel: 'qwen2.5:7b',
  wakewordDir: () => wwDir,
  wakewordFiles: () => ['melspectrogram.onnx', 'embedding_model.onnx'],
  ensureWakeword: async () => ({ ok: true, dir: wwDir }),
  sidecarGet: async () => { throw new Error('sidecar down'); },
  sidecarWarmStt: async () => ({ ok: false, error: 'not running' })
});

(async () => {
  const st = await downloads.status();
  assert.strictEqual(st.length, 6);
  const ids = st.map((a) => a.id);
  assert.deepStrictEqual(ids, ['ollama-runtime', 'chat-model', 'vision-model', 'whisper-stt', 'piper-voice', 'wakeword-models']);
  assert.ok(st.every((a) => typeof a.installed === 'boolean' && typeof a.label === 'string' && a.sizeMB > 0));
  assert.strictEqual(st[0].installed, false); // no ollama
  assert.strictEqual(st[3].detail, 'sidecar not running');

  // routing
  let r = await downloads.start('ollama-runtime', () => {});
  assert.strictEqual(r.external, true);
  r = await downloads.start('chat-model', () => {});
  assert.strictEqual(r.ok, false); // ollama down -> clear error, no silent pull
  assert.strictEqual(pulled, null);
  r = await downloads.start('piper-voice', () => {});
  assert.strictEqual(r.error, 'use-voice-installer');
  r = await downloads.start('wakeword-models', () => {});
  assert.strictEqual(r.ok, true);
  r = await downloads.start('nope', () => {});
  assert.ok(/unknown asset/.test(r.error));

  // ollama up -> chat model pull routes through ollama.pullModel
  downloads.init({
    config: { get: () => ({ offlineModel: 'qwen2.5:7b', wakeWordModel: 'hey_jarvis_v0.1.onnx' }) },
    ollama: { isUp: () => true, findExe: () => 'ollama.exe', listTags: async () => ['moondream:latest'], pullModel: async (m) => { pulled = m; } },
    defaultOfflineModel: 'qwen2.5:7b',
    wakewordDir: () => wwDir,
    wakewordFiles: () => ['melspectrogram.onnx', 'embedding_model.onnx'],
    ensureWakeword: async () => ({ ok: true }),
    sidecarGet: async () => ({ available: true, cached: ['base.en'] }),
    sidecarWarmStt: async () => ({ ok: true })
  });
  const st2 = await downloads.status();
  assert.strictEqual(st2[2].installed, true);  // moondream tag present -> vision installed
  assert.strictEqual(st2[3].installed, true);  // whisper available + cached
  r = await downloads.start('chat-model', () => {});
  assert.strictEqual(r.ok, true);
  assert.strictEqual(pulled, 'qwen2.5:7b');

  console.log('test-downloads: all assertions passed');
})().catch((e) => { console.error(e); process.exit(1); });
